/**
 * FullBody —— 全量渲染档的行挂载器（「小而美」档位的渲染器载体）。
 *
 * 与 RowPool（../2026-09-05-grid-demo/src/core/rowpool.ts，已删）对照，删掉的机器：
 * - 无窗口订阅（range/slice）、无速度感知 lead、无跳转检测、无池/freeList/planReassign
 *   —— 滚动 = 浏览器原生合成器滚动，JS 零行工作（stats.assigns 纯滚动恒 0，bench 断言）
 * - 无骨架条纹：不存在「未挂载区」，任何滚动速度结构性无白屏（本 spike 的验证对象）
 *
 * 保留的同构资产（buildRow/bindCell 原样搬移）：
 * - top = 扁平绝对索引 × 行高（不用 transform：sticky 在 transform 祖先下错位）
 * - 每 slot 一个 rowIdAtom + 20 个常驻 cell effect 读 readCell（dataVersion 依赖锚点，
 *   编辑 → 只有值变 cell 写 textContent；__cellRenders 计数契约不变）
 * - 列样式静态 class（columnCss.ts）、树列文本目标 = .val span
 *
 * 全量档新增的两件事：
 * - 分块首屏：首块先挂（默认 200 行/帧，?chunk=0 = 同步全量对照档）；
 *   .body 总高在数据就绪时立即写入 → 分块期间滚动条恒定
 * - 数据变化（展开/收起）＝ rowId 键控 reconcile：索引漂移的行只重写 top（零 effect
 *   churn），新增行挂载、消失行移除 —— planReassign 在「next = 全量列表」下的简化版
 *
 * 已知简化：中途插入的子行 append 到 body 末尾（DOM 序 ≠ 逻辑序，与 RowPool 同款）；
 * content-visibility 由渲染层 CSS 控制（.body.cv），本模块不感知。
 */
import { atom, effect, type Atom } from './signal'
import { ROW_HEIGHT, type FlatRow, type GridStore } from './store'

// —— 纯块计划（无 DOM；tests/fullbody.test.ts 锁定契约）——

/** [from, to) 扁平索引区间 */
export interface Chunk {
  from: number
  to: number
}

/** chunkSize ≤ 0 = 单块全量（同步挂载对照档）；末块截断到 count */
export function planChunks(count: number, chunkSize: number): Chunk[] {
  if (count <= 0) return []
  const size = chunkSize > 0 ? chunkSize : count
  const out: Chunk[] = []
  for (let from = 0; from < count; from += size) out.push({ from, to: Math.min(count, from + size) })
  return out
}

// —— DOM 半边 ——

export interface FullBodyStats {
  /** 挂载行数（一次性；reconcile 新增行也计） */
  mounts: number
  /** reconcile 次数（数据变化；纯滚动恒 0 —— 「滚动零行工作」的观测点） */
  assigns: number
  assignMs: number
  /** 每块挂载净耗时（ms，不含调度间隙；同步档 = 单元素） */
  chunkMs: number[]
  /** 首块挂载完成（相对数据就绪，含调度） */
  firstChunkMs: number
  /** 全量挂载完成（相对数据就绪，含全部调度间隙） */
  fullMs: number
}

export interface FullBodySlot {
  el: HTMLElement
  /** [0] = 树列 .val span（文本目标），其余 = cell div */
  cellEls: HTMLElement[]
  treeCell: HTMLElement
  expander: HTMLButtonElement
}

interface SlotState {
  index: number
  depth: number
  hasChildren: boolean
  expanded: boolean
}

interface Slot extends FullBodySlot {
  rowIdAtom: Atom<string>
  state: SlotState
  stops: (() => void)[]
}

const UNSET = Symbol('unset')

export class FullBody {
  readonly stats: FullBodyStats = {
    mounts: 0,
    assigns: 0,
    assignMs: 0,
    chunkMs: [],
    firstChunkMs: 0,
    fullMs: 0,
  }
  private readonly byId = new Map<string, Slot>()
  private readonly colCellClass: string[]
  private readonly treeCellClass: string
  private readonly colIds: string[]
  private lastTotal = -1
  private disposed = false
  private mounting = false
  private mountRaf = 0
  private dataReadyAt = 0

  constructor(
    private readonly store: GridStore,
    /** 挂载容器（bench/自检读它的实际位置做 rect 对比；总高由此写入撑滚动条） */
    readonly bodyEl: HTMLElement,
    /** 每帧挂载行数；≤0 = 同步全量（对照档） */
    private readonly chunkSize = 200,
  ) {
    const cols = store.columns
    this.colIds = cols.map((c) => c.id)
    this.colCellClass = cols.map((c, ci) =>
      ci === 0 ? '' : ['cell', 'gcol-' + c.id, c.pinned ? 'pinned' : ''].filter(Boolean).join(' '),
    )
    this.treeCellClass = 'cell pinned treecell gcol-' + (cols[0]?.id ?? '') + ' d'
    // 唯一的订阅：flatRows（数据就绪 / 展开收起）—— 滚动不在订阅图里
    effect(() => this.onFlatRows(store.flatRows()))
  }

  resetStats(): void {
    this.stats.mounts = 0
    this.stats.assigns = 0
    this.stats.assignMs = 0
    this.stats.chunkMs.length = 0
    this.stats.firstChunkMs = 0
    this.stats.fullMs = 0
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.mountRaf)
    this.mounting = false
    for (const slot of this.byId.values()) for (const stop of slot.stops) stop()
    this.byId.clear()
  }

  /** 绑定中的行数（dataVersion 订阅数应 = 该值 × 列数） */
  get activeCount(): number {
    return this.byId.size
  }

  /** 全量挂载完成（无数据 = 亦就绪） */
  get ready(): boolean {
    if (this.mounting) return false
    const n = this.store.flatRows.peek().length
    return n === 0 || this.byId.size === n
  }

  getSlot(rowId: string): FullBodySlot | null {
    return this.byId.get(rowId) ?? null
  }

  // —— 数据就绪 / 变化 ——

  private onFlatRows(rows: readonly FlatRow[]): void {
    if (this.disposed) return
    this.dataReadyAt = performance.now()
    const total = rows.length * ROW_HEIGHT
    if (total !== this.lastTotal) {
      // 数据就绪即写总高：分块挂载期间滚动条恒定（滚动条精度与挂载进度解耦）
      this.bodyEl.style.height = total + 'px'
      this.lastTotal = total
    }
    if (this.mounting) {
      // 挂载途中数据变化：取消分块，走 reconcile 同步补齐
      cancelAnimationFrame(this.mountRaf)
      this.mounting = false
    }
    if (this.byId.size === 0) {
      this.initialMount(rows)
      return
    }
    this.reconcile(rows)
  }

  private initialMount(rows: readonly FlatRow[]): void {
    const chunks = planChunks(rows.length, this.chunkSize)
    if (chunks.length <= 1) {
      const t0 = performance.now()
      for (const c of chunks) this.mountRange(rows, c)
      this.stats.chunkMs.push(performance.now() - t0)
      this.stats.firstChunkMs = this.stats.fullMs = performance.now() - this.dataReadyAt
      return
    }
    this.mounting = true
    let ci = 0
    const step = () => {
      if (this.disposed || !this.mounting) return
      const c = chunks[ci++]
      const t0 = performance.now()
      this.mountRange(rows, c)
      this.stats.chunkMs.push(performance.now() - t0)
      if (ci === 1) this.stats.firstChunkMs = performance.now() - this.dataReadyAt
      if (ci >= chunks.length) {
        this.mounting = false
        this.stats.fullMs = performance.now() - this.dataReadyAt
        return
      }
      this.mountRaf = requestAnimationFrame(step)
    }
    this.mountRaf = requestAnimationFrame(step)
  }

  private mountRange(rows: readonly FlatRow[], c: Chunk): void {
    for (let i = c.from; i < c.to; i++) {
      const fr = rows[i]
      if (!this.byId.has(fr.id)) this.buildRow(i, fr)
    }
  }

  /** rowId 键控差分：漂移只重写 top；缺失挂载；消失移除。O(n) 单遍。 */
  private reconcile(rows: readonly FlatRow[]): void {
    const t0 = performance.now()
    const alive = new Set<string>()
    for (const fr of rows) alive.add(fr.id)
    for (const [id, slot] of this.byId) {
      if (!alive.has(id)) {
        for (const stop of slot.stops) stop()
        slot.el.remove()
        this.byId.delete(id)
      }
    }
    for (let i = 0; i < rows.length; i++) this.placeRow(rows[i], i)
    this.stats.assignMs += performance.now() - t0
    this.stats.assigns++
  }

  private placeRow(fr: FlatRow, index: number): void {
    const slot = this.byId.get(fr.id)
    if (!slot) {
      this.buildRow(index, fr)
      return
    }
    const st = slot.state
    if (st.index !== index) {
      slot.el.style.top = index * ROW_HEIGHT + 'px'
      st.index = index
    }
    if (st.depth !== fr.depth || st.hasChildren !== fr.hasChildren || st.expanded !== fr.expanded) {
      this.applyTreeVisual(slot, fr)
      st.depth = fr.depth
      st.hasChildren = fr.hasChildren
      st.expanded = fr.expanded
    }
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

  // —— 行构造（挂载即绑定；DOM 序 = 挂载序 = 逻辑序，中途插入除外）——

  private buildRow(index: number, fr: FlatRow): Slot {
    const el = document.createElement('div')
    el.className = 'row gridrow'
    el.setAttribute('role', 'row')
    el.style.top = index * ROW_HEIGHT + 'px'
    const cellEls: HTMLElement[] = []
    let treeCell!: HTMLElement
    let expander!: HTMLButtonElement
    for (let ci = 0; ci < this.colCellClass.length; ci++) {
      if (ci === 0) {
        treeCell = document.createElement('div')
        treeCell.className = this.treeCellClass + Math.min(fr.depth, 2)
        expander = document.createElement('button')
        expander.className = 'expander'
        expander.tabIndex = -1
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
    this.bodyEl.appendChild(el)
    const rowIdAtom = atom<string>(fr.id)
    const slot: Slot = {
      el,
      cellEls,
      treeCell,
      expander,
      rowIdAtom,
      state: { index, depth: fr.depth, hasChildren: fr.hasChildren, expanded: fr.expanded },
      stops: [],
    }
    this.applyTreeVisual(slot, fr)
    for (let ci = 0; ci < cellEls.length; ci++) {
      slot.stops.push(this.bindCell(rowIdAtom, cellEls[ci], this.colIds[ci]))
    }
    this.byId.set(fr.id, slot)
    this.stats.mounts++
    return slot
  }

  /**
   * 常驻 cell effect：读 rowIdAtom + readCell（dataVersion）写 textContent。
   * 计数语义与 RowPool 时代一致：同行值变化（编辑/undo）才 +1，首绑不计。
   */
  private bindCell(rowIdAtom: Atom<string>, textTarget: HTMLElement, colId: string): () => void {
    const store = this.store
    let last: unknown = UNSET
    let lastRid: unknown = UNSET
    return effect(() => {
      const rid = rowIdAtom()
      const v = store.readCell(rid, colId)
      if (v === last) {
        lastRid = rid
        return
      }
      textTarget.textContent = v == null ? '' : String(v)
      if (lastRid === rid) {
        const w = window as unknown as Record<string, number>
        w.__cellRenders = (w.__cellRenders ?? 0) + 1
      }
      lastRid = rid
      last = v
    })
  }
}
