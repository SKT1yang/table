<script setup lang="ts">
/**
 * 编辑覆盖层（spike 假设 #4 的交互入口）：
 * absolute 定位在 content 坐标系 → 随滚动天然跟随目标 cell。
 * Enter/blur 提交（值变才走 COMMAND）、Esc 取消；input 内 keydown stopPropagation
 * 防方向键/Ctrl+Z 泄漏进网格导航（编辑期间 Ctrl+Z 归 input 原生行为）。
 */
import { ref, onMounted } from 'vue'
import { ROW_HEIGHT, type GridStore, type Rect } from './core/store'

const props = defineProps<{
  store: GridStore
  rect: Rect
  initial: string
}>()

const inputEl = ref<HTMLInputElement | null>(null)
let done = false

onMounted(() => {
  inputEl.value?.focus()
  inputEl.value?.select()
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}

function commit() {
  if (done) return
  done = true
  props.store.commitEdit(inputEl.value?.value ?? '')
}

function cancel() {
  if (done) return
  done = true
  props.store.cancelEdit()
}
</script>

<template>
  <div
    class="editor"
    :style="{ top: rect.top + 'px', left: rect.left + 'px', width: rect.width + 'px', height: ROW_HEIGHT + 'px' }"
  >
    <input ref="inputEl" :value="initial" spellcheck="false" @keydown.stop="onKey" @blur="commit" />
  </div>
</template>

<style scoped>
.editor {
  position: absolute;
  z-index: 6;
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
