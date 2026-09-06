<script setup lang="ts">
/** rAF 帧率表：显示当前 fps 与本次会话最低秒均值（验收 1） */
import { ref, onMounted, onBeforeUnmount } from 'vue'

const fps = ref(0)
const min = ref<number | null>(null)

let count = 0
let last = performance.now()
let raf = 0

function loop(t: number) {
  count++
  const dt = t - last
  if (dt >= 1000) {
    const f = Math.round((count * 1000) / dt)
    fps.value = f
    min.value = min.value == null ? f : Math.min(min.value, f)
    count = 0
    last = t
  }
  raf = requestAnimationFrame(loop)
}

onMounted(() => {
  raf = requestAnimationFrame(loop)
})
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <span class="fps">
    FPS <b>{{ fps }}</b> · 最低 <b>{{ min ?? '—' }}</b>
    <button @click="min = null">重置最低</button>
  </span>
</template>

<style scoped>
.fps { font-variant-numeric: tabular-nums; }
.fps b { color: #1668dc; }
</style>
