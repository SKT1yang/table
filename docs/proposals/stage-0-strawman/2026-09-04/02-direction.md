# 方向决策记录（ADR）：自定义表格组件的大方向

> 状态：已敲定（2026-09-04 与所有者确认）
> 依据：同目录 `01-market-research.md`（下称「调研」）
> 阶段：stage-0 strawman — 本文档只定方向，不含详细设计

---

## 1. 背景与目标

自研一个表格组件，服务公司以 **Vue 3** 为主的技术栈，核心要求**框架无关**（core + 各框架适配层），避免被单一框架绑架，也为未来 React 复用留路。

本阶段要回答的只有一件事：**做什么形态、走哪条技术路线**。详细设计（模块划分、接口、目录结构）是下一阶段的产出。

## 2. 决策

### 决策 D-1：形态 = 业务列表表格（data grid）

**不是**类 Excel 电子表格，**不是**多维表格。

理由（调研 §1、§3.4、§10.8）：
- 业务表格是 Vue3 中后台最高频刚需，投入产出比最高
- 电子表格引擎（公式+canvas+cell model）是公司级工程（Univer 由 Luckysheet 原班人马公司级重写）；若未来确需 Excel 能力，基于 Univer 二开优于自研
- 多维表格是产品形态（记录 schema、多视图、重后端），不是组件库选题

### 决策 D-2：量级 = 万~十万行 → DOM + 虚拟化路线（不上 canvas）

理由（调研 §2、§3、§10.1）：
- 此量级是 DOM 窗口化的舒适区（AG Grid Client-Side 10 万+、Handsontable 1 万~10 万实践口径），canvas 的收益不成立
- canvas 的代价（a11y 黑盒、IME 覆盖层、自绘排版、命中检测）只有百万行以上才值得付
- DOM 路线保留 CSS 生态、原生输入/a11y、任意 HTML 单元格内容

### 决策 D-3：编辑 = 单元格编辑 + 撤销重做（Command 模式，为协同留门）

理由（调研 §6.1）：
- 编辑走 **COMMAND→MUTATION 命令流**（Univer 范式）：一套操作日志同时服务渲染刷新（脏标记）、撤销重做（undo/redo 对压栈）、未来协同（OT transform mutation）
- 不做协同本身，但架构留接缝：协同版只需替换 undo/redo 服务实现，不改命令流

## 3. 架构蓝图（三层）

```
┌─ adapter 层
│    Vue3 优先（shallowRef + triggerRef 消费 core store + 组件包装）
│    React 次之（useSyncExternalStore / selector 消费）
├─ 渲染器层（可替换）
│    div 网格 + 行虚拟化（列虚拟化后置）+ CSS sticky 固定列/表头
│    + cell 级 change detection
└─ core 层（纯 TS，零框架依赖）
     ├─ signal store：每特性一个 atom（排序/筛选/选中/列宽/展开），细粒度订阅
     ├─ 数据管线：可插拔 row model（client-side 先行，server-side 预留接口）
     ├─ selection model：anchor/focus/ranges 状态机，与渲染解耦
     └─ 命令系统：COMMAND→MUTATION 流 + undo/redo 栈
```

## 4. 关键技术决策表

| # | 决策点 | 选择 | 依据（调研章节） |
|---|---|---|---|
| 1 | 渲染元素 | **div 网格，弃 `<table>`** | §3.1：antd「tbody 替换虚拟列表」的缝合、Element Plus 两套组件的分裂，反面教材；AG Grid/MUI X/el-table-v2 全部 div |
| 2 | 虚拟化范围 | **行纵向虚拟化优先，列虚拟化后置** | §3.1/§3.2：antd、el-table-v2 长期仅纵向虚拟化即覆盖主流业务场景；列数通常远少于行，纵向先拿 90% 收益 |
| 3 | 行高策略 | **三档显式管理**：定高（默认，全功能）/ 每行声明高 / 实测动态（禁用列虚拟化） | §7.2：MUI X 动态行高禁列虚拟化的结构冲突（#9738）必须显式建模，不能隐式踩坑 |
| 4 | 固定列/表头 | **CSS sticky 容器**，固定列不参与水平虚拟化 | §7.2：AG Grid v35 三容器 JS 同步（官方自认延迟）→ v36 重构 sticky；Kendo 双表锁列与列虚拟化冲突 |
| 5 | 状态核 | **signal store，每特性一个 atom**（自研薄实现或内嵌 @preact/signals-core） | §5：TanStack v9 刚重写为同构架构（alien-signals），验证路线可行；Vue/React 都有标准消费原语 |
| 6 | 局部更新 | **cell 级值副本 + `===` diff**（AG Grid 模式），selector 订阅兜底 | §3.2/§5：AG Grid 用本地值副本比对做到比框架 diff 更细的粒度，DOM 路线上限 |
| 7 | 编辑/撤销 | **Command→Mutation 流 + undo/redo 对压栈** | §6.1：Univer 范式，一套日志三个消费者；协同留门（OT 只 transform mutation） |
| 8 | 树形数据 | **可见行扁平化投影**（虚拟器只认扁平序列） | §7.2：AG Grid/TanStack/antd(useFlattenRecords) 共识 |
| 9 | 选区模型 | **独立 selection model**（anchor/focus/normalized ranges 状态机）+ roving tabindex | §7.3：WAI-ARIA Grid Pattern；focus 与 selection 正交；先模型后渲染，与渲染层解耦 |
| 10 | 键盘导航×虚拟化 | 目标格不在 DOM：scrollIntoView({block:'nearest'}) + focus({preventScroll:true})，纵横解耦 | §7.1⑤：HighTable 两段式；selection 状态机与滚动状态机的协商点 |
| 11 | rowId | **强制稳定 rowId**（getRowId 必填） | §3.2/§4：TanStack 强烈建议、AG Grid immutable 模式、虚拟化/编辑/选中全依赖 |
| 12 | 整表 autoHeight | **不支持**（虚拟化与整表撑开互斥） | §7.2：AG Grid domLayout='autoHeight' 渲染全部行；显式不支持优于隐式退化 |

## 5. 非目标（明确不做）

- ❌ 公式引擎——若未来需要，外挂 HyperFormula（headless、渲染无关，调研 §3.4）
- ❌ canvas 渲染——量级不支撑其代价
- ❌ 实时协同——只在命令系统留 OT 接缝
- ❌ Excel 兼容（xlsx 导入导出、合并单元格语义）——业务表格不需要
- ❌ 无限流/十亿行——那是 HighTable 式纯数学方案 + 牺牲可变行高的取舍，超出目标量级

## 6. 风险与开放问题（留给设计阶段）

1. **signal store 自研 vs 内嵌 @preact/signals-core**：自研约数百行（atom/computed/effect），内嵌则跟随上游演进——设计阶段 spike 对比
2. **Vue adapter 的消费原语**：shallowRef 包装 vs VueUse 的 syncSignal 类方案；关注 Vue 3.6 Vapor（2026 底 stable）对高频更新组件的收益
3. **动态行高档位与列虚拟化的切换语义**：档位切换时测量缓存如何失效（参考 react-virtualized resetAfterIndex 的陷阱）
4. **cell 级 diff 与 Vue 渲染的分工**：adapter 层何时走 Vue patch、何时走引擎直改 DOM（AG Grid 模式在 Vue 下的对应物）
5. **行高测量**：ResizeObserver + measureElement 回填（TanStack Virtual 模式）还是声明式（Kendo 模式）——倾向前者，估算往大估

## 7. 下一阶段计划

1. **详细设计**（stage-1）：core 层模块接口（store/row-model/selection/command）、渲染器 DOM 结构与 diff 协议、Vue3 adapter API 形态
2. **最小验证 demo**：已于 2026-09-05 完成 spike（代码与结论见 `spike/2026-09-05-grid-demo/RESULTS.md`，单测 21/21 绿），验收清单：
   - [x] 10 万行 × 20 列滚动 60fps（定高档）— 生产构建 CDP 实测（连续滚动形态：滚轮/触控板）：常规 59-60fps 零白屏、惯性 fling 51fps 零白屏；拖滚动条形态经跳转检测修复 8→45+fps（快速拖拽的残余空白带为 DOM mount 吞吐的结构性边界，量化与对策见 RESULTS.md「结构性边界」节；根治 = 行回收或 canvas）
   - [x] 固定列 + 固定表头 + 横向滚动无错位、无 JS 同步延迟 — 代码中零 JS 同步逻辑；fling 稳态截图复核 pinned 列对齐
   - [x] 单元格编辑 → 只重渲染该 cell（DevTools 验证）— === 停传播语义单测锁定；CDP 实测计数 delta=1
   - [x] undo/redo（Ctrl+Z/Y）跨多次编辑正确 — 单测覆盖值序列与对压栈
   - [x] 树形展开/收起，滚动锚点不跳 — 单测覆盖锚点补偿（展开上方节点 scrollTop +新增行数×行高）
   - [x] 键盘导航（方向键/Tab）在虚拟化边界正确滚动+聚焦 — 导航数学单测通过；CDP 冒烟（方向键穿边界 + End 跳尾行）通过
3. **canvas 对照 spike**：已于 2026-09-05 完成（代码与结论见 `spike/2026-09-05-canvas-demo/RESULTS.md`，单测 33/33 绿，core 与 DOM 版字节级一致）：跳转/拖拽形态（DOM 路线结构性边界）**60fps、重绘=帧数、零白屏，单次全量重绘 1.0-1.7ms（≈30-40 倍于 DOM mount 吞吐）**。**D-2 维持不变**（canvas 代价清单——a11y 黑盒/IME 覆盖层/自绘排版/命中检测——全部实际付费，量级不摊销）；canvas 校准为「边界根治选项之一」，与行回收（~0.1ms/行，保 a11y）的优先级及触发条件见该 RESULTS.md「对方向决策的含义」
