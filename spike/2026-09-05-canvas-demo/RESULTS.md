# Spike 验证结论 — 2026-09-05（canvas 对照组）

> 对象：DOM spike（`../2026-09-05-grid-demo/RESULTS.md`，下称「DOM 版」）识别出的**结构性边界**——
> 不连续滚动（拖滚动条/跳转）下挂载吞吐 0.45ms/行 vs 需求 0.16ms/行，快速拖拽必有空白带，
> 根治出路之一是 canvas（重绘可见区一次 draw call）。
> 本 spike 用**同一份 core**（`diff -r` 字节级一致）把渲染器换成 canvas，量化这条对比轴。
> 代码定位：一次性 spike，丢弃型，本文件才是产出。
> 运行：`pnpm i && pnpm dev`；`pnpm test`（33 单测）；`pnpm build && pnpm measure`（CDP 实测，结果在 `scripts/measure-out.json`，截图在 `scripts/shots/`）。

## 结论速览

**canvas 把「不连续滚动」从结构性边界降级为一次 ~1.2ms 的全量重绘**：DOM 版 45-47fps + 空白带的跳转场景，canvas 版 60fps、重绘次数 = 帧数、连拍截图零白屏。但方向文档 D-2（DOM 为主）**维持不变**——canvas 的代价清单（a11y 黑盒、IME 覆盖层、自绘排版、命中检测）在本 spike 全部实际付费，量级（万~十万行）不足以摊销。

| # | 验收项（对齐 DOM 版清单） | 结论 | 证据 |
|---|---|---|---|
| 1 | 10 万行滚动 60fps | **通过（全形态 60fps，超 DOM 版上限）** | 连续 +100~+2500px/帧全 60fps（DOM 版 +2500 时 33fps）；真实 wheel 管线 60fps |
| — | **跳转/拖拽形态（DOM 版结构性边界）** | **通过：60fps、零白屏** | 跳转 3500/17500px/帧两端往返 60fps、重绘=帧数；单跳重绘=2；fling 连拍 0/8 白样本 |
| 2 | 固定列+表头不错位、零 JS 同步 | **通过** | 单 canvas 多 clip 分层（body/pinned/header×2 四 pass），代码零同步逻辑；截图复核 |
| 3 | 编辑只重绘一次 | **通过（粒度=整帧而非 cell）** | CDP 实测 `editRepaintDelta=1`；单测锁定；单次重绘 1.0-1.7ms（画 ~300 个可见 cell） |
| 4 | undo/redo 跨多次编辑 | **通过** | CDP 实测值往返正确（另抓出并修复编辑后焦点丢失：卸载时还给 scroller） |
| 5 | 树形展开/收起 | **通过** | CDP 实测展开 +95 行（95 子级，孙级仍折叠）；spacer 尺寸同步单测锁定 |
| 6 | 键盘导航×虚拟化边界 | **通过** | CDP 实测 Control+End 跳尾、focus 行=尾行；纵横两轴跟随（纵向 store/横向 ensureColVisible） |

自动化证据：`pnpm test` → **33/33 绿**（geometry 26 + draw 即 effect 语义 7）。

## 浏览器实测记录（CDP headless Chrome，生产构建，1440×900@2x —— 与 DOM 版同条件）

### 性能：滚动帧率（DOM 版数字见右列对照）

| 场景 | canvas fps | 单次重绘均值 | DOM 版 fps | DOM 版现象 |
|---|---|---|---|---|
| 连续 +100px/帧（快滚轮） | **60** | 0.99ms | 60 | 无白屏 |
| 连续 +400px/帧（极快滚轮） | **60** | 1.13ms | 60 | 无白屏 |
| 连续 +800px/帧（轻 fling） | **60** | 1.39ms | 54 | 无白屏 |
| 连续 +1500px/帧（触控板动量峰值） | **60** | 1.47ms | 51 | 无白屏 |
| 连续 +2500px/帧（极端 fling） | **60** | 1.52ms | **33** | 无白屏但撞 mount 吞吐墙 |
| 真实输入管线 wheel 100/400px | **60** | ~1.0ms | — | 同形态 |
| wheel 横向 120px/帧（持续回卷） | **60** | 0.98ms | — | 列虚拟化免费拿到 |
| **跳转 3500px/帧两端往返**（拖滚动条 1px/帧形态） | **60** | 1.26ms | **45** | ~50% 帧空白带 |
| **跳转 17500px/帧两端往返**（拖滚动条 5px/帧形态） | **60** | 1.19ms | **47** | 空白时长 1.9s |
| Cmd+End 单跳（350 万 px） | **60**（重绘恰 2 次） | 1.21ms | 零空白 | 单次挂 39 行 ≈ 一帧 |
| 白屏连拍（fling/跳转中截图） | **0/8 + 0/3 白样本** | — | — | 对照 DOM 版空白带 |

**吞吐对比（本 spike 的核心数字）**：跳转帧需要覆盖 ~100 行新内容时——
- DOM 路线：100 行 × 0.45ms/行 mount ≈ **45ms/帧**（>3 帧预算，空白带不可避免）
- canvas 路线：全量重绘可见区 ≈ **1.0-1.7ms/帧**（约 300 cell 的 fillText + 批量线条），**~30-40 倍**
- 重绘次数 = 滚动帧数（182/180），每 scroll 事件恰一次同步重绘（scroll 事件先于同帧 paint）

拖滚动条真机项：headless 无经典滚动条（offsetWidth==clientWidth），真实拖拽无法注入——已用「两端往返跳转」覆盖其本质（单帧位移与挂载/绘制窗口不相交），拖拽手感留真机复测（`pnpm dev` 或 `pnpm preview`）。

### 功能冒烟（CDP 真实事件）

| 项 | 步骤 | 结果 |
|---|---|---|
| 编辑 | 双击 cell → typing → Enter | editor 覆盖层弹出 ✓ 提交后重绘 **恰 +1** ✓ 值写入 ✓ |
| undo/redo | Ctrl+Z → Ctrl+Y | 值往返正确 ✓（各 +1 重绘） |
| 树形 | 滚至父节点 → 点行首 ▸ | flatRows +95 ✓（95 子级；孙级默认折叠） |
| 键盘 | 点 cell → ↓/Control+End | 焦点环连续 ✓ 跳尾 atBottom ✓ focus=尾行 ✓ |
| 横向 | wheel deltaX 流 | 60fps，重绘跟 scroll 事件（浏览器按帧合并 wheel，canvas 逐事件同步） |

生成 10 万行×20 列 ≈ 430ms（与 DOM 版同 mock，core 未动）。

## 测量套件抓出的两个真 bug（都已修复 + 单测锁定）

这正是「spike 的价值在测量，不在代码」的注脚——两个 bug 单靠读代码都没看出来：

1. **hitTest pinned 命中回归**：命中检测把 viewport x 一律做 content 换算（+scrollLeft），横向滚动后点击 pinned 区（x<pinnedW）会误命中藏在下方的 body 列——CDP 冒烟中树形开关点击失效而暴露。绘制路径用独立 pinned pass 本无此问题，纯命中数学错。修复：pinned 区按 viewport 坐标扫 pinned 列。`tests/geometry.test.ts ★` 锁定。
2. **hTick 缺订阅（横向滚动 canvas 滞留）**：onScroll 造了滚动脉冲原子并在横向滚动时 bump 它，但 draw() 里忘了读它——draw effect 从未订阅该信号，纯横滚（scrollTop 不变 → === 停传播吞掉重绘）时 canvas 完全不刷新。headless/有头双环境注入 deltaX 复现（scroller 监听 6 次全跑、重绘纹丝不动）。修复：draw 首行读 hTick。`tests/renderer.test.ts ★` 锁定（mock host 记录 listener，直接派发 scroll 事件断言纯横滚 +1 重绘）。

另修复：编辑器提交卸载后焦点落回 `<body>`，网格键盘（方向键/Ctrl+Z）全部失灵至用户再点击——编辑结束显式 focus 还给 scroller。

## 架构结论

1. **「渲染器层可替换」兑现**：`diff -r ../2026-09-05-grid-demo/src/core src/core` 零差异——signal/store/virtual/command 原样复用，换渲染器零 core 改动。DOM 版结论「三层切分兑现承诺」在此拿到第二个数据点。
2. **draw 即 effect**：draw() 本身是一个 signal effect，直接订阅 scrollTop/viewportSize/flatRows/focusCell/每个可见 cell 的 readCell（→dataVersion）。零手动刷新管线；=== 停传播保证同值零重绘；dispose 后 dataVersion 订阅归零（防泄漏单测）。这是 signal 架构在非 DOM 渲染器上的自然延伸——**渲染器不一定是 DOM，但订阅图同构**。
3. **分层绘制替代 sticky/z-index**：body（clip 右侧）→ pinned body（左实底）→ 接缝阴影 → header body → header pinned，四 pass 单 canvas。DOM 版「零 JS 同步」的对应物是「clip 区域互斥」；DOM 版 z-index 层级表的对应物是 draw 顺序。
4. **列虚拟化免费**：colRange 相交测试即得可见列窗口——DOM 版列为「后置」的列虚拟化，canvas 只是绘制循环的边界，20 列或 200 列同一套数学。
5. **交互管线同构**：原生滚动容器 + spacer（滚动条/滚轮/惯性全免费，与 DOM 版共享）；canvas `pointer-events:none` 覆盖，事件全部穿透到 scroller，命中检测走 geometry 纯函数——DOM 版「事件委托 + 几何命中」的备胎方案在 canvas 是唯一途径，但代码量同级（~40 行）。

## canvas 代价清单的实际付费记录（方向文档 D-2 论据的实证）

- **a11y 黑盒**：整表无 DOM 语义（DOM 版至少有 role=row + aria 树路径）；屏幕阅读器完全不可用，补救需独立 aria 层——本 spike 未做。
- **IME/编辑覆盖层**：编辑必须 DOM overlay（本 demo input 尚可，富文本/控件即复杂化）；且 overlay 是 canvas 兄弟节点，只能 viewport 坐标 + scroll 监听跟随——DOM 版「content 坐标随滚动天然跟随」的红利不存在。
- **自绘排版**：省略号（fitText + measureText）、右对齐、缩进档位、0.5px 线条对齐全是手写；列宽动态化、字体测量缓存、富内容（多行/图标/超链接）每一项都是新工程。
- **命中检测**：~40 行纯函数 + 单测（成本可控但不可省，且抓出过 pinned 回归）。
- **粒度反转**：DOM 版编辑 = 1 个 cell 重渲染；canvas 版编辑 = 全帧重绘（~1.2ms，本量级无感，但「cell 级更新」叙事在 canvas 需重述为脏区重绘）。

## 对方向决策的含义

- **D-2 维持**：万~十万行 + 常规中后台场景，DOM 路线的 CSS 生态/a11y/任意 HTML cell 收益仍大于 canvas 的滚动形态优势；canvas 代价清单全部实际付费且不可摊销。
- **canvas 的定位从「不做」校准为「边界的根治选项之一」**：触发条件 = 业务真出现「每帧 ≥100 行的不相交跳滚」形态（大表拖滚动条是唯一已知入口）。届时优先级：行回收（DOM 内优化，~0.1ms/行，保 a11y）→ canvas（本 spike 证明 30-40 倍吞吐，但整体重写渲染层）。本 spike 的 geometry/draw-as-effect/分层绘制可直接作为该路线的种子。
- **DOM 版结构性边界数字获得对侧印证**：0.45ms/行 mount vs 1.2ms/帧 draw（~100 行可见）——两条曲线的交叉点即路线切换点，量化基础已齐。

## 已知简化（丢弃型 spike，不阻塞结论）

1. 无 hover 高亮/文本选择/列宽拖拽/排序点击（表头点击不响应）；无 aria 层。
2. 单 canvas 全量重绘：编辑/焦点变化也是整帧重绘（1-1.7ms）；分层 canvas（pinned 层仅纵向滚时重绘）与脏区重绘未做。
3. fitText 无宽度缓存（~300 次 measureText/帧含在内，<0.5ms）；列宽静态。
4. 编辑值一律 string（与 DOM 版同简化）；Tab 不跨行；Home/End 简化语义。
5. headless ≠ 真机 GPU 合成，fps 以本机复测为准（DOM 版教训同款：dev: `pnpm dev`；生产：`pnpm build && pnpm preview`）；拖滚动条真机手感待复测。
6. CDP deltaX 滚轮会被浏览器按帧合并（40 次注入 → 6 次 scroll 事件），canvas 逐事件同步已验证，但极端横滚的 1 帧级陈旧窗口未专项截图（连续横滚 60fps 已覆盖）。
