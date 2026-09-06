<!--
  泛型组件壳（决策 6）：store-object prop 是 T 的推断源。
  模板不支持组件显式类型实参（RFC #436）→ T 必须恒从 prop 推断。
  本组件只验证类型面，渲染为最小占位。
-->
<script setup lang="ts" generic="T extends object">
import type { CellClickEvent, Table } from './core-types'

const props = defineProps<{ store: Table<T> }>()

const emit = defineEmits<{ cellClick(e: CellClickEvent<T>): void }>()

defineSlots<{
  /** 表体插槽：rows 已按当前行模型投影 */
  default(slotProps: { rows: readonly T[]; total: number }): void
}>()
</script>

<template>
  <div class="table-shell" data-total="0">
    <slot :rows="props.store.options.data" :total="props.store.options.data.length"></slot>
  </div>
</template>
