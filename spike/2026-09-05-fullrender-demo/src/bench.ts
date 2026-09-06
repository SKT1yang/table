/**
 * 全量档页内自检（?bench=1 进入；headless `--dump-dom --virtual-time-budget` 捕获结果）。
 *
 * 方法论对齐 grid-demo RESULTS.md：
 * - 数字只认生产构建（dev ~1.7x 慢）；
 * - 程序化 scrollTop 驱动滚动卫生断言（滚动期 assigns/mounts 严格为 0 —— 全量档
 *   「滚动零行工作」主张的直接证明；真实拖拽的 fps/白屏走 cdp.mjs native + 截图）；
 * - 功能自检在真浏览器 DOM 上断言：可见行文本 vs readCell、展开锚点、编辑计数
 *   （验收 3 语义在 10 万常驻 effect 图下）、撤销、订阅数恒等式；
 * - 挂载计时报告（分块首屏主张的直接观测）：首块 / 全量 / 每块净耗时分布。
 */
import { ROW_HEIGHT, type GridStore } from './core/store'
import type { FullBody } from './core/fullbody'

interface ScrollResult {
  name: string
  frames: number
  assigns: number
  mounts: number
}

interface MountTiming {
  rows: number
  chunkSize: number
  chunks: number
  firstChunkMs: number
  fullMs: number
  workMs: number
  chunkP50Ms: number
  chunkP95Ms: number
  chunkMaxMs: number
  /** 全量挂载完成后一次强制 layout 的耗时（c-v 收益的观测面之一） */
  reflowMs: number
}

interface EditTiming {
  executeMs: number
  /** execute 到 cell 文本更新（下一帧 paint 前后）的墙钟 */
  textUpdateMs: number
}

interface BenchResult {
  mount: MountTiming
  scroll: ScrollResult[]
  edit: EditTiming
  /** false = 该变体数据无父节点，树形三检查 n/a（已从 pass 剔除） */
  treeChecked: boolean
  checks: Record<string, boolean>
  subs: number
  subsExpected: number
  mountedRows: number
  domNodes: number
  pass: boolean
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame()
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]
}

async function waitFor<T>(fn: () => T | null, timeoutMs = 30_000): Promise<T> {
  const t0 = performance.now()
  for (;;) {
    const v = fn()
    if (v != null) return v
    if (performance.now() - t0 > timeoutMs) throw new Error('bench: 等待就绪超时')
    await sleep(25)
  }
}

/** 滚动卫生场景：每帧滚 deltaPx —— 全量档断言 assigns/mounts 全程为 0 */
async function runScroll(name: string, fb: FullBody, viewport: HTMLElement, deltaPx: number, frameCount: number): Promise<ScrollResult> {
  fb.resetStats()
  let f = 0
  for (; f < frameCount; f++) {
    const before = viewport.scrollTop
    viewport.scrollTop = before + deltaPx
    if (viewport.scrollTop === before && deltaPx !== 0) break // 触底
    await nextFrame()
  }
  await frames(2)
  return { name, frames: f, assigns: fb.stats.assigns, mounts: fb.stats.mounts }
}

/** 可见窗口采样断言：slot 存在 / 实际布局位置 / 文本 与 store 一致（含树列 .val 与普通格） */
function checkVisible(store: GridStore, fb: FullBody, viewport: HTMLElement): boolean {
  const rows = store.flatRows.peek()
  const cols = store.columns
  // 用 rect 而非 style.top 字符串：CSSOM 科学计数法回读有损（grid-demo 教训）
  const vpTop = viewport.getBoundingClientRect().top
  const bodyY = fb.bodyEl.getBoundingClientRect().top - vpTop + viewport.scrollTop
  const st = viewport.scrollTop
  const vh = viewport.clientHeight
  const first = Math.max(0, Math.floor((st - 0) / ROW_HEIGHT))
  const last = Math.min(rows.length - 1, Math.floor((st + vh) / ROW_HEIGHT))
  const n = last - first
  for (let k = 0; k <= 6; k++) {
    const idx = Math.min(last, first + Math.floor((n * k) / 6))
    const fr = rows[idx]
    if (!fr) continue
    const slot = fb.getSlot(fr.id)
    if (!slot) return false
    const actual = slot.el.getBoundingClientRect().top - vpTop + viewport.scrollTop
    if (Math.abs(actual - (bodyY + idx * ROW_HEIGHT)) > 0.5) return false
    if (slot.el.style.display === 'none') return false
    for (const ci of [0, 1, 5, cols.length - 1]) {
      const expect = store.readCell(fr.id, cols[ci].id)
      if (slot.cellEls[ci].textContent !== (expect == null ? '' : String(expect))) return false
    }
    // 树形视觉：expander 可见性与 glyph
    const visible = slot.expander.style.display !== 'none'
    if (visible !== fr.hasChildren) return false
    if (visible && slot.expander.textContent !== (fr.expanded ? '▾' : '▸')) return false
  }
  return true
}

async function runBench(store: GridStore, ensureLoaded: () => Promise<void>): Promise<void> {
  const w = window as unknown as Record<string, unknown>
  await ensureLoaded()
  const fb = await waitFor<FullBody>(() => {
    if (!(w.__fullbody as FullBody | undefined)?.ready) return null
    return w.__fullbody as FullBody
  })
  const viewport = await waitFor<HTMLElement>(
    () => w.__viewport as HTMLElement | undefined ?? null,
  )
  const maxScroll = () => viewport.scrollHeight - viewport.clientHeight

  // —— 挂载计时（stats 已在挂载过程记录；滚动前先取走）——
  const st = fb.stats
  const sortedChunks = [...st.chunkMs].sort((a, b) => a - b)
  const t0 = performance.now()
  void fb.bodyEl.offsetHeight // 强制 layout：全量行都在 DOM 时的 layout 总成本观测
  const reflowMs = performance.now() - t0
  const mount: MountTiming = {
    rows: fb.activeCount,
    chunkSize: Math.round(st.chunkMs.length > 1 ? fb.activeCount / st.chunkMs.length : fb.activeCount),
    chunks: st.chunkMs.length,
    firstChunkMs: +st.firstChunkMs.toFixed(1),
    fullMs: +st.fullMs.toFixed(1),
    workMs: +st.chunkMs.reduce((a, b) => a + b, 0).toFixed(1),
    chunkP50Ms: +quantile(sortedChunks, 0.5).toFixed(2),
    chunkP95Ms: +quantile(sortedChunks, 0.95).toFixed(2),
    chunkMaxMs: +(sortedChunks[sortedChunks.length - 1] ?? 0).toFixed(2),
    reflowMs: +reflowMs.toFixed(1),
  }

  viewport.scrollTop = 0
  await frames(3)

  // —— 滚动卫生：滚动期零行工作（全量档核心主张）——
  const cont = await runScroll('wheel-like +400px/f', fb, viewport, 400, 120)
  viewport.scrollTop = 0
  await frames(3)
  const jump = await runScroll('drag-like +17500px/f', fb, viewport, 17_500, 60)

  // —— 功能自检 ——（回到中部）
  viewport.scrollTop = maxScroll() / 2
  await sleep(250)
  await frames(3)
  const checks: Record<string, boolean> = {}
  checks.visibleText = checkVisible(store, fb, viewport)

  // 展开/收起：锚点行不变 + 内容正确（store 补偿 + FullBody reconcile）
  // mock 每 ~1000 行才有一个父节点：小行数变体（rows=1000）可能全表无树 → n/a 不计 pass
  const rows = store.flatRows.peek()
  const stp = store.scrollTop.peek()
  const firstIdx = Math.floor(stp / ROW_HEIGHT)
  const anchorId = rows[firstIdx]?.id
  const parentIdx = rows.findIndex((fr, i) => i >= firstIdx && fr.hasChildren)
  let treeChecked = true
  if (parentIdx >= 0) {
    store.toggleExpand(rows[parentIdx].id)
    await sleep(250)
    await frames(3)
    const rows2 = store.flatRows.peek()
    const newAnchor = rows2[Math.floor(store.scrollTop.peek() / ROW_HEIGHT)]?.id
    checks.expandAnchor = newAnchor === anchorId
    checks.expandVisible = checkVisible(store, fb, viewport)
    store.toggleExpand(rows[parentIdx].id) // 还原
    await sleep(250)
    await frames(3)
    checks.collapseRestore = checkVisible(store, fb, viewport)
  } else {
    treeChecked = false // 数据无父节点（rows=1000 变体）——树形检查 n/a
  }

  // 编辑路径：execute → 恰好 +1 计数且文本更新；undo → 还原且 +1（验收 3 语义；
  // 5000×20 = 10 万常驻 effect 全部重跑一次的实测成本就这里是主要风险观测点）
  const rows3 = store.flatRows.peek()
  const target = rows3[Math.floor(rows3.length / 2)]
  const colId = store.columns[3].id
  const prevVal = store.readCell(target.id, colId)
  w.__cellRenders = 0
  const e0 = performance.now()
  store.commands.execute([{ type: 'setCell', rowId: target.id, colId, prev: prevVal, value: 'BENCH-EDIT' }])
  const executeMs = performance.now() - e0
  await nextFrame()
  const textUpdateMs = performance.now() - e0
  const editCount = (w.__cellRenders as number) ?? 0
  const slot = fb.getSlot(target.id)
  checks.editCount = editCount === 1
  checks.editText = slot?.cellEls[3].textContent === 'BENCH-EDIT'
  store.commands.undo()
  await frames(2)
  const undoCount = ((w.__cellRenders as number) ?? 0) - editCount
  checks.undoText = slot?.cellEls[3].textContent === String(prevVal)
  checks.undoCount = undoCount === 1
  const edit: EditTiming = { executeMs: +executeMs.toFixed(1), textUpdateMs: +textUpdateMs.toFixed(1) }

  // 卫生：订阅数 = 挂载行×20 且滚动重压后严格不变；DOM 节点数记录
  const subsBefore = store.dataVersionSubs()
  await runScroll('hygiene', fb, viewport, 800, 90)
  const subsAfter = store.dataVersionSubs()
  const subsExpected = fb.activeCount * store.columns.length
  checks.subsStable = subsBefore === subsAfter
  checks.subsMatchActive = subsAfter === subsExpected
  checks.mountsStable = fb.stats.mounts === 0

  const result: BenchResult = {
    mount,
    scroll: [cont, jump],
    edit,
    treeChecked,
    checks,
    subs: subsAfter,
    subsExpected,
    mountedRows: fb.activeCount,
    domNodes: document.getElementsByTagName('*').length,
    pass: Object.values(checks).every(Boolean),
  }
  const json = JSON.stringify(result, null, 2)
  const pre = document.createElement('pre')
  pre.id = 'bench-result'
  pre.textContent = json
  document.body.appendChild(pre)
  document.title = 'BENCH:' + (result.pass ? 'PASS' : 'FAIL')
  console.log('[bench]', json)
}

export { runBench }
