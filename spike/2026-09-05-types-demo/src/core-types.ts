/**
 * 类型体验 spike —— 提案公共 API 类型草稿（核心产出）
 *
 * 只验证类型模式，运行时为最小桩实现。
 * 决策依据见 docs/proposals/stage-0-strawman/2026-09-05/01-typescript-types-research.md §5。
 */

// ---------------------------------------------------------------------------
// 单元格上下文（core 纯数据，不含 VNode —— VNode 只进 adapter 扩展接口）
// ---------------------------------------------------------------------------

/**
 * 单元格渲染/编辑回调的上下文。
 *
 * @example
 * // value 精确为 T[K]，无需标注
 * { field: 'year', title: '年份', width: 90,
 *   renderCell: ({ value }) => `${2026 - value}` }
 */
export interface CellContext<T extends object, K extends keyof T> {
  /** 当前列的值，类型精确为 `T[K]` */
  value: T[K]
  /** 原始行数据 */
  row: T
  /** 行 id（`getRowId` 的产物） */
  rowId: string
  /** 行索引（当前扁平化可见序） */
  index: number
}

/**
 * 列元数据锚点：故意声明为空接口，供用户声明合并扩展。
 *
 * @example
 * declare module '@table/core' {
 *   interface ColumnMeta { tone?: 'warn' | 'error' }
 * }
 */
export interface ColumnMeta {}

/**
 * 编辑描述符：编辑器的值类型边界（core 命令层的 mutation 值保持 unknown，
 * 拒错能力放在这里与 `setCellValue<K>`）。
 *
 * @example
 * { field: 'year', title: '年份', width: 90,
 *   editor: { parse: (raw) => Number(raw) } }  // 返回值必须是 number
 */
export interface EditorDef<T extends object, K extends keyof T> {
  /** 编辑器组件引用（adapter 层消费，core 只透传） */
  component?: unknown
  /** 从编辑器原始字符串解析为列值，返回类型必须可赋给 `T[K]` */
  parse?: (raw: string) => T[K]
}

// ---------------------------------------------------------------------------
// 列定义：映射联合（决策 1-A）
// ---------------------------------------------------------------------------

/**
 * 数据列定义：`field` 键控为 `K`，回调上下文随之精确到 `T[K]`。
 *
 * @example
 * { field: 'title', title: '片名', width: 220, pinned: true }
 */
export interface ColumnDef<T extends object, K extends keyof T> {
  /** 行数据字段名，自动补全 = keyof T，拼写错误编译报错 */
  field: K
  /** 判别位：键控列不允许 id（见 Columns 联合的互斥判别说明） */
  id?: never
  /** 判别位：键控列不允许 path */
  path?: never
  /** 表头文案 */
  title: string
  /** 列宽（px，定高档） */
  width: number
  /** 固定列（必须是前缀列） */
  pinned?: boolean
  /** 单元格渲染函数，`ctx.value` 精确为 `T[K]` */
  renderCell?: (ctx: CellContext<T, K>) => unknown
  /** 编辑描述符 */
  editor?: EditorDef<T, K>
  /** 列元数据（可声明合并） */
  meta?: ColumnMeta
}

/**
 * 展示列（操作列等）：无字段，靠显式 id。
 *
 * @example
 * { id: 'actions', title: '操作', width: 120,
 *   renderCell: ({ row }) => `${row.id} 的操作按钮` }
 */
export interface DisplayColumnDef<T extends object> {
  /** 判别位：展示列不允许 field */
  field?: never
  /** 显式稳定列 id */
  id: string
  /** 判别位：展示列不允许 path */
  path?: never
  /** 表头文案 */
  title: string
  /** 列宽（px） */
  width: number
  /** 单元格渲染函数（无 value） */
  renderCell?: (ctx: Omit<CellContext<T, keyof T>, 'value'>) => unknown
  /** 列元数据（可声明合并） */
  meta?: ColumnMeta
}

/**
 * 动态列逃生舱（决策 1-B）：服务端 schema 等运行期才知道的字段。
 * 值类型放宽为 unknown，可用裸字面量（path 判别）或 typedColumn(field, def) 构造。
 *
 * spike 关键发现（判别矩阵）：上下文对联合的过滤只认「字面量已携带的属性被成员拒绝」，
 * 缺必填属性不会排除成员——所以宽化成员绝不能复用 `field` 属性名（会被键控字面量
 * 的 field:'xx' 命中，逐列推断与 typo 检测整体退化）。三成员两两互斥：
 * field（键控）/ id（展示）/ path（动态），非本位属性一律 `?: never`。
 */
export interface LooseColumnDef<T extends object> {
  /** 判别位：动态列不允许 field */
  field?: never
  /** 判别位：动态列不允许 id */
  id?: never
  /** 任意字符串字段路径（放弃键控换取动态性） */
  path: string & {}
  /** 表头文案 */
  title: string
  /** 列宽（px） */
  width: number
  /** 固定列 */
  pinned?: boolean
  /** 单元格渲染函数，`ctx.value` 为 unknown */
  renderCell?: (ctx: { value: unknown; row: T; rowId: string; index: number }) => unknown
  /** 列元数据（可声明合并） */
  meta?: ColumnMeta
}

/**
 * 键控数据列的联合：为 T 的每个 key 生成专属 ColumnDef 再摊成联合。
 * 这是「每列值类型不被数组位置擦除」的关键（radekmie 映射联合模式）。
 */
export type AccessorColumn<T extends object> = { [K in keyof T]: ColumnDef<T, K> }[keyof T]

/** 列数组：键控列 | 展示列 | 动态列 的混合 */
export type Columns<T extends object> = readonly (
  | AccessorColumn<T>
  | DisplayColumnDef<T>
  | LooseColumnDef<T>
)[]

// ---------------------------------------------------------------------------
// 深路径实验（决策 2 备查：v1 只用 keyof，DeepKeys 后置）
// ---------------------------------------------------------------------------

type Prev = [never, 0, 1, 2, 3, 4]

/** 只对「可继续下钻」的类型递归（排除数组与 Date，TanStack DeepKeys 同款取舍） */
type Recurse<T> = T extends Date
  ? never
  : T extends readonly unknown[]
    ? never
    : T extends object
      ? T
      : never

/**
 * 点路径键联合，深度预算 D（默认 3）。
 *
 * @example
 * Paths<{ a: { b: { c: string } } }>  // 'a' | 'a.b' | 'a.b.c'
 */
export type Paths<T, D extends number = 3> = [D] extends [never]
  ? never
  : T extends object
    ? {
        [K in keyof T]-?: K extends string | number
          ? `${K}` | (Recurse<T[K]> extends infer S
              ? S extends object
                ? `${K}.${Paths<S, Prev[D]>}`
                : never
              : never)
          : never
      }[keyof T]
    : never

/** 解析点路径的值类型。可选属性会带入 undefined。 */
export type DeepValue<T, P extends string> =
  T extends null | undefined
    ? undefined
    : P extends `${infer Head}.${infer Rest}`
      ? Head extends keyof T
        ? DeepValue<T[Head], Rest>
        : never
      : P extends keyof T
        ? T[P]
        : never

// ---------------------------------------------------------------------------
// 表实例与选项
// ---------------------------------------------------------------------------

/** 受控更新值：直接值或基于旧值的函数（TanStack Updater 模式） */
export type Updater<T> = T | ((old: T) => T)

/** 排序状态（简化版：field 在运行时是字符串，类型键控在方法签名上） */
export interface SortingState {
  field: string
  dir: 'asc' | 'desc'
}

/** 单元格点击事件 payload */
export interface CellClickEvent<T extends object> {
  /** 原始行数据 */
  row: T
  /** 行 id */
  rowId: string
  /** 命中列的字段名 */
  field: keyof T
}

/**
 * 建表选项：T 的唯一推断源（data 优先）。
 *
 * @example
 * const table = createTable({
 *   data: movies,                       // T = Movie 从这里推断
 *   getRowId: (row) => row.id,          // row: Movie，无需标注
 *   columns: [                          // field 自动补全 keyof Movie
 *     { field: 'title', title: '片名', width: 220 },
 *   ],
 * })
 */
export interface TableOptions<T extends object> {
  /** 行数据（T 的第一推断源） */
  data: readonly T[]
  /** 行 id 提取器（必填，ADR 决策 11） */
  getRowId: (row: T) => string
  /** 列定义（映射联合） */
  columns: Columns<T>
  /** 树形子行提取器（非侵入，返回 false 显式声明无子行） */
  getRowChildren?: (row: T) => readonly T[] | undefined | false
}

/** 表实例（方法面）：命令式 API 按 field 键控（方法级泛型） */
export interface Table<T extends object> {
  /** 建表选项（含 data / columns） */
  options: TableOptions<T>
  /** 按字段排序；field 拼写错误编译报错 */
  sortBy<K extends keyof T>(field: K, dir: 'asc' | 'desc'): void
  /** 设单元格值；K 从 field 实参推断，value 随之收敛为 T[K] */
  setCellValue<K extends keyof T>(rowId: string, field: K, value: T[K]): void
  /**
   * 按字段过滤。NoInfer 固定 K 的推断源为 field 实参，
   * 防止回调参数注解反向污染推断。
   */
  setFilter<K extends keyof T>(field: K, predicate: (value: NoInfer<T[K]>, row: T) => boolean): void
  /** 订阅单元格点击；payload 携 row: T 与 field: keyof T */
  onCellClick(cb: (e: CellClickEvent<T>) => void): () => void
  /** 受控更新排序（Updater 双态：直接值或函数） */
  setSorting(updater: Updater<SortingState[]>): void
  /** 读取当前排序（运行时桩用） */
  getSorting(): SortingState[]
}

/**
 * 建表：T 全程自动推断，用户零泛型标注。
 * 运行时为最小桩（本 spike 只验类型，真实实现走 COMMAND→MUTATION）。
 */
export function createTable<T extends object>(options: TableOptions<T>): Table<T> {
  let sorting: SortingState[] = []
  const clickHandlers = new Set<(e: CellClickEvent<T>) => void>()

  const table: Table<T> = {
    options,
    sortBy(field, dir) {
      sorting = [{ field: field as string, dir }]
    },
    setCellValue(rowId, field, value) {
      // 真实实现：走 COMMAND→MUTATION + undo/redo 栈（见 grid-demo spike）
      const row = options.data.find((r) => options.getRowId(r) === rowId)
      if (row) (row as Record<string, unknown>)[field as string] = value
    },
    setFilter(_field, _predicate) {
      /* 桩：真实实现在 row model 管线 */
    },
    onCellClick(cb) {
      clickHandlers.add(cb)
      return () => clickHandlers.delete(cb)
    },
    setSorting(updater) {
      sorting = typeof updater === 'function' ? updater(sorting) : updater
    },
    getSorting() {
      return sorting
    },
  }
  return table
}
