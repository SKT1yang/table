<script setup lang="ts">
/**
 * canvas 网格壳（markup + 生命周期，逻辑全在 renderer.ts —— 纯 TS）：
 * - scroller：唯一滚动容器（原生滚动条/滚轮/键盘全免费），spacer 撑出 content 尺寸
 * - canvas：覆盖在 scroller 之上的兄弟节点，pointer-events:none ——
 *   命中/滚轮/拖滚动条全部穿透落到 scroller，事件侧与 DOM 版完全同构
 * - Editor：编辑 DOM 覆盖层（canvas 兄弟，z 序其上）
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import type { GridStore } from './core/store'
import { useSignal } from './adapter'
import { createRenderer, type GridRenderer } from './renderer'
import Editor from './Editor.vue'

const props = defineProps<{ store: GridStore }>()
const s = props.store

const wrapEl = ref<HTMLElement | null>(null)
const scrollerEl = ref<HTMLElement | null>(null)
const spacerEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

const editing = useSignal(s.editingCell)

let renderer: GridRenderer | null = null

onMounted(() => {
  renderer = createRenderer(s, {
    wrap: wrapEl.value!,
    scroller: scrollerEl.value!,
    spacer: spacerEl.value!,
    canvas: canvasEl.value!,
  })
  scrollerEl.value!.focus({ preventScroll: true })
  // debug：CDP 实验入口（measure.mjs 读 stats.repaints）
  ;(window as unknown as Record<string, unknown>).__renderer = renderer
})
onBeforeUnmount(() => {
  renderer?.dispose()
  renderer = null
})

defineExpose({
  stats: () => renderer?.stats ?? null,
})
</script>

<template>
  <div ref="wrapEl" class="wrap">
    <div ref="scrollerEl" class="scroller" tabindex="0">
      <div ref="spacerEl" class="spacer"></div>
    </div>
    <canvas ref="canvasEl" class="surface"></canvas>
    <Editor v-if="editing" :store="s" :scroller="scrollerEl!" />
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  height: 100%;
}
.scroller {
  position: absolute;
  inset: 0;
  overflow: auto;
  outline: none;
}
.spacer {
  position: absolute;
  top: 0;
  left: 0;
  width: 1px;
  height: 1px; /* 尺寸由 renderer 按行数写入 */
}
.surface {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  pointer-events: none; /* 滚轮/滚动条/点击全部穿透到 scroller */
}
</style>
