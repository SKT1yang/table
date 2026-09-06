/**
 * typedColumn —— 列定义 helper（决策 1-B 逃生舱）
 *
 * 静态列通常直接写对象字面量（映射联合自动推断）；本 helper 服务两个场景：
 * 1. 动态列（服务端 schema，字段运行期才知道）→ 宽化重载，值 unknown
 * 2. 用户想拿到单列的精确 ColumnDef<T, K> 类型时
 */
import type { ColumnDef, LooseColumnDef } from './core-types'

/**
 * 静态列：字段键控 + 每列值类型推断。
 *
 * @example
 * typedColumn<Movie>('year', { title: '年份', width: 90 })
 * // → ColumnDef<Movie, 'year'>，renderCell 的 value: number
 */
export function typedColumn<T extends object, K extends keyof T>(
  field: K,
  def: Omit<ColumnDef<T, K>, 'field'>,
): ColumnDef<T, K>

/**
 * 动态列逃生舱：任意字符串字段，值类型 unknown（显式 <T> 仅为 renderCell 的 row 类型）。
 *
 * @example
 * typedColumn<Movie>('runtime', { title: '时长', width: 80 })
 * // → LooseColumnDef<Movie>（path: 'runtime'），renderCell 的 value: unknown
 */
export function typedColumn<T extends object>(
  field: string,
  def: Omit<LooseColumnDef<T>, 'path'>,
): LooseColumnDef<T>

export function typedColumn(field: string, def: unknown): unknown {
  return { path: field, ...(def as Record<string, unknown>) }
}
