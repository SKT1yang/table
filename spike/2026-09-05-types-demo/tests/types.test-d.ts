/**
 * 类型断言（vitest --typecheck）—— 对应文档 §1.2 验收清单 ①–⑩ 与 §5 决策矩阵。
 * 断言编号与 RESULTS.md 表格一一对应。
 */
import { describe, expectTypeOf, it } from 'vitest'
import { createTable, type Columns, type DeepValue, type Paths, type Table } from '../src/core-types'
import { typedColumn } from '../src/column-helper'

type Movie = {
  id: string
  title: string
  year: number
  tags: string[]
  meta?: { lang: string }
}

// interface 行型回归（决策 3：T extends object 不得排除 interface）
interface Film {
  id: string
  title: string
  year: number
}

const movies: Movie[] = []
const films: Film[] = []

describe('决策 1：映射联合列定义', () => {
  it('① 无标注列数组通过（T 从 data/getRowId 推断，零泛型标注）', () => {
    const table = createTable({
      data: movies,
      getRowId: (row) => row.id,
      columns: [
        { field: 'title', title: '片名', width: 220 },
        { field: 'year', title: '年份', width: 90, renderCell: ({ value }) => `${value}` },
        { field: 'tags', title: '标签', width: 200 },
        { id: 'actions', title: '操作', width: 120, renderCell: ({ row }) => row.title },
      ],
    })
    expectTypeOf(table).toExtend<Table<Movie>>()
  })

  it('② typo field 拒绝（清单 ①）', () => {
    createTable({
      data: movies,
      getRowId: (row) => row.id,
      columns: [
        { field: 'title', title: '片名', width: 220 },
        // @ts-expect-error 'yaer' 不在 keyof Movie 中（单行对象，指令覆盖任意报错位置）
        { field: 'yaer', title: '年份', width: 90 },
      ],
    })
  })

  it('③ renderCell 的 value 精确为 T[K]（清单 ②）', () => {
    createTable({
      data: movies,
      getRowId: (row) => row.id,
      columns: [
        {
          field: 'year',
          title: '年份',
          width: 90,
          renderCell: ({ value, row }) => {
            expectTypeOf(value).toEqualTypeOf<number>()
            expectTypeOf(row).toEqualTypeOf<Movie>()
            return `${2026 - value}`
          },
        },
        {
          field: 'tags',
          title: '标签',
          width: 200,
          renderCell: ({ value }) => {
            expectTypeOf(value).toEqualTypeOf<string[]>()
            return value.join('/')
          },
        },
      ],
    })
  })

  it('④ 值类型误用拒绝：number 列上当 string 用（清单 ②负向）', () => {
    createTable({
      data: movies,
      getRowId: (row) => row.id,
      columns: [
        {
          field: 'year',
          title: '年份',
          width: 90,
          renderCell: ({ value }) => {
            // @ts-expect-error number 上不存在 length
            value.length
            return String(value)
          },
        },
      ],
    })
  })
})

describe('决策 4：编辑与命令式方法的值边界', () => {
  const table = createTable({ data: movies, getRowId: (r) => r.id, columns: [] })

  it('⑤ setCellValue 拒错值 / 收对值（清单 ④）', () => {
    table.setCellValue('m1', 'year', 2024)
    table.setCellValue('m1', 'title', 'Bugonia')
    // @ts-expect-error 值类型必须匹配列：year 是 number
    table.setCellValue('m1', 'year', '2024')
    // @ts-expect-error field 拼写错误
    table.setCellValue('m1', 'yaer', 2024)
  })

  it('⑥ 编辑描述符 parse 的返回类型收敛为 T[K]（清单 ④⑨）', () => {
    createTable({
      data: movies,
      getRowId: (row) => row.id,
      columns: [
        {
          field: 'year',
          title: '年份',
          width: 90,
          editor: {
            parse: (raw) => {
              expectTypeOf(raw).toEqualTypeOf<string>()
              return Number(raw)
            },
          },
        },
        // @ts-expect-error parse 必须返回 string（title 列的 T[K]）——单行对象
        { field: 'title', title: '片名', width: 220, editor: { parse: (raw: string) => Number(raw) } },
      ],
    })
  })

  it('⑦ sortBy 拒 typo / 收正确 field（清单 ⑤）', () => {
    table.sortBy('year', 'asc')
    // @ts-expect-error field 拼写错误
    table.sortBy('yaer', 'asc')
    // @ts-expect-error dir 字面量联合
    table.sortBy('year', 'up')
  })
})

describe('决策 3：行类型约束', () => {
  it('⑧ getRowId 参数精确为 T（清单 ③）', () => {
    createTable({
      data: movies,
      getRowId: (row) => {
        expectTypeOf(row).toEqualTypeOf<Movie>()
        return row.id
      },
      columns: [],
    })
  })

  it('⑫ interface 行型通过（隐式索引签名回归：Record<string, unknown> 会排除）', () => {
    const filmTable = createTable({
      data: films,
      getRowId: (row) => row.id,
      columns: [
        { field: 'title', title: '片名', width: 220 },
        // @ts-expect-error interface 行型键控同样生效——单行对象
        { field: 'naem', title: '片名', width: 220 },
      ],
    })
    expectTypeOf(filmTable).toExtend<Table<Film>>()
  })
})

describe('决策 2 备查：深路径类型', () => {
  it('⑨ Paths 产物精确（深度预算 3）', () => {
    expectTypeOf<Paths<Movie>>().toEqualTypeOf<
      'id' | 'title' | 'year' | 'tags' | 'meta' | 'meta.lang'
    >()
  })

  it('⑩ DeepValue 解析点路径（可选属性带入 undefined）', () => {
    expectTypeOf<DeepValue<Movie, 'meta.lang'>>().toEqualTypeOf<string | undefined>()
    expectTypeOf<DeepValue<Movie, 'title'>>().toEqualTypeOf<string>()
  })
})

describe('决策 5：ColumnMeta 声明合并（usage-shims.d.ts）', () => {
  it('⑪ 合并后的键可用且键控（清单 ⑩）', () => {
    createTable({
      data: movies,
      getRowId: (row) => row.id,
      columns: [
        { field: 'title', title: '片名', width: 220, meta: { tone: 'warn' } },
        // @ts-expect-error tone 拼写错误（声明合并后的键控）——单行对象
        { field: 'year', title: '年份', width: 90, meta: { ton: 'warn' } },
      ],
    })
  })
})

describe('决策 1-B：typedColumn 逃生舱', () => {
  it('⑬ 动态列宽化：value 为 unknown，仍可入列数组', () => {
    const dynamicCol = typedColumn<Movie>('runtime', {
      title: '时长',
      width: 80,
      renderCell: ({ value, row }) => {
        expectTypeOf(value).toEqualTypeOf<unknown>()
        expectTypeOf(row).toEqualTypeOf<Movie>()
        return String(value)
      },
    })
    const cols: Columns<Movie> = [
      { field: 'title', title: '片名', width: 220 },
      dynamicCol,
      // 裸字面量动态列（path 判别）同样推断正确
      { path: 'boxOffice', title: '票房', width: 100, renderCell: ({ value, row }) => {
        expectTypeOf(value).toEqualTypeOf<unknown>()
        expectTypeOf(row).toEqualTypeOf<Movie>()
        return String(value)
      } },
      // 展示列混排不受动态列影响
      { id: 'actions', title: '操作', width: 120, renderCell: ({ row }) => {
        expectTypeOf(row).toEqualTypeOf<Movie>()
        return row.title
      } },
    ]
    expectTypeOf(cols).toExtend<Columns<Movie>>()
  })
})

describe('§3.8：Updater 双态', () => {
  it('⑭ 直接值与函数式更新皆可', () => {
    const table = createTable({ data: movies, getRowId: (r) => r.id, columns: [] })
    table.setSorting([{ field: 'year', dir: 'asc' }])
    table.setSorting((old) => [...old, { field: 'title', dir: 'desc' }])
    // @ts-expect-error dir 字面量联合
    table.setSorting([{ field: 'year', dir: 'up' }])
  })
})
