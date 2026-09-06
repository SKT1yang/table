#!/usr/bin/env node
/**
 * CDP 扫描（零依赖，node ≥22 内置 WebSocket；静态服务器内联）。
 *
 * 目标：零框架噪声下测纯 HTML 表格的 DOM 主线程地板——
 *   构建（innerHTML 解析路径 vs fragment 命令式路径）/ 样式失效 / 布局 / 单格编辑 /
 *   命中测试 / 跳转 / 连续滚动 / 内存（CDP Nodes+LayoutObjects，renderer 真相）。
 * 每步用 Performance.getMetrics 差分拿浏览器内部归因（RecalcStyle/Layout 次数与时长）。
 *
 * 方法论对齐前两个 spike（headless 无 GPU 合成器，滚动数字仅方向性；
 *   样式/布局/构建为主线程成本，headless 有效）。
 * 用法：node scripts/measure.mjs
 *   环境变量：SIZES=1000,5000 COLS=10 VPROBE=0 SKIP=mode1,mode2 TIMEOUT_BUILD_MS=180000
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createServer } from './serve.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 4195
const URL = `http://localhost:${PORT}/`
const CDP_PORT = 9335
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SIZES = (process.env.SIZES ?? '1000,5000,10000,50000,100000').split(',').map(Number)
const COLS = Number(process.env.COLS ?? 10)
const BUILD_TIMEOUT = Number(process.env.TIMEOUT_BUILD_MS ?? 240_000)
const BENCH_TIMEOUT = Number(process.env.TIMEOUT_BENCH_MS ?? 120_000)
const SKIP = new Set((process.env.SKIP ?? '').split(',').filter(Boolean))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// —— 静态服务器 ——
const server = createServer().listen(PORT)
process.on('exit', () => server.close())

// —— Chrome / CDP ——
let proc = null
let ws = null
let msgId = 0
const pending = new Map()
let chromeVersion = ''

async function launchChrome() {
  proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=/tmp/dom-limit-cdp',
    '--js-flags=--expose-gc',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' })
  proc.on('error', (e) => { console.error('chrome 启动失败', e); process.exit(1) })
  let target
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      target = (await r.json()).find((t) => t.type === 'page')
      if (target) break
    } catch { /* retry */ }
    await sleep(200)
  }
  if (!target) throw new Error('CDP: 找不到 page target')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? rej(new Error(m.error.message)) : res(m.result)
    }
  }
  const send = (method, params = {}) => {
    const id = ++msgId
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => pending.set(id, { res, rej }))
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Performance.enable')
  await send('Page.navigate', { url: URL })
  await sleep(800)
  chromeVersion = (await send('Browser.getVersion')).product
  return send
}
let send = await launchChrome()

/** 带看门狗的 evaluate：renderer 卡死/崩溃时超时返回 null（不 reject——让扫描继续） */
async function evalT(expression, timeoutMs = BENCH_TIMEOUT, awaitPromise = true) {
  const id = ++msgId
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }))
  const p = new Promise((res, rej) => pending.set(id, { res, rej }))
  const winner = await Promise.race([p.then((v) => ({ v })), sleep(timeoutMs).then(() => ({ timeout: true }))])
  if (winner.timeout) { pending.delete(id); return null }
  if (winner.v.exceptionDetails) return { __err: winner.v.exceptionDetails.exception?.description ?? winner.v.exceptionDetails.text }
  return winner.v.result.value
}
const evalJs = async (expression) => {
  const v = await evalT(expression, 30_000, false)
  if (v === null) throw new Error('页面无响应: ' + expression.slice(0, 80))
  if (v && v.__err) throw new Error('page js: ' + v.__err)
  return v
}

// —— renderer 内部指标（Performance.getMetrics 差分）——
const METRIC_NAMES = ['Nodes', 'LayoutObjects', 'JSEventListeners', 'JSHeapUsedSize', 'RecalcStyleCount', 'RecalcStyleDuration', 'LayoutCount', 'LayoutDuration', 'Documents']
let lastM = null
async function snap() {
  const { metrics } = await send('Performance.getMetrics')
  const o = {}
  for (const m of metrics) if (METRIC_NAMES.includes(m.name)) o[m.name] = m.value
  lastM = o
  return o
}
const delta = (m) => ({
  nodes: Math.round(m.Nodes - lastM.Nodes),
  layoutObjects: Math.round(m.LayoutObjects - lastM.LayoutObjects),
  recalcMs: +((m.RecalcStyleDuration - lastM.RecalcStyleDuration) * 1000).toFixed(1),
  recalcCount: Math.round(m.RecalcStyleCount - lastM.RecalcStyleCount),
  layoutMs: +((m.LayoutDuration - lastM.LayoutDuration) * 1000).toFixed(1),
  layoutCount: Math.round(m.LayoutCount - lastM.LayoutCount),
  heapMB: +((m.JSHeapUsedSize - lastM.JSHeapUsedSize) / 1048576).toFixed(1),
})

// —— 场景执行 ——
const results = { env: { chrome: chromeVersion, viewport: '1400x900@1x', cols: COLS, build: '静态文件（无构建）', url: URL }, scenarios: [] }
const fence = new Map() // key=mode:method → 已失败的最大规模；更大规模跳过（OOM/超时栅栏）
let respawned = 0

async function pageAlive() { return (await evalT('1', 5000, false)) === 1 }

async function scenario({ size, mode, method, cv = false }) {
  const key = `${mode}:${method}${cv ? ':cv' : ''}`
  const fencedAt = fence.get(key)
  if (fencedAt && size > fencedAt) { console.log(`  [skip] ${key} @${size}（>${fencedAt} 已栅栏）`); return }
  const tag = `${size.toLocaleString()}行 ${mode}${cv ? '+cv' : ''} ${method}`
  const out = { size, mode, method, cv, benches: {} }
  results.scenarios.push(out)

  const buildArg = JSON.stringify({ rows: size, cols: COLS, mode, method, cv })
  let b = await evalT(`__bench.build(${buildArg})`, BUILD_TIMEOUT)
  if (b === null || b?.__err) {
    // renderer 疑似卡死/崩溃：探活，死了就重生，本场景记失败
    out.fail = b === null ? 'timeout' : b.__err
    fence.set(key, size)
    if (!(await pageAlive())) { await respawn(); console.log('  [respawn] renderer 已重启') } else { await evalT('__bench.destroy()', 20_000) }
    console.log(`  [FAIL] ${tag} — ${out.fail}`)
    return
  }
  out.build = b
  await snap()

  // bench 序列（各自带浏览器内部归因差分）
  const nSmall = size >= 50_000 ? 3 : 5
  const run = async (name, expr, timeoutMs) => {
    const r = await evalT(expr, timeoutMs ?? BENCH_TIMEOUT)
    if (r === null || r?.__err) { out.benches[name] = { fail: r === null ? 'timeout' : r.__err }; return }
    const m = await snap()
    out.benches[name] = { ...r, _attr: delta(m) }
  }
  await run('cleanRead', `__bench.cleanRead(10)`)
  await run('styleHot', `__bench.styleHot(${nSmall})`)
  await run('styleLayout', `__bench.styleLayout(${Math.min(nSmall, 3)})`)
  await run('rowHover', `__bench.rowHover(10)`)
  await run('mutateCell', `__bench.mutateCell(${Math.min(nSmall, 3)})`)
  await run('hitTest', `__bench.hitTest(30)`)
  await run('jumpEnd', `__bench.jumpEnd()`)
  if (mode === 'virtual') await evalJs('__bench.vreset()')
  await run('fling1500', `__bench.fling(1500, ${size >= 50_000 ? 120 : 180})`)
  await evalT('__bench.destroy()', 60_000)
  await evalJs('window.__vGc()')
  await sleep(300)

  const bb = out.benches
  const f = (x) => (x == null ? '—' : typeof x === 'number' ? (x >= 100 ? x.toFixed(0) : x.toFixed(x < 10 ? 1 : 0)) : String(x))
  console.log(
    `[${tag}]`.padEnd(34) +
    ` build ${f(b.buildMs)}+${f(b.firstLayoutMs)}ms` +
    ` | nodes ${(b.nodes / 1000).toFixed(0)}k` +
    ` | hot p50 ${f(bb.styleHot?.p50)}ms(${f(bb.styleHot?._attr?.recalcMs)}attr)` +
    ` | hotL p50 ${f(bb.styleLayout?.p50)}ms(recalc ${f(bb.styleLayout?._attr?.recalcMs)}/layout ${f(bb.styleLayout?._attr?.layoutMs)})` +
    ` | mut ${f(bb.mutateCell?.p50)}ms` +
    ` | hover ${f(bb.rowHover?.p50)}` +
    ` | hit ${f(bb.hitTest?.p50)}ms` +
    ` | jump ${f(bb.jumpEnd?.ms)}ms` +
    ` | fling ${f(bb.fling1500?.fps)}fps` +
    (mode === 'virtual' ? ` | rebinds ${bb.fling1500?.rebinds} assign ${f(bb.fling1500?.assignMs)}ms` : ''),
  )

  if (!(await pageAlive())) await respawn()
}

async function respawn() {
  if (respawned++ > 6) throw new Error('respawn 次数超限')
  try { proc.kill('SIGKILL') } catch {}
  ws = null
  await sleep(800)
  send = await launchChrome()
}

// —— 扫描矩阵 ——
console.log(`Chrome ${chromeVersion} | cols=${COLS} | sizes=${SIZES.join(',')}\n`)
console.log('— 主矩阵：table-fixed / div × innerHTML / fragment —')
for (const size of SIZES) {
  for (const mode of ['table-fixed', 'div']) {
    if (SKIP.has(mode)) continue
    for (const method of ['innerHTML', 'fragment']) await scenario({ size, mode, method })
  }
  if (!SKIP.has('table-auto') && size <= 10_000) await scenario({ size, mode: 'table-auto', method: 'fragment' })
  if (!SKIP.has('cv') && size >= 10_000) await scenario({ size, mode: 'div', method: 'fragment', cv: true })
}
console.log('\n— 虚拟化对照组（O(视口) 应与数据量无关）—')
if (!SKIP.has('virtual')) {
  for (const size of [SIZES[0], SIZES[SIZES.length - 1]]) await scenario({ size, mode: 'virtual', method: 'fragment' })
}

// —— 极限探测（可选）：翻倍到死为止 —
if (process.env.VPROBE === '1') {
  console.log('\n— 极限探测：从 max(SIZES) 翻倍 —')
  let size = SIZES[SIZES.length - 1]
  for (let i = 0; i < 3 && size <= 800_000; i++) {
    size *= 2
    const r = await evalT(`__bench.build(${JSON.stringify({ rows: size, cols: COLS, mode: 'div', method: 'fragment' })})`, BUILD_TIMEOUT)
    if (r === null || r?.__err) { console.log(`  [极限] ${size} 行 — ${r === null ? 'timeout/崩溃' : r.__err}`); break }
    console.log(`  [存活] ${size} 行 nodes=${(r.nodes / 1e6).toFixed(2)}M build=${r.buildMs}ms layout=${r.firstLayoutMs}ms`)
    results.probe = results.probe ?? []
    results.probe.push({ size, ...r })
    await evalT('__bench.destroy()', 60_000)
    await sleep(1000)
  }
}

writeFileSync(path.join(ROOT, 'scripts', 'measure-out.json'), JSON.stringify(results, null, 2))
console.log('\n结果: scripts/measure-out.json')
proc.kill('SIGKILL')
process.exit(0)
