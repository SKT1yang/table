/**
 * 回收压测 + 功能自检（?bench=1 进入；headless `--dump-dom --virtual-time-budget` 捕获结果）。
 *
 * 方法论对齐 RESULTS.md：
 * - 吞吐数字只认生产构建（dev ~1.7x 慢）；
 * - 程序化 scrollTop 驱动（测的是 assign 的 JS 成本，不模拟合成器输入 —— 真实拖拽
 *   滚动条的 fps/白屏判定仍走 CDP Input 派发 + 事后截图，见 RESULTS.md 验证方法节）；
 * - 功能自检在真浏览器 DOM 上断言回收正确性：可见行文本 vs readCell、展开锚点、
 *   编辑计数（验收 3 语义）、撤销、订阅数恒定（回收 = 零 effect churn 的证明）。
 */
import { ROW_HEIGHT, type GridStore } from './core/store'
import type { RowPool } from './core/rowpool'

interface ScenarioResult {
  name: string
  frames: number
  rebinds: number
  mounts: number
  assignMs: number
  /** rebinds / assignMs —— 对标 mount 时代的 ~0.45ms/行（其倒数） */
  rowsPerMs: number
  p95AssignMs: number
}

interface BenchResult {
  scenarios: ScenarioResult[]
  checks: Record<string, boolean>
  subs: number
  subsExpected: number
  poolSize: number
  mountsDebug: { before: number; after: number }
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

function p95(samples: number[]): number {
  if (!samples.length) return 0
  const a = [...samples].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)]
}

async function waitFor<T>(fn: () => T | null, timeoutMs = 10_000): Promise<T> {
  const t0 = performance.now()
  for (;;) {
    const v = fn()
    if (v != null) return v
    if (performance.now() - t0 > timeoutMs) throw new Error('bench: 等待就绪超时')
    await sleep(25)
  }
}

/** 场景：每帧滚 deltaPx，共 frames 帧（或提前触底） */
async function runScenario(
  name: string,
  pool: RowPool,
  viewport: HTMLElement,
  deltaPx: number,
  frameCount: number,
): Promise<ScenarioResult> {
  pool.resetStats()
  await frames(2) // 速度状态清零（120ms debounce 后）再起测
  let f = 0
  for (; f < frameCount; f++) {
    const before = viewport.scrollTop
    viewport.scrollTop = before + deltaPx
    if (viewport.scrollTop === before && deltaPx !== 0) break // 触底
    await nextFrame()
  }
  await sleep(200) // 尾帧 velocity 清零后的恢复 assign 也计入
  await frames(2)
  const st = pool.stats
  return {
    name,
    frames: f,
    rebinds: st.rebinds,
    mounts: st.mounts,
    assignMs: st.assignMs,
    rowsPerMs: st.assignMs > 0 ? st.rebinds / st.assignMs : 0,
    p95AssignMs: p95(st.samples),
  }
}

// —— 功能自检 ——

function findSlot(pool: RowPool, rowId: string) {
  return pool.slots.find((s) => s.state?.rowId === rowId) ?? null
}

/** 窗口内采样断言：slot 绑定/实际布局位置/文本 与 store 一致（含树列 .val 与普通格） */
function checkVisible(store: GridStore, pool: RowPool, viewport: HTMLElement): boolean {
  const rows = store.flatRows.peek()
  const r = store.range.peek()
  const cols = store.columns
  // 用 rect 而非 style.top 字符串：top ≥ 1e6px 时 CSSOM 序列化为 6 位有效数字的
  // 科学计数法（1.5673e+06px），parseFloat 回读有损；真实布局是精确的
  const vpTop = viewport.getBoundingClientRect().top
  const bodyY = pool.bodyEl.getBoundingClientRect().top - vpTop + viewport.scrollTop
  const n = r.endIndex - r.startIndex
  for (let k = 0; k <= 6; k++) {
    const idx = Math.min(r.endIndex - 1, r.startIndex + Math.floor((n * k) / 6))
    const fr = rows[idx]
    if (!fr) continue
    const slot = findSlot(pool, fr.id)
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
  await ensureLoaded()
  const pool = await waitFor<RowPool>(
    () => (window as unknown as Record<string, unknown>).__rowpool as RowPool | undefined ?? null,
  )
  const viewport = await waitFor<HTMLElement>(
    () => (window as unknown as Record<string, unknown>).__viewport as HTMLElement | undefined ?? null,
  )
  const w = window as unknown as Record<string, unknown>
  const maxScroll = () => viewport.scrollHeight - viewport.clientHeight

  viewport.scrollTop = 0
  await frames(3)

  // —— 吞吐场景 ——（1500px/f ≈ 触控板 fling 峰值档；17500px/f = 快拖滚动条档 → 触发 jump 分流）
  const warm = await runScenario('warmup', pool, viewport, 400, 60)
  const cont = await runScenario('continuous+1500px/f', pool, viewport, 1500, 300)
  viewport.scrollTop = 0
  await frames(3)
  const jump = await runScenario('drag+17500px/f', pool, viewport, 17_500, 120)

  // —— 功能自检 ——（回到中部）
  const mid = maxScroll() / 2
  viewport.scrollTop = mid
  await sleep(250)
  await frames(3)
  const checks: Record<string, boolean> = {}
  checks.visibleText = checkVisible(store, pool, viewport)

  // 展开/收起：锚点行不变 + 内容正确
  const rows = store.flatRows.peek()
  const st = store.scrollTop.peek()
  const firstIdx = Math.floor(st / ROW_HEIGHT)
  const anchorId = rows[firstIdx]?.id
  const parentIdx = rows.findIndex((fr, i) => i >= firstIdx && fr.hasChildren)
  if (parentIdx >= 0) {
    store.toggleExpand(rows[parentIdx].id)
    await sleep(250)
    await frames(3)
    const rows2 = store.flatRows.peek()
    const newAnchor = rows2[Math.floor(store.scrollTop.peek() / ROW_HEIGHT)]?.id
    checks.expandAnchor = newAnchor === anchorId
    checks.expandVisible = checkVisible(store, pool, viewport)
    store.toggleExpand(rows[parentIdx].id) // 还原
    await sleep(250)
    await frames(3)
    checks.collapseRestore = checkVisible(store, pool, viewport)
  } else {
    checks.expandAnchor = checks.expandVisible = checks.collapseRestore = false
  }

  // 编辑路径：execute → 恰好 +1 计数且文本更新；undo → 还原且 +1（验收 3 语义）
  const r2 = store.range.peek()
  const rows3 = store.flatRows.peek()
  const target = rows3[Math.floor((r2.startIndex + r2.endIndex) / 2)]
  const colId = store.columns[3].id
  const prevVal = store.readCell(target.id, colId)
  w.__cellRenders = 0
  store.commands.execute([{ type: 'setCell', rowId: target.id, colId, prev: prevVal, value: 'BENCH-EDIT' }])
  await frames(2)
  const editCount = (w.__cellRenders as number) ?? 0
  const slot = findSlot(pool, target.id)
  checks.editCount = editCount === 1
  checks.editText = slot?.cellEls[3].textContent === 'BENCH-EDIT'
  store.commands.undo()
  await frames(2)
  const undoCount = ((w.__cellRenders as number) ?? 0) - editCount
  checks.undoText = slot?.cellEls[3].textContent === String(prevVal)
  checks.undoCount = undoCount === 1

  // 卫生：订阅数 = 绑定行×20 且滚动重压后不变；池容量预热后不增长（回收 = 零 mount）
  const subsBefore = store.dataVersionSubs()
  const mountsBefore = pool.stats.mounts
  await runScenario('hygiene', pool, viewport, 800, 90)
  const subsAfter = store.dataVersionSubs()
  const subsExpected = pool.activeCount * store.columns.length
  checks.subsStable = subsBefore === subsAfter
  checks.subsMatchActive = subsAfter === subsExpected
  checks.mountsStable = pool.stats.mounts === mountsBefore

  const result: BenchResult = {
    scenarios: [warm, cont, jump],
    checks,
    subs: subsAfter,
    subsExpected,
    poolSize: pool.slots.length,
    mountsDebug: { before: mountsBefore, after: pool.stats.mounts },
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
