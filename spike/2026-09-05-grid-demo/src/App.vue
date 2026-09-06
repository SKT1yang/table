<script setup lang="ts">
/**
 * demo 壳：工具栏承载 6 项验收的观测点。
 *  - 生成 10 万行（含耗时）
 *  - Undo/Redo 按钮（disabled 绑 canUndo/canRedo）—— 验收 4
 *  - FPS 表 —— 验收 1
 *  - cell 渲染计数（编辑提交后 delta 应为 1）—— 验收 3
 *  - 视口首行 id（展开/收起上方节点后应不变）—— 验收 5
 *  - 泄漏自检（dataVersion 订阅数应稳定在 ≈ 可视 cell 数）—— 防泄漏契约
 */
import { ref, onMounted, onScopeDispose } from 'vue'
import { effect } from './core/signal'
import { createStore, ROW_HEIGHT } from './core/store'
import { generateData, COLUMNS } from './mock'
import { useSignal } from './adapter'
import Grid from './Grid.vue'
import FpsMeter from './FpsMeter.vue'

const store = createStore(COLUMNS)
// 跳转 lead 实验开关（?jumplead=N）：setup 期读入 —— 须先于 Grid 挂载（池容量预热依据）
const jumpLeadParam = new URLSearchParams(location.search).get('jumplead')
if (jumpLeadParam) store.setJumpLead(Number(jumpLeadParam) || 0)
// 行数变体（?rows=N，默认 10 万不变）：5000 行拖拽复核用（03 文档 §3.2 预测表实测列）
const ROWS = Math.max(1, Math.floor(Number(new URLSearchParams(location.search).get('rows')) || 100_000))
// debug：控制台/CDP 实验入口
;(window as unknown as Record<string, unknown>).__store = store

const loading = ref(false)
const loaded = ref(false)
const genMs = ref(0)
const flatCount = ref(0)
const totalCount = ref(0)
const firstVisibleId = ref('—')
const cellRenders = ref(0)

const canUndo = useSignal(store.commands.canUndo)
const canRedo = useSignal(store.commands.canRedo)

// 验收 5 debug：视口首行 id
const stopFirst = effect(() => {
  const st = store.scrollTop()
  const rows = store.flatRows.peek()
  const idx = Math.max(0, Math.floor(st / ROW_HEIGHT))
  firstVisibleId.value = rows[idx]?.id ?? '—'
})
onScopeDispose(stopFirst)

// 验收 3：cell 渲染计数轮询
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    cellRenders.value = (window as unknown as Record<string, number>).__cellRenders ?? 0
  }, 250)
  // 回收压测模式：?bench=1（动态 import，不进正常路径/产物主包）
  if (new URLSearchParams(location.search).has('bench')) {
    import('./bench').then((m) => m.runBench(store, ensureLoaded))
  }
})
onScopeDispose(() => clearInterval(timer))

/** bench 用：确保数据已加载（复用工具栏生成逻辑） */
function ensureLoaded(): Promise<void> {
  if (loaded.value) return Promise.resolve()
  generate()
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (loaded.value) {
        clearInterval(t)
        resolve()
      }
    }, 20)
  })
}

function generate() {
  if (loading.value) return
  loading.value = true
  setTimeout(() => {
    const t0 = performance.now()
    const rows = generateData(ROWS)
    genMs.value = Math.round(performance.now() - t0)
    store.loadRows(rows)
    flatCount.value = store.flatRows.peek().length
    totalCount.value = store.totalRows
    loading.value = false
    loaded.value = true
  }, 30)
}

function leakCheck() {
  // 行回收后该数 = 绑定中 slot × 20，滚动中恒定不增长（fling 窗口扩到最大时最高 ~2.6k）
  console.log(
    `[泄漏自检] dataVersion 订阅数 = ${store.dataVersionSubs()}（应 = 绑定行 × 20，滚动中恒定不增长）`,
  )
}

function resetCellRenders() {
  ;(window as unknown as Record<string, number>).__cellRenders = 0
  cellRenders.value = 0
}

const hints = [
  '验收1：快速滚动 30s + 拖滚动条往返，看 FPS 表',
  '验收2：横+纵对角滚动，前两列与表头不错位',
  '验收3：归零计数 → 双击改一个 cell → 计数应 +1',
  '验收4：多处编辑 → Ctrl+Z 逐步还原 → Ctrl+Y 重做',
  '验收5：滚到中部，展开/收起上方父节点行(▸)，视口首行不变',
  '验收6：点任意 cell 后按 ↓/End/Tab，高亮连续、视口跟随',
]
</script>

<template>
  <div class="app">
    <div class="toolbar">
      <button class="primary" :disabled="loading" @click="generate">
        {{ loading ? '生成中…' : `生成 ${ROWS.toLocaleString()} 行 × 20 列` }}
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
        cell 渲染计数 <b>{{ cellRenders }}</b>
        <button @click="resetCellRenders">归零</button>
      </span>
      <span class="stat">视口首行 <b>{{ firstVisibleId }}</b></span>
      <button @click="leakCheck">泄漏自检</button>
      <span class="divider"></span>
      <FpsMeter />
    </div>
    <div class="hints">
      <span v-for="h in hints" :key="h" class="hint">{{ h }}</span>
    </div>
    <div class="grid-wrap">
      <Grid v-if="loaded" :store="store" />
      <div v-else class="empty">点击「生成 {{ ROWS.toLocaleString() }} 行 × 20 列」开始验证</div>
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
