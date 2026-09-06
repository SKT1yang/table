/**
 * 运行时冒烟：createTable 桩实现可用（类型断言之外的兜底，
 * 保证 `pnpm test` 有真实测试而非空转）。
 */
import { describe, expect, it } from 'vitest'
import { createTable } from '../src/core-types'

type Movie = { id: string; title: string; year: number }

const movies: Movie[] = [
  { id: 'm1', title: 'Bugonia', year: 2025 },
  { id: 'm2', title: 'The Bride!', year: 2026 },
]

describe('createTable 运行时桩', () => {
  it('方法面齐备', () => {
    const table = createTable({
      data: movies,
      getRowId: (r) => r.id,
      columns: [
        { field: 'title', title: '片名', width: 220 },
        { field: 'year', title: '年份', width: 90 },
      ],
    })
    expect(typeof table.sortBy).toBe('function')
    expect(typeof table.setCellValue).toBe('function')
    expect(table.getSorting()).toEqual([])
  })

  it('sortBy / setSorting（Updater 双态）', () => {
    const table = createTable({ data: movies, getRowId: (r) => r.id, columns: [] })
    table.sortBy('year', 'desc')
    expect(table.getSorting()).toEqual([{ field: 'year', dir: 'desc' }])
    table.setSorting((old) => [...old, { field: 'title', dir: 'asc' }])
    expect(table.getSorting()).toHaveLength(2)
  })

  it('setCellValue 按 rowId 命中行', () => {
    const table = createTable({ data: movies, getRowId: (r) => r.id, columns: [] })
    table.setCellValue('m1', 'year', 1999)
    expect(movies[0].year).toBe(1999)
    expect(movies[1].year).toBe(2026)
  })

  it('onCellClick 返回退订函数', () => {
    const table = createTable({ data: movies, getRowId: (r) => r.id, columns: [] })
    const off = table.onCellClick(() => {})
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })
})
