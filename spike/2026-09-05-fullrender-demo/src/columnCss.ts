/**
 * 列样式静态化：列宽 / pinned sticky 偏移生成为 per-column class，一次性注入。
 * 滚动时新挂载的 cell 零内联样式写入（profile 证据：setStyle+patchStyle 占比过高，
 * 每帧数百次 style.setProperty 触发的样式失效是 (program) 60% 的主因）。
 */
import type { GridStore } from './core/store'

const injected = new WeakSet<GridStore>()

export function ensureColumnStyles(store: GridStore): void {
  if (injected.has(store)) return
  injected.add(store)
  const rules: string[] = []
  for (const c of store.columns) {
    const m = store.colById.get(c.id)!
    rules.push(`.gcol-${c.id}{width:${c.width}px;}`)
    if (c.pinned) {
      // 只管定位；z-index 留给 SFC 的 .cell.pinned/.hcell.pinned（避免优先级之争）
      rules.push(`.gcol-${c.id}.pinned{position:sticky;left:${m.pinLeft}px;}`)
    }
  }
  rules.push(`.gridrow{width:${store.totalWidth}px;}`)
  const style = document.createElement('style')
  style.setAttribute('data-grid-cols', '')
  style.textContent = rules.join('\n')
  document.head.appendChild(style)
}
