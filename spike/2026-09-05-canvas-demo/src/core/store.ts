/**
 * grid store：组装 atoms + 数据管线 + 交互动作（纯 TS，零框架依赖 —— 三层架构的 core 层）。
 */
import { atom, computed, batch, type Atom, type Computed } from './signal'
import { computeRange, scrollTargetForIndex, type VirtualRange } from './virtual'
import { createCommandService, type SetCellMutation, type CommandService } from './command'

// —— 类型 ——

export interface RowNode {
  id: string
  children?: RowNode[]
  /** 列字段平铺；编辑 = 浅克隆 data（保持未编辑字段引用不变 → === 停传播） */
  data: Record<string, unknown>
}
export interface FlatRow {
  id: string
  depth: number
  hasChildren: boolean
  expanded: boolean
}
export interface Column {
  id: string
  title: string
  width: number
  /** 固定列必须是前缀列（sticky left 累计偏移的简化） */
  pinned?: boolean
}
export interface CellPos {
  rowId: string
  colId: string
}

export const ROW_HEIGHT = 35
export const HEADER_HEIGHT = 36
/** 静止时双向缓冲行数 */
const OVERSCAN_BASE = 12

// —— 树形 → 可见行扁平化投影（虚拟器唯一真源；递归按树深度，非行数） ——

export function flatten(roots: readonly RowNode[], expanded: ReadonlySet<string>, out: FlatRow[] = []): FlatRow[] {
  const walk = (nodes: readonly RowNode[], depth: number) => {
    for (const n of nodes) {
      const has = !!n.children?.length
      const isOpen = has && expanded.has(n.id)
      out.push({ id: n.id, depth, hasChildren: has, expanded: isOpen })
      if (isOpen) walk(n.children!, depth + 1)
    }
  }
  walk(roots, 0)
  return out
}

export interface Rect {
  top: number
  left: number
  width: number
  pinned: boolean
}

export function createStore(columns: Column[]) {
  // —— 静态布局量（demo 列不变，不进响应式）——
  let x = 0
  let px = 0
  const colMeta = columns.map((c) => {
    const meta = { col: c, absLeft: x, pinLeft: c.pinned ? px : 0, pinned: !!c.pinned }
    x += c.width
    if (c.pinned) px += c.width
    return meta
  })
  const colById = new Map(colMeta.map((m) => [m.col.id, m]))
  const totalWidth = x
  const pinnedWidth = px

  // —— atoms（每特性一个）——
  const rowsAtom = atom<readonly RowNode[]>([])
  const rowIndex = new Map<string, RowNode>() // 全量行（含折叠子树），普通 Map，store 私有
  const dataVersion = atom(0) // 编辑/undo/redo 时 bump —— 所有 cell computed 的依赖锚点
  const expanded = atom<ReadonlySet<string>>(new Set())
  const scrollTop = atom(0)
  /** 滚动方向（1 下 / -1 上 / 0 静止 / 2 跳转）+ 方向前方额外缓冲行数 —— 速度感知 lead buffer */
  const scrollDir = atom(0)
  const leadExtra = atom(0)
  const viewportSize = atom({ width: 0, height: 0 })
  const focusCell = atom<CellPos | null>(null)
  const editingCell = atom<CellPos | null>(null)

  // —— 数据管线（computed 链）——
  const flatRows = computed<readonly FlatRow[]>(() => flatten(rowsAtom(), expanded()))
  const range = computed<VirtualRange>(() => {
    const rows = flatRows()
    const { height } = viewportSize()
    const dir = scrollDir()
    const extra = leadExtra()
    let tail: number, lead: number
    if (dir === 2) {
      // 跳转（拖滚动条 / End 类）：新窗口与旧窗口不相交，任何预挂载都永远不会被
      // 看到 → 只挂可见行（否则每帧全量重挂 + 废 lead，实测个位数 fps）
      tail = 0
      lead = 0
    } else {
      // 连续滚动：方向感知（前方 = 基础 + 速度加成；后方压半）
      tail = dir === 1 ? OVERSCAN_BASE >> 1 : OVERSCAN_BASE + extra
      lead = dir === -1 ? OVERSCAN_BASE >> 1 : OVERSCAN_BASE + extra
    }
    return computeRange(rows.length, scrollTop(), height, ROW_HEIGHT, tail, lead)
  })
  /** 渲染切片（Grid 的 v-for 源） */
  const slice = computed<readonly FlatRow[]>(() => {
    const r = range()
    return flatRows().slice(r.startIndex, r.endIndex)
  })
  /** rowId → flat index（focus/编辑定位用，flatRows 变化时才重建） */
  const rowIndexMap = computed(() => {
    const m = new Map<string, number>()
    const rows = flatRows()
    for (let i = 0; i < rows.length; i++) m.set(rows[i].id, i)
    return m
  })

  function loadRows(rows: readonly RowNode[]): void {
    rowIndex.clear()
    const walk = (ns: readonly RowNode[]) => {
      for (const n of ns) {
        rowIndex.set(n.id, n)
        if (n.children) walk(n.children)
      }
    }
    walk(rows)
    rowsAtom.set(rows)
  }

  /**
   * cell 读取（在 effect/computed 内调用即建立 dataVersion 依赖）。
   * AG Grid cell 级 change detection 的 signal 化：编辑 = 行浅克隆 + version bump →
   * 所有挂载 cell 的 computed 重算（各一次 Map 查找）→ 值 === 不变的停传播 →
   * 只有值真正变化的 cell 触发下游 effect。
   */
  function readCell(rowId: string, colId: string): unknown {
    dataVersion()
    return rowIndex.get(rowId)?.data[colId]
  }

  function applyMutation(m: SetCellMutation): void {
    const row = rowIndex.get(m.rowId)
    if (!row) return
    rowIndex.set(m.rowId, { ...row, data: { ...row.data, [m.colId]: m.value } })
    dataVersion.set(dataVersion.peek() + 1)
  }

  const commands: CommandService = createCommandService(applyMutation)

  /**
   * 滚动速度感知（Grid 在 scroll 事件里喂入每帧滚动像素量；静止后由 Grid 调 clear）。
   * 两种形态分流（实测教训，见 RESULTS.md 性能优化过程）：
   * - 连续滚动（滚轮/触控板）：方向前方预挂 ≈2 帧滚动量（封顶 90 行）→ fling 不白屏
   * - 不连续跳转（拖滚动条/End）：单帧位移 > 整个挂载窗口 → 预挂载永远看不到，
   *   只会让每帧多挂 ~90 行废行 + v-memo 重叠失效 → 全量重挂 → 8fps。跳转模式只挂可见行
   */
  function setScrollVelocity(deltaPx: number): void {
    const vh = viewportSize.peek().height
    const windowRows = (vh > 0 ? Math.ceil(vh / ROW_HEIGHT) + 1 : 0) + OVERSCAN_BASE + leadExtra.peek()
    if (Math.abs(deltaPx) > windowRows * ROW_HEIGHT) {
      scrollDir.set(2)
      leadExtra.set(0)
      return
    }
    scrollDir.set(deltaPx > 0 ? 1 : -1)
    leadExtra.set(Math.min(90, Math.round(Math.abs(deltaPx) / ROW_HEIGHT) * 2))
  }
  function clearScrollVelocity(): void {
    scrollDir.set(0)
    leadExtra.set(0)
  }

  // —— 树形展开/收起 + 滚动锚点补偿（spike 假设 #5）——
  function toggleExpand(rowId: string): void {
    const node = rowIndex.get(rowId)
    if (!node?.children?.length) return
    batch(() => {
      const before = flatRows.peek()
      const st = scrollTop.peek()
      const firstVisible = Math.floor(st / ROW_HEIGHT)
      const anchorId = before[firstVisible]?.id // 锚 = 展开前视口首行
      const prev = expanded.peek()
      const next = new Set(prev)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      expanded.set(next)
      const after = flatRows.peek()
      if (anchorId != null) {
        const newIdx = after.findIndex((r) => r.id === anchorId)
        if (newIdx >= 0) {
          const delta = newIdx - firstVisible
          if (delta !== 0) scrollTop.set(Math.max(0, st + delta * ROW_HEIGHT))
        }
      }
    })
  }

  // —— 焦点导航（spike 假设 #6；容器持焦点 + 高亮环，roving tabindex 后置）——
  function focusIndices(): [number, number] {
    const pos = focusCell.peek()
    const rows = flatRows.peek()
    if (!pos) return [0, 0]
    const r = rowIndexMap.peek().get(pos.rowId) ?? 0
    const c = Math.max(0, columns.findIndex((c) => c.id === pos.colId))
    return [Math.min(r, Math.max(0, rows.length - 1)), c]
  }

  function moveFocus(dr: number, dc: number): void {
    const rows = flatRows.peek()
    if (!rows.length) return
    const [r, c] = focusIndices()
    const nr = Math.min(rows.length - 1, Math.max(0, r + dr))
    const nc = Math.min(columns.length - 1, Math.max(0, c + dc))
    focusCell.set({ rowId: rows[nr].id, colId: columns[nc].id })
  }

  function focusEdge(kind: 'home' | 'end' | 'rowHome' | 'rowEnd'): void {
    const rows = flatRows.peek()
    if (!rows.length) return
    const [r] = focusIndices()
    const rowId = rows[kind === 'home' ? 0 : kind === 'end' ? rows.length - 1 : r].id
    const colId = columns[kind === 'rowHome' || kind === 'home' ? 0 : columns.length - 1].id
    focusCell.set({ rowId, colId })
  }

  /** 目标行不在切片时驱动滚动（两段式第一段；幂等可连按） */
  function scrollFocusIntoView(): void {
    const pos = focusCell.peek()
    if (!pos) return
    const idx = rowIndexMap.peek().get(pos.rowId)
    if (idx == null) return
    const target = scrollTargetForIndex(
      idx,
      viewportSize.peek().height,
      ROW_HEIGHT,
      flatRows.peek().length,
      scrollTop.peek(),
    )
    if (target != null) scrollTop.set(target)
  }

  // —— 编辑（COMMAND 入口）——
  function beginEdit(pos?: CellPos | null): void {
    const p = pos ?? focusCell.peek()
    if (p) editingCell.set(p)
  }
  function cancelEdit(): void {
    editingCell.set(null)
  }
  function commitEdit(value: unknown): void {
    const pos = editingCell.peek()
    if (!pos) return
    editingCell.set(null)
    const prev = readCell(pos.rowId, pos.colId) // 事件处理器内调用，无 activeSub，不建立依赖
    if (value === prev) return
    commands.execute([{ type: 'setCell', rowId: pos.rowId, colId: pos.colId, prev, value }])
  }

  // —— 高亮环 / 编辑器定位（content 坐标系，随滚动天然跟随）——
  function rectFor(pos: CellPos): Rect | null {
    const idx = rowIndexMap.peek().get(pos.rowId)
    const meta = colById.get(pos.colId)
    if (idx == null || !meta) return null
    return {
      top: HEADER_HEIGHT + idx * ROW_HEIGHT,
      left: meta.absLeft,
      width: meta.col.width,
      pinned: meta.pinned,
    }
  }
  const focusRect = computed<Rect | null>(() => {
    const f = focusCell()
    return f ? rectFor(f) : null
  })
  const editingRect = computed<Rect | null>(() => {
    const e = editingCell()
    return e ? rectFor(e) : null
  })
  const editingInitial = computed(() => {
    const e = editingCell()
    if (!e) return ''
    const v = readCell(e.rowId, e.colId)
    return v == null ? '' : String(v)
  })

  return {
    // 常量/静态
    columns,
    colById,
    totalWidth,
    pinnedWidth,
    ROW_HEIGHT,
    HEADER_HEIGHT,
    // atoms / computeds
    scrollTop,
    viewportSize,
    flatRows,
    range,
    slice,
    rowIndexMap,
    focusCell,
    editingCell,
    focusRect,
    editingRect,
    editingInitial,
    // 数据
    get totalRows() {
      return rowIndex.size
    },
    loadRows,
    readCell,
    // 命令
    commands,
    // 交互
    toggleExpand,
    setScrollVelocity,
    clearScrollVelocity,
    moveFocus,
    focusEdge,
    scrollFocusIntoView,
    beginEdit,
    cancelEdit,
    commitEdit,
    // debug（验收 3 / 泄漏自检）
    dataVersionSubs: () => dataVersion._subs,
  }
}

export type GridStore = ReturnType<typeof createStore>
export type { Atom, Computed }
