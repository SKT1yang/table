/**
 * 定高档行虚拟化（spike 假设 #1 的载体）。
 * 三件套：viewport（定高滚动容器）→ spacer（content 总高撑出滚动条）→ slice（padTop + 正常文档流）。
 * 不用 transform 定位 slice：sticky 在 transform 祖先下会错位（调研 §7.2）。
 */

export interface VirtualRange {
  startIndex: number
  /** exclusive */
  endIndex: number
  /** slice 上方填充高度 = startIndex * rowHeight */
  padTop: number
  /** 撑滚动条用总高 = totalRows * rowHeight */
  totalHeight: number
}

export function computeRange(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  /** 视口上方缓冲行数 */
  tail: number,
  /** 视口下方缓冲行数 */
  lead: number,
): VirtualRange {
  const first = Math.floor(scrollTop / rowHeight)
  const start = Math.max(0, first - tail)
  const visible = viewportHeight > 0 ? Math.ceil(viewportHeight / rowHeight) + 1 : 0
  const end = Math.min(total, first + visible + lead)
  return {
    startIndex: start,
    endIndex: Math.max(start, end),
    padTop: start * rowHeight,
    totalHeight: total * rowHeight,
  }
}

/**
 * 键盘导航 × 虚拟化（spike 假设 #6）：目标行的目标 scrollTop。
 * 'nearest' 对齐：上方露出 → 顶对齐；下方露出 → 底对齐；已可见 → null（不滚动）。
 */
export function scrollTargetForIndex(
  index: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  scrollTop: number,
): number | null {
  const maxScroll = Math.max(0, total * rowHeight - viewportHeight)
  const top = index * rowHeight
  const bottom = top + rowHeight
  if (top >= scrollTop && bottom <= scrollTop + viewportHeight) return null
  const target = top < scrollTop ? top : bottom - viewportHeight
  return Math.min(maxScroll, Math.max(0, target))
}
