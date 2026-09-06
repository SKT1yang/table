<script setup lang="ts">
/**
 * 渲染器层（全量渲染档；spike 假设 #1/#2/#6 的载体）：
 * - 单滚动容器 + spacer（.body 总高）；行 = FullBody 一次性分块挂载（signal effect
 *   直改 DOM，top = 扁平绝对索引 × 行高）——滚动 = 浏览器原生合成器滚静态层，
 *   JS 零行工作、无骨架、无未挂载区（任意速度结构性无白屏 = 本 spike 验证对象）
 * - 表头 sticky top / 前两列 sticky left —— 零 JS 同步逻辑（与 grid-demo 同 z 表）
 * - cell = 常驻 effect + 列样式静态 class（零内联样式）；事件 = viewport 级委托 +
 *   几何命中检测（复用 grid-demo 资产）
 * - focus-ring / editor 挂 Grid 层独立「选区层」（focus 变化零波及 cell）
 * - content-visibility（?cv=0 关，默认开）：屏外行跳过 layout/paint，DOM 保留
 *   （Ctrl+F / a11y / 打印不破）；overflow-anchor: none —— 展开锚点补偿由 store
 *   显式做，关掉浏览器原生 scroll anchoring 防双重补偿
 *
 * z-index 层级表：focus-ring 1(over:3) < pinned cell 2 < header 3 < pinned header 5 < editor 6
 */
import { ref, onMounted, onBeforeUnmount, onScopeDispose } from 'vue'
import { effect } from './core/signal'
import { ROW_HEIGHT, HEADER_HEIGHT, type GridStore } from './core/store'
import { FullBody } from './core/fullbody'
import { useSignal } from './adapter'
import { ensureColumnStyles } from './columnCss'
import CellEditor from './CellEditor.vue'

const props = defineProps<{ store: GridStore }>()
const s = props.store
ensureColumnStyles(s)

const viewportEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
// content-visibility 默认开（?cv=0 关闭做对照）
const cv = new URLSearchParams(location.search).get('cv') !== '0'
// 分块首屏：每帧挂载行数（?chunk=0 = 同步全量对照档；默认 200）
const chunkSize = (() => {
  const raw = new URLSearchParams(location.search).get('chunk')
  if (raw == null) return 200
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 0 ? n : 200
})()

// —— Vue 消费原语：shallowRef + signal effect（adapter 层的 spike 形态）——
// 行不在 Vue 里（FullBody 命令式挂载）；这里只剩选区层
const focusRect = useSignal(s.focusRect)
const editingRect = useSignal(s.editingRect)
const editingInitial = useSignal(s.editingInitial)

// —— DOM scroll → store（passive；唯一工作 = scrollTop.set：首行指示 + 展开锚点
//    补偿读取。无行级工作 —— 与 grid-demo 对照，这就是「删掉的机器」）——
function onScroll() {
  const el = viewportEl.value
  if (!el) return
  s.scrollTop.set(el.scrollTop)
}

// —— store scrollTop → DOM（键盘导航 / 展开补偿的反向同步；同值 no-op 无环路）——
const stopSync = effect(() => {
  const st = s.scrollTop()
  const el = viewportEl.value
  if (el && Math.abs(el.scrollTop - st) > 0.5) el.scrollTop = st
})
onScopeDispose(stopSync)

let ro: ResizeObserver | null = null
let fullbody: FullBody | null = null
onMounted(() => {
  const el = viewportEl.value!
  s.viewportSize.set({ width: el.clientWidth, height: el.clientHeight })
  ro = new ResizeObserver((entries) => {
    const r = entries[0].contentRect
    s.viewportSize.set({ width: r.width, height: r.height })
  })
  ro.observe(el)
  el.focus({ preventScroll: true })
  fullbody = new FullBody(s, bodyEl.value!, chunkSize)
  const w = window as unknown as Record<string, unknown>
  w.__fullbody = fullbody // debug/bench 入口（沿用 __store 先例）
  w.__viewport = el
})
onScopeDispose(() => fullbody?.dispose())
onBeforeUnmount(() => ro?.disconnect())

// —— 事件委托 + 几何命中检测（列前缀宽度 / 行高定档，O(列数)）——
function hitTest(e: MouseEvent): { rowId: string; colId: string } | null {
  const el = viewportEl.value
  if (!el) return null
  const r = el.getBoundingClientRect()
  const contentX = e.clientX - r.left + el.scrollLeft
  const contentY = e.clientY - r.top + el.scrollTop
  const rowIdx = Math.floor((contentY - HEADER_HEIGHT) / ROW_HEIGHT)
  const rows = s.flatRows.peek()
  if (rowIdx < 0 || rowIdx >= rows.length || contentY < HEADER_HEIGHT) return null
  let acc = 0
  for (let ci = 0; ci < s.columns.length; ci++) {
    acc += s.columns[ci].width
    if (contentX < acc) return { rowId: rows[rowIdx].id, colId: s.columns[ci].id }
  }
  return null
}

function onClick(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.expander')) {
    const hit = hitTest(e)
    if (hit) s.toggleExpand(hit.rowId)
    return
  }
  const hit = hitTest(e)
  if (hit) s.focusCell.set(hit)
}

function onDblClick(e: MouseEvent) {
  const hit = hitTest(e)
  if (hit) s.beginEdit(hit)
}

// —— 键盘路由（验收 6）——
function onKeydown(e: KeyboardEvent) {
  const meta = e.ctrlKey || e.metaKey
  if (meta && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    if (e.shiftKey) s.commands.redo()
    else s.commands.undo()
    return
  }
  if (meta && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault()
    s.commands.redo()
    return
  }
  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault()
      s.moveFocus(-1, 0)
      s.scrollFocusIntoView()
      break
    case 'ArrowDown':
      e.preventDefault()
      s.moveFocus(1, 0)
      s.scrollFocusIntoView()
      break
    case 'ArrowLeft':
      e.preventDefault()
      s.moveFocus(0, -1)
      s.scrollFocusIntoView()
      break
    case 'ArrowRight':
      e.preventDefault()
      s.moveFocus(0, 1)
      s.scrollFocusIntoView()
      break
    case 'Tab':
      e.preventDefault()
      s.moveFocus(0, e.shiftKey ? -1 : 1)
      s.scrollFocusIntoView()
      break
    case 'Home':
      e.preventDefault()
      s.focusEdge(meta ? 'home' : 'rowHome')
      s.scrollFocusIntoView()
      break
    case 'End':
      e.preventDefault()
      s.focusEdge(meta ? 'end' : 'rowEnd')
      s.scrollFocusIntoView()
      break
    case 'Enter':
    case 'F2':
      e.preventDefault()
      s.beginEdit()
      break
    case 'Escape':
      s.cancelEdit()
      break
  }
}

// 行/格的静态 class 预算在 FullBody 内（core/fullbody.ts）；模板不渲染行
</script>

<template>
  <div
    ref="viewportEl"
    class="viewport"
    tabindex="0"
    role="grid"
    @scroll.passive="onScroll"
    @keydown="onKeydown"
    @mousedown="viewportEl?.focus({ preventScroll: true })"
    @click="onClick"
    @dblclick="onDblClick"
  >
    <div class="content" :style="{ width: s.totalWidth + 'px' }">
      <!-- 表头静态（列不变）：v-memo 空依赖 → 只渲染一次 -->
      <div v-memo="[]" class="header" role="row">
        <div
          v-for="col in s.columns"
          :key="col.id"
          class="hcell"
          :class="['gcol-' + col.id, { pinned: col.pinned }]"
          role="columnheader"
        >
          {{ col.title }}
        </div>
      </div>
      <!-- 全量挂载容器（FullBody 命令式管理；总高数据就绪即写入 → 分块挂载期间
           滚动条恒定）。cv 类开启屏外行 content-visibility（跳过 layout/paint）；
           滚动热路径 Vue 零重渲染 —— Grid 模板响应只剩选区层 -->
      <div ref="bodyEl" class="body" :class="{ cv }"></div>
      <!-- 独立选区层：focus 高亮环（单元素，focus 变化不波及 cell） -->
      <div
        v-if="focusRect"
        class="focus-ring"
        :class="{ over: focusRect.pinned }"
        :style="{
          top: focusRect.top + 'px',
          left: focusRect.left + 'px',
          width: focusRect.width + 'px',
          height: ROW_HEIGHT + 'px',
        }"
      ></div>
      <CellEditor v-if="editingRect" :store="s" :rect="editingRect" :initial="editingInitial" />
    </div>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  height: 100%;
  overflow: auto;
  outline: none;
  background: #fafafa;
  /* 展开锚点补偿由 store 显式做；关掉原生 scroll anchoring 防双重补偿 */
  overflow-anchor: none;
}
.content {
  position: relative;
}
.header {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  background: #eef0f3;
  border-bottom: 1px solid #d7d9de;
}
.hcell {
  flex: none;
  display: flex;
  align-items: center;
  height: 36px; /* = HEADER_HEIGHT，静态化免内联样式 */
  padding: 0 8px;
  box-sizing: border-box;
  font-weight: 600;
  font-size: 12px;
  color: #333;
  border-right: 1px solid #e0e2e6;
  white-space: nowrap;
  overflow: hidden;
}
.hcell.pinned {
  z-index: 5;
  background: #e8eaef;
}
.focus-ring {
  position: absolute;
  z-index: 1;
  border: 2px solid #1668dc;
  box-sizing: border-box;
  pointer-events: none;
}
/* focus 在 pinned 列时环要在 pinned cell(z2) 之上、表头之下 */
.focus-ring.over {
  z-index: 3;
}
</style>

<!-- 行/格规则必须非 scoped：FullBody 命令式创建的 DOM 拿不到 data-v- 作用域属性
     （.gridrow 宽度类见 columnCss.ts 注入表，同理） -->
<style>
.body {
  position: relative; /* 行绝对定位的包含块；不设 z-index（保 z 表：pinned cell 2 < header 3） */
}
/* 全量档的工程化核心：屏外行跳过 layout/paint（DOM 保留 → Ctrl+F/a11y/打印不破）。
   行绝对定位 + 显式 top/height → c-v 只影响子内容渲染，不影响定位；
   contain-intrinsic-size 与 ROW_HEIGHT 一致，防滚动条抖动 */
.body.cv .row {
  content-visibility: auto;
  contain-intrinsic-size: auto 35px;
}
.row {
  position: absolute; /* 不用 transform：sticky 在 transform 祖先下错位 */
  left: 0;
  display: flex;
}
.cell {
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 8px;
  box-sizing: border-box;
  height: 35px;
  border-right: 1px solid #eee;
  border-bottom: 1px solid #eee;
  background: #fff;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  cursor: default;
  contain: layout style;
}
/* sticky 实色背景：否则横向滚动时内容透出（left/width 见 gcol-* 静态类） */
.cell.pinned {
  z-index: 2;
  background: #f4f5f7;
  border-right: 1px solid #e3e4e8;
}
/* 树形缩进档位（深度 0/1/2） */
.treecell.d1 {
  padding-left: 24px;
}
.treecell.d2 {
  padding-left: 40px;
}
.val {
  overflow: hidden;
  text-overflow: ellipsis;
}
.expander {
  flex: none;
  width: 18px;
  height: 18px;
  margin-right: 4px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  color: #555;
  font-size: 11px;
  line-height: 1;
}
.expander:hover {
  color: #1668dc;
}
</style>
