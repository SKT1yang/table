# 讨论纪要：类型体验六个追问（QA）

> 时间：2026-09-05，紧随 `01-typescript-types-research.md` 定稿之后的讨论整理。
> 性质：主文档的补充与细化——五个追问都源于「为什么这样设计」，答案落在 TS/打包/多版本机制层。
> 与主文档的关系：Q1/Q2 细化 §5 决策 1 与 §4.3；Q4/Q5 扩充 §6 工程化未覆盖的**发布后类型存续**问题。
> 编号沿用主文档的决策号，便于回查。

---

## 1. Q1：`createTable` 和 `typedColumn` 都是必须的么？

**结论：入口必须存在（形态名字不限），helper 是糖、可不进首发 API。**

- 用户代码里必须存在**某个携带 `T` 的泛型入口**——函数、composable、组件 prop 皆可，桥的结构才是本质：签名里 `data` 的类型与 `columns` 的类型绑定**同一个 `T`**。
- 完全没有入口（裸 `const cols = [...]`）不成立：上下文不存在，用户被迫手写 `Columns<Movie>` 标注，验收清单第 8 条（泛型零标注）破功。
- `typedColumn` 不必须：判别矩阵落地后，动态列裸字面量 `{ path: 'boxOffice', ... }` 即可（spike 断言 ⑬ 实证）。残余价值仅两处——从服务端 schema **循环生成列**时（`.map` 回调里的字面量拿不到外层 `Columns<T>` 上下文，helper 的显式 `<T>` 是唯一让 `row` 有类型的写法）、以及语义糖。
- **对 stage-1**：入口函数必进 API；helper 先不进，等真实「循环生成列」需求再加（避免 API 提前膨胀）。

## 2. Q2：为什么必须有泛型入口？裸 `const cols = [...]` 看起来很美好

**结论：TS 给代码定类型只有两条通道，回调参数的类型只能来自第二条，而第二条需要一个期望类型的源头。**

| 通道 | 方向 | 例子 |
|---|---|---|
| 自下而上（推断） | 从值推导类型 | `const cols = [...]`：编译器看着字面量造类型 |
| 自上而下（上下文化） | 期望类型灌进字面量、**给回调参数注入类型** | `createTable({...})` 里 columns 的检查 |

- 裸写下编译器眼里**没有 T**：`field` 宽化成 `string`，`renderCell` 的参数无类型（隐式 any 报错）。`'year'` 字符串与 `Movie` 接口之间不存在编译期关联——**类型不按名字跨语句传播，只沿数据流走**。
- 入口做的事：`data: movies` 自下而上推出 `T = Movie` → 同一个 `T` 把 `Columns<Movie>` 作为期望类型灌进 columns 字面量 → 映射联合展开 → 每个对象字面量靠判别属性收窄到唯一成员 → 回调参数从该成员注入。
- 三种写法的命运：A 裸写 = `value: any`；B 标注 `const cols: Columns<Movie>` = `value: number` 但要手写泛型；C 入口内联 = `value: number` 且零标注。
- **推论（hoisting 陷阱）**：字面量必须**内联写在调用里**。先存变量，类型在声明处已定格（`field: string`），再传给入口报 `string` 匹配不上 `field: K`——TS 不做回头重新上下文化。想 hoist 只能走 B 标注或 helper（TanStack 的 columnHelper 一半为这个而生）。

## 3. Q3：手动标注 `Columns<Movie>` 也行？

**结论：功能完全成立，是备胎不是错误路径；代价是「一个类型来源变回两个」。**

```ts
import type { Columns } from '@table/core'   // 代价 1：引工具类型（API 面泄漏）
const movies: Movie[] = ...                   // 来源 1
const cols: Columns<Movie> = [...]            // 代价 2：Movie 手写第二遍
```

- **漂移风险**：`Movie` 钉死两处。数据换型（`movies: Film[]`）时标注不跟随，错误拖到 `createTable` 调用点才以费解的联合不匹配爆出——离根因远。C 路径里 T 只有一处定义，columns 永远自动跟随。
- 场景分工：列内联在入口里（绝大多数用户）→ C 零标注；列要 hoist / export / 循环生成 → B 标注或 helper。
- **对 stage-1**：`Columns<T>` 及全部公共工具类型必须导出——「默认路径零标注」不等于「禁止标注」。

## 4. Q4：打包 external 后，d.ts 里会出现 `import("vue").xxx` 吗？宿主没这个包会怎样？

**结论：会、且必须会；宿主缺包时大概率静默退化 any——这正是 core 零外部 import 的完整论证。**

- `external` 是 **JS bundler 的概念**；类型从来不是被打进来的——**自己写的类型内联进 d.ts，别人的类型永远只留按模块名的引用**，由宿主就近解析。
- 形态：`tsc -d` 产顶层 `import type { VNodeChild } from 'vue'`；tsup / api-extractor / rollup-plugin-dts 这类 **d.ts 摊平工具**产行内 `import("vue").VNodeChild`（合并多文件时避免顶层 import 洪水与命名冲突），语义等价。d.ts 工具链里 vue 不标 external 会把 vue 类型整个内联——体积爆炸 + 宿主侧「两份类型」身份分裂。
- 宿主三种情况：

| 宿主情况 | 结果 |
|---|---|
| 装了 vue（组件库宿主常态） | 正常解析；同一份 vue → 类型同一性成立 |
| **没装** | TS2307 报在库的 d.ts 里；宿主几乎都开 `skipLibCheck: true` → **错误被吞、相关类型静默 any**（最恶性：不报错也不工作） |
| 解析出两份 vue | 结构相同类型多数仍统一；symbol / 私有字段 / brand 报「两个独立声明」不可赋值 |

- **幽灵类型**风险：公共类型面不小心 import 了未声明在 `dependencies` 的传递依赖——本地被 hoist 解析到，发布后宿主编译断裂。
- **对 stage-1**（三条规矩）：
  1. core 的 d.ts **零外部 import**——让 Q4 整体不成立（不是让引用可解析，是让引用不存在）；React/Node 宿主引用 core 不可能因解析环境退化。
  2. adapter 的 d.ts 合法含 `import("vue")` → vue 进 `peerDependencies`（宿主必有）。
  3. **产物类型测试**：attw / publint + `file:` 协议装 tarball 的 fixture 工程对打包后 d.ts 重跑 14 条断言——源类型绿 ≠ 产物类型绿（主文档 §6 补此缺口）。

## 5. Q5：多个业务组件用我们的 table、版本还不一样，app 里会出问题么？

**结论：会，分运行时与类型两面；我们的结构已排掉「静默坏掉」的雷，剩下是纪律。**

前提：版本范围兼容时 npm/pnpm 通常 dedupe 成**一份**；跨大版本/范围冲突出现**嵌套拷贝**（两份同 app）——后者是危险态。

**运行时断裂点**：

| 断裂点 | 机理 | 本项目状态 |
|---|---|---|
| 双份代码体积 | bundle 各来一份 | 生态税，树摇缓解 |
| 模块级单例不共享 | 两拷贝各一份 module state | `createTable` 返回独立实例，**免疫** |
| `provide/inject` symbol 分裂 | InjectionKey 按**身份**匹配，跨拷贝 inject 得 undefined | 决策 6 走 store-object prop 直传，**结构性免疫** |
| CSS 类名冲突 | DOM 渲染 + 两版样式互覆 | DOM adapter 需版本前缀 / CSS Modules；canvas 路线免疫 |
| `instanceof` 跨拷贝失效 | 两个构造函数 | API 面无 class 谓词，免疫 |

**类型面**：程序里同时存在两份类型，TS 按导入文件**就近解析**。兜底是结构化类型——纪律是 **major 内公共类型 additive-only**（加可选、加重载，不动已有签名）。三个具体断裂点：

1. **声明合并就近解析**（对本项目最致命）：业务组件的 `declare module '@table/core'` 增强按名字就近命中其中一份物理拷贝，另一份的 `ColumnMeta` 仍是空的，且 `skipLibCheck` 吞成静默 any（同 Q4 机制）。
2. **dedupe 成一份时反向中招**：多个业务组件的 meta 增强**全局合并互相污染**（A 的 `tone` 出现在 B 的列里）——TanStack v9 per-table 槽要解决的问题在多业务组件场景同构复现；决策 5 的双轨预留即为此。
3. **GlobalComponents 冲突**：两版本向 `GlobalComponents` 声明合并同一组件名 → 接口冲突。对策：不依赖全局注册，SFC 显式 import。

**对 stage-1 的四条纪律**：类型 semver major 内 additive-only；meta 双轨（v1 全局合并 + 文档警示，per-table 槽按需提前）；不做 GlobalComponents / app.use 强依赖；DOM adapter CSS 版本前缀。另：FAQ 引导宿主 dedupe（`pnpm dedupe` / resolutions）。

---

## 6. Q6：data/columns 必须像 createTable 那样合成单个属性给组件？分开不行也不推荐吧？

**结论：「不推荐」对，「分开=不行」不对。硬要求不是属性个数，而是——列字面量的检查点必须和 T 的推断点处在同一个完整表达式里，且离纯 TS 环境越近越稳。**

| 写法 | 类型推断 | 备注 |
|---|---|---|
| ① script 里 `useTable({ data, getRowId, columns: [内联] })` → `:store="table"` | ✅ 已实证（spike 断言 ①） | 推断在纯 TS 函数调用里；组件边界只推**已定型**的 `Table<T>` |
| ② 分散泛型 props `<DataTable :data="movies" :columns="[内联]" />` | ⚠️ 机制上应当成立，**未实证** | Volar 把 props 合成单个对象字面量做 context-sensitive 推断，与函数调用同机制；但这是链条里最脆、最少被生产验证的环节 |
| ③ 分散传 + hoist（script 裸写 `const cols` 再 `:columns`） | ❌ | Q2 hoisting 陷阱原样复现 |

决策 6 选 store-object（①）的四条理由：**推断分层**（最难的推断放最稳环境，组件面最笨）；**编辑体验**（几十列配置写在 template 属性字符串里，TS 服务差一档）；**状态所有权**（分散 props 需组件管「props→内部 store」同步，store-object 下组件是纯渲染器）；**实证不对称**（① 全绿，② 需另开 spike 且收益为零）。关系链：`createTable`（core）→ `useTable`（adapter，同一 options 泛型）→ 组件只收 `:store`——**所有类型魔法都发生在用户 script 的一次函数调用里**。

---

## 7. 本纪要对主文档的增量修正

| 项 | 主文档原表述 | 本纪要细化 |
|---|---|---|
| 决策 1 逃生舱 | 「A 为主 + B 逃生舱」 | helper 可**不进首发 API**（裸 path 字面量已覆盖，断言 ⑬） |
| §4.3 T 恒从 prop 推断 | 结论性陈述 | 补机制论证（双通道 + 桥），及 hoisting 陷阱作为 `Columns<T>` 必须导出的理由 |
| §6 工程化 | CI 双轨 + dts 卫生 | 补**产物类型测试**（attw / tarball fixture）与幽灵类型关口 |
| §6 工程化 | 未覆盖多版本 | 补多业务组件多版本两面断裂点与四条纪律 |
| 决策 6 store-object prop | 结论性推荐 | 补机制论证：分散泛型 props 可行但走 Volar 合成层（未实证）；硬不变量是「字面量与 T 推断同表达式」+ 推断分层（Q6） |
