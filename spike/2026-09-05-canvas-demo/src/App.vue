<script setup lang="ts">
/**
 * demo 壳（canvas 版）：与 DOM spike 同一套工具栏观测点，便于横向对比：
 *  - 生成 10 万行（含耗时）/ Undo/Redo / FPS 表
 *  - 重绘计数 + 单次重绘耗时（canvas 版核心指标：不连续滚动时每帧一次全量重绘，
 *    「编辑 → 计数 +1」对应 DOM 版的 cell 渲染计数 delta=1）
 *  - 视口首行 id（展开锚点补偿）
 */
import { ref, onMounted, onScopeDispose } from 'vue'
import { effect } from './core/signal'
import { createStore, ROW_HEIGHT } from './core/store'
import { generateData, COLUMNS } from './mock'
import { useSignal } from './adapter'
import CanvasGrid from './CanvasGrid.vue'
import FpsMeter from './FpsMeter.vue'

const store = createStore(COLUMNS)
;(window as unknown as Record<string, unknown>).__store = store

const loading = ref(false)
const loaded = ref(false)
const genMs = ref(0)
const flatCount = ref(0)
const totalCount = ref(0)
const firstVisibleId = ref('—')
const repaints = ref(0)
const lastMs = ref(0)
const avgMs = ref(0)

const canUndo = useSignal(store.commands.canUndo)
const canRedo = useSignal(store.commands.canRedo)
const grid = ref<InstanceType<typeof CanvasGrid> | null>(null)

const stopFirst = effect(() => {
  const st = store.scrollTop()
  const rows = store.flatRows.peek()
  const idx = Math.max(0, Math.floor(st / ROW_HEIGHT))
  firstVisibleId.value = rows[idx]?.id ?? '—'
})
onScopeDispose(stopFirst)

// 重绘计数/耗时轮询（与 DOM spike 的 cell 计数轮询同一形态）
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    const st = grid.value?.stats()
    if (!st) return
    repaints.value = st.repaints.peek()
    lastMs.value = Math.round(st.lastMs.peek() * 100) / 100
    avgMs.value = Math.round(st.avgMs.peek() * 100) / 100
  }, 250)
})
onScopeDispose(() => clearInterval(timer))

function generate() {
  if (loading.value) return
  loading.value = true
  setTimeout(() => {
    const t0 = performance.now()
    const rows = generateData(100_000)
    genMs.value = Math.round(performance.now() - t0)
    store.loadRows(rows)
    flatCount.value = store.flatRows.peek().length
    totalCount.value = store.totalRows
    loading.value = false
    loaded.value = true
  }, 30)
}

function resetRepaints() {
  const st = grid.value?.stats()
  if (st) st.repaints.set(0)
  repaints.value = 0
}

const hints = [
  '验收1：快速滚动 30s + 拖滚动条往返 + Cmd+End 跳尾，看 FPS 与重绘耗时',
  '验收2：横+纵对角滚动，前两列与表头不错位（纯 clip 分层，零 JS 同步）',
  '验收3：归零重绘 → 双击改一个 cell 提交 → 重绘应 +1（draw 即 effect）',
  '验收4：多处编辑 → Ctrl+Z 逐步还原 → Ctrl+Y 重做',
  '验收5：滚到中部，点上方父节点行的 ▸，视口首行不变',
  '验收6：点任意 cell 后按 ↓/End/Tab，焦点环连续、视口纵横跟随',
]
</script>

<template>
  <div class="app">
    <div class="toolbar">
      <button class="primary" :disabled="loading" @click="generate">
        {{ loading ? '生成中…' : '生成 10 万行 × 20 列' }}
      </button>
      <span v-if="loaded" class="stat">
        可见行 <b>{{ flatCount.toLocaleString() }}</b> / 全部 <b>{{ totalCount.toLocaleString() }}</b>
        · 生成耗时 <b>{{ genMs }}ms</b>
      </span>
      <span class="divider"></span>
      <button :disabled="!canUndo" @click="store.commands.undo()">Undo (Ctrl+Z)</button>
      <button :disabled="!canRedo" @click="store.commands.redo()">Redo (Ctrl+Y)</button>
      <span class="divider"></span>
      <span class="stat">
        重绘 <b>{{ repaints.toLocaleString() }}</b> 次 · 单次 <b>{{ lastMs }}ms</b> · 均值 <b>{{ avgMs }}ms</b>
        <button @click="resetRepaints">归零</button>
      </span>
      <span class="stat">视口首行 <b>{{ firstVisibleId }}</b></span>
      <span class="divider"></span>
      <FpsMeter />
    </div>
    <div class="hints">
      <span v-for="h in hints" :key="h" class="hint">{{ h }}</span>
    </div>
    <div class="grid-wrap">
      <CanvasGrid v-if="loaded" ref="grid" :store="store" />
      <div v-else class="empty">点击「生成 10 万行 × 20 列」开始验证</div>
    </div>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
.app { display: flex; flex-direction: column; height: 100vh; }
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: #fff;
  border-bottom: 1px solid #e5e6eb;
  flex-wrap: wrap;
}
.toolbar button {
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid #d7d9de;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}
.toolbar button:hover:not(:disabled) { border-color: #1668dc; color: #1668dc; }
.toolbar button:disabled { color: #bbb; cursor: not-allowed; }
.toolbar button.primary {
  background: #1668dc;
  border-color: #1668dc;
  color: #fff;
}
.toolbar button.primary:disabled { background: #8ab6f0; border-color: #8ab6f0; color: #fff; }
.stat { font-size: 12px; color: #555; font-variant-numeric: tabular-nums; }
.stat b { color: #1668dc; }
.stat button { margin-left: 4px; padding: 1px 6px; font-size: 11px; border: 1px solid #ddd; background: #fff; border-radius: 3px; cursor: pointer; }
.divider { width: 1px; height: 18px; background: #e5e6eb; }
.hints {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 4px 12px;
  background: #fbfbfd;
  border-bottom: 1px solid #eee;
}
.hint { font-size: 11px; color: #999; }
.grid-wrap { flex: 1; min-height: 0; }
.empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #aaa;
  font-size: 14px;
}
</style>
