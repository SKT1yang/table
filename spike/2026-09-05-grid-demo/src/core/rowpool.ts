/**
 * 行回收池 —— RESULTS.md 结构边界（mount ~0.45ms/行 vs 快拖需求 0.16ms/行）的 DOM 路线答案。
 *
 * 思路（AG Grid 模式）：
 * - 固定容量行元素池；行绝对定位 top = 扁平绝对索引 × ROW_HEIGHT —— 行的索引是数据
 *   的属性（只有展开/收起/换数据会变）→ 纯滚动时保持行零 DOM 写入，只有进入窗口的行
 *   复用离开行释放的 slot 做 rebind。
 * - rebind 不销毁 signal effect：每 slot 一个 rowIdAtom，20 个常驻 cell effect 读它 +
 *   readCell（依赖 dataVersion，编辑路径不变）。rebind = 1 次 style + 1 次 atom write →
 *   20 个 effect 各写一次 textContent —— 把 mount 成本（建 21 元素 + 20 effect）摊成 ~0.1ms/行。
 * - 差分算法 planReassign 是纯函数（无 DOM，node 单测锁定「滚动零样式写入契约」）。
 *
 * 已知坑（预判/踩过）：
 * - flatten() 展开后全量重建 FlatRow 对象 → 引用比较无效，必须比 depth/hasChildren/expanded
 * - assign 只 set rowIdAtom 绝不 read（自订阅 → 整池重跑）
 * - 空闲 slot 三件套缺一不可：display:none + rowIdAtom.set(null)（退订 dataVersion）+ 复用时 display:''
 * - 树列文本目标是 .val span（textContent 直接写 cell div 会毁掉 expander 按钮）
 * - top 用绝对索引而非窗口相对偏移（相对偏移 = 每帧全量 setStyle，撞 profile 里 setStyle 的墙）
 */
import { atom, effect, type Atom } from './signal'
import { ROW_HEIGHT, type FlatRow, type GridStore } from './store'

// —— 纯差分规划器（无 DOM；tests/rowpool.test.ts 锁定契约）——

/** slot 上次绑定的行快照 */
export interface SlotState {
  rowId: string
  /** 扁平绝对索引（top = index × ROW_HEIGHT 的依据） */
  index: number
  depth: number
  hasChildren: boolean
  expanded: boolean
}

export interface KeepAction {
  /** prev 数组中的下标（调用方负责映射回 slot） */
  slot: number
  index: number
  fr: FlatRow
  /** 索引变了 → 需重写 top（仅展开/收起/换数据；纯滚动恒 false） */
  topMoved: boolean
  /** depth/hasChildren/expanded 任一变化 → 需更新树形视觉 */
  visual: boolean
}

export interface ReassignPlan {
  keeps: KeepAction[]
  /** 离开窗口的 slot（prev 下标）→ 归还空闲池 */
  frees: number[]
  /** 进入窗口的行 → 从空闲池取 slot 或增长 */
  enters: { index: number; fr: FlatRow }[]
}

/**
 * O(prev + next)，单遍扫描；prev/next 均为窗口内的连续行。
 * start = next[0] 的扁平绝对索引（top 与 topMoved 都以绝对索引为基准 ——
 * 行的绝对索引是数据的属性，纯滚动时保持行索引天然不变）。
 */
export function planReassign(prev: readonly SlotState[], next: readonly FlatRow[], start = 0): ReassignPlan {
  const byId = new Map<string, number>()
  for (let i = 0; i < prev.length; i++) byId.set(prev[i].rowId, i)
  const hit = new Set<number>()
  const keeps: KeepAction[] = []
  const enters: { index: number; fr: FlatRow }[] = []
  for (let i = 0; i < next.length; i++) {
    const fr = next[i]
    const abs = start + i
    const si = byId.get(fr.id)
    if (si === undefined) {
      enters.push({ index: abs, fr })
      continue
    }
    hit.add(si)
    const p = prev[si]
    keeps.push({
      slot: si,
      index: abs,
      fr,
      topMoved: abs !== p.index,
      // 引用比较无效：flatten 每次重建全部对象（store.ts:41-52）
      visual: fr.depth !== p.depth || fr.hasChildren !== p.hasChildren || fr.expanded !== p.expanded,
    })
  }
  const frees: number[] = []
  for (let i = 0; i < prev.length; i++) if (!hit.has(i)) frees.push(i)
  return { keeps, frees, enters }
}

// —— DOM 半边 ——

export interface RowPoolStats {
  assignMs: number
  assigns: number
  rebinds: number
  mounts: number
  /** 单次 assign 耗时样本（p95 用；上限截断防长会话膨胀） */
  samples: number[]
}

interface Slot {
  el: HTMLElement
  /** [0] = 树列 .val span（文本目标），其余 = cell div */
  cellEls: HTMLElement[]
  treeCell: HTMLElement
  expander: HTMLButtonElement
  rowIdAtom: Atom<string | null>
  state: SlotState | null // null = 空闲
}

const UNSET = Symbol('unset')

export class RowPool {
  readonly stats: RowPoolStats = { assignMs: 0, assigns: 0, rebinds: 0, mounts: 0, samples: [] }
  readonly slots: Slot[] = []
  private readonly freeList: Slot[] = []
  private readonly stops: (() => void)[] = []
  private readonly colCellClass: string[]
  private readonly treeCellClass: string
  private readonly colIds: string[]
  private lastTotal = -1
  private disposed = false

  constructor(
    private readonly store: GridStore,
    /** 挂载容器（bench/自检需要读它的实际位置做 rect 对比） */
    readonly bodyEl: HTMLElement,
  ) {
    const cols = store.columns
    this.colIds = cols.map((c) => c.id)
    this.colCellClass = cols.map((c, ci) =>
      ci === 0 ? '' : ['cell', 'gcol-' + c.id, c.pinned ? 'pinned' : ''].filter(Boolean).join(' '),
    )
    this.treeCellClass = 'cell pinned treecell gcol-' + (cols[0]?.id ?? '') + ' d'
    // 池的唯一窗口订阅：range（窗口起点/总高）+ slice（窗口行）—— Vue 不再出现在滚动热路径
    this.stops.push(
      effect(() => this.assign(store.range(), store.slice())),
    )
  }

  resetStats(): void {
    this.stats.assignMs = 0
    this.stats.assigns = 0
    this.stats.rebinds = 0
    this.stats.mounts = 0
    this.stats.samples.length = 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stops) stop()
    this.stops.length = 0
    this.slots.length = 0
    this.freeList.length = 0
  }

  /** 当前绑定中的 slot 数（dataVersion 订阅数应 ≈ 该值 × 列数） */
  get activeCount(): number {
    let n = 0
    for (const s of this.slots) if (s.state) n++
    return n
  }

  // —— 窗口差分应用 ——

  private assign(range: { startIndex: number; totalHeight: number }, rows: readonly FlatRow[]): void {
    if (this.disposed) return
    if (range.totalHeight !== this.lastTotal) {
      this.bodyEl.style.height = range.totalHeight + 'px'
      this.lastTotal = range.totalHeight
    }
    // 预热（不计时）：窗口非空时把池补到最大窗口容量，fling 中途零分配。
    // 容量 = store.poolCapacityHint（可见行 + max(连续档缓冲上限, 跳转 lead) + 余量）
    if (rows.length) {
      const target = this.store.poolCapacityHint
      while (this.slots.length < target) this.buildRow()
    }
    const t0 = performance.now()
    // prev = 绑定中 slot 的快照（规划器只认 SlotState；slot 下标映射留在本地）
    const prevIdx: number[] = []
    const prevStates: SlotState[] = []
    for (let i = 0; i < this.slots.length; i++) {
      const st = this.slots[i].state
      if (st) {
        prevIdx.push(i)
        prevStates.push(st)
      }
    }
    const plan = planReassign(prevStates, rows, range.startIndex)
    for (const k of plan.frees) this.freeSlot(this.slots[prevIdx[k]])
    for (const k of plan.keeps) {
      const slot = this.slots[prevIdx[k.slot]]
      if (k.topMoved) slot.el.style.top = k.index * ROW_HEIGHT + 'px'
      if (k.visual) this.applyTreeVisual(slot, k.fr)
      const st = slot.state!
      st.index = k.index
      st.depth = k.fr.depth
      st.hasChildren = k.fr.hasChildren
      st.expanded = k.fr.expanded
    }
    for (const e of plan.enters) this.bindSlot(this.acquire(), e.index, e.fr)
    const dt = performance.now() - t0
    this.stats.assignMs += dt
    this.stats.assigns++
    if (this.stats.samples.length < 2000) this.stats.samples.push(dt)
  }

  private freeSlot(slot: Slot): void {
    slot.el.style.display = 'none'
    slot.rowIdAtom.set(null) // 退订 dataVersion：空闲 cell 不参与编辑重跑
    slot.state = null
    this.freeList.push(slot)
  }

  private bindSlot(slot: Slot, index: number, fr: FlatRow): void {
    slot.el.style.display = ''
    slot.el.style.top = index * ROW_HEIGHT + 'px'
    this.applyTreeVisual(slot, fr)
    slot.state = { rowId: fr.id, index, depth: fr.depth, hasChildren: fr.hasChildren, expanded: fr.expanded }
    slot.rowIdAtom.set(fr.id) // → 20 个常驻 effect 重跑写 textContent
    this.stats.rebinds++
  }

  private applyTreeVisual(slot: Slot, fr: FlatRow): void {
    slot.treeCell.className = this.treeCellClass + Math.min(fr.depth, 2)
    if (fr.hasChildren) {
      slot.expander.style.display = ''
      slot.expander.textContent = fr.expanded ? '▾' : '▸'
      slot.expander.setAttribute('aria-label', fr.expanded ? '收起' : '展开')
    } else {
      slot.expander.style.display = 'none'
    }
  }

  private acquire(): Slot {
    return this.freeList.pop() ?? this.buildRow()
  }

  // —— 行构造（一次 mount，终身复用）——

  private buildRow(): Slot {
    const el = document.createElement('div')
    el.className = 'row gridrow'
    el.setAttribute('role', 'row')
    const cellEls: HTMLElement[] = []
    let treeCell!: HTMLElement
    let expander!: HTMLButtonElement
    for (let ci = 0; ci < this.colCellClass.length; ci++) {
      if (ci === 0) {
        treeCell = document.createElement('div')
        treeCell.className = this.treeCellClass + '0'
        expander = document.createElement('button')
        expander.className = 'expander'
        expander.tabIndex = -1
        expander.style.display = 'none' // bind 前不可见
        treeCell.appendChild(expander)
        const val = document.createElement('span')
        val.className = 'val'
        treeCell.appendChild(val)
        el.appendChild(treeCell)
        cellEls.push(val) // 文本目标 = .val span，不是 cell div
      } else {
        const cell = document.createElement('div')
        cell.className = this.colCellClass[ci]
        el.appendChild(cell)
        cellEls.push(cell)
      }
    }
    el.style.display = 'none' // 新行闲置入池，bind 时才显示
    this.bodyEl.appendChild(el)
    const slot: Slot = { el, cellEls, treeCell, expander, rowIdAtom: atom<string | null>(null), state: null }
    this.slots.push(slot)
    for (let ci = 0; ci < cellEls.length; ci++) this.stops.push(this.bindCell(slot, ci))
    this.stats.mounts++
    this.freeList.push(slot)
    return slot
  }

  /**
   * 常驻 cell effect：绑定 → 读 rowIdAtom + readCell（dataVersion）写 textContent；
   * 空闲 → 只依赖 rowIdAtom（退订 dataVersion，且文本留在 DOM —— display:none 零写入）。
   * 计数语义与 v-cell 时代一致：同行值变化（编辑/undo）才 +1，rebind/首绑不计。
   */
  private bindCell(slot: Slot, ci: number): () => void {
    const store = this.store
    const colId = this.colIds[ci]
    const textTarget = slot.cellEls[ci]
    const rowIdAtom = slot.rowIdAtom
    let last: unknown = UNSET
    let lastRid: unknown = UNSET
    return effect(() => {
      const rid = rowIdAtom()
      if (rid == null) return
      const v = store.readCell(rid, colId)
      if (v === last) {
        lastRid = rid // 槽上已显示该值（含跨行 rebind 巧合相等）→ 零 DOM 写入
        return
      }
      textTarget.textContent = v == null ? '' : String(v)
      if (lastRid === rid) {
        // 验收 3：值更新计数（rebind 不计）
        const w = window as unknown as Record<string, number>
        w.__cellRenders = (w.__cellRenders ?? 0) + 1
      }
      lastRid = rid
      last = v
    })
  }
}
