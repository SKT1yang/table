/**
 * CDP 驱动的验证（零依赖，node ≥22 内置 WebSocket）。
 *
 * 用法（先 pnpm build + vite preview --port 4173）：
 *   node scripts/cdp.mjs bench   # ?bench=1 自驱压测 + 功能自检，输出 JSON
 *   node scripts/cdp.mjs drag    # CDP wheel 输入：fps + 白屏帧采样 + 事后截图（headless）
 *   node scripts/cdp.mjs native '?skel=1&jumplead=150'
 *                                # headful（真 GPU 合成器）真实滚动条拇指拖拽 A/B；
 *                                # 参数 = 追加到 URL 的变体查询串（空 = 基线）
 *
 * 方法论对齐 RESULTS.md：
 * - 真实输入必须走 CDP Input 派发（程序化 scrollTop 赋值绕过合成器）；
 * - 白屏判定看渲染结果而非几何采样：paint 后采样器（setTimeout 而非 rAF——
 *   rAF 队列里采样器先于 Grid 的滚动处理执行，读到 assign 前状态，系统性误报）；
 * - headless 无 GPU 合成器：合成器领先主线程的时序（真机拖滚动条白屏的真凶）
 *   只有 native 模式（headful）能复现；
 * - fps 只作方向性参考（headless 帧率 ≠ 真机），结论以作者本机为准（沿用先例）。
 */
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = 'http://localhost:4173/'
const PORT = 9333

const mode = process.argv[2] ?? 'bench'
const variant = process.argv[3] ?? ''
const { spawn } = await import('node:child_process')
const headful = mode === 'native' || mode === 'cast' // 真窗口 + 真 GPU 合成器（复现合成器领先）
const SHOTS = `${import.meta.dirname}/shots`
const proc = spawn(CHROME, [
  ...(headful ? ['--window-size=1200,860', '--window-position=60,60', '--no-first-run'] : ['--headless=new', '--disable-gpu']),
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=/tmp/grid-spike-cdp',
  ...(headful ? [] : ['--window-size=1400,900']),
  'about:blank',
], { stdio: 'ignore' })
proc.on('error', (e) => { console.error('chrome 启动失败', e); process.exit(1) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let msgId = 0
const pending = new Map()
let onCdpEvent = () => {}

async function main() {
  // 等 CDP 端口就绪
  let target
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      target = (await r.json()).find((t) => t.type === 'page')
      if (target) break
    } catch { /* retry */ }
    await sleep(200)
  }
  if (!target) throw new Error('CDP: 找不到 page target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? rej(new Error(m.error.message)) : res(m.result)
    } else if (m.method) {
      onCdpEvent(m) // screencastFrame 等事件（cast 模式用）
    }
  }
  const send = (method, params = {}) => {
    const id = ++msgId
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => pending.set(id, { res, rej }))
  }
  const evalJs = async (expression, awaitPromise = false) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (exceptionDetails) throw new Error('page js: ' + exceptionDetails.text + ' ' + (exceptionDetails.exception?.description ?? ''))
    return result.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  const query = mode === 'bench' ? '?bench=1' : variant.startsWith('?') ? variant.slice(1) : ''
  await send('Page.navigate', { url: URL + (query ? '?' + query : '') })
  await sleep(1500)

  if (mode === 'bench') {
    for (let i = 0; i < 600; i++) {
      const v = await evalJs(`document.querySelector('#bench-result')?.textContent ?? null`)
      if (v) { console.log(v); break }
      await sleep(500)
    }
  } else if (mode === 'drag') {
    await runDrag(send, evalJs)
  } else if (mode === 'cast') {
    await runCast(send, evalJs)
  } else {
    await runNative(send, evalJs, () => send('Page.captureScreenshot', { format: 'png' }))
  }
  proc.kill('SIGKILL')
  process.exit(0)
}

// —— 页内采样器（drag / native 共用；每 phase 重装，代际守卫防旧循环双计）——
// 注意：本采样器读的是「采样时刻的 DOM」——合成器领先的空白（已上屏像素滞后于
// offset）它原理上看不到，空白结论以截图为准；fps/行位移分布仍有效。
const INSTALL_SAMPLER = `(() => {
  window.__samplerGen = (window.__samplerGen ?? 0) + 1
  const gen = window.__samplerGen
  window.__samples = { frames: 0, blankFrames: 0, blankRowsMax: 0, blankRowsSum: 0, dt: [], rowDelta: [], running: true, lastSt: null }
  let last = performance.now()
  const fpsTick = () => {
    if (gen !== window.__samplerGen) return
    const now = performance.now()
    window.__samples.dt.push(now - last); last = now
    requestAnimationFrame(fpsTick)
  }
  requestAnimationFrame(fpsTick)
  const blankTick = () => {
    if (gen !== window.__samplerGen) return
    const s = window.__samples
    const vp = window.__viewport, pool = window.__rowpool, store = window.__store
    const st = vp.scrollTop
    if (s.lastSt != null && Math.abs(st - s.lastSt) > 1) s.rowDelta.push(Math.abs(st - s.lastSt) / 35)
    s.lastSt = st
    const first = Math.floor(st / 35), last_ = Math.ceil((st + vp.clientHeight) / 35)
    const bodyTop = pool.bodyEl.getBoundingClientRect().top
    let blank = 0
    for (let i = first; i < last_; i++) {
      const fr = store.flatRows.peek()[i]
      if (!fr) continue
      const slot = pool.slots.find((x) => x.state && x.state.rowId === fr.id)
      // slotRect.top - bodyTop = 行在 .body 内的绝对偏移 = i*35（bodyTop 已随滚动移动，天然相消）
      if (!slot || slot.el.style.display === 'none' || Math.abs(slot.el.getBoundingClientRect().top - bodyTop - i * 35) > 0.5) blank++
    }
    s.frames++
    if (blank > 0) { s.blankFrames++; s.blankRowsSum += blank; s.blankRowsMax = Math.max(s.blankRowsMax, blank) }
    setTimeout(blankTick, 8)
  }
  setTimeout(blankTick, 8)
})()`

const READ_STATS = `(() => {
  const s = window.__samples
  const q = (a, p) => { if (!a.length) return 0; const b = [...a].sort((x,y)=>x-y); return b[Math.min(b.length-1, Math.ceil(b.length*p)-1)] }
  return JSON.stringify({
    samples: s.frames, blankFrames: s.blankFrames,
    blankRowsAvg: s.blankFrames ? +(s.blankRowsSum / s.blankFrames).toFixed(1) : 0,
    blankRowsMax: s.blankRowsMax,
    fps: (() => { const d = s.dt.filter(x => x < 500); return d.length > 1 ? +(1000/(d.reduce((a,b)=>a+b,0)/d.length)).toFixed(1) : 0 })(),
    scrollRowsP50: q(s.rowDelta, 0.5), scrollRowsP95: q(s.rowDelta, 0.95), scrollRowsMax: s.rowDelta.length ? Math.max(...s.rowDelta) : 0,
    scrollTop: Math.round(window.__viewport.scrollTop),
    stats: { rebinds: window.__rowpool.stats.rebinds, mounts: window.__rowpool.stats.mounts, assignMs: +window.__rowpool.stats.assignMs.toFixed(1), assigns: window.__rowpool.stats.assigns },
  }) })()`

async function loadDataAndInstallSampler(send, evalJs) {
  // 生成数据（点真实按钮）→ 等池就绪 → 装采样器
  await evalJs(`document.querySelector('.toolbar button.primary').click()`)
  for (let i = 0; i < 100; i++) {
    if (await evalJs(`!!window.__rowpool && window.__store.flatRows.peek().length > 0`)) break
    await sleep(300)
  }
  await evalJs(INSTALL_SAMPLER)
}

async function runDrag(send, evalJs) {
  await loadDataAndInstallSampler(send, evalJs)
  const geo = JSON.parse(await evalJs(`JSON.stringify((() => {
    const vp = window.__viewport, r = vp.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, sw: vp.scrollWidth, sh: vp.scrollHeight, cw: vp.clientWidth }
  })())`))
  console.log('viewport:', geo)

  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  const resetDragStats = () => evalJs(`window.__rowpool.resetStats()`)
  const phase = async (name, deltaY, events) => {
    await resetDragStats()
    await evalJs(INSTALL_SAMPLER)
    const t0 = Date.now()
    for (let f = 0; f < events; f++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY })
      await sleep(16)
    }
    await sleep(300)
    const r = JSON.parse(await evalJs(READ_STATS))
    console.log(`[${name}] ${Date.now() - t0}ms / ${events} 事件:`)
    console.log(JSON.stringify(r, null, 2))
    return r
  }
  await evalJs(`window.__viewport.scrollTop = 0`)
  await sleep(300)
  const fling = await phase('fling 1750px/事件', 1750, 240)
  await evalJs(`window.__viewport.scrollTop = 0`)
  await sleep(300)
  const drag = await phase('drag 17500px/事件', 17_500, 120)

  await sleep(300)
  console.log('白屏采样（全阶段汇总，paint 后）: 见上方各 phase samples/blankFrames')
  void fling; void drag

  // 事后截图（静止态三档）供人工核对
  const fs = await import('node:fs')
  fs.mkdirSync('/tmp/grid-drag-frames', { recursive: true })
  for (const st of [0, Math.floor(drag.scrollTop), 3_000_000]) {
    await evalJs(`window.__viewport.scrollTop = ${st}`)
    await sleep(400)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(`/tmp/grid-drag-frames/at-${st}.png`, Buffer.from(shot.data, 'base64'))
  }
  console.log('截图: /tmp/grid-drag-frames/')
}

/**
 * headful 真实滚动条拇指拖拽（复现真机「极限拖动白屏」）。
 * 变体（URL 参数）A/B：空 = 基线；?skel=1 骨架条纹；&jumplead=N 跳转方向性 lead。
 * 每个 phase：先 wheel 基准（与 headless 数字对齐），再真实拇指拖拽两档（fast/extreme）。
 */
async function runNative(send, evalJs, screenshot) {
  await loadDataAndInstallSampler(send, evalJs)
  const fs = await import('node:fs')
  fs.mkdirSync('/tmp/grid-drag-frames', { recursive: true })
  const tag = variant.replace(/[^a-z0-9]+/gi, '-') || 'baseline'
  const geo = JSON.parse(await evalJs(`JSON.stringify((() => {
    const vp = window.__viewport, r = vp.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, sw: vp.scrollWidth, sh: vp.scrollHeight, cw: vp.clientWidth }
  })())`))
  console.log('viewport:', geo, 'variant:', variant || '(baseline)')

  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  const reset = () => evalJs(`window.__rowpool.resetStats(); ` + INSTALL_SAMPLER)

  const report = async (name) => {
    await sleep(300)
    const r = JSON.parse(await evalJs(READ_STATS))
    console.log(`\n[${name}]`)
    console.log(JSON.stringify(r, null, 2))
    return r
  }

  // —— 1. wheel 基准（与 headless drag 模式同参数，headful vs headless 对比用）——
  await evalJs(`window.__viewport.scrollTop = 0`)
  await sleep(300)
  await reset()
  for (let f = 0; f < 120; f++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 17_500 })
    await sleep(16)
  }
  const wheelRes = await report('wheel 17500px/事件 ×120（headful 基准）')

  // —— 2. 真实拇指拖拽 ——
  // macOS overlay 滚动条：合成 mouseMoved 唤不出（fullrender spike 实测右缘截图无滚动条、
  // 按压落空）；确定性唤出 = 先 wheel 一格。classic 滚动条则占据布局（cw < w）。
  // 拇指长度 = max(系统最小 ~28px, 轨道×可视比) —— 5000 行下被最小拇指兜底（实测映射 ≈257px/px）
  const classic = geo.w - geo.cw > 8
  const sbX = classic ? geo.x + geo.cw + (geo.w - geo.cw) / 2 : geo.x + geo.w - 5
  const trackTop = geo.y
  const trackH = geo.h
  const thumbLen = Math.max(28, (trackH * geo.h) / geo.sh)
  const thumbDrag = async (name, stepPx, steps, intervalMs) => {
    await evalJs(`window.__viewport.scrollTop = 0`)
    await sleep(350)
    if (!classic) { // wheel 唤出 overlay 滚动条（从顶部出发，拇指在轨道顶部）
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 300 })
      await sleep(150)
    }
    await reset()
    const startY = trackTop + thumbLen / 2 // scrollTop≈0 → 拇指在轨道顶部
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sbX, y: startY, button: 'left', clickCount: 1 })
    await sleep(40)
    const moved = await evalJs(`window.__viewport.scrollTop`)
    let y = startY
    const shotAt = new Set([Math.floor(steps / 3), Math.floor((steps * 2) / 3)])
    for (let i = 0; i < steps; i++) {
      y = Math.min(trackTop + trackH - 10, y + stepPx)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sbX, y, button: 'left', buttons: 1 })
      if (shotAt.has(i)) {
        const shot = await screenshot()
        fs.writeFileSync(`/tmp/grid-drag-frames/native-${tag}-${name}-mid${i}.png`, Buffer.from(shot.data, 'base64'))
      }
      await sleep(intervalMs)
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sbX, y, button: 'left', clickCount: 1 })
    const r = await report(`拇指拖拽 ${name}（步进 ${stepPx}px ×${steps} @${intervalMs}ms，起始 scrollTop=${moved}）`)
    return r
  }

  const fast = await thumbDrag('fast', 8, 40, 10)
  const extreme = await thumbDrag('extreme', 32, 25, 10)

  // 事后静止截图（两档落点）
  await evalJs(`window.__viewport.scrollTop = ${Math.floor(extreme.scrollTop)}`)
  await sleep(400)
  const shot = await screenshot()
  fs.writeFileSync(`/tmp/grid-drag-frames/native-${tag}-settled.png`, Buffer.from(shot.data, 'base64'))

  console.log('\n===== 汇总（headful, variant=' + (variant || 'baseline') + '）=====')
  console.log(JSON.stringify({
    wheel17500: { fps: wheelRes.fps, blankFrames: `${wheelRes.blankFrames}/${wheelRes.samples}`, blankRowsAvg: wheelRes.blankRowsAvg, scrollRowsP95: wheelRes.scrollRowsP95 },
    thumbFast: { fps: fast.fps, blankFrames: `${fast.blankFrames}/${fast.samples}`, blankRowsAvg: fast.blankRowsAvg, blankRowsMax: fast.blankRowsMax, scrollRowsP95: fast.scrollRowsP95, mounts: fast.stats.mounts },
    thumbExtreme: { fps: extreme.fps, blankFrames: `${extreme.blankFrames}/${extreme.samples}`, blankRowsAvg: extreme.blankRowsAvg, blankRowsMax: extreme.blankRowsMax, scrollRowsP95: extreme.scrollRowsP95, scrollRowsMax: extreme.scrollRowsMax, mounts: extreme.stats.mounts },
  }, null, 2))
  console.log('截图: /tmp/grid-drag-frames/native-' + tag + '-*.png')
}

/**
 * 连拍不停手验证（cast）——修复 native 连拍的方法论缺口（fullrender spike 发现）。
 *
 * 缺口：native 模式的中途截图是 await Page.captureScreenshot——往返延迟期间拖拽
 * 输入流暂停，主线程趁机把 paint 追平，截图读到「追平后」状态。10 万行档每步跳
 * 55 个视口、追平结构性不可能（所以能拍到空白带）；5000 行每步 12 个视口、追平
 * 只要 1-2 帧——恰好全部落进截图延迟的盲区。「连拍满行」可能是假阴性。
 *
 * 修法：Page.startScreencast 让浏览器在每次 present 时主动推送帧（合成器视角的
 * 上屏真相），拖拽循环内零停顿。帧带墙钟时间戳，与页内 rAF scroll 日志对齐后
 * 可知「每个上屏帧对应的 scrollTop」；帧文件名直接编码 scrollTop，肉眼核对
 * 满行/空白带/骨架条纹。变体同 native（'?rows=5000' 等）。
 * 环境变量：CAST_STEP（默认 32）/ CAST_STEPS（25）/ CAST_MS（10）。
 * 注：本 demo 骨架条纹默认开——若拖拽中有未追平区，预期显示为「空行条纹」而非
 * 纯白（fullrender 无骨架，显示纯白）；?skel=0 可对照。
 */
async function runCast(send, evalJs) {
  await loadDataAndInstallSampler(send, evalJs)
  const fs = await import('node:fs')
  // tag 追加步长：不同速度档的同变体 cast 不互相覆盖帧目录（吃过一次亏）
  const tag = (variant.replace(/[^a-z0-9]+/gi, '-') || 'baseline') + `-${Number(process.env.CAST_STEP ?? 32)}px`
  const dir = `${SHOTS}/cast-${tag}`
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const geo = JSON.parse(await evalJs(`JSON.stringify((() => {
    const vp = window.__viewport, r = vp.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, sw: vp.scrollWidth, sh: vp.scrollHeight, cw: vp.clientWidth }
  })())`))
  console.log('viewport:', geo, 'variant:', variant || '(baseline)')

  const cx = geo.x + geo.w / 2
  const cy = geo.y + geo.h / 2
  const classic = geo.w - geo.cw > 8
  const sbX = classic ? geo.x + geo.cw + (geo.w - geo.cw) / 2 : geo.x + geo.w - 5
  const trackTop = geo.y
  const trackH = geo.h
  const thumbLen = Math.max(28, (trackH * geo.h) / geo.sh)

  // 页内 rAF scroll 日志（对齐帧时间戳 ↔ scrollTop；metadata.scrollTop 是主框架的，读不到内层 div）
  await evalJs(`window.__stLog = []; (() => {
    const l = window.__stLog
    const tick = () => { l.push([Math.round(performance.now()), Math.round(window.__viewport.scrollTop)]); if (l.length > 3000) l.shift(); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })()`)
  const clockOffset = Date.now() - (await evalJs(`performance.now()`)) // 墙钟 − 页钟

  const frames = []
  let ackOk = 0
  onCdpEvent = (m) => {
    if (m.method !== 'Page.screencastFrame') { if (m.method !== 'Page.screencastVisibilityChanged') console.log('event:', m.method); return }
    const p = m.params
    frames.push({ t: Date.now(), data: p.data })
    send('Page.screencastFrameAck', { sessionId: p.sessionId }) // Chrome 152 改名（旧为 screencastFrameAcked）
      .then(() => { ackOk++ })
      .catch((e) => console.error('ack FAIL:', e.message))
  }

  const stepPx = Number(process.env.CAST_STEP ?? 32)
  const steps = Number(process.env.CAST_STEPS ?? 25)
  const intervalMs = Number(process.env.CAST_MS ?? 10)

  await evalJs(`window.__viewport.scrollTop = 0`)
  await sleep(350)
  if (!classic) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 300 })
    await sleep(150)
  }
  await evalJs(`window.__rowpool.resetStats(); ` + INSTALL_SAMPLER)
  await send('Page.startScreencast', { format: 'png', maxWidth: 900, maxHeight: 645, everyNthFrame: 1 })
  await sleep(400) // 基线帧（拖拽前，应满行）

  const startY = trackTop + thumbLen / 2
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sbX, y: startY, button: 'left', clickCount: 1 })
  await sleep(40)
  let y = startY
  const t0 = Date.now()
  for (let i = 0; i < steps; i++) {
    y = Math.min(trackTop + trackH - 10, y + stepPx)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sbX, y, button: 'left', buttons: 1 })
    await sleep(intervalMs)
  }
  const dragMs = Date.now() - t0
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sbX, y, button: 'left', clickCount: 1 })
  await sleep(600) // 收尾帧（松手后，应满行）
  await send('Page.stopScreencast')
  onCdpEvent = () => {}

  // 帧时间戳 ↔ 页内 scroll 日志对齐，帧文件名编码「该上屏帧时刻的 scrollTop」
  const log = await evalJs(`window.__stLog`)
  const stAt = (t) => {
    const pt = t - clockOffset
    let best = log.length ? log[0][1] : -1
    for (const [pt0, st] of log) { if (pt0 <= pt + 30) best = st; else break }
    return best
  }
  const lines = []
  frames.forEach((f, i) => {
    const st = stAt(f.t)
    fs.writeFileSync(`${dir}/f${String(i).padStart(3, '0')}-st${st}.png`, Buffer.from(f.data, 'base64'))
    lines.push(`f${i} st=${st}`)
  })
  const r = JSON.parse(await evalJs(READ_STATS))
  console.log(`\ncast ${tag}: 拖拽 ${dragMs}ms（${stepPx}px×${steps}@${intervalMs}ms），上屏帧 ${frames.length}（ack ok ${ackOk}）`)
  console.log('各帧 scrollTop:', lines.join(' | '))
  console.log(JSON.stringify({ fps: r.fps, scrollRowsP50: r.scrollRowsP50, scrollRowsP95: r.scrollRowsP95, scrollRowsMax: r.scrollRowsMax, stats: r.stats }, null, 2))
  console.log('帧目录:', dir + '/')
}

main().catch((e) => { console.error(e); proc.kill('SIGKILL'); process.exit(1) })
