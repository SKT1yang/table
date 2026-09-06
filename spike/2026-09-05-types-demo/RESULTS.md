# Spike 结果：类型体验验证（types-demo）

> 日期：2026-09-05。目标：验证 `01-typescript-types-research.md` §5 决策矩阵的关键推荐在
> TS 5.9 + Vue 3.5 + vue-tsc 3.3（Volar）下成立。只验类型模式，不含渲染实现。
> 工具链与 grid-demo 完全一致（零新增依赖）。**结论：7 项决策推荐全部成立，其中决策 1
> 需补一条关键细则（判别矩阵），见 §2。**

验证命令：`pnpm typecheck`（vue-tsc，全程序）｜`pnpm test:types`（vitest --typecheck，14 断言）｜
`pnpm test`（运行时桩冒烟，4 例）。三者全绿。

---

## 1. 断言结果（对照文档 §1.2 验收清单）

| # | 断言 | 结果 |
|---|---|---|
| ① | 无标注列数组通过（T 从 data/getRowId 推断，零 `<Movie>` 标注） | ✅ |
| ② | typo field 拒绝（`'yaer'` 报 TS2322） | ✅ |
| ③ | renderCell 的 value 精确 `T[K]`（number / string[] 分别断言）+ row 精确 `T` | ✅ |
| ④ | 值类型误用拒绝（number 列上 `value.length`） | ✅ |
| ⑤ | setCellValue 拒错值 / 收对值（field 推断 K，value 收敛） | ✅ |
| ⑥ | 编辑描述符 parse 返回值收敛 `T[K]`（返 number 给 title 列被拒） | ✅ |
| ⑦ | sortBy 拒 typo + dir 字面量联合 | ✅ |
| ⑧ | getRowId 参数精确 `T` | ✅ |
| ⑨ | `Paths<Movie>`（深度 3）产物精确六元联合 | ✅ |
| ⑩ | `DeepValue<Movie,'meta.lang'>` = `string \| undefined`（可选属性带入） | ✅ |
| ⑪ | ColumnMeta 声明合并：`tone` 可用、`ton` 被拒（经 tsconfig paths 别名 `@table/core`） | ✅ |
| ⑫ | interface 行型通过（`T extends object` 不排除 interface） | ✅ |
| ⑬ | 动态列宽化：helper 与裸字面量（path 判别）value 均 unknown、row 均 T、展示列混排不受影响 | ✅ |
| ⑭ | Updater 双态（直接值 / 函数式）+ dir 字面量拒错 | ✅ |

模板面（vue-tsc 把关，`src/Usage.vue`）：泛型组件 `generic="T extends object"` 从 `:store` 推断 T ✅；
`@vue-expect-error` 模板探针（`r.noSuchField`）报错确认 ✅；slot props `{ rows }` 推断 ✅。

## 2. 关键发现：逃生舱判别矩阵（决策 1 补充细则）

映射联合 `{ [K in keyof T]: ColumnDef<T, K> }[keyof T][]` 本身逐列推断良好，**但联合里加入任何
「宽化成员」会连锁破坏推断与键控**。三个失败设计（均经 tsc 二分复现）：

| 设计 | 结果 | 机理 |
|---|---|---|
| A. 宽化成员复用 `field: string & {}` | ❌ 全部 renderCell 参数 any，且 **typo 检测消失**（`'yaer'` 作为宽化列合法） | 键控字面量的 `field:'title'` 可赋给 `string & {}`，宽化成员不被过滤，上下文停在多成员联合，函数签名合成失败。TanStack v9 `accessorKey: (string & {}) \| keyof TData` 的放宽正是这个代价 |
| B. 加 `loose: true` 必填标记 | ❌ 依旧 any | TS 过滤联合上下文只认「**字面量已携带的属性被成员拒绝**」；字面量缺必填属性**不会**排除成员 |
| C. 宽化成员改 `field?: never` + `path: string & {}`（其余成员不加互斥位） | ❌ 键控列恢复，但**展示列字面量**推断断裂（被宽化成员污染） | 同上：展示字面量缺 `path`，无法排除宽化成员 |
| **D. 互斥判别矩阵（最终）** | ✅ | 见下 |

**最终矩阵**——三成员两两互斥，非本位属性一律 `?: never`：

```ts
interface ColumnDef<T, K>       { field: K;        id?: never; path?: never; … }
interface DisplayColumnDef<T>   { field?: never;   id: string; path?: never; … }
interface LooseColumnDef<T>     { field?: never;   id?: never; path: string & {}; … }
```

语义顺势清晰：**field = 键控（keyof T）、id = 展示列、path = 动态列（任意字符串，未来与深路径
DeepKeys 命名对齐）**。每个字面量自带的判别属性恰好把上下文收窄到唯一成员，逐列推断与
typo 检测同时存活。

> 对 stage-1 的硬约束：**新增任何列变体都必须加入判别矩阵**（自带本位判别属性 + 其余成员补
> `?: never`），否则整个列定义的类型体验退化。建议进 CI 类型测试守住（本 spike ⑬ 即范本）。

## 3. 其余实证记录

- **声明合并经 paths 别名可行**：`declare module '@table/core'`（tsconfig paths 指向源文件）合并
  `ColumnMeta` 生效，正反例均有。备选方案（包名自引用）未启用。
- **interface 行型**：`T extends object` 下 `interface Film` 正常；`Record<string, unknown>` 约束
  会排除 interface（隐式索引签名陷阱），文档 §4.4 成立。
- **深路径**：`Paths<T, D=3>`（Prev 元组闸 + 排除数组/Date）产物精确；`DeepValue` 对可选属性
  返回 `| undefined`。20 列级宽表未见可感知编译延迟（体感，未量化）。
- **负向断言的报错位置**：联合上下文下，列对象整体的不可赋值错误可能报到对象字面量行而非
  具体属性行——**负向用例一律写单行对象**，让 `@ts-expect-error` 覆盖任意报错列。
- **vitest --typecheck 分工**：tsc 不解析 `.vue` 导入，配置 `typecheck.ignoreSourceErrors: true`，
  `.vue` 与全程序检查归 `vue-tsc`（双轨分工，文档 §6）。

## 4. 红丸记录（防假绿）

1. 注释掉断言 ② 的 `@ts-expect-error` → `pnpm typecheck` 报 `TS2322: '"yaer"' is not assignable…`，
   `pnpm test:types` 2 failed ✅（测试有能力失败）
2. 断言 ③ 的 `toEqualTypeOf<number>()` 改 `<string>()` → `pnpm test:types` 报
   `Expected string, Actual number` ✅
3. 恢复后三命令复绿 ✅

## 5. 手动 Volar 清单（编辑器内体验，CI 无法覆盖，待在 VSCode 逐项过）

- [ ] `pnpm dev` 打开 `src/Usage.vue`：在 columns 里新写一行 `{ field: '` → 出现 keyof Movie 补全
- [ ] hover `ColumnDef` / `renderCell` / `parse` → 显示中文 JSDoc 与 @example
- [ ] 模板内 slot props `rows` 悬停显示 `readonly Movie[]`；故意写 `r.noSuchField` 出红色波浪线
- [ ] 输入无卡顿（20 列级行型）
- [ ] `grep -n '<Movie>' src/Usage.vue` 仅逃生舱 `typedColumn<Movie>` 一处显式标注
- [ ] 记录映射联合 typo 的报错信息原文（union 报错宽泛度体感，决策 1 报错质量轴）

## 6. 对 §5 决策矩阵的修正意见

- 决策 1：推荐不变（映射联合为主 + helper 逃生舱），**追加判别矩阵细则**（§2）——裸动态列
  字面量（path 判别）亦可用，不强制 helper。
- 决策 2/3/4/5/6/7：无修正，全部实证成立。
- 新增工程化建议：类型测试中为「判别矩阵完整性」加一条断言（新增列变体时防止退化）。
