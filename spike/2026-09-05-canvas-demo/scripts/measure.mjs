#!/usr/bin/env node
/**
 * CDP 实测（生产构建 + vite preview + 系统 Chrome headless，DPR 2 —— 与 DOM spike 同条件）。
 * 场景对齐 DOM spike RESULTS.md 的表格，重点是不连续滚动（拖滚动条/跳转）——
 * DOM 路线的结构性边界（挂载吞吐 0.45ms/行 vs 需求 0.16ms/行）。
 * 用法：pnpm build && pnpm measure
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { PNG } from 'pngjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4193
const URL = `http://localhost:${PORT}/`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SHOTS = path.join(ROOT, 'scripts', 'shots')
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// —— preview server ——
const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
})
process.on('exit', () => preview.kill())
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(URL)
      if (r.ok) return
    } catch {}
    await sleep(500)
  }
  throw new Error('preview 未就绪')
}
await waitReady()

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
})
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'networkidle0' })

// 页内工具：fps 计数器
await page.evaluate(() => {
  window.__runFps = (ms) =>
    new Promise((res) => {
      let frames = 0
      const t0 = performance.now()
      const loop = () => {
        frames++
        performance.now() - t0 < ms ? requestAnimationFrame(loop) : res(Math.round(frames / ((performance.now() - t0) / 1000)))
      }
      requestAnimationFrame(loop)
    })
})

const results = { env: { viewport: '1440x900@2x', build: 'production', chrome: 'headless' }, scenarios: [] }

// 生成数据
const t0 = Date.now()
await page.click('.toolbar button.primary')
await page.waitForFunction(() => window.__store?.flatRows.peek().length > 0)
results.generateMs = Date.now() - t0

// 预热（字体整形/首帧布局摊销，避免首个场景背锅）
await page.evaluate(
  async () => {
    const el = document.querySelector('.scroller')
    let n = 0
    const warm = () => {
      el.scrollTop += 800
      if (++n < 40) requestAnimationFrame(warm)
    }
    requestAnimationFrame(warm)
    await new Promise((r) => setTimeout(r, 900))
    el.scrollTop = 0
  },
)
await sleep(200)

const repaints = () => page.evaluate(() => window.__renderer.stats.repaints.peek())
const drawStats = () =>
  page.evaluate(() => {
    const s = window.__renderer.stats
    return { avgMs: Math.round(s.avgMs.peek() * 100) / 100, lastMs: Math.round(s.lastMs.peek() * 100) / 100 }
  })

/** 程序化滚动场景（页面内 rAF 驱动 + 同步计数） */
async function programmatic(name, mode, arg, ms = 3000) {
  const r = await page.evaluate(
    async (mode, arg, ms) => {
      const el = document.querySelector('.scroller')
      const st = window.__renderer.stats
      const r0 = st.repaints.peek()
      el.scrollTop = 0
      let frames = 0
      let stop = false
      const t0 = performance.now()
      const drive = () => {
        if (stop) return
        frames++
        if (mode === 'linear') el.scrollTop += arg
        else if (mode === 'jump') el.scrollTop = (frames % 2) * arg // 0 ↔ arg 两端往返，单帧位移=arg（不相交窗口）
        else if (mode === 'end') el.scrollTop = el.scrollHeight // 单跳
        if (performance.now() - t0 < ms) requestAnimationFrame(drive)
        else stop = true
      }
      requestAnimationFrame(drive)
      const fps = await window.__runFps(ms)
      stop = true
      await new Promise((r) => requestAnimationFrame(r))
      return { fps, repaints: st.repaints.peek() - r0, frames }
    },
    mode,
    arg,
    ms,
  )
  const d = await drawStats()
  results.scenarios.push({ name, mode, arg, ...r, ...d })
  console.log(
    `${name.padEnd(34)} fps=${String(r.fps).padStart(3)}  重绘=${String(r.repaints).padStart(5)}  draw均值=${d.avgMs}ms`,
  )
}

/** 真实输入管线：滚轮流（page.mouse.wheel 走 CDP Input 管线；先落鼠标到网格区） */
async function wheelStream(name, { deltaY = 0, deltaX = 0, rewindEvery = 0 }, ms = 3000) {
  const { x, y } = await page.evaluate(() => {
    const r = document.querySelector('.scroller').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.move(x, y)
  await page.evaluate(() => {
    const el = document.querySelector('.scroller')
    el.scrollTop = 0
    el.scrollLeft = 0
  })
  const r0 = await repaints()
  const fpsP = page.evaluate((ms) => window.__runFps(ms), ms)
  const t0 = Date.now()
  let n = 0
  while (Date.now() - t0 < ms) {
    await page.mouse.wheel({ deltaY, deltaX })
    n++
    if (rewindEvery && n % rewindEvery === 0) {
      await page.evaluate(() => (document.querySelector('.scroller').scrollLeft = 0)) // 横向到头后回卷，维持持续横滚
    }
    await sleep(16)
  }
  const fps = await fpsP
  const rep = (await repaints()) - r0
  const d = await drawStats()
  results.scenarios.push({ name, deltaY, deltaX, ms, fps, repaints: rep, ...d })
  console.log(`${name.padEnd(34)} fps=${String(fps).padStart(3)}  重绘=${String(rep).padStart(5)}  draw均值=${d.avgMs}ms`)
}

/** 拖滚动条：按住拇指每帧 ±stepPx（拇指移动换算的内容位移 = stepPx × 滚动比例）。
 *  headless 若无经典滚动条（offsetWidth==clientWidth）则跳过——真实拖拽留真机复测，
 *  不连续滚动的本质（单帧位移与视口不相交）已由 jump 模式覆盖。 */
async function dragScrollbar(name, stepPx, steps) {
  const setup = await page.evaluate(() => {
    const el = document.querySelector('.scroller')
    // 滚到中部 → 拇指位于轨道中部，按下点即拇指
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
    const r = el.getBoundingClientRect()
    return {
      left: r.left,
      top: r.top,
      w: r.width,
      h: r.height,
      scrollbarW: el.offsetWidth - el.clientWidth,
      scrollable: el.scrollHeight > el.clientHeight,
    }
  })
  if (!setup.scrollbarW) {
    console.log(`${name.padEnd(34)} [跳过] headless 无经典滚动条 → 真机复测；本质已由跳转模式覆盖`)
    results.scenarios.push({ name, skipped: 'no-classic-scrollbar-in-headless' })
    return
  }
  const x = setup.left + setup.w - setup.scrollbarW / 2
  const y = setup.top + setup.h / 2
  const r0 = await repaints()
  const st0 = await page.evaluate(() => document.querySelector('.scroller').scrollTop)
  const fpsP = page.evaluate((ms) => window.__runFps(ms), steps * 16)
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, y + i * stepPx)
    await sleep(16)
  }
  await page.mouse.up()
  const fps = await fpsP
  const stDelta = Math.abs((await page.evaluate(() => document.querySelector('.scroller').scrollTop)) - st0)
  const rep = (await repaints()) - r0
  const d = await drawStats()
  const pxPerFrame = Math.round(stDelta / steps)
  results.scenarios.push({ name, stepPx, steps, fps, repaints: rep, scrollTopDelta: stDelta, pxPerFrame, ...d })
  console.log(
    `${name.padEnd(34)} fps=${String(fps).padStart(3)}  重绘=${String(rep).padStart(5)}  ≈${pxPerFrame}px/帧  draw均值=${d.avgMs}ms`,
  )
}

/** 白屏检测：fling 过程中连拍截图，数「无文本像素」样本（paint 后真相，与 DOM spike 同口径） */
async function blankDuringFling(name, speed, maxFrames, alternate = false) {
  const clip = await page.evaluate(() => {
    const r = document.querySelector('.grid-wrap').getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  await page.evaluate(
    (speed, maxFrames, alternate) => {
      window.__flingDone = false
      const el = document.querySelector('.scroller')
      el.scrollTop = 0
      let n = 0
      const drive = () => {
        n++
        el.scrollTop = alternate ? (n % 2) * speed : el.scrollTop + speed
        if (n >= maxFrames || el.scrollTop >= el.scrollHeight - el.clientHeight - 10) {
          window.__flingDone = true
          return
        }
        requestAnimationFrame(drive)
      }
      requestAnimationFrame(drive)
    },
    speed,
    maxFrames,
    alternate,
  )
  let blank = 0
  let total = 0
  let lastShot = null
  while (!(await page.evaluate(() => window.__flingDone))) {
    const buf = await page.screenshot({ clip })
    lastShot = buf
    const { dark } = analyze(buf)
    if (dark < 200) blank++ // 网格区几乎无深色像素 = 无文本
    total++
  }
  if (lastShot) writeFileSync(path.join(SHOTS, `${name.replace(/[/\\]/g, '_')}.png`), lastShot)
  results.scenarios.push({ name, speed, blank, total })
  console.log(`${name.padEnd(34)} 白屏样本 ${blank}/${total}`)
}

function analyze(buf) {
  const png = PNG.sync.read(buf)
  let dark = 0
  for (let i = 0; i < png.data.length; i += 8) {
    // 每 2 像素抽 1；#333 文本大量深色像素，#eee 网格线/浅底不算
    const lum = 0.3 * png.data[i] + 0.59 * png.data[i + 1] + 0.11 * png.data[i + 2]
    if (lum < 100) dark++
  }
  return { dark }
}

/** 功能冒烟：编辑/undo/树形/键盘（CDP 真实事件） */
async function smoke() {
  const out = {}
  const cellPos = (rowId, colId) =>
    page.evaluate((rowId, colId) => {
      const s = window.__store
      const el = document.querySelector('.scroller')
      const r = el.getBoundingClientRect()
      const idx = s.rowIndexMap.peek().get(rowId)
      const m = s.colById.get(colId)
      return {
        x: r.left + (m.pinned ? m.pinLeft : m.absLeft - el.scrollLeft) + m.col.width / 2,
        y: r.top + s.HEADER_HEIGHT + idx * s.ROW_HEIGHT - el.scrollTop + s.ROW_HEIGHT / 2,
      }
    }, rowId, colId)

  // 3 编辑：双击 → 输入 → Enter → 重绘恰 +1（横竖滚动都归零，防坐标错位）
  await page.evaluate(() => {
    const el = document.querySelector('.scroller')
    el.scrollTop = 0
    el.scrollLeft = 0
  })
  const p = await cellPos('r5', 'c3')
  await page.mouse.click(p.x, p.y, { clickCount: 2 })
  await new Promise((r) => setTimeout(r, 120))
  out.editorShown = await page.evaluate(() => !!document.querySelector('.editor input'))
  const r0 = await repaints()
  await page.keyboard.type('CDP-EDIT')
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 80))
  out.editRepaintDelta = (await repaints()) - r0
  out.edited = await page.evaluate(() => window.__store.readCell('r5', 'c3') === 'CDP-EDIT')
  // 4 undo/redo
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Control')
  await new Promise((r) => setTimeout(r, 80))
  out.undoRestored = await page.evaluate(() => window.__store.readCell('r5', 'c3') !== 'CDP-EDIT')
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyY')
  await page.keyboard.up('Control')
  await new Promise((r) => setTimeout(r, 80))
  out.redoApplied = await page.evaluate(() => window.__store.readCell('r5', 'c3') === 'CDP-EDIT')
  // 5 树形：滚到首个父节点 r899，点行首 ▸ 开关区（x≈10，非单元格中心）
  await page.evaluate(() => (document.querySelector('.scroller').scrollTop = 899 * 35 - 100))
  await new Promise((r) => setTimeout(r, 120))
  const tp = await page.evaluate(() => {
    const s = window.__store
    const el = document.querySelector('.scroller')
    const r = el.getBoundingClientRect()
    const idx = s.rowIndexMap.peek().get('r899')
    return { x: r.left + 10, y: r.top + s.HEADER_HEIGHT + idx * s.ROW_HEIGHT - el.scrollTop + s.ROW_HEIGHT / 2 }
  })
  const before = await page.evaluate(() => window.__store.flatRows.peek().length)
  await page.mouse.click(tp.x, tp.y)
  await new Promise((r) => setTimeout(r, 120))
  out.expandDelta = (await page.evaluate(() => window.__store.flatRows.peek().length)) - before
  // 6 键盘：Control+End 跳尾 + focus 行到位
  await page.keyboard.down('Control')
  await page.keyboard.press('End')
  await page.keyboard.up('Control')
  await new Promise((r) => setTimeout(r, 200))
  out.endJump = await page.evaluate(() => {
    const el = document.querySelector('.scroller')
    const s = window.__store
    return {
      atBottom: el.scrollTop >= el.scrollHeight - el.clientHeight - 40,
      focusRow: s.focusCell.peek()?.rowId,
      lastRow: s.flatRows.peek()[s.flatRows.peek().length - 1]?.id,
    }
  })
  results.smoke = out
  console.log('功能冒烟:', JSON.stringify(out))
}

// —— 跑场景 ——
console.log(`\n== 生成 10 万行耗时 ${results.generateMs}ms ==\n`)
console.log('-- 连续滚动（程序化 rAF，DOM spike 对照：+100/400=60fps，+1500=51fps，+2500=33fps）--')
await programmatic('连续 +100px/帧', 'linear', 100)
await programmatic('连续 +400px/帧', 'linear', 400)
await programmatic('连续 +800px/帧', 'linear', 800)
await programmatic('连续 +1500px/帧', 'linear', 1500)
await programmatic('连续 +2500px/帧', 'linear', 2500)

console.log('\n-- 真实输入管线（CDP wheel，每帧一次）--')
await wheelStream('wheel deltaY=100/帧', { deltaY: 100 })
await wheelStream('wheel deltaY=400/帧', { deltaY: 400 })
await wheelStream("wheel deltaX=120/帧（横向，30 步回卷）", { deltaX: 120, rewindEvery: 30 })

console.log('\n-- 不连续滚动（DOM 路线结构性边界：拖滚动条 17500px/帧=47fps+空白带 / 3500px/帧=45fps+~50%空白）--')
await programmatic('跳转 3500px/帧（两端往返）', 'jump', 3500)
await programmatic('跳转 17500px/帧（两端往返）', 'jump', 17500)
await programmatic('跳转 350万px 单跳（Cmd+End）', 'end', 0, 1000)
await dragScrollbar('拖滚动条 拇指±5px/帧×90', 5, 90)
await dragScrollbar('拖滚动条 拇指±1px/帧×180', 1, 180)

console.log('\n-- 白屏检测（fling 连拍截图，paint 后真相）--')
await blankDuringFling('fling+2500px/帧连拍', 2500, 150)
await blankDuringFling('跳转17500px/帧连拍', 17500, 60, true)

console.log('\n-- 功能冒烟 --')
await smoke()

// 横向滚动稳态截图（pinned 对齐人工复核）
{
  await page.evaluate(() => {
    const el = document.querySelector('.scroller')
    el.scrollTop = 500000
    el.scrollLeft = 1200
  })
  await new Promise((r) => setTimeout(r, 200))
  const clip = await page.evaluate(() => {
    const r = document.querySelector('.grid-wrap').getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  writeFileSync(path.join(SHOTS, 'pinned-alignment.png'), await page.screenshot({ clip }))
}

writeFileSync(path.join(ROOT, 'scripts', 'measure-out.json'), JSON.stringify(results, null, 2))
console.log('\n结果已写入 scripts/measure-out.json；截图在 scripts/shots/')
await browser.close()
preview.kill()
process.exit(0)
