/**
 * 行索引 → 滚动目标位置的纯数学（渲染档无关：全量渲染所有行都在 DOM，
 * 'nearest' 对齐同样适用；窗口计算 computeRange 随虚拟化机器一并删除）。
 */

/**
 * 键盘导航目标行的目标 scrollTop（spike 假设 #6）。
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
