# 调研：表格组件的「极致 TypeScript 类型体验」

> 调研时间：2026-09-05。方法：一手源码（TanStack Table v9 main 分支 table-core/types）+ 库作者文章（radekmie.dev）+ GitHub issue/RFC + 本仓类型 spike 实证（`spike/2026-09-05-types-demo/`，14 断言全绿）。
> 版本基线：TypeScript 5.9 / Vue 3.5.13 / vue-tsc 3.3（Volar）/ vitest 3.2。
> 本文档是 stage-1「core 层模块接口设计」的类型面输入。**结论速览见 §7。**后续讨论追问（入口必要性 / 打包后类型存续 / 多版本共存）整理于 `02-types-qa.md`，其中对本文的增量修正见其 §6。

---

## 1. 目标与「极致」的定义

用户要求：业务侧把行数据 `T` 交给表格后，表格的属性、方法、事件、回调**全部完美补全与推断**，无需手写任何泛型标注。本节把这个诉求翻译成可机械验证的清单。

### 1.1 现状基线（gap）

两个 spike（grid-demo / canvas-demo）的数据面 API 完全没有泛型（源码核验）：

| 现状 API | 类型问题 |
|---|---|
| `RowNode { id: string; data: Record<string, unknown> }` | 单元格值不透明；列 id 兼任数据 key，无编译期关联 |
| `Column { id; title; width; pinned? }` | 零泛型；拼错 id 静默降级（`applyMutation` 直接写入新 key） |
| `readCell(rowId: string, colId: string): unknown` | 字符串式 id + unknown 返回值 |
| `commitEdit(value: unknown)` / `SetCellMutation { prev/value: unknown }` | 编辑值不受列类型约束 |
| 显示恒为 `String(v)` | 无 accessor / formatter / render 函数 / 单元格组件概念 |
| 泛型只存在于 signal 管道（`atom<T>` / `useSignal<T>`） | 数据路径上没有任何 `T` |

结论：数据面 API 的类型化是**绿地**；它不是 stage-1 的附庸，而是接口设计的输入——先定类型形态，再落实现。

### 1.2 「极致」验收清单

以下 10 条即「极致」的操作定义，spike 逐条对应测试（标注见 `spike/2026-09-05-types-demo/RESULTS.md`）：

1. 列 `field` 自动补全 = `keyof T`，typo 编译报错
2. `renderCell` / 编辑回调的 `value` 精确为 `T[K]`（不是 `T[keyof T]` 联合，不是 unknown）
3. 回调上下文 `row: T` 完整（`getRowId` 参数同样是 `T`）
4. `setCellValue` / 编辑提交拒绝错误值类型
5. 命令式方法按 field 键控（`sortBy('字段')` 拒 typo）
6. 事件 / 回调 payload 推断（`onCellClick` 携 `row: T`、`field: keyof T`）
7. hover 显示 JSDoc（中文一句话 + `@example`）
8. **泛型零标注**：用户代码任何位置不需要写 `<Movie>`（逃生舱除外）
9. 编辑器组件的 `value` prop 类型 = `T[K]`
10. `meta` 扩展可声明合并（declaration merging）且有拼写检查

---

## 2. 竞品类型体验盘点

### 2.1 TanStack Table v8 → v9：正面标杆与已知痛点

- **`ColumnDef<TData, TValue>` 是判别式联合**（Display / Group / AccessorKey / AccessorFn 四分支）。第二泛型 `TValue`（默认 `unknown`）是推断痛源：**每列的 TValue 本应不同，但放进数组后位置类型被擦除**，TS 只能给整个数组一个 `TValue` → 被迫引入 `createColumnHelper` 逐列包装（源码核验）。
- 已知 gotcha 三连：
  - **#4302**：IntelliSense 在联合上补全时塌缩，报 "accessorKey does not exist on type ColumnDef"——判别联合对补全不友好的直接证据；
  - **#4382**：行类型是联合（判别联合数据）时 columnHelper 推断报错；
  - **#4195**：用户把 `useReactTable` 包进自己的泛型组件时，泛型被覆盖、推断链断裂——**「库泛型 × 用户泛型」叠加是真实高频场景**。
- `accessorKey: (string & {}) | keyof TData`（v9，源码核验）：`(string & {})` 幻影联合**保留 keyof 补全的同时允许任意字符串逃生**。v8 只有 `keyof TData`（#4302 的诉求推动了放宽）。
- **`ColumnMeta` 故意声明为空接口**，供用户 `declare module '@tanstack/table-core' { interface ColumnMeta { ... } }` 声明合并——源码注释明确写了设计意图（源码核验）。v9 又新增 per-table 替代：`tableFeatures({ columnMeta: {} as MyMeta })` 类型槽，由 `ExtractColumnMeta` 解析（`IsAny<T> = 0 extends 1 & T` 判定：feature 槽优先，否则全局合并）——**官方用双轨制承认了全局声明合并的「多表冲突」问题**。
- v9 feature-map：`ExtractFeatureMapTypes<TFeatures, TFeatureMap>` 按 `features` 选项的键交集出各特性的选项接口——**类型随特性树摇**，未注册的特性连类型都不出现（源码核验）。
- type-utils 工具箱（源码核验）：`DeepKeys`（点路径键，**数组长度计数器限深 5**、支持元组索引、排除 Date）、`DeepValue`、自制 `NoInfer`（早于 TS 5.4 内置）、`Getter<TValue> = <TTValue = TValue>() => NoInfer<TTValue>`（`cell.getValue<string>()` 显式转型 API 的幻影泛型基础）、`UnionToIntersection`、`Updater<T> = T | ((old: T) => T)` + `OnChangeFn`。

### 2.2 AG Grid：field 已强类型，值管线靠手动

- `ColDef.field` 已按 `TData` 强类型为 keyof（issue #6741 已解决，文档核验）——「企业库放弃字段键控」是过时印象。
- 但**每列值类型 `TValue` 不随 field 自动推断**：`valueFormatter` / `valueGetter` 等回调要拿到精确值类型，需手动标注泛型（社区高频诉求，StackOverflow 77829149）。
- 归因：`ColDef<TData, TValue>` 同样是「数组位置擦除 TValue」结构 + 兼容动态列 / 字符串 API 的历史包袱。

### 2.3 Element Plus / vxe-table：插槽作用域的类型洼地

- Element Plus 插槽 `scope` 长期无类型（issue #3233：所有带 scope slot 的组件都没有类型支持）；**新版已在 `el-table-column` 上补 `generic="MyRow"` 属性**做补救（文档核验）——补救方式本身说明 Vue 动态命名插槽不可类型化，只能在组件级手动标泛型。
- vxe-table 泛型支持较强（待核实，未读源码）。
- 这是 Vue 表格「类型体验」的经典失败模式：**单元格定制走插槽 → 插槽 props 无类型 → 用户拿到的 row 是 any**。

### 2.4 正面参照：radekmie / MinTable 的映射联合

radekmie《On Refactoring With Generic Types》（2026-03，全文核验）给出**无 helper 仪式的每列推断**：

```ts
function renderTable<T>(
  data: T[],
  columns: { [K in keyof T]: Column<T, K> }[keyof T][],
) { /* ... */ }

renderTable(movies, [
  { field: 'title', fn: value => `"${value}"` },   // value: string
  { field: 'year',  fn: value => value * 1 },      // value: number
])
```

映射类型先为每个 key 生成专属 `Column<T, K>`，再 `[keyof T]` 摊成联合，最后 `[]`。**每列回调看到精确的 `T[K]`，彻底绕开 TValue 擦除**。作者自述的 TS 限制：hook 形态（useReactTable）必须显式传 `Movie`（推断顺序），workaround 是 `typeof data[number]`——**把 T 的推断源放在普通对象属性（如 `data`）上即可规避**。

### 2.5 对比表

| 库 | field 键控 | 每列值类型推断 | 回调/slot 类型 | meta 扩展 | 逃生舱 | 核验 |
|---|---|---|---|---|---|---|
| TanStack v8/v9 | ✅ keyof（v9 加 `(string&{})`） | ⚠️ 需 columnHelper 逐列包装 | ✅ context 泛型强 | ✅ 声明合并 + v9 per-table 槽 | accessorFn | 源码 |
| AG Grid | ✅ keyof（#6741 后） | ❌ TValue 手动标注 | ✅ 参数对象泛型 | ✅ TContext | 字符串 API 惯性 | 文档/issue |
| Element Plus | ❌ prop 字符串 | ❌ | ⚠️ slot 历史无类型，新版 `generic` 补救 | ❌ | — | issue/文档 |
| vxe-table | ⚠️ | ⚠️ 泛型较强 | ⚠️ | ⚠️ | — | 待核实 |
| radekmie/MinTable | ✅ | ✅ 映射联合 | ✅ | — | — | 全文 |
| **本项目目标** | ✅ keyof | ✅ 映射联合 | ✅ 含 Vue 模板面 | ✅ 双轨预留 | typedColumn 宽化 | 本仓 spike |

**差距归因**：TanStack/AG Grid 的痛都在「TValue 数组位置擦除」（一个靠 helper 补、一个干脆放弃）；Element Plus 的痛在「插槽不可类型化」。→ 可行路径 = **映射联合列定义 + 分层边界类型 + 单元格定制走列定义函数而非动态插槽**。

---

## 3. 核心类型技术武器库

| # | 技术 | 机制 | 代价/限制 | 本项目用途 |
|---|---|---|---|---|
| 3.1 | **映射类型联合列定义** | `{ [K in keyof T]: ColumnDef<T, K> }[keyof T][]` | 联合里的**宽化成员必须走判别矩阵**（spike 实证，见 §5 决策 1）；联合上报错信息宽泛（负向用例写单行对象） | **主候选**（§5 决策 1） |
| 3.2 | `(string & {})` 幻影联合 | 与 keyof 的交叉保补全 + 任意 string 逃生 | 削弱拼写检查强度 | 逃生舱字段（动态列） |
| 3.3 | `satisfies` / `as const satisfies` / `<const T>` | 保字面量推断的同时校验形状 | TS#58031：satisfies 不能做泛型约束（open） | 用户列数组写法建议 |
| 3.4 | DeepKeys / DeepValue + 深度预算 | 元组计数器限深（TanStack 限 5） | 实例化成本随深度组合膨胀；react-hook-form 有 eager/lazy 求值之辨 | 嵌套字段（后置决策） |
| 3.5 | `NoInfer`（TS 5.4+ 内置） | 逆变量位固定推断源，防回调参数反客为主 | 版本门槛 | 回调/事件签名 |
| 3.6 | `Getter` 幽灵泛型 | `<TTValue = TValue>() => NoInfer<TTValue>` | 学习成本 | 可选的 `getValue<T>()` 式 API（默认不做） |
| 3.7 | 声明合并 | 空接口 + `declare module` | 全局污染（v9 为此加 per-table 槽） | ColumnMeta / 插件扩展 |
| 3.8 | `Updater<T>` / `OnChangeFn` | `T \| ((old: T) => T)` | — | 受控状态（后置） |
| 3.9 | `IsAny` / `UnionToIntersection` 等 | 类型元工具 | — | 内部实现 |

关键示例（spike 直接采用）：

```ts
// 3.1 映射联合：每列 K 专属，数组位置不擦除
export type Columns<T extends object> =
  readonly ({ [K in keyof T]: ColumnDef<T, K> }[keyof T] | LooseColumnDef<T> | DisplayColumnDef<T>)[]

// 3.4 深度预算（Prev 元组闸门）
type Prev = [never, 0, 1, 2, 3, 4]
export type Paths<T, D extends number = 3> = [D] extends [never] ? never
  : T extends object
    ? { [K in keyof T]-?: K extends string | number
        ? `${K}` | `${K}.${Paths<Recurse<T[K]>, Prev[D]>}` : never }[keyof T]
    : never
```

---

## 4. 映射到三层架构：T 的生命周期（stage-1 直接输入）

### 4.1 core 层（纯 TS，零框架依赖）

```ts
export interface TableOptions<T extends object> {
  data: readonly T[]                                  // T 的第一推断源
  getRowId: (row: T) => string                        // 必填（ADR 决策 11）
  columns: Columns<T>                                 // 映射联合（§5 决策 1）
  getRowChildren?: (row: T) => readonly T[] | undefined | false  // 树形非侵入（ADR 决策 8）
}

export function createTable<T extends object>(options: TableOptions<T>): Table<T>
```

- `Table<T>` 方法级泛型：`sortBy<K extends keyof T>(field: K, dir: 'asc' | 'desc')`、`setCellValue<K extends keyof T>(rowId: string, field: K, value: T[K])`——**K 从实参 field 推断，value 随之收敛**。
- **mutation 维持 unknown**：`SetCellMutation { prev/value: unknown }` 不动。依据 D-3：COMMAND→MUTATION 是可序列化数据 + 未来 OT 的 transform 单位，类型化放在边界（编辑描述符、命令式方法）而非数据层。
- selection 状态机以 `rowId: string` 为键，**不泄漏 T**（正交性，ADR 决策 9）。
- `CellContext<T, K> { value: T[K]; row: T; rowId: string; index: number }` 定义在 core——纯数据，不含 VNode。

### 4.2 renderer / adapter 接缝

`renderCell?: (ctx: CellContext<T, K>) => VNodeChild` 这类含框架类型的返回值**只出现在 adapter/renderer 的扩展接口**（TanStack table-core 与各框架包分包的同构证据）。core 类型零 Vue 依赖 → React 后置可行。

### 4.3 Vue adapter 硬约束（RFC discussion #436 系）

- `<script setup lang="ts" generic="T extends object">`；**模板不支持组件显式类型实参**（`<Foo<Bar>>` 非法）→ **API 必须设计成 T 恒从 prop 推断**（`:store` / `:data`），用户永不手标。
- TSX / defineComponent 无法表达泛型组件构造子 → 不承诺 HOC 式泛型用法。
- **动态命名的 per-column slot 不可类型化**（Element Plus 的教训）→ 单元格定制走列定义 `renderCell`（类型化）或列级泛型组件，不提供 `scope: any` 式插槽。
- `defineEmits` 事件 payload 携 `row: T`、`field: keyof T`；表级 slot 用 `defineSlots` 类型化。
- radekmie「hook 必须显式传 T」陷阱：我们的 T 从 `data`/`store` prop 推断，天然规避。

### 4.4 T 的约束与陷阱

- `T extends object`（最宽）。**陷阱（必须记录）**：`T extends Record<string, unknown>` 会**排除 `interface` 声明的行类型**——隐式索引签名只对 type alias 生效，interface 没有。spike 有回归测试（断言 ⑫）。

---

## 5. 决策矩阵（已经 spike 实证，依据见 `spike/2026-09-05-types-demo/RESULTS.md`）

| # | 决策点 | 选项 | 推荐 | 依据与权衡轴 |
|---|---|---|---|---|
| 1 | 列定义形态 | A 映射联合 / B helper（`typedColumn<T,K>`）/ C 判别联合 + TValue 泛型 | **A 为主 + B 逃生舱**；弃 C。**硬约束：联合成员必须两两判别互斥**（spike 关键发现，见下） | 轴：每列值推断 × 零仪式 × 拼写检查 × 动态列 × 报错质量。A 唯一同时满足清单 ①②⑧；C 是 TanStack #4302/#4382 的直接痛点；动态列（服务端 schema）走 path 判别的裸字面量或 helper 宽化（value=unknown） |
| 2 | 字段寻址 | keyof only / DeepKeys（深度 3–5）/ `(string & {})` 逃生 | **keyof（映射联合天然枚举）**，深路径后置 stage-2+ 按需 | 轴：补全完备 × 嵌套支持 × 实例化成本。宽表的 DeepKeys 组合膨胀（react-hook-form eager 教训）；TanStack 限深 5 的成本信号。spike 已实证 `Paths<T,3>` 产物精确、`DeepValue` 可用（RESULTS.md §3） |
| 3 | 行类型约束与树形 | `T extends object` / `Record<string, unknown>`；children 约定字段 / 回调 | **object + `getRowChildren` 回调** | interface 排除陷阱（§4.4，spike 断言 ⑫ 实证）；回调非侵入（树是投影不是数据形状） |
| 4 | 编辑值类型边界 | 全链 TValue / core unknown + 边界类型化 | **core 命令层 unknown + 编辑描述符（`parse: (raw: string) => T[K]`）与 `setCellValue<K>` 承担拒错** | D-3：mutation 是序列化数据；类型化放 edge；清单 ④⑨ 双路满足（spike 断言 ⑤⑥ 实证） |
| 5 | meta 扩展 | 声明合并 / per-table 类型槽 / 泛型 TMeta | **空接口声明合并（v1）+ 预留 per-table 槽** | v9 双轨演进的直接证据：全局 merge 有多表冲突；泛型参数路径爆炸。spike 实证 paths 别名下的声明合并正反例均生效（断言 ⑪） |
| 6 | Vue 组件 API 形态 | store-object prop / exploded props + useTable | **store-object prop（`generic="T"`）为主** | RFC #436 限制下 T 必须从 prop 推断；与两个 spike 已验证的消费模式一致。spike 实证 `:store` 推断 + 模板 `@vue-expect-error` 探针（RESULTS.md §1） |
| 7 | 类型测试框架 | vitest --typecheck / tsd | **vitest --typecheck**（仓库 vitest 3.2 已支持，零新依赖） | 工程一致性；spike 14 断言 + 红丸验证通过（RESULTS.md §4） |

**决策 1 的判别矩阵细则（spike 三次失败设计换来的规则）**：TS 对联合上下文的过滤只认
「字面量**已携带**的属性被成员拒绝」，缺必填属性**不会**排除成员。因此：

```ts
interface ColumnDef<T, K>     { field: K;      id?: never;  path?: never; … }  // 键控列
interface DisplayColumnDef<T> { field?: never; id: string; path?: never; … }  // 展示列
interface LooseColumnDef<T>   { field?: never; id?: never; path: string & {}; … }  // 动态列
```

宽化成员若复用 `field: string & {}`（TanStack v9 `(string & {})` 式放宽），键控字面量会命中它：
逐列推断退化为 any **且 typo 检测整体消失**（`'yaer'` 作为动态列合法）。`loose: true` 类必填
标记也救不回来（缺必填不排除）。只有互斥判别属性对（field/id/path，非本位 `?: never`）能让
每个字面量把上下文收窄到唯一成员。**stage-1 新增列变体必须同步扩矩阵，并加 CI 类型断言守住。**

> 红丸（防假绿）：注释掉任一 `@ts-expect-error` → 双轨变红；翻转 expectTypeOf 泛型 → 变红；
> 恢复复绿。类型断言确实在断言。

---

## 6. 性能与工程化

- **实例化成本**：映射联合对 `keyof T` 线性展开（安全）；DeepKeys 是组合增长（后置理由之一）。spike 记录 20 列行型的编译延迟体感。
- **CI 类型测试双轨**（spike 已实证配置）：`vitest run --typecheck`（`*.test-d.ts`，expectTypeOf + `@ts-expect-error` 负测）管纯 TS 面（tsc 不解析 `.vue`，配 `typecheck.ignoreSourceErrors: true`）；`vue-tsc --noEmit` 管全程序与模板面。**负向用例一律写单行对象**——联合上下文下报错位置可能在对象字面量任意列。
- **判别矩阵完整性断言**：列定义新增变体时，CI 必须带一条「三类字面量混排 + typo 拒绝」断言（spike 断言 ⑬ 即范本），防止宽化成员静默退化键控。
- **JSDoc 标准**（清单 ⑦ 的载体）：每个导出类型/方法中文一句话 + `@example`；列定义字段的 hover 即文档。
- **dts 卫生**：core 包 types 独立入口、无 Vue 类型泄漏；`skipLibCheck` 下用户侧仍可声明合并。
- **TS peer 范围**：`>=5.4`（内置 NoInfer；satisfies / const 泛型参数全覆盖）。watch item：tsgo 对深层泛型实例化的影响。

---

## 7. 结论速览（供 stage-1 引用；全部经 spike 实证）

1. 列定义走**映射联合** `{ [K in keyof T]: ColumnDef<T, K> }[keyof T][]`——每列回调精确 `T[K]`，零标注零仪式；动态列走 path 判别字面量或 `typedColumn` helper 宽化（value=unknown）。
2. **判别矩阵是映射联合的硬约束**：field（键控）/ id（展示）/ path（动态）两两互斥，非本位属性 `?: never`；宽化成员复用 `field` 会让逐列推断与 typo 检测整体退化（TanStack v9 `(string & {})` 同款代价）。新增列变体必须同步扩矩阵 + CI 断言。
3. 弃判别联合 + TValue 泛型形态（TanStack #4302/#4382 痛点结构）。
4. core 命令层值类型维持 **unknown**（D-3 序列化/OT 边界），拒错能力放编辑描述符（`parse: (raw) => T[K]`）与 `setCellValue<K>` 方法级泛型。
5. `CellContext<T, K>` 在 core（纯数据）；VNode 只进 adapter 扩展接口——core 零框架依赖不破。
6. 字段寻址 v1 只用 **keyof**；DeepKeys（深度预算 ≤3，spike 已验产物精确）后置 stage-2+ 按需引入。
7. 行约束 `T extends object`（禁 `Record<string, unknown>`——interface 排除陷阱，spike 断言 ⑫）；树形走 `getRowChildren` 回调。
8. Vue 组件 `generic="T extends object"`，T 恒从 prop（`:store`/`:data`）推断；单元格定制走 `renderCell` 不走动态插槽（Element Plus 教训）；模板负向探针用 `<!-- @vue-expect-error -->`。
9. meta 扩展：空接口声明合并 v1（spike 已验 paths 别名下生效），预留 per-table 类型槽（v9 双轨证据）。
10. 工程化：`vitest --typecheck`（ignoreSourceErrors，管 test-d）+ `vue-tsc --noEmit`（管全程序与模板）双轨进 CI；负向用例单行对象；红丸验证防假绿；JSDoc 全覆盖；TS peer `>=5.4`。
11. 实证依据：`spike/2026-09-05-types-demo/RESULTS.md`（14 断言 + 红丸 + 手动 Volar 清单待办）。

---

## 8. 参考资料

**TanStack**：GitHub `TanStack/table` main 分支 `packages/table-core/src/types/`（ColumnDef.ts / TableFeatures.ts / type-utils.ts，源码核验）；issues [#4302](https://github.com/TanStack/table/issues/4302)、[#4382](https://github.com/TanStack/table/issues/4382)；discussion [#4195](https://github.com/TanStack/table/discussions/4195)；v9 官方文档 tanstack.com/table。
**radekmie**：[On Refactoring With Generic Types](https://radekmie.dev/blog/on-refactoring-with-generic-types/)（2026-03-30，全文核验）。
**AG Grid**：[TypeScript Generics 官方文档](https://www.ag-grid.com/javascript-data-grid/typescript-generics/)；issue [#6741](https://github.com/ag-grid/ag-grid/issues/6741)（field 键控）；[StackOverflow 77829149](https://stackoverflow.com/questions/77829149/)（值推断诉求）。
**Element Plus / vxe**：issue [#3233](https://github.com/element-plus/element-plus/issues/3233)；[el-table 文档](https://element-plus.org/en-US/component/table)（generic 属性）；vxe-table（待核实）。
**Vue**：RFC discussion [#436](https://github.com/vuejs/rfcs/discussions/436)（泛型组件限制）；Vue 3.3+ `generic` SFC 文档；`@vue-expect-error` 模板指令（Vue 3.4+）。
**TypeScript**：[#58031](https://github.com/microsoft/TypeScript/issues/58031)（satisfies 作泛型约束，open）；TS 4.9（satisfies）/ 5.0（const 类型参数）/ 5.4（NoInfer）release notes；react-hook-form `FieldPath`（深路径生产参照，文件路径待核实）。
**本仓**：`spike/2026-09-05-grid-demo/src/core/`（现状未类型化 API）；`spike/2026-09-05-types-demo/`（本次类型 spike）。
