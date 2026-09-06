/**
 * 声明合并实验（决策 5）：用户侧扩展 ColumnMeta 的方式模拟。
 * '@table/core' 经 tsconfig paths / vite alias 指向 ./core-types.ts。
 */
import '@table/core'

declare module '@table/core' {
  interface ColumnMeta {
    /** 业务自定义：单元格色调 */
    tone?: 'warn' | 'error'
  }
}
