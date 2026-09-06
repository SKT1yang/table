# Spike 验证结论 — 2026-09-05

> 对象：`docs/proposals/stage-0-strawman/2026-09-04/02-direction.md` §7.2 最小验证清单。
> 代码定位：**一次性 spike，丢弃型**。本文件才是产出。
> 运行：`pnpm i && pnpm dev`（工具栏「生成 10 万行 × 20 列」；`?rows=N` 行数变体，默认 10 万）；`pnpm test` 跑 31 个单测。
> 回收压测/真实输入验证（生产构建）：`pnpm build && pnpm exec vite preview --port 4173` 后 `node scripts/cdp.mjs bench`（自驱压测+功能自检）/ `node scripts/cdp.mjs drag`（headless wheel fps 采样）/ `node scripts/cdp.mjs native '?rows=5000'`（**headful 真 GPU** 真实滚动条拇指拖拽 A/B，第二参数 = 变体查询串）/ `node scripts/cdp.mjs cast '?rows=5000'`（同拖拽但 `Page.startScreencast` 连拍**上屏帧**、拖拽循环零停顿——native 的停顿截图对空白类结论是假阴性，见教训清单末条；`CAST_STEP/CAST_STEPS/CAST_MS` 调速度档，帧存 `scripts/shots/cast-*/`）。

## 结论速览

| # | 验收项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 10 万行×20 列滚动 60fps（定高档） | **通过（连续滚动形态）**；真机拖滚动条为**合成器领先边界**（已量化+缓解，见「真机复现」小节） | 行回收后（CDP wheel 真实输入，生产构建）：fling 档 1750px/事件 **59.7fps**、快拖档 17500px/事件（jump 分流）**59.8fps**，mounts=0，paint 后白屏采样 2/1267 帧（仅相位切换的程序化复位）。真机极限拖滚动条：JS 侧无瓶颈（每步 assign 1.5-4.5ms、mounts=0），残留间隙为合成器领先——**骨架条纹默认开**（空白带→空行条纹）+ 跳转 lead 可覆盖中速拖拽（headful 截图实证，见下）。回收前 mount 路线：滚轮 ≤400px/帧 60fps 零白屏、fling 1500px/帧 51fps、快拖 47fps + 1.9s 空白带 |
| 2 | 固定列+表头 sticky 无错位无 JS 同步 | **通过**（headless 截图 + 回收后 CDP 几何断言） | 代码中**不存在任何 JS 列同步逻辑**（grep 可证）；z-index 层级表写死；行绝对定位用 `top` 不用 transform（transform 祖先毁 sticky）；回收后几何断言：headerTop=0、pinned 表头/格 sticky 偏移 0/180 精确、行宽 3040、首格宽 180 |
| 3 | 编辑只重渲染该 cell | **通过**（CDP 实测 delta=1） | 单测 `signal.test.ts ★值不变停传播`；浏览器实测：编辑提交 → `__cellRenders` 恰 +1，undo/redo 各 +1 |
| 4 | undo/redo 跨多次编辑 | **通过**（逻辑层 + CDP 冒烟） | 单测：undo×2→redo×2 值序列、对压栈（undo 后新命令清空 redo）；CDP 冒烟过 |
| 5 | 树形展开/收起锚点不跳 | **通过**（逻辑层 + CDP 冒烟） | 单测：视口上方展开 → scrollTop +新增行数×35，锚行 index 不变；收起还原；自身首行展开不跳 |
| 6 | 键盘导航×虚拟化边界 | **通过**（逻辑层 + CDP 冒烟） | 单测：scrollTargetForIndex 可见返回 null/头顶对齐/底对齐/最大值 clamp；CDP 冒烟：方向键+End 跳尾正常 |
| — | 泄漏自检 | **通过** | CDP 长滚：`dataVersion 订阅数 = 绑定行 × 20` 恒等式严格成立（稳态 46×20=920，fling 时随窗口有界增长 ≤ 池容量×20），**反复滚动不累积**（回收 = 零 effect churn 的直接证明）；回收前 v-for 时代：静止回落 680 |
| — | 行回收吞吐（结构性边界的跨越） | **通过** | rebind **163-177 行/ms**（0.006ms/行）vs mount 0.45ms/行（~73×）、需求 0.16ms/行（26×）、AG Grid 预期 0.1ms/行（16×）；全场景 mounts=0，池容量 132 恒定 |

自动化证据：`pnpm test` → **31/31 绿**（signal 语义 9 + core 集成 12 + perf smoke 1 + 行回收差分规划器 9）；另有 `?bench=1` 页内功能自检 11 项（生产构建下全过，见功能冒烟节）。

实测数据（node，M 系 Mac）：
- mock 生成 10 万行×20 列（树形）：**~600ms**（一次性，按钮触发 + loading 态，未上 Worker）
- 全展开 flatten（10 万可见行全量重算）：**~6ms** —— 展开单节点只 +105 行，全量重算也远低于一帧预算，增量优化确认可留给 stage-2 之后

## 浏览器实测记录

### 性能：滚动帧率（CDP headless Chrome，生产构建 `vite preview`，DPR 2）

> 本小节为 **mount 路线（回收前）** 的数据，保留作对照；行回收后的最终数字见下一小节。

**连续滚动**（滚轮/触控板形态——程序化 rAF 滚动 + 真实输入管线 wheel 事件双重验证）：

| 滚动速度 | fps | 稳态白屏 |
|---|---|---|
| +100px/帧（快滚轮） | **60** | 无 |
| +400px/帧（极快滚轮） | **60** | 无 |
| +800px/帧（轻 fling） | **54** | 无 |
| +1500px/帧（触控板动量峰值，DPR2 大视口） | **51** | 无 |
| +2500px/帧（极端 fling） | **33** | 无 |

白屏判定 = fling 稳态连拍截图（compositor paint 后真相）→ 行区完整、pinned 列对齐。

**不连续滚动**（拖滚动条 / 键盘跳转——每帧位移与挂载窗口不相交，v-memo 重叠完全失效）：

| 场景 | 修复前 | 修复后（跳转检测） |
|---|---|---|
| 拖滚动条 17500px/帧（拇指 5px/帧） | 27fps、4.5s 中 4.5s 白屏（真机实测 8fps） | **47fps**、空白时长降至 1.9s |
| 拖滚动条 3500px/帧（拇指 1px/帧） | — | **45fps**、~50% 帧有空白带（结构性边界） |
| Cmd+End 跳尾行（350 万 px 单跳） | — | **零空白**（单次挂 39 行 ≈ 一帧内） |

**结构性边界（量化，回收前）**：挂载吞吐实测 ~0.45ms/行；快速拖滚动条需求 = 跳转行数/16ms（100 行/帧 → 0.16ms/行），**差 ~3 倍**——mount/unmount 路线在任何 lead 配置下都无法覆盖「不相交跳转每帧一跳」的滚动形态（挂载永远滞后合成器一跳）。跨过它只有两条路：**行 DOM 回收**（复用节点只改文本，~0.1ms/行，AG Grid 模式）或 **canvas**（重绘可见区一次 draw call）。这是 DOM 路线的真实边界、也是 canvas 路线的核心优势轴，方向决策时应作为对比维度。

### 行回收后（最终架构）——DOM 路线已跨过该边界

> 行元素池化复用，rebind（改文本/绑 atom）替代 mount（建 21 元素 + 20 effect）；实现见 `src/core/rowpool.ts`，优化过程见「第三轮修复」。复现：`node scripts/cdp.mjs bench|drag`。

**回收吞吐**（bench 自驱，程序化 scrollTop，只测 assign 的 JS 成本）：

| 场景 | rebinds | assign 累计 | 吞吐 | assign p95 | mounts |
|---|---|---|---|---|---|
| 连续 +1500px/帧 ×300 | 12671 | 77.6ms | **163 行/ms**（0.006ms/行） | 0.4ms | 0 |
| 快拖 +17500px/帧 ×120 | 5306 | 29.9ms | **177 行/ms** | 0.3ms | 0 |

vs mount 路线 0.45ms/行 **~73×**；快拖需求 0.16ms/行 **26×**；AG Grid 量级预期 0.1ms/行 **16×**。池容量 132（预热后恒定）；`dataVersion` 订阅数恒等于 绑定行×20（稳态 46×20=920，fling 窗口变宽时有界增长 ≤ 132×20，反复滚动不累积）——滚动 = 纯 rebind，零 effect churn、零 Vue 重渲染。

**真实输入**（CDP `Input.dispatchMouseEvent` wheel，生产构建；headless overlay 滚动条无法命中，用等价 wheel 档位）：

| 场景 | fps | rebinds | mounts | assign 累计 |
|---|---|---|---|---|
| fling 1750px/事件 ×240 | **59.7** | 5304 | 0 | 43.3ms |
| 快拖 17500px/事件 ×120（触发 jump 分流） | **59.8** | 2664 | 0 | 18.8ms |

白屏判定 = paint 后采样（`setTimeout(8ms)` 而非 rAF——rAF 队列里采样器先于滚动处理执行，读到 assign 前状态，系统性误报）：**2/1267 帧**，且均为相位切换时的程序化 `scrollTop` 复位，滚动过程本身零空白。对比回收前同档：47fps + 1.9s 空白带。

### 真机拖滚动条复现（headful GPU Chrome）——合成器领先边界

> 作者真机反馈：极限拖滚动条仍有白屏带（比回收前好、但性质相同）。headless 复现不了（无 GPU 合成器、输入时序不同）；DOM 采样器也看不到（它读的是采样时刻的 DOM，早已 assign 完毕，而非已上屏像素）。复现 = **headful 真窗口 Chrome + CDP 真实拇指拖拽 + 拖拽中截图（上屏像素）**：`node scripts/cdp.mjs native '<变体>'`。

**复现与根因**（截图：`/tmp/grid-drag-frames/native-*.png`）：拖拽中的上屏帧出现大片空白带（fast 档约 60% 视口高），而同期 JS 侧毫无瓶颈（每步 assign 1.5-4.5ms、rebinds 正常、mounts=0）。根因 = **原生滚动条拖动是合成器线程先行滚动/上屏**：presented 帧带新 offset + 旧 commit 内容 → 新暴露区无行。10 万行 × 35px = 350 万 px 滚动条轨道下，**拇指 1px ≈ 122 行**，8px/10ms 步进即 ~1000 行/步、32px 步进 ~3900 行/步（实测每帧位移 P50 ~4400 行 / P95 ~8200 行）——任何 lead 都追不上合成器的领先段，这是 DOM + 原生滚动条的结构边界，**与 JS 吞吐无关**（AG Grid 同样如此）。

**缓解 A——骨架条纹（默认开，`?skel=0` 关）**：`.body` 背景 = 行网格对齐的条纹 + pinned 列底色。覆盖不了的区域从「破窗白屏」变为「空行条纹」——表格结构（行网格/pinned 列/表头）全程稳定可见。行/格有实色背景，正常态骨架不可见，零成本。

**缓解 B——跳转 lead（`?jumplead=N`，回收时代重开）**：lead ≥ 每步位移时 presented 帧满行（stale 内容，读起来是「内容略滞后」而非空白）。headful 实证：`?jumplead=1000` 下 fast 档（~1000 行/步）**视口满行零间隙**（fps 45）；extreme 档（~3900 行/步）部分覆盖 + 骨架兜底。全覆盖需 lead ≈ 4000（~25ms/步 assign）→ 拖垮帧率，不做。

**缓解 C——拖拽限速钳制（实测否决，`?dragcap=N` 保留作反面记录）**：思路 = 单次位移超 N 行时主线程把 `scrollTop` 钳回（位移进入 lead 可覆盖区间）。headful 实测两个致命问题：① **钳制写回直接取消合成器拖拽手势**——macOS Chrome 下拖拽进行中的主线程 `scrollTop` 赋值会终止手势，拇指冻结在起点（截图：拖拽中途内容仍在第 2 批，拇指停在轨道顶部，scrollRows=0）；② 钳制写回与合成器 scroll latching 打架，wheel 档 fps 59.8→**13.1**。结论：**原生滚动条的速度主线程管不了，对抗合成器手势不可行**。限速只在「自己拥有输入」时成立 = 自绘滚动条（拖拽 → 主线程 set scrollTop → 同帧 assign → 无空白，Cmd+End 单跳已证零空白；限速反而可省）——代价是重造滚动条 UX/a11y，属正式版路线决策。

**残留结论**：真机极限拖动下 DOM 路线有 1-2 帧的「空行条纹→满行」过渡。彻底消除只有自绘滚动条（DOM 路线内）或 **canvas 固定画布**（画布不随滚动层移动，仅 spacer 滚动，此形态下显示上一帧完整内容而非空白带）——感知差异（「内容滞后一帧」vs「空行过渡」）是方向决策 canvas 轴的真实对比维度，此前「DOM 路线已补齐短板」的结论在此滚动形态下不成立。

### 5000 行拖拽复核（2026-09-05 增补，`?rows=5000` 变体）

> 触发：`docs/proposals/stage-0-strawman/2026-09-05/03-scale-and-positioning.md` §3.2 预测表当时只有推算列——「5000 行时常规拖拽落入连续滚动形态、极限拖拽仅残留 ~1 帧瞬态」。本节为实测列。复现：`node scripts/cdp.mjs native '?rows=5000'`（截图 `/tmp/grid-drag-frames/native--rows-5000-*.png`）。同日 cdp.mjs 修了两处：overlay 滚动条改 wheel 唤出（合成 hover 唤不出，按压落空）、拇指按压点按最小拇指长度计算中心（5000 行 thumb 线性 2.8px 被系统 ~28px 最小值兜底 → 实际映射 ≈257px/px ≈ **7.3 行/px**）。

> **2026-09-05 二次修正（screencast 真相）**：初版本节「连拍满行、零空白带」全部出自**停顿截图**——拖拽中途 `await Page.captureScreenshot` 的往返延迟会暂停输入派发，paint 趁机追平 → 假阴性（机制详见 fullrender RESULTS 教训 10）。零停顿复现：`CAST_STEP=8 CAST_STEPS=40 node scripts/cdp.mjs cast '?rows=5000'`（帧存 `scripts/shots/cast--rows-5000-8px/`；极速档 `cast--rows-5000-32px/`）。下表已按真相修正。

| 同手势同参数（headful 真 GPU） | 10 万行（原测） | 5000 行（复核） |
|---|---|---|
| 每帧位移 P50/P95 | ~4400 / ~8200 行 | fast 57 行/步、extreme 227-679 行/步（物理映射吻合） |
| 拖拽中上屏帧 | **~60% 视口空白带**（骨架条纹缓解为空行条纹） | **快拖/极速拖拽期间表体 ~100% 白**（screencast 早/中/晚段抽样帧：8px 档 f030/f065/f090、32px 档 f020/f042——表头恒画、pinned 列体空、**连骨架条纹背景都未上屏** = 瓦片未光栅化，慢于 paint 的层） |
| DOM 白屏采样 | 空白带期间持续 | **0/513（fast）、0/290（extreme）、0/575（wheel）**——只证 JS/DOM 层无未挂载区；采样读的是当刻 DOM，原理上看不到合成器领先的上屏空白 |
| 滚动形态 | 不相交跳转（jump 分流：只挂可见行） | fast = 连续滚动（57 行/步 < 窗口 ~130 行）；extreme 跨阈值但 rebind 0.006ms/行即时覆盖 |
| 主线程 fps | 快拖 ~45 | fast 17.9 / extreme 28.1（见下方注） |

- **预测表半成立（二次修正后）**：位移物理值逐格吻合；但「白屏问题整个消失」被 screencast 证伪——§3.2 的推理「连续滚动形态 → presented 帧满行」在 **DOM 层**成立（rebind 即时覆盖、mounts=0），在**上屏层**不成立：还有一条更低的天花板 = 光栅化吞吐。快拖 57 行/步（每帧新暴露 ~2000px）时 DOM 已满而上屏全白。
- **白屏边界（两档共同物理，与虚拟化/c-v 无关）**：慢拖 ≲30 行/步 → 拖拽中满行（fullrender `cast-baseline-2px/`，P50 15 行/步，早/中/晚三帧全满）；快拖 ≳57 行/步 → 表体 ~100% 白；松手 ≤600ms 追平满行（fullrender f047 证实；本 demo 松手帧视觉分析工具两次报错，以 DOM 采样 0/290 + 手感「一停就有」佐证）。10 万行同一手势 8px → ~1000 行/步，几乎所有拖速都在界外——「白屏幅度 ∝ 总高」的真机制是同一手部速度在更长轨道上映射成更大的每帧位移。
- fps 反直觉注：5000 行拖拽的 fps（18-28）低于 10 万行（~45），不是退化——10 万行 jump 分流每帧只挂 ~40 行可见区（其余空白），5000 行连续形态每帧 rebind 200+ 行 + 更大片 paint（8px 档 rebinds 2472、assignMs 19.9、mounts=0，JS 完全跟得上）。**但「做了更多工作，换来零空白」不成立**——fps 是 rAF 主线程节奏，不是上屏节奏；主线程忙 paint commit 时，光栅化仍追不上。
- 与全量渲染档对照（`../2026-09-05-fullrender-demo/RESULTS.md`）：5000 行两档滚动体验同级的方式变了——不是「都零白屏」，而是**白法一样**：同样的速度边界（30-60 行/步之间）、同样的松手即满、与 cv0/cv1 无关。虚拟化档的窗口机制与全量档的「无未挂载区」都只解决 JS 层；上屏层空白是通用物理（合成器先行 + 瓦片未光栅化），两档都只能靠「松手追平」兜底。

### 功能冒烟（CDP 驱动，dev 构建）

| 项 | 步骤 | 结果 |
|---|---|---|
| 3 cell 级 | 双击 cell → 改值 → Enter | `__cellRenders` **+1** ✓ |
| 4 undo/redo | Ctrl+Z → Ctrl+Y | 值往返正确，各 +1 渲染 ✓ |
| 5 树形 | toggleExpand 首个父节点 | flatRows 正确增长 ✓ |
| 6 键盘 | 方向键 + Cmd+End | 高亮移动、尾行入视口 ✓ |
| 泄漏 | 3 轮快滚 + 回顶 | 订阅数 = 行数×20，静止回落 680 ✓ |

**行回收改造后同一组语义复测**（`?bench=1` 页内自检，生产构建，`node scripts/cdp.mjs bench` 复现）——**11/11 PASS**：可见行采样断言 slot 绑定/`getBoundingClientRect` 级 top 精确（±0.5px）/文本 === `readCell`/expander 视觉；展开锚点行不变 + 收起还原；编辑 `__cellRenders` 恰 +1 且文本更新、undo 还原且 +1（验收 3 语义在回收架构下不变）；订阅数 = 绑定行×20 且重压后稳定；mounts 预热后零增长。

真实浏览器手感复测：作者 2026-09-05 反馈**「极限拖滚动条全程白屏」已证实**（screencast 复核，见「5000 行拖拽复核」二次修正）——且比骨架缓解预期更糟：连骨架条纹都未上屏（瓦片未光栅化时背景层也不画），呈纯白而非「空行条纹」。仍待手感确认：慢拖（≲30 行/步）应满行、快甩白但松手即满（≤600ms）、fling 惯性、展开/收起锚点。

## 性能优化过程（问题 → 证据 → 修法，正式版直接抄作业）

**问题**：初版（Cell.vue 组件路径）快速滚动白屏；第一轮改造（v-cell 指令 + v-memo + overscan 20）后 headless 42fps，真实机器仍 ~15fps + 白屏。

**证据链**（CDP Profiler，函数级 self-time）：`(program)` 占 60%（样式失效/布局/绘制），热点 `setStyle` 219ms（每帧数百次内联样式写入）、`addEventListener` 24ms（每 cell 挂监听）、节点数过多。

**第一轮修复（针对连续滚动）**：
1. **列样式静态化**（columnCss.ts）：列宽/pinned sticky 偏移生成为 per-column class 一次性注入 → 滚动时新挂载 cell 零内联样式写入。42 → 59fps。
2. **事件委托 + 几何命中**：viewport 级 click/dblclick，行 = 坐标÷行高，列 = 前缀宽度线性扫描（canvas 命中检测的 DOM 版）→ 每 cell 零监听器。
3. **速度感知 lead buffer**：rAF 里喂入每帧滚动 delta → 方向前方预挂载 ≈2 帧滚动量（封顶 90 行，校准：45 行只够 1500px/帧，trackpad fling 峰值 ≈72 行/帧）；反方向压半；120ms 静止回收。速度在 scroll 事件里**同步**喂（先于当帧 paint），白屏窗口再减 1 帧。**封顶 90 是白屏消除的门槛**（45 行时 +2500px/帧持续白屏 73/73 帧 → 90 行后 2 帧）。

**第二轮修复（针对不连续滚动——用户真机白屏的真凶）**：连续滚动全绿后用户真机仍「8fps + 白屏」，触发方式是**拖滚动条/键盘**——这是连续滚动测试从未覆盖的形态：单帧位移（可达数万 px）与挂载窗口完全不相交，v-memo 重叠失效 → 每帧全量重挂 ~3000 节点，且速度 lead buffer 在此形态下是纯毒药（预挂的行永远看不到，每帧多挂 90 行废行 + 触发双重渲染）。修复 = **跳转检测**：`|单帧位移| > 挂载窗口行数 × 行高` 判为不相交 → 只挂可见行、零缓冲；单测锁定三分支（连续/跳转/静止恢复）。拖拽档 27→47fps（真机 8fps 的崩溃机制同源消除），Cmd+End 单跳零空白。

**第三轮修复（行回收——跨过结构性边界，最终架构）**：v-for 整行 mount/unmount 换成命令式 `RowPool`（`src/core/rowpool.ts`），四个关键设计：
1. **纯函数差分规划器** `planReassign`：按 rowId 单遍扫描得 keep/free/enter；keep 只在必要时写 DOM。node 单测锁定「纯滚动零样式写入契约」（位移 k → 恰 k enter/k free、全部 keep 零写）。
2. **top = 扁平绝对索引 × 35**：行的索引是数据的属性，纯滚动时保持行**零 DOM 写入**（用窗口相对偏移则每帧全量 setStyle，重新撞 profile 里 setStyle 占 60% 的墙）。
3. **rebind 不销毁 effect**：每 slot 一个 `rowIdAtom`，20 个常驻 cell effect 读它 + `readCell`（dataVersion 依赖）；rebind = 1 次 top 写 + 1 次 atom write → 20 个 effect 各写一次 textContent。空闲 slot 三件套：`display:none` + `rowIdAtom.set(null)`（退订 dataVersion）+ 复用时恢复。
4. **字段比较而非引用比较**：`flatten()` 展开后全量重建 FlatRow 对象，keep 判定必须比 `depth/hasChildren/expanded`（单测锁定）。

效果：吞吐 0.45 → 0.006ms/行（~73×），快拖 47→59.8fps、空白带 1.9s→0，极端 fling 同步受益；滚动热路径 Vue 完全零重渲染（Grid 模板响应只剩 focus/编辑矩形）。行/格 CSS 需从 scoped 迁非 scoped（池建的 DOM 无 `data-v-` 属性）。真机复现后追加：scroll 事件里的 `scrollTop.set` 从 rAF 推迟改回**同步**（rAF 合帧是 v-for 时代的节流遗产，RowPool 差分廉价无需合帧，推迟只会在真机上白给合成器多一帧领先）。

**附带修掉一个存量 store bug（回收让它显形）**：滚动速度清零时两个连续 atom set（`scrollDir` 再 `leadExtra`）会让下游看到「dir=0 + 旧 extra」的中间态，产生瞬时双侧 overscan 超宽窗口（实测窗口行数序列 49→221→49）——v-for 时代每次 fling 结束都在静默多挂 ~90 行；回收后表现为池被迫增长。`batch()` 合并两个 set 修复，node 复现确认 49→65→129→49，11 个 store 测试保持绿。

次要削减（fling 档 profile：每帧 ~900 cell mount，patchDOMProp/setAttribute/computed 创建占比可观）：v-cell 融合为单 effect 直读 readCell（省一半信号节点）、cell 去掉 id/role/aria 属性绑定、表头 v-memo=[]、`.cell{contain:layout style}`。

**教训清单**：
- **滚动形态比滚动速度更重要**：连续（滚轮/触控板）与不连续（拖滚动条/跳转）是两个世界，后者才是最坏情况；性能测试必须显式覆盖「拖滚动条」。
- 程序化 `scrollTop +=` 是主线程同步滚动，绕过合成器；真实输入必须走 `Input.dispatchMouseEvent(wheel)` 输入管线复现。
- rAF 内的几何采样测的是「当帧渲染提交前」状态，且 rAF 队列内回调先后顺序不稳定（采样器可能先于滚动处理执行，把 assign 前状态系统性误报成白屏）——白屏结论必须以 paint 后为准（截图，或 paint 后 setTimeout 采样）。
- dev 与生产构建差 ~1.7 倍（dev-only 的 checkRecursiveUpdates 等），验收数字必须测生产构建。
- **headless 连「输入时序」都不等于真机**：无 GPU 合成器时滚动事件与 paint 的次序不同，「合成器领先主线程」类的空白 headless 根本不发生——白屏类结论必须 headful（真窗口）复现，且以**上屏像素**（截图）为准：DOM 采样读的是采样时刻的状态，永远比已上屏内容新。
- **signal 多个关联 atom 顺序 set 必须考虑中间态**：下游会 flush 在过渡组合上（本例：瞬时 221 行窗口，v-for 时代静默多挂 ~90 行/次 fling 结束）；语义上属同一变更就 `batch()`。
- **CSSOM 序列化有损**：`style.top` ≥1e6px 回读为 6 位有效数字科学计数法（`1.5673e+06px`，±5px 误差），但真实布局精确——几何断言用 `getBoundingClientRect`，别信 style 字符串回读。
- **停顿截图测空白 = 系统性假阴性**（2026-09-05 追加，本清单最大的坑）：拖拽中途 `await Page.captureScreenshot` 的往返延迟会暂停输入派发，paint 趁机追平——截到的是「追平后」状态。5000 行追平只要 1-2 帧，恰好全落进盲区 → 初版「5000 行连拍满行」结论错误；10 万行因每步跳 55 个视口、追平结构性不可能，才拍得到真空白带。真相 = `Page.startScreencast` 连拍（`cast` 模式，帧名 `fNNN-stNNNN.png` 编码对齐后的 scrollTop）；机制细节与 Chrome 152 ack 改名等见 fullrender RESULTS 教训 10。

## 开放问题的 spike 回答

**#1 signal store 自研 vs 内嵌 @preact/signals-core**：自研够用。全部语义（=== 停传播、lazy 缓存、动态依赖、dispose 防泄漏、batch 合并）在 **~230 行**内实现且被 9 个单测锁定。实现中发现并修掉一个非平凡坑：菱形依赖下急切重算若立即 flush effect，会读到尚未重算的兄弟 computed → 二次调度（glitch）；解法 = 通知波次计数器，整波结束统一 flush。这个坑说明：自研可行，但**语义测试必须先行**——建议正式版继续自研但把 `tests/signal.test.ts` 的语义集作为契约原样保留（或对比内嵌 @preact/signals-core 时用同一套测试跑两边）。

**#2 Vue adapter 消费原语**：`shallowRef + signal effect`（`useSignal`，8 行）即可。所有值都是不可变替换，signal 层 === 停传播 + Vue hasChanged 双保险，不需要 triggerRef，也不需要 VueUse 的 syncSignal。

**#4 cell 级 diff 与 Vue 渲染的分工**：**编辑粒度上 Vue patch 路径达标，但滚动 mount 成本不达标 → 已切换 Plan B（引擎模式），行级最终也退出 Vue（行回收）**。
- A 路径（Cell.vue 组件，每 cell 一个组件实例）：编辑 → 600 个挂载 cell 的 computed 重算 → 599 个 === 停传播 → 恰 1 个组件重渲染，编辑粒度 ✓。但**浏览器实测快速纵向滚动白屏**：fling 时每帧需实例化数十个组件（setup + computed/effect 挂接），主线程跟不上，新暴露区域来不及渲染。
- B 路径（`v-cell` 指令 + `v-memo="[fr]"` 行，回收前的中间形态）：cell 的 mount 成本 = 一个 effect + 一次 textContent 赋值；滚动时 FlatRow 引用不变 → 稳定行整棵子树跳过 vnode diff。cell 级更新语义不变：编辑 → dataVersion bump → 挂载 cell 的 effect 全部重跑（各一次 Map 查找 + === 比较）→ 只有值变的那个写 DOM，验收 3 观测不变；`===` 停传播的 core 语义由单测锁定。
- **结论：Vue 下「cell 级 === diff」的正确落点不是组件粒度而是 DOM 直写粒度** —— AG Grid 引擎模式在 Vue 里对应物是「指令/渲染辅助函数 + signal effect 直改 DOM」；行回收后组件只保留到容器层级（行 = 命令式池 + 差分规划器，滚动帧 Vue 零重渲染），cell 级语义（dataVersion bump → 只有值变 cell 写 DOM）原样保留、验收 3 复测通过。
- **补充（性能兜底）**：B 路径之上还需列样式静态化 + 事件委托 + 速度感知 lead buffer 三件套才能扛住连续滚动（见优化过程节）；不连续滚动的结构性边界（0.45 vs 0.16ms/行）最终由行回收解决（见性能节）。

## 已知简化（正式版需补，不阻塞方向结论）

1. **焦点模型**：容器持焦点 + 高亮环，未做 roving tabindex 和 aria-activedescendant（方向文档本来就列为后置）。focus-ring/editor 是独立「选区层」（挂 Grid 层单元素），focus 变化零波及 cell —— 与 canvas 网格独立选区层同构。
2. **cell 无 id/role/aria 属性**（性能取舍，见优化过程）；行保留 role=row。行回收后 DOM 顺序进一步与逻辑行序解耦（slot 复用顺序 ≠ 窗口顺序）且无 aria-rowindex——屏幕阅读器阅读顺序乱序。正式版需在 rebind 时同步 `aria-rowindex`（或容器 `aria-owns` 重排），cell 粒度可在指令里同步维护或仅对 focus cell 动态挂 id。
3. **Tab 不跨行换行**、Home/End 语义简化（Ctrl+Home/End 跳全表首尾）。
4. **编辑值一律 string**（input.value），prev 为 number 时首次编辑必然产生 mutation —— 正式版需要 valueParser。
5. 固定列为前缀列假设（sticky 累计偏移的简化）；列宽静态。
6. **快速拖滚动条——JS 瓶颈已由行回收根治，真机残留合成器领先间隙**（原结构性边界 0.45 vs 0.16ms/行已跨过：快拖 59.8fps、1.9s 空白带消除）。真机极限拖动的残留 = 合成器先行上屏新 offset + 旧 commit 内容（350 万 px 轨道下拇指 1px ≈ 122 行，每帧可达数千行），**任何 JS 吞吐都追不上**（见「真机复现」小节）。缓解：骨架条纹默认开（空白带→空行条纹）+ `?jumplead=N` 覆盖中速拖拽（1000 行/步以内满行）；**限速钳制已实测否决**（取消拖拽手势 + wheel 13fps）；彻底消除 = 自绘滚动条或 canvas 固定画布，正式版按感知 A/B 定路线取舍。**跳转 lead 的默认值**（0 vs ~1000）留正式版按感知调优。
7. **CDP headless ≠ 真机 GPU 合成**：fps 数字以本机浏览器复测为准（headless 无 GPU，paint 成本偏高，真机预期只高不低）。

## 架构结论

三层切分在 spike 尺度就兑现了承诺：core（signal/store/virtual/command/rowpool）**零 Vue import**，被 30 个单测直接覆盖（rowpool 的差分规划器是纯函数，与 DOM 半边同文件但逻辑级可测）；Vue 侧只有 8 行消费原语 + 组件，且滚动热路径已完全退出 Vue——Grid 模板的响应式只剩 focus/编辑矩形，滚动帧零重渲染、`dataVersion` 订阅数恒定。TanStack v9 式「signal 核 + 框架适配」与 AG Grid 式「行回收 + cell 级更新」在同一份 ~1560 行代码里同时成立，**方向文档的三层架构与关键技术决策表 #1/#4/#5/#6/#7/#8/#10 全部获得正验证**。JS 吞吐维度的短板（mount 0.45ms/行）已由回收补齐（0.006ms/行）；canvas 路线的残留优势轴 = **原生滚动条快拖/极速拖动的「合成器领先」形态**（固定画布显示上一帧完整内容；DOM 路线快拖中连骨架背景都不上屏——瓦片未光栅化，见「5000 行拖拽复核」二次修正，「真机复现」小节的骨架/lead 缓解只在落点追平后可见）与极端列规模/绘制自由度——方向决策时 canvas vs DOM 应以该形态的感知差异为最后对比维度。
