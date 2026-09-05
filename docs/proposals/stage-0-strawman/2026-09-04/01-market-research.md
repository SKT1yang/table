# 表格组件市场调研 — 底层架构差异分析

> 调研时间：2026-09。方法：三路并行网络调研（DOM 渲染类 / Canvas·电子表格引擎类 / 专项技术与趋势），以官方文档、官方架构博客、GitHub 仓库与一手源码分析为主。
> 版本基线：TanStack Table v8(稳定)/v9(2026-06 Beta)、AG Grid v36.x、antd 5.x、Element Plus 2.x、Naive UI 2.45、MUI X Data Grid v9(2026-04)、DevExtreme v24.2+、Univer(当前版)、Luckysheet(已归档)。
> 本文档是 `02-direction.md`（方向决策记录）的依据。**结论速览见 §10。**

---

## 1. 市场三类形态

| 形态 | 代表 | 本质 | 数据模型 |
|---|---|---|---|
| **业务列表表格** (data grid) | TanStack Table、AG Grid、antd Table、Element Plus、MUI X、Handsontable | 行数组 + 列 schema 的展示/编辑，read-mostly | 行数组 + 稳定 rowId |
| **类 Excel 电子表格** (spreadsheet engine) | Univer、Luckysheet(已归档)、SpreadJS、ReoGrid、wolf-table | 单元格是原子操作对象的"文档"，read-write | 稀疏 cell model |
| **多维表格** (record-based) | 飞书 Bitable、APITable/AITable、Baserow、NocoDB | 记录 + 字段 schema + 多视图投影（表格/看板/画廊），重后端产品 | 记录 + 字段类型 |

两个品类的分化判断（rv-grid 2026 综述）：**数据网格（read-mostly）与电子表格（read-write 文档）是两个物种**——前者 DOM 虚拟化 + 服务端行模型足够，后者全面 canvas 化 + 独立公式引擎。

**事实核查与勘误**：
- `joywave`、`react-big-data-grid` 经检索**不存在**（调研提纲中的误记）
- 真实活跃的新方案：**wolf-table**（x-spreadsheet 同作者后继）、**ReoGrid Web**（2026 活跃）、**virtua**（零配置虚拟滚动库）
- **Glide Data Grid 上游开发停滞**（最后大版本 v6.0.3，约 2024 初），社区 fork `@glideappsfinal/glide-data-grid` 维护 React 19 兼容
- **Luckysheet 已归档**，官方指引迁移到 Univer（原班人马公司级重写）

---

## 2. 差异维度总览

所有表格组件的底层差异可以归为四个维度：

| 维度 | 问题 | 选项谱系 |
|---|---|---|
| **D1 渲染层** | 谁来画、画在哪 | 原生 `<table>` → div 自绘管线 → canvas → WebGL |
| **D2 数据模型** | 数据长什么样 | 行数组 / 稀疏 cell model / 记录+schema |
| **D3 状态与更新粒度** | 改一个格子，谁重画、画多少 | 框架响应式(行级) → selector 订阅 → signals(cell级) → 引擎自持 diff |
| **D4 扩展与命令流** | 编辑/撤销/协同如何统一 | 可插拔 row model / 插件系统 / Command→Mutation 流 |

性能边界速查（DOM 无虚拟化 ~1k 行 → DOM+窗口化 ~10 万行 → canvas 100 万行+；Handsontable 官方实践口径 1 万~10 万行，AG Grid Client-Side 10 万+，"浏览器内存先爆，网格后出问题"）。

---

## 3. D1 渲染层

### 3.1 DOM 路线：`<table>` 与虚拟化的结构性冲突

- **antd/rc-table**：真实 `<table>` 元素。固定列 v4 起用 `position: sticky`（v3 时代克隆整表）；虚拟滚动 v5.9+ 的实现方式是**把 `<tbody>` 替换为 rc-virtual-list**（与 Select/Tree 同一虚拟列表，并为此补了横向滚动支持）——"语义化元素"与"虚拟化"靠组件替换缝合，**只做纵向虚拟化、无列虚拟化**（社区高频抱怨：50+ 列场景受限）。树形靠 `useFlattenRecords` 拍平；rowSpan 合并单元格在虚拟滚动下要靠 `extraRender({start,end})` 只对可见区两侧收集再裁剪，最坏情况退化全量渲染。
- **Element Plus**：干脆维护**两套组件**——`el-table`（`<table>` + sticky 固定列，富交互、无虚拟化）与 `el-table-v2`（**div 网格**，main/left/right 三区，虚拟化，定制性低）。侧面印证 `<table>` 语义与虚拟化的结构性冲突。v2 行高双模式：`row-height` 定高 / `estimated-row-height` 实测动态（估不准会跳动），`cache=2` 预渲染，`fixed-data` 吸顶行；**colspan/rowspan 需自定义 row renderer 手工实现**（div 布局的代价）。
- **结论**：新一代高性能 DOM 网格（AG Grid、MUI X、el-table-v2）**清一色放弃 `<table>` 改用 div**。`<table>` 的语义/a11y/CSS 生态优势，换来的是虚拟化、单元格合并、固定列的处处受限。

### 3.2 逐库架构要点（DOM 系）

#### TanStack Table v8 → v9（本次调研最重要发现）

- **v8**：纯 headless——只有「状态管理内核 + 行模型管线」（core→filtered→sorted→grouped→expanded→paginated，memo 化纯函数），渲染 100% 归使用者；虚拟化不内置（配 TanStack Virtual）；受控/非受控皆可，不可变更新。
- **v8 的三个结构性问题**（官方博客自述）：① 状态管理不符合 React 官方模式，React Compiler 稳定后直接"开始崩"；② **无法控制重渲染范围**——任意状态变化整表重渲染，大表被迫堆 memo hack；③ 大规模虚拟化表内存占用过高（每行/cell 对象挂方法，R×C×N 封装面）。
- **v9（2026-06 Beta）底层重写**：
  - 底层换 **TanStack Store（signal 实现，基于改造版 alien-signals）**，**每个特性一个独立 atom**（pagination、rowSelection、columnSizing、columnFilters…），`table.store` 派生聚合视图；
  - 新增 **optionsStore**：选项（data、columns…）也进响应式图，不再构造期快照；
  - 核心只依赖 Atom/ReadonlyAtom **契约**：signal 原生框架（Angular/Solid/Vue）用原生原语实现，React 用 @tanstack/react-store（`useSyncExternalStoreWithSelector` 桥接）；
  - React 端细粒度重渲染 **opt-in**：`useTable(table, selector)` 缩小订阅面 + `<Subscribe>` 在低层级建独立订阅边界（勾一行 checkbox 不重渲染其它行/分页/筛选）；
  - **特性树摇化**：feature 以类插件方式注册，不注册则无 API 也无代码。
- **对本次选题的意义**：业界头部库刚刚收敛到「signal 核 + 框架适配器」架构，与"框架无关 core + Vue3 适配"的目标路线完全同构。

#### AG Grid v36

- **div 网格 + 自研引擎（MVC）**：数据项包装为 `RowNode`（含选中态/行高），全局唯一 `RowRenderer` 监听 `modelUpdated` 直接操作 DOM；**核心不是 React**——经典架构里 React 组件经 React Portal 挂载（`ag-react-container` 包裹），v26 起 "React UI" 渲染引擎把 React 适配层 100% React 化（去 portal、Profiler 可见），**但行列虚拟化与 DOM 结构始终归引擎掌控**。
- **虚拟化**：行+列双向。rowBuffer=10 按「默认行高 × 数量」换算成**像素区间**；**最多渲染 500 行**安全上限；列虚拟化默认开启且无 buffer（横向滚动 CPU 代价低）。
- **四种 Row Model**（可插拔）：Client-Side / Infinite（分块懒加载）/ Server-Side（服务端分组聚合）/ Viewport（服务端只推送可视行）。更新走 **Transaction**（`applyTransaction` 增删改）或 **Immutable Data 模式**（`getRowId` + 引用 diff → 内部转事务，保住选中/排序/筛选状态）。
- **状态**：命令式内部状态 + api/columnApi，事件回调外广播——不是受控组件范式。
- **cell 级 change detection（业界最精细一档）**：网格为每个已渲染 cell 保留**本地值副本**，任何更新后对所有 cell 做 `===` 比对（可 `colDef.equals` 自定义），**只刷新值变化的 cell DOM**；聚合变更走树路径选择（只重算受影响分组到根）+ 列路径选择。编辑后**默认不自动重排序/重筛选**（UX 保护，防行在输入时跳动）。

#### MUI X Data Grid v9（2026-04）

- div + ARIA role（`role="row"/"gridcell"`），行+列双向虚拟化（`rowBufferPx`/`columnBufferPx`），受浏览器滚动容器像素上限约束（Firefox ~1750 万 px、Chrome/Safari ~3350 万 px）。
- **两种布局模式（架构亮点）**：**uncontrolled（默认）**——浏览器原生滚动 + 表头/pinned 用 CSS sticky + 一个撑总高的 filler 元素（快速滚动可能白区）；**controlled（实验）**——网格接管滚动，所有可见元素 `position: absolute`，每次滚动事件在**一次 JS pass 同步更新**（无 filler，消白区但放弃原生滚动性能）。
- **动态行高 × 列虚拟化的结构冲突**：`getRowHeight` 返回 `'auto'`（渲染后实测）会**禁用列虚拟化**——需要所有列在 DOM 中才能测准高度（GitHub #9738 长期跟踪）。
- **状态**：内部 store + reducer，对外 `apiRef`；**state 结构不是公开 API，强制经 selector 读取**——`useGridSelector(apiRef, selector)` 建立响应式订阅（该切片变化才重渲染所在组件），selector 目录覆盖几十个切片。受控/非受控双轨（`initialState` / `xxxModel` + `onXxxModelChange`），`exportState()/restoreState()` 快照。
- **编辑管线**：`valueParser`（转换）→ `valueSetter`（返回新行对象，不可变）→ `processRowUpdate(newRow, oldRow)`（可异步，服务端回写入口）；高吞吐走 `updateRows()`（按 id 部分更新）。

#### Naive UI（Vue 3，经源码核验）

- 真实 `<table>` 元素 + colgroup；固定列 = sticky + 累计偏移（`fixedColumnLeftMap`）；数据管线是 **computed 链**：`filteredDataRef → sortedDataRef → paginatedDataRef`；树/勾选基于 **treemate** 库。
- 2.45.0（2026-08-16）新增 `virtual-scroll-x`、`height-for-row`、`min-row-height`——此前长期只有纵向虚拟（#5996）。

#### DevExtreme / Kendo（jQuery 血统的"重企业"档）

- DevExtreme：`<table>` 渲染；固定列历史是**两张独立 table 同步滚动**（官方自认性能差），v24.2 重写单表；v21.2 起严格只渲染视口行；`repaintChangesOnly` 只重绘变化行。
- Kendo：锁列 = **锁定/非锁定双表容器**，与列虚拟化结构性冲突（锁列表丢 cell、hover 跨容器不同步等官方已知问题）；行虚拟化用「**假滚动容器**」：`.k-height-container` 撑出 `总行数 × rowHeight` 高度产生滚动条，实际渲染可见子集 + `translateY` 位移——**强制固定 rowHeight**，换行高需重建组件。

### 3.3 DOM 路线渲染层对比表

| 维度 | TanStack v9 | AG Grid v36 | antd | EP v1/v2 | Naive UI | MUI X v9 | DevExtreme | Kendo |
|---|---|---|---|---|---|---|---|---|
| 渲染层 | 无(headless) | div 自研引擎 | `<table>`+sticky | `<table>`+sticky / div 三区 | `<table>`+sticky | div+role | `<table>` | `<table>` 双表锁列 |
| 虚拟化 | 外置(Virtual) | 行+列；500行上限 | 仅纵向(tbody替换) | v1无 / v2纵向 | 纵向+2.45横向 | 行+列 | 行(视口only) | 行(强制定高) |
| 状态 | signal store+selector | 命令式+api | 受控/非受控混合 | v-model 受控 | computed+v-model | store+selector+apiRef | widget 内部 | widget 内部 |
| 局部更新 | selector 订阅 | **cell 级 === diff** | React 行级 | Vue 组件级 | Vue 组件级 | 行级+selector | repaintChangesOnly | 全量/行级 |

### 3.4 Canvas 路线（电子表格引擎，本方向不采用、作为边界认知）

**为什么 canvas**（Glide 作者第一手论述）：react-virtualized 双向 DOM 虚拟化的瓶颈是"每帧挂载/卸载数百 DOM 元素时什么都救不了你"；canvas 绘制成本与数据总量无关。**代价**：文本换行要自写排版引擎、HiDPI、半像素对齐、字体渲染慢、a11y 另做一套。

成熟 canvas 引擎的**六大件**（Glide/Univer/Luckysheet/SpreadJS/ReoGrid 共同模式）：

1. **主动式渲染循环 + 脏标记**：自持 rAF 循环，所有变更走「命令→模型→脏标记→下一帧重绘」单向数据流；draw call 纪律（合并 stroke/fill、缓存 ctx 状态避免 save/restore、按列批量 clip、关闭 alpha）；`fillText` 是第一热点（约 50% CPU）。
2. **分层缓存**：不常变的像素缓存成离屏位图，滚动时 blit 平移 + 只补增量（SpreadJS 的主体图层/装饰图层、Univer 的 Layer 离屏缓存、Glide 的 self-blit 同一思想）；冻结拆多 Viewport（Univer 常规 4 个、冻结行列 9 个）。
3. **命中检测**：预计算行列前缀和数组，点击坐标**二分查找**定位（Luckysheet `visibledatacolumn` + `searcharray` 是范本）——变行列宽下的标准做法。
4. **编辑器覆盖层**："canvas 负责画，DOM 负责输入"——编辑态在 canvas 上方绝对定位真实 `<input>`/富文本 div，解决 IME/光标/选词；提交模型普遍"编辑期间不写模型，失焦/下一次交互时统一提交"（Luckysheet updatecell 模式，Google Sheets 同款）。
5. **a11y subdom**：canvas 内嵌虚拟化语义 DOM（`<table>` + aria-rowindex/colindex，Glide 方案，默认开启不可关闭，同时是主输入路由）——canvas 相对 DOM 唯一系统性多出的工程量。
6. **数据与计算解耦**：渲染层不拥有数据（Glide 的 pull 回调 `getCellContent` / Univer 的 Skeleton ViewModel）；公式引擎独立成 headless 模块（HyperFormula 商品化、Univer 可进 Worker）。

**Univer 补充**（架构最完整、公开文档最全）：微内核 + 插件（一切功能皆 plugin）+ redi DI 依赖倒置；ViewModel（SheetSkeleton）负责排版布局；渲染引擎对象树 Engine→Scene→Viewport→Layer(离屏缓存)→Object，参考 Babylon/Konva；单元格文本排版与文档排版复用同一引擎（单元格富文本 = 内嵌 doc）；公式引擎五层（Lexer→Parser→Interpreter，ArrayValueObject 矩阵 broadcasting，依赖图标脏 + 拓扑序执行队列，INDIRECT/OFFSET 预计算）；Web Worker 里跑精简实例 + RPC + mutation 回写。

**Handsontable（DOM 对照组）**：行/列双向窗口化 + buffer；官方性能调优面恰好暴露 DOM 方案成本结构——固定行列尺寸、关 autoRowSize、慎用 cells 函数（每渲染周期每可见 cell 执行）、`hot.batch()` 批量、超大数据转分页。其 **HyperFormula 是"公式引擎与渲染层彻底解耦"的独立产品**（385 函数，依赖图 + range 节点分解抗 O(n²) + 惰性求值）。

---

## 4. D2 数据模型

| 库 | 运行时存储 | 说明 |
|---|---|---|
| 业务表格系 | 行数组 + getRowId/dataKey + accessor 列定义（稳定 rowId 是虚拟化/编辑/选中的共同前提：TanStack 强烈建议、AG Grid immutable 模式必需） | 列与数据 schema 解耦 |
| Luckysheet/FortuneSheet | **序列化稀疏、运行时稠密**：`celldata {r,c,v}` 一维稀疏数组 ⇄ `data[m][n]` 二维矩阵 | v(原始值)/m(显示值)分离，格式独立；公式依赖用独立 calcChain |
| Univer | cellData 二维矩阵 + ICellData（p 富文本/s 样式 id），**样式表 Workbook 级共享 id 引用** | 对齐 Excel 省 内存 |
| SpreadJS | cell model + **集算表（列存储 + 数据绑定）** | 10 万行加载从 32s 级到秒级——渲染快之后瓶颈转到数据结构 |
| Glide Data Grid | **无存储**：pull 型 `getCellContent(row,col)` 回调 + 行数 | 内存与数据量解耦，业务侧自管 |
| x-spreadsheet | 行数组 | 轻量 demo 级内核 |

**为什么电子表格必须用稀疏 cell model**（五条）：① 单元格是样式/公式/权限/操作的最小单位，行数组下改一格要整行读写；② 插删行列/合并需要重排公式引用与条件格式范围，cell + 坐标是最自然载体；③ 公式依赖图以 cell 为节点；④ v/m 分离是 Excel 兼容硬需求；⑤ 但稠密 cell model 内存大——实践是"序列化稀疏、渲染按需、运算选合适粒度"。

**业务表格的树形/分组表达**：树 = getSubRows/children 递归；分组 = row model 管线生成"分组行 + 叶子行"聚合视图（TanStack getGroupedRowModel + getExpandedRowModel）。

---

## 5. D3 状态管理与更新粒度

**本质问题：数据变化粒度与更新粒度不匹配**（改 1 个 cell 却重渲染整行/整表）。解法谱系：

```
React/Vue 框架响应式(行/组件级)
  → memo/shallowRef 缓解（element-plus 官方案例：ref→shallowRef + 非响应化，渲染耗时降 85%）
    → selector 订阅（MUI X useGridSelector / TanStack v9 selector+Subscribe，"读取过该状态的组件"才更新）
      → signals 细粒度（cell=signal 只动一个 text 节点，无 VDOM 调和）
        → 引擎自持 diff（AG Grid cell 级 === 比对，比框架 diff 更细）
          → canvas（放弃 DOM 更新管线，自己画）
```

- **Vue 生态模式**：大数组 `shallowRef` + 替换式更新，类实例 `markRaw`，"浅层响应式数据源 + 仅可见项完全响应"；**Vue 3.6 Vapor Mode**（无 VDOM 编译策略，Solid 同源）feature set 已在 3.6.0-beta.1 完成，stable 预计 2026 底——把"手动 shallowRef + 虚拟化"经验编译器化，对高频更新的表格组件收益最大。
- **RevoGrid**："virtual reactive architecture"——Stencil Web Components 编译期细粒度响应 + 虚拟滚动双轮（官方口径 60fps、3x less memory、百万级 cell）；框架无关靠 custom element 分发。
- **signals × React createSelectorAPI（提案）**：不竞争、可组合。框架无关 core 做成「带细粒度订阅的 external store」（`subscribe(cell/row/range, cb)` + `getSnapshot()`）；React 侧 `useSyncExternalStore`/createSelectorAPI 消费（选择器记忆化），Vue 侧 `shallowRef`+`triggerRef` 消费；@preact/signals-core 这类框架无关 signals 可直接内嵌为 store 实现（其 React binding 内部正是 useSyncExternalStore——业界已这样组合）。

**Headless 光谱（谁拥有 DOM 更新权，谁拥有性能上限）**：

1. 纯 headless（逻辑+状态）：TanStack——不拥有 DOM，但把「状态→重渲染」订阅图做到每特性原子，让用户渲染层获得等价精确性
2. 渲染组件、逻辑外置：rc-table / Naive UI——给完整 DOM 与交互，状态可交还应用，无性能引擎
3. 中间态（框架原生引擎）：MUI X / el-table-v2——框架渲染 + 内置虚拟化与内部 store；MUI X 把内部状态 selector 化公开，接近"半个 headless 内核 + 默认渲染层"
4. 全包引擎（框架只是宿主）：AG Grid / DevExtreme / Kendo——核心自管 DOM 与渲染管线，靠 cell 级 change detection 做到比框架 diff 更细的粒度

---

## 6. D4 编辑、撤销重做与协同

### 6.1 命令流范式（Univer，最值得借鉴）

```
COMMAND（用户一次交互，撤销重做的单位，可派生其它 COMMAND）
   → MUTATION（对模型的原子操作，未来协同的 transform 单位）
   → OPERATION（临时状态：滚动/光标/选区，不参与协同）
```

- **一套命令流三个消费者**：渲染刷新（mutation 后 makeDirty 下一帧重绘）、撤销重做（undos/redos 成对压栈）、协同（OT transform mutation）。
- 协同版用 DI 把 `LocalUndoRedoService` 替换为 `CollaborativeUndoRedoService`——**协同下 undo 不是简单回滚**，收远端 op 前要先 transform 本地 undo/redo 栈。
- 插件可通过 InterceptorService 拦截命令注入额外 redos/undos（改样式自动追加自动行高 mutation）。

### 6.2 OT vs CRDT（表格领域格局）

| 产品 | 协同算法 | 数据模型 | 备注 |
|---|---|---|---|
| Univer（前飞书表格团队） | **OT** | cell-based mutation | 公开设计文档最完整 |
| APITable/AITable | **OT (OTJSON)** | row-based record | 前后端同构 core；socket-server（连接）+ room-server（OT 计算）分离 |
| 飞书多维表格 | OT 为主（推断） | row-based | 1000 万热行、千人协同；canvas 引擎 + 脏矩形 |
| Baserow / NocoDB | **无 OT/CRDT**（WebSocket 事件广播） | row-based | "看到别人的更改"≠协同编辑，分属不同复杂度层级 |
| Rows and Columns（商业） | CRDT (Yjs) | cell-based | local-first 代表 |

- **OT 工程化要点**（比算法本身值钱）：服务器分配全序 revision；op 合并压缩（changeset）；n 种原子操作 transform 矩阵 O(n²)（行列插入的 index 变换是重灾区）；**七状态客户端状态机**（Synced/Pending/Awaiting/AwaitingWithPending/FetchMiss/Offline/Conflict）；快照+重放做版本历史；协作光标节流 + 同样要 transform。
- **为什么不用 CRDT**（Univer 官方理由）：企业场景需要服务端做权限与全局版本历史的协调点；表格 intention preservation 复杂、CRDT 元数据膨胀风险。
- **CRDT 的教科书设计**（Bartosz Sypytkowski）：每 cell 一个 LWW register；行列定位用 **LSeq 分数索引**（插入生成前后邻居之间的字典序 key，因果去重下免 tombstone）；**选区/公式引用不能存 A1:B3 用户序号，要存逻辑坐标**（并发插行不漂移），大量选区用 R-Tree 索引。

---

## 7. 专项难题的共识解法

### 7.1 虚拟滚动三件套与三库分化

所有 DOM 虚拟滚动的物理基础：**viewport（定高滚动容器）→ spacer/canvas（撑总高）→ slice（绝对定位的真实渲染切片）**。定高时 `rowStart = floor(scrollTop / rowHeight)` 是 O(1)；行高可变即失效，必须换累积偏移结构。

| 库 | 尺寸来源 | 动态测量 | 特点 |
|---|---|---|---|
| react-window | **用户提供**（itemSize 数字或函数） | 无（声明错布局就错） | ~2KB 极简 |
| TanStack Virtual | estimateSize 估算（**往大估**）+ measureElement 手动接线 | 内置 ResizeObserver + measurementsCache + getItemKey | headless、框架无关、lanes 支持网格 |
| react-virtuoso | **全包自动测量** | 内置 | **SizeTree = AA 树区间平衡 BST**（连续同高合并节点，O(log n) 双向查找，未测量区按平均高外推回填） |

- **反向无限滚动（prepend）**：逻辑 index 与渲染 index 分离（virtuoso `firstItemIndex`，保持测量缓存与滚动锚点）+ 新行测量后 scrollTop 补偿。新库 **virtua**（零配置，四框架）专攻滚动位置准确性。
- **极端规模（HighTable 十亿行五项技术）**：① DataFrame 惰性接口（getCell/fetch/resolve）；② table slice（Chrome 建议单次增删 <300 元素）；③ **滚动条降采样**（浏览器元素高度上限 ~1700 万 px，超阈值按比例缩映射，代价是"不可达行"）；④ **双模式滚动**状态机（滚轮记 localOffset、拖滚动条才更新 globalAnchor，1px 精度可达 2 万亿行）；⑤ 两段式随机访问（`scrollIntoView({block:'nearest'})` + `focus({preventScroll:true})`，纵横解耦，programmatic scroll 用 `behavior:'instant'` + flag 防中间态污染）。**HighTable 的取舍：牺牲可变行高，换纯数学滚动模型**。

### 7.2 复合难题矩阵

| 难题组合 | 共识解法 | 已知代价/冲突 |
|---|---|---|
| 虚拟化+可变行高 | 前缀和/区间树 + 估算(往大估) + 测量回填 + buffer | 滚动条抖动；快速滚动白屏（overscan/buffer 遮丑，AG Grid rowBuffer 像素区间算法） |
| 可变行高+列虚拟化 | **MUI X：动态行高禁用列虚拟化（#9738）** | 设计上必须显式分行高策略档位 |
| 虚拟化+树形 | 树 → 可见行扁平化序列（虚拟器单一真源）；展开 = 扁平序列局部插删 + 滚动锚点保持 | 展开动画难、深层嵌套每次重算 |
| 固定列+水平虚拟化 | 固定列**脱离水平虚拟化**，独立渲染域 | Kendo 双表锁列与列虚拟化冲突；sticky 与 transform 祖先冲突（angular/components#10122） |
| 固定列实现 | **AG Grid v35 前**：左/中/右三容器 JS 同步垂直滚动 → **v36 重构为 sticky CSS 容器**消除延迟 | 官方升级文档原话："此前 header、body、固定列放在各自容器中用 JavaScript 同步滚动，导致可见延迟" |
| AG Grid 边界 | `domLayout='autoHeight'`（整表撑开）会渲染全部行；Master/Detail 内嵌 grid 用 autoHeight 时行虚拟化失效 | "整表自适应高度"与虚拟化天然互斥 |

### 7.3 选区与键盘导航（selection model）

- **WAI-ARIA Grid Pattern 是事实标准**：**roving tabindex**（全网格恰好一个 cell `tabindex=0`，方向键移动焦点时迁移 tabindex）或容器持焦点 + `aria-activedescendant`；**focus 与 selection 是正交状态**。
- **最小状态集**：`anchor cell`（起点锚）+ `active/focus cell` + `ranges[]`（normalize 成 min/max 的矩形数组）+ 模式位（selecting/editing/idle）。迁移规则即各家键盘表：Shift+方向键扩选、Ctrl/Cmd+click 追加 range、双击/键入进 editing。
- **结构化范本**：Glide `GridSelection`（current + rows/columns/cells ranges 显式模型）；AG Grid 区分 cell focus 与 cell range。
- **canvas 命中链**：screen → canvas（减表头偏移）→ grid（加 scroll 偏移）→ cell（沿累积宽度**二分查找**；视口规模小 O(n) 遍历反而更优）；选区画在**独立选区层**（选区变化只重绘该层）。
- **键盘导航 × 虚拟化**：目标格不在 DOM 时先滚动再聚焦（见 7.1 HighTable 第⑤项）——selection 状态机与虚拟滚动状态机的协商点。
- **协同语境**：选区/公式引用存逻辑坐标（fractional key）而非用户序号，大量选区 R-Tree 索引；协作光标同样需要 transform + 节流（Univer）。

---

## 8. 前沿趋势（2024-2026）

1. **signal 化**：TanStack v9（alien-signals）、Vue 3.6 Vapor、Angular 内置 signals、Preact Signals 渗入 React——「编译期/细粒度响应 + 虚拟化」是当前 DOM 表格性能的主流演进方向。
2. **WebGL 渲染的标杆：Quadratic**（目前最完整公开拆解）：MSDF 多通道距离场文本（一张 42px atlas 覆盖 0.01x-10x 缩放仍锐利）；4 类 shader 分层批处理（黑文本走无 tint 专用 shader 省约 33% 顶点缓冲）；**空间哈希分块局部重算**（15×30 一块，编辑一个 cell 只重算所在块几何，约 100 倍削减）；Core Worker（Rust/WASM 持有数据与公式）+ Render Worker + SharedArrayBuffer + Transferable 零拷贝；百万级 cell 60fps 平移缩放。**WebGPU 尚无直接落地的表格产品**，短期经 PixiJS v8 间接受益。
3. **Web Worker 计算下沉**：Univer（精简实例进 Worker，mutation 回写）、SpreadJS V19（Worker 增量重算）、HyperFormula（headless 公式引擎独立产品）——"渲染快之后瓶颈转到数据结构/计算"，公式与重算与主线程解耦是标配方向。
4. **virtua / HighTable**：虚拟滚动库在"滚动位置精确性"与"极端规模数学化"两条线上继续推进。

---

## 9. 信息来源

**DOM 系**：TanStack Table v9 博客（tanstack.com/blog/tanstack-table-v9-taking-form / …-v9-reactivity，2026-06/07）、InfoQ TanStack v9 Beta（2026-07）；AG Grid 文档 DOM Virtualisation / Row Models / Change Detection / Immutable Data / Massive Row Count、AG Grid Blog: React UI Overview、Upgrading to v36；ant.design/docs/blog/virtual-table；Element Plus table-v2 文档；Naive UI CHANGELOG 2.45.0 + #5996；MUI X Virtualization / Row Height #9738 / State / Editing、MUI Blog v9.0（2026-04）；DevExtreme 工单 T1099959/T715094/T1042010/T1252275；Kendo 虚拟滚动文档 + kendo-react#217。
**Canvas 系**：Glide Data Grid 作者文（itnext.io "I wrote an HTML canvas data grid so you don't have to"）+ GitHub + docs.grid.glideapps.com；Univer 官方博客 this-is-univer / rendering / formula / web-worker / ot + GitHub；LuckysheetDocs（cell/FAQ）+ 掘金源码分析 + FortuneSheet README/协同文；x-spreadsheet GitHub + HN 讨论；SpreadJS 官方技术文（CSDN/知乎/集算表/SegmentFault 实测）；Handsontable 文档（row-virtualization/performance）+ HyperFormula 文档（dependency-graph/volatile-functions）；ReoGrid 对比文（web.reogrid.net）；rv-grid 2026 综述。
**专项**：HighTable 博文（rednegra.net，2026-02）；virtuoso 作者 dev.to + 官方 endless-scrolling 文档；TanStack Virtual 文档；react-window web.dev 教程；virtua GitHub；Solid fine-grained reactivity 文档 + The New Stack 访谈；RevoGrid 官网/GitHub/维护者复盘（Reddit）；Vue 官方响应式进阶文档 + element-plus 优化案例（知乎）+ Vapor Roadmap（vuejs/core#13687）；Univer OT 博客 + 协同性能（掘金）；APITable 架构文档 + GitHub #173；Baserow WebSocket 文档 + 社区；NocoDB changelog 2025.08.0；飞书官方文章 + 知乎技术栈讨论；Bartosz Sypytkowski "Conflict-free Replicated Spread Sheets"；Rows and Columns Yjs 文档；Quadratic 博客（quadratichq.com）；WAI-ARIA Grid Pattern（w3.org）；Glide Selection API 文档；Handsontable Selection 文档；angular/components#10122；MUI discussion #9001。

（完整 URL 清单见各调研原始报告；引用时已逐条核验存在性。）

---

## 10. 结论速览（供 02-direction.md 引用）

1. **业务列表表格选 DOM+虚拟化路线是共识**：万~十万行量级下，div 网格 + 行列窗口化是 AG Grid/MUI X/Handsontable 共同验证的方案；canvas 的收益在此量级不成立，代价（a11y/IME/排版自绘）却不小。
2. **弃 `<table>` 用 div**：antd/Element 的结构性困境 vs AG Grid/MUI X 的自由度，一正一反两条证据链。
3. **状态核选 signal store + selector 消费**：TanStack v9 刚完成同样的架构重写；Vue（shallowRef/原生 signal）与 React（useSyncExternalStore）都有标准消费原语。
4. **cell 级更新选 AG Grid 模式**（本地值副本 + === diff）+ selector 订阅兜底。
5. **编辑走 Command→Mutation 流**：一套日志同时服务撤销重做与未来协同（OT），Univer 已完整示范。
6. **固定列选 CSS sticky 容器**（AG Grid v36 演进方向）；行高分三档显式管理（定高/每行声明/实测动态），实测动态档明确禁用列虚拟化。
7. **选区模型独立于渲染层**（anchor/focus/ranges 状态机 + roving tabindex），先模型后渲染。
8. **不做的事**：公式引擎（HyperFormula 可外挂）、canvas 渲染、协同（架构留 Command/OT 接缝即可）。
