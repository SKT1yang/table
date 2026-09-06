/**
 * canvas 渲染的几何纯函数层（可单测，零 DOM 依赖）：
 * DOM 渲染器把命中检测交给浏览器；canvas 渲染器必须自己算 —— 这正是
 * 方向文档里 canvas 代价清单（自绘排版/命中检测）的最小化载体。
 */
import type { Column } from './core/store'

export interface ColMeta {
  col: Column
  /** content 坐标系左缘（含 pinned 列；pinned 必为前缀列） */
  absLeft: number
  /** pinned 列在 viewport 的固定左缘（非 pinned 为 0） */
  pinLeft: number
  pinned: boolean
}

/** 树形缩进/开关常量（绘制与命中检测共享同一份真源） */
export const PAD_X = 8
export const INDENT_PX = 16
export const TOGGLE_W = 18

/**
 * 可见 body 列窗口 [start, end)（数组下标）。
 * 与 DOM 路线「列虚拟化后置」不同，canvas 只画相交列 —— 列虚拟化在此近乎免费。
 * pinned 列不进窗口（整 pass 单独绘制）；N 列线性扫描（20~200 列量级足够）。
 */
export function colRange(
  cols: readonly ColMeta[],
  scrollLeft: number,
  viewportW: number,
  pinnedW: number,
): [number, number] {
  let start = -1
  let end = -1
  for (let i = 0; i < cols.length; i++) {
    const m = cols[i]
    if (m.pinned) continue
    if (m.absLeft + m.col.width <= scrollLeft + pinnedW) continue // 防御：藏在 pinned 之下
    if (m.absLeft >= scrollLeft + viewportW) break // absLeft 有序，其后全不可见
    if (start < 0) start = i
    end = i + 1
  }
  return start < 0 ? [0, 0] : [start, end]
}

/** 可见行窗口 [start, end)：上下各带 1 行过绘，覆盖首行被表头遮住的跨界情形 */
export function rowRange(
  total: number,
  scrollTop: number,
  viewportH: number,
  rowH: number,
  headerH: number,
): [number, number] {
  if (total <= 0 || viewportH <= 0) return [0, 0]
  const start = Math.max(0, Math.floor((scrollTop - headerH) / rowH))
  const end = Math.min(total, Math.ceil((scrollTop + viewportH - headerH) / rowH) + 1)
  return [start, Math.max(start, end)]
}

export interface HitResult {
  rowIdx: number
  colIdx: number
  /** 命中树形展开开关（仅首列父行） */
  toggle: boolean
}

/**
 * 几何命中检测：viewport 坐标 (x, y) → 行列下标。
 * pinned 区（x < pinnedW）按 viewport 坐标扫 pinned 列；body 区才做
 * content 坐标换算（+scrollLeft）——横向滚动后 pinned 区点击若也走 content
 * 换算会误命中藏在下方的 body 列（CDP 冒烟抓到的真 bug，单测锁定）。
 */
export function hitTest(
  x: number,
  y: number,
  cols: readonly ColMeta[],
  rows: readonly { hasChildren: boolean; depth: number }[],
  scrollLeft: number,
  scrollTop: number,
  headerH: number,
  rowH: number,
  pinnedW: number,
): HitResult | null {
  const cy = y + scrollTop
  if (cy < headerH) return null // 表头区（本 demo 不响应点击）
  const rowIdx = Math.floor((cy - headerH) / rowH)
  if (rowIdx < 0 || rowIdx >= rows.length) return null
  let colIdx = -1
  if (x < pinnedW) {
    for (let i = 0; i < cols.length; i++) {
      const m = cols[i]
      if (!m.pinned) break
      if (x >= m.pinLeft && x < m.pinLeft + m.col.width) {
        colIdx = i
        break
      }
    }
  } else {
    const cx = x + scrollLeft
    for (let i = 0; i < cols.length; i++) {
      const m = cols[i]
      if (m.pinned) continue
      if (cx >= m.absLeft && cx < m.absLeft + m.col.width) {
        colIdx = i
        break
      }
    }
  }
  if (colIdx < 0) return null // 总宽之外
  let toggle = false
  const fr = rows[rowIdx]
  if (colIdx === 0 && fr.hasChildren) {
    const c0 = cols[0]
    const cellLeft = c0.pinned ? c0.pinLeft : c0.absLeft - scrollLeft
    const tx = cellLeft + PAD_X + fr.depth * INDENT_PX
    toggle = x >= tx - 2 && x <= tx + TOGGLE_W + 2
  }
  return { rowIdx, colIdx, toggle }
}

/**
 * 焦点列横向滚入视口（scrollTargetForIndex 的横向对应物，'nearest' 语义）：
 * 已可见 → null；右缘露出 → 右对齐；左缘被 pinned 遮住 → 左对齐到 pinned 右缘。
 */
export function ensureColVisible(
  m: ColMeta,
  scrollLeft: number,
  viewportW: number,
  pinnedW: number,
): number | null {
  if (m.pinned) return null
  const left = m.absLeft
  const right = left + m.col.width
  const viewL = scrollLeft + pinnedW
  const viewR = scrollLeft + viewportW
  if (right <= viewR && left >= viewL) return null
  const target = right > viewR ? right - viewportW : left - pinnedW
  return Math.max(0, target)
}

/** 文本省略（measureText 注入，纯函数可测）。极窄列返回省略号本身，由 clip 兜底 */
export function fitText(text: string, maxW: number, measure: (s: string) => number): string {
  if (maxW <= 0) return ''
  if (measure(text) <= maxW) return text
  const ell = '…'
  for (let n = text.length - 1; n > 0; n--) {
    const t = text.slice(0, n) + ell
    if (measure(t) <= maxW) return t
  }
  return ell
}
