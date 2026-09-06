<script setup lang="ts">
/**
 * 编辑覆盖层（canvas 的 IME/a11y 代价轴载体）：
 * canvas 无法承载原生输入 → 必须 DOM overlay（真实 input，IME 走原生）。
 * viewport 坐标定位（canvas 覆盖层的兄弟节点，z 序在其上），
 * 纵横滚动时由 scroll 监听跟随 —— DOM spike 里「content 坐标随滚动天然跟随」
 * 的红利在 canvas 路线不存在，这是两条路线的真实差异点之一。
 */
import { ref, onMounted, onBeforeUnmount, onScopeDispose } from 'vue'
import { effect } from './core/signal'
import { ROW_HEIGHT, type GridStore } from './core/store'

const props = defineProps<{
  store: GridStore
  scroller: HTMLElement
}>()

const rootEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const initial = props.store.editingInitial.peek()
let done = false

function reposition(): void {
  const rect = props.store.editingRect.peek()
  const el = rootEl.value
  if (!rect || !el) return
  el.style.left = (rect.pinned ? rect.left : rect.left - props.scroller.scrollLeft) + 'px'
  el.style.top = rect.top - props.scroller.scrollTop + 'px'
  el.style.width = rect.width + 'px'
}
const stop = effect(() => {
  if (props.store.editingRect()) reposition()
})
onScopeDispose(stop)

onMounted(() => {
  reposition()
  props.scroller.addEventListener('scroll', reposition, { passive: true })
  inputEl.value?.focus()
  inputEl.value?.select()
})
onBeforeUnmount(() => props.scroller.removeEventListener('scroll', reposition))

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}
function doneEdit() {
  // 编辑器卸载后焦点会落回 <body>，网格键盘（方向键/undo）将全部失灵——还给 scroller
  props.scroller.focus({ preventScroll: true })
}
function commit() {
  if (done) return
  done = true
  props.store.commitEdit(inputEl.value?.value ?? '')
  doneEdit()
}
function cancel() {
  if (done) return
  done = true
  props.store.cancelEdit()
  doneEdit()
}
</script>

<template>
  <div ref="rootEl" class="editor" :style="{ height: ROW_HEIGHT + 'px' }">
    <input ref="inputEl" :value="initial" spellcheck="false" @keydown.stop="onKey" @blur="commit" />
  </div>
</template>

<style scoped>
.editor {
  position: absolute;
  z-index: 2;
}
.editor input {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  border: 2px solid #1668dc;
  padding: 0 6px;
  font-size: 12px;
  outline: none;
  background: #fff;
}
</style>
