<script setup lang="ts">
/**
 * 渲染器层（spike 假设 #1/#2/#6 的载体；行回收版）：
 * - 单滚动容器 + spacer（.body 总高）；行 = RowPool 命令式回收池（signal effect 直改 DOM，
 *   top = 扁平绝对索引 × 行高），滚动热路径 Vue 零参与、零重渲染
 * - 表头 sticky top / 前两列 sticky left —— 零 JS 同步逻辑（行回收不改 z 表与 sticky 语义）
 * - cell = 常驻 effect（rebind = rowIdAtom 一次 write）+ 列样式静态 class（零内联样式）
 * - 事件 = viewport 级委托 + 几何命中检测（列前缀宽度线性扫描，canvas 命中检测的 DOM 版）
 * - focus-ring / editor 挂 Grid 层独立「选区层」（focus 变化零波及 cell）
 *
 * z-index 层级表：focus-ring 1(over:3) < pinned cell 2 < header 3 < pinned header 5 < editor 6
 */
import { ref, onMounted, onBeforeUnmount, onScopeDispose } from 'vue'
import { effect } from './core/signal'
import { ROW_HEIGHT, HEADER_HEIGHT, type GridStore } from './core/store'
import { RowPool } from './core/rowpool'
import { useSignal } from './adapter'
import { ensureColumnStyles } from './columnCss'
import CellEditor from './CellEditor.vue'

const props = defineProps<{ store: GridStore }>()
const s = props.store
ensureColumnStyles(s)

const viewportEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
// 空白带骨架（默认开，?skel=0 关闭）：未覆盖区域显示行条纹而非纯白 ——
// 真机拖滚动条时合成器领先段的视觉缓解（行/格有实色背景，覆盖时骨架不可见，零成本）
const skel = new URLSearchParams(location.search).get('skel') !== '0'
// 拖拽限速试验（?dragcap=N 行/事件）：单次位移超过 N 行时把 scrollTop 钳回 ——
// 对抗合成器领先：钳后位移进入连续滚动 lead 可覆盖区间。代价 = 拇指追不上手
const dragCapRows = Math.max(0, Number(new URLSearchParams(location.search).get('dragcap')) || 0)

// —— Vue 消费原语：shallowRef + signal effect（adapter 层的 spike 形态）——
// 行窗口不再走 Vue（RowPool 直接订阅 range/slice）；这里只剩选区层
const focusRect = useSignal(s.focusRect)
const editingRect = useSignal(s.editingRect)
const editingInitial = useSignal(s.editingInitial)

// —— DOM scroll → store（passive；scrollTop 同步 set —— RowPool 差分廉价，无需合帧。
//    rAF 推迟是 v-for 时代的节流遗产，真机上会白给合成器多一帧领先）——
let dirTimer: ReturnType<typeof setTimeout> | undefined
function onScroll() {
  const el = viewportEl.value
  if (!el) return
  let delta = el.scrollTop - s.scrollTop.peek()
  // 拖拽限速：跳变超过 cap 行时钳回（连续滚动/滚轮的增量本来就在 cap 内，不受影响）
  if (dragCapRows > 0 && Math.abs(delta) > dragCapRows * ROW_HEIGHT) {
    el.scrollTop = s.scrollTop.peek() + Math.sign(delta) * dragCapRows * ROW_HEIGHT
    delta = el.scrollTop - s.scrollTop.peek()
  }
  s.scrollTop.set(el.scrollTop) // 同步 assign：scroll 事件先于本帧 paint
  if (Math.abs(delta) > 2) {
    s.setScrollVelocity(delta)
    clearTimeout(dirTimer)
    dirTimer = setTimeout(() => s.clearScrollVelocity(), 120)
  }
}

// —— store scrollTop → DOM（键盘导航 / 展开补偿的反向同步；同值 no-op 无环路）——
const stopSync = effect(() => {
  const st = s.scrollTop()
  const el = viewportEl.value
  if (el && Math.abs(el.scrollTop - st) > 0.5) el.scrollTop = st
})
onScopeDispose(stopSync)

let ro: ResizeObserver | null = null
let pool: RowPool | null = null
onMounted(() => {
  const el = viewportEl.value!
  s.viewportSize.set({ width: el.clientWidth, height: el.clientHeight })
  ro = new ResizeObserver((entries) => {
    const r = entries[0].contentRect
    s.viewportSize.set({ width: r.width, height: r.height })
  })
  ro.observe(el)
  el.focus({ preventScroll: true })
  // 行回收池（viewportSize 已知 → 首次 assign 即预热到满容量）
  pool = new RowPool(s, bodyEl.value!)
  const w = window as unknown as Record<string, unknown>
  w.__rowpool = pool // debug/bench 入口（沿用 __store 先例）
  w.__viewport = el
})
onScopeDispose(() => pool?.dispose())
onBeforeUnmount(() => {
  ro?.disconnect()
  clearTimeout(dirTimer)
})

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

// 行/格的静态 class 预算在 RowPool 内（core/rowpool.ts）；模板不再渲染行
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
      <!-- 行回收池挂载点（RowPool 命令式管理；高度由池按 totalHeight 写入撑起滚动条）。
           行绝对定位 top = 扁平绝对索引 × 行高（不用 transform：sticky 在 transform 祖先下错位）；
           滚动热路径 Vue 零重渲染 —— Grid 的模板响应只剩选区层 -->
      <div ref="bodyEl" class="body" :class="{ skel }"></div>
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

<!-- 行/格规则必须非 scoped：RowPool 命令式创建的 DOM 拿不到 data-v- 作用域属性
     （.gridrow 宽度类见 columnCss.ts 注入表，同理） -->
<style>
.body {
  position: relative; /* 行绝对定位的包含块；不设 z-index（保 z 表：pinned cell 2 < header 3） */
}
/* 空白带骨架：条纹与行网格对齐（35px 周期，自 body 顶 = 扁平索引 0 起）；
   pinned 区（前 180px）用固定列底色 → 覆盖不了时看起来是「空行」而非破窗 */
.body.skel {
  background:
    repeating-linear-gradient(to bottom, transparent 0 34px, #e8eaee 34px 35px),
    linear-gradient(to right, #f4f5f7 0 180px, #fff 180px);
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
