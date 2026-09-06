# Spike 验证结论 — 2026-09-05（全量渲染档）

> 对象：`docs/proposals/stage-0-strawman/2026-09-05/03-scale-and-positioning.md` §3 的实测化——「小而美」档（全量渲染 + 分块首屏 + content-visibility + 已建资产复用）在 5000 行的真实效果，同一份 core、渲染器从「虚拟化+行回收」换成「全量挂载」。
> 代码定位：**一次性 spike，丢弃型**。本文件才是产出。姊妹篇：`../2026-09-05-grid-demo/RESULTS.md`（虚拟化档，本文所有对照数字的来源）。
> 运行：`pnpm i && pnpm dev`（默认 5000 行；`?rows=N` / `?cv=0` / `?chunk=0` 变体）；`pnpm test` 23 个单测。
> 生产测量：`pnpm build && pnpm exec vite preview --port 4173` 后 `node scripts/cdp.mjs bench 'rows=5000&cv=1'`（自检+挂载计时）/ `node scripts/cdp.mjs drag`（headless wheel）/ `node scripts/cdp.mjs native '?cv=0'`（**headful 真 GPU** 真实拇指拖拽 + 连拍截图，存 `scripts/shots/`）/ `node scripts/cdp.mjs cast '?cv=0'`（同拖拽但 `Page.startScreencast` 连拍**上屏帧**、拖拽循环零停顿——native 的停顿截图对空白类结论是假阴性，见教训 10；`CAST_STEP/CAST_STEPS/CAST_MS` 调速度档）。

## 结论速览

| # | 验证项 | 结论 | 证据 |
|---|---|---|---|
| 1 | **拖滚动条白屏边界**（§3.3 原主张「任意速度零白屏」） | **快拖及以上被证伪；慢拖满行** | screencast 连拍（拖拽零停顿，合成器视角真相）：慢拖 2px/10ms（P50 15 行/步）**满行**（`cast-baseline-2px/`）；快拖 8px/10ms（P50 60 行/步）与极速 32px/10ms（P50 227 行/步）**拖拽中表体 ~100% 白**——表头恒画、pinned 列体空、连背景层都未上屏（瓦片未光栅化；`cast-baseline-8px/`、`cast-baseline-32px/`、cv0 同白 `cast--cv-0-32px/`）；grid-demo 虚拟化档同边界（其复核小节）。松手 ≤600ms 追平满行（`cast-baseline-32px/` 尾帧）。**初版「fast/extreme 连拍满行」是 captureScreenshot 停顿假阴性**（教训 10）。DOM 白屏采样 0/112 依旧成立（JS 层无未挂载区，结构性空白确不存在）——白屏纯发生在上屏层（光栅化追不上每帧新暴露面积），与渲染档、c-v 均无关 |
| 2 | 分块首屏 | **通过** | 首块 200 行 **13-19ms**（数据就绪即可交互，与总行数无关）；5000 行全量墙钟 944ms（净 JS 234ms，其余为帧调度）；同步全量对照档 242ms 一口气（0.053ms/行） |
| 3 | content-visibility 收益 | **通过（量化）** | 挂载墙钟 cv1/cv0：5000 行 944/3408ms（**3.6×**）、10000 行 2319/10794ms（**4.6×**）；headful 极限拖拽主线程 fps cv1/cv0 = 35.7/16.7（**2.1×**）。副作用待重证：初版「快滚进入跳过区无 paint-hold 空白（wheel 中途帧满行）」出自停顿截图，空白类结论不可信（教训 10）；可站住的旁证 = cv0 快拖同样整屏白（白屏与 c-v 无关，归因瓦片光栅化） |
| 4 | 滚动零行工作 | **通过** | 全场景 `stats.assigns=0`、`mounts=0`（滚动不在订阅图：onScroll 只剩 `scrollTop.set`）；订阅恒等式 `dataVersion 订阅数 = 挂载行 × 20` 精确成立（5000 行 91600=4580×20，滚动重压后严格不变） |
| 5 | 交互语义不回归 | **通过（11 项）** | 可见行采样（rect ±0.5px + 文本 === readCell + expander 视觉）、展开锚点补偿、编辑 `__cellRenders` 恰 +1、undo/redo 各 +1、树形 n/a 诚实标注（rows=1000 无父节点数据） |
| 6 | **编辑成本（10 万常驻 effect 风险点）** | **坐实，需分片** | 一次编辑/undo 的 execute 同步耗时：1000 行 58-75ms、5000 行 **1182ms**、10000 行 **4404-4572ms**（超线性：91.6k effect 12.9µs/个 → 181k 24.5µs/个）。5000×20 的编辑每次冻结主线程 1.2s —— 正式版必须做 per-row dataVersion 分片/脏行集（本文「已知简化」#1） |
| 7 | grid-demo@5000 复核（§3.2 预测表） | **位移预测成立；白屏预测被证伪** | 见 grid-demo RESULTS「5000 行拖拽复核」（已按 screencast 真相修正）：10 万行同手势 ~60% 视口空白带；5000 行快拖/极速拖拽期间**同样整屏白**、慢拖满行——白屏边界由拖速（~30-60 行/步之间）决定，不由总高单独决定。位移物理值逐格吻合（拇指 1px≈7.3 行、fast 57 行/步、extreme 227 行/步） |

自动化：`pnpm test` **23/23 绿**（signal 语义 9 + core 集成 7 + 块计划 6 + perf smoke 1）；`?bench=1` 页内自检各变体 PASS。构建 84.44 kB（gzip 33.37）vs grid-demo 84.97 kB（33.62）——渲染器替换对包体零感。

## 「删掉的机器」账（对照 grid-demo，core 全目录）

| 文件 | grid-demo | fullrender | 差额内容 |
|---|---|---|---|
| store.ts | 364 | 282 | **-82**：range/slice 窗口订阅、scrollDir/leadExtra/jumpLead 速度状态机、setScrollVelocity/clearScrollVelocity/setJumpLead、poolCapacityHint |
| virtual.ts | 56 | 23 | **-33**：computeRange + VirtualRange（只留 scrollTargetForIndex） |
| rowpool.ts → fullbody.ts | 309 | 332 | 删掉池/freeList/planReassign 差分规划器/窗口分配（~160 行机器），保留 buildRow/bindCell 原样搬移，新增 chunk 调度 + rowId reconcile（~80 行，其中 chunk 调度 ~30 行） |
| signal.ts / command.ts | 223/71 | 223/71 | **0 改动**（core 数据层 100% 幸存的第三个数据点） |
| 合计 | 1023 | 931 | 净 -92 行，但**复杂度差远大于行数差**：删掉的是全部滚动形态状态机（连续/跳转二分、lead 封顶、跳转阈值），新增的 chunk/reconcile 无滚动耦合 |

滚动路径对照：grid-demo 的 onScroll = scrollTop.set + 速度喂入 + 120ms debounce 清零；本 demo 的 onScroll = **一行 `scrollTop.set`**。CSS 侧删掉骨架条纹（无未挂载区，无「空白带」可缓解），加 `overflow-anchor: none`（store 显式锚点补偿 vs 浏览器原生 scroll anchoring 二选一）。

## 挂载计时矩阵（#1，headless bench，生产构建）

| 变体 | 首块 ms | 全量 ms（墙钟） | 净 JS ms | 块 p95 ms | DOM 节点 |
|---|---|---|---|---|---|
| 1000 行 chunk200 cv1 | 13.7-18.2 | 194-202 | 58-61 | 13.4-14.7 | 23 066 |
| 1000 行 chunk200 cv0 | 19.4 | 408 | 60 | 14.7 | 23 066 |
| 5000 行 chunk200 cv1 | 13.5 | **944** | 234 | 14.2-20.6 | 105 406 |
| 5000 行 chunk200 cv0 | 12.6 | **3408** | 262 | 17.9-20.4 | 105 406 |
| 5000 行 chunk0（同步全量）cv1/cv0 | 242.6 / 241.7 | 同左 | 242 | — | 105 406 |
| 10000 行 chunk200 cv1 | 13.7 | 2319 | 481 | 18.2-27.7 | 208 331 |
| 10000 行 chunk200 cv0 | 13.4 | 10794 | 520 | 19.6-29.2 | 208 331 |

读法：
- **首块常量**：13-19ms 与总行数无关（200 行/帧的固定预算）——「可交互」时刻由 chunk 大小决定，不由数据规模决定。
- **c-v 买的是墙钟不是 JS**：净 JS（workMs）cv 0/1 几乎相同（c-v 不改 JS）；差在全量墙钟——无 c-v 时每块挂载触发已挂行累积重 layout（O(n²) 累计），5000 行 3.6×、10000 行 4.6× 劣化。
- **裸渲染恐惧值修正**：grid-demo RESULTS 的 0.45ms/行是 Vue v-for mount 时代数字；命令式 buildRow（本 demo，资产复用）= **0.053ms/行**（242ms/4580 行），8.5× 便宜。03 文档 §3.1「1000 行裸渲染 ≈0.5s」应修正为「≈60ms（同步）或 14ms 首块（分块）」。
- **DOM 节点价**：5000×20 ≈ 105k 节点常驻（grid-demo 同规模 ~5k）——全量渲染的内存/样式树代价，与订阅数（挂载行×20）同为「用空间换结构性零白屏」的账。

## 滚动帧率（#2/#3）

**headful 真 GPU（1200×860 窗口，真拇指拖拽）**：

| 场景 | fullrender cv1 | fullrender cv0 | grid-demo@5000（对照） | grid-demo@100k（历史） |
|---|---|---|---|---|
| wheel 17500px/事件 | 49.3fps | 40.7 | 51.2 | — |
| 拇指 fast 8px/10ms | 18.8fps | 13.8 | 17.9 | 45（快拖档） |
| 拇指 extreme 32px/10ms | **35.7** | **16.7** | 28.1 | ~45 |
| DOM 白屏采样（JS 层） | **0 全场景** | **0 全场景** | **0 全场景** | 空白带期间持续非零 |
| 拖拽中上屏（screencast） | 慢拖 15-30 行/步**满行**；快拖 60 / 极速 227 行/步 **~100% 白** | 极速 **~100% 白** | 快拖 57 / 极速 227 行/步 **~100% 白** | ~60% 视口空白带 |

- 位移物理值（5000 行，thumb 最小 28px 兜底 → 映射 ≈257px/px ≈ **7.3 行/px**）：fast 8px/步 ≈ 58 行/步、extreme 32px/步 ≈ 227 行/步——与采样实测 P95 57/679 行吻合（后者为忙帧合批）。
- **fps 是 rAF 主线程节奏，不是上屏节奏**：快拖档主线程 19.5fps 但上屏表体 ~100% 白——主线程在忙 paint commit，光栅化仍追不上每帧新暴露的 ~2000px 内容；这层只有 screencast（教训 10 的方法）看得见，停顿截图与 DOM 采样都看不见。感知顺滑度以作者本机手感复测为准。
- **c-v 的第二个收益**：extreme 拖拽 cv1/cv0 = 35.7/16.7（2.1×）——屏外行被 lock 后样式/布局不随滚动重算；headless 17500 跳滚档同向（27.6/15.3）。fling 低速档 cv 无差（25.9/25.3）——收益随每帧新暴露面积增长。但 c-v 不救上屏白——cv0 快拖同样整屏白：白的是「瓦片未光栅化」，不是「布局重算」。

**headless wheel（软光栅，仅方向性）**：cv1 fling1750 25.9fps / 17500px 27.6fps，白屏 0/705；cv0 25.3 / 15.3，白屏 0/707。headless 无 GPU 时新暴露行 paint 成本主导，真机预期只高不低（grid-demo 教训七）。

## 交互语义（#4/#5，bench 自检全 PASS）

- 编辑 `__cellRenders` 恰 +1、undo/redo 各 +1、文本更新正确——cell 级 === diff 语义在全量档原样成立（`__cellRenders` 计数契约不变）。
- 展开锚点补偿 + FullBody rowId reconcile：锚行不变、收起还原、可见行采样全过——树形语义零回归（reconcile：漂移行只重写 top，零 effect churn）。
- 键盘 End 跳尾（bench 外，native 会话手测）：满行即时（无挂载等待）。
- **编辑延迟实测**（execute 同步段，含 effect flush）：

| 规模 | 常驻 cell effect | 单次编辑/undo |
|---|---|---|
| 1000 行 | 20 000 | 58-75ms |
| 5000 行 | 91 600 | **1182ms** |
| 10000 行 | 181 100 | **4404-4572ms** |

超线性恶化（µs/effect 随规模上涨，GC/缓存二次效应）。**这是全量档的阿喀琉斯之踵**：滚动体验同级虚拟化档，编辑交互在 ≥5000×20 不可用。甜点档 ≤1000 行 60-75ms 勉强、≤500 行 ~30ms 良好。修法方向（不在本 spike 实现）：per-row dataVersion（行级版本原子，编辑只 bump 所属行）或脏行集广播——把 O(挂载 cell) 降到 O(变更行×20)。

## CDP 方法论增量（三条新教训，沿用 grid-demo 六条之后）

7. **变体 URL 拼接丢 `?` 会静默跑错变体**：`URL + 'rows=5000'` 被 SPA fallback 当路径回首页 → 实际跑默认 10 万行，数字「看起来正常」全然不觉。**变体生效性必须页面侧断言**（本例救命的断言是 `geo.sh ≈ flatRows.length × 35`）。
8. **合成 mouseMoved 唤不出 macOS overlay 滚动条**（右缘截图无滚动条、按压落在内容上、拖拽全静默）。确定性唤出 = 先 wheel 一格（滚动条必然现身 ~1-2s），150ms 内按压。
9. **拇指位移映射要用最小拇指长度兜底**：overlay/classic 滚动条拇指有系统最小长度（实测 ≈28px），5000 行下线性估计 2.8px 被兜底 → 实际映射 = (scrollH − clientH)/(trackH − 28) ≈ 257px/px，而非线性估计的 226px/px。grid-demo 旧代码硬编码 `trackTop+14` 恰好押中最小拇指中心，属侥幸成立。
10. **停顿截图对空白类结论是系统性假阴性**（本 demo 最大的方法论翻车，作者手感复测揭穿）：native 模式拖拽中途 `await Page.captureScreenshot` 的往返延迟会暂停拖拽输入派发，主线程/光栅化趁机追平——截到的是「追平后」状态。5000 行追平只要 1-2 帧，恰好全部落进盲区 → 初版「fast/extreme 连拍满行、任意速度零白屏」结论错误（grid-demo 复核小节的「连拍满行」同错）。真相 = `Page.startScreencast` 连拍：合成器每次 present 主动推帧、拖拽循环零停顿；帧名 `fNNN-stNNNN.png` 编码对齐后的 scrollTop（页内 rAF `__stLog` + 墙钟 offset，+30ms 容差），肉眼核对满行/空白。Chrome 152 细节：ack 方法名是 `Page.screencastFrameAck`（旧名 `screencastFrameAcked` 已改）。附带：cast 输出目录 tag 必须带速度档（`-${CAST_STEP}px`），否则同变体不同速度互相覆盖帧目录。

## 已知简化（正式版需补）

1. **编辑 O(全量 cell) 未分片**——见上表，正式版第一优先级（per-row version / 脏行集）。
2. 中途插入的树子行 append 到 body 末尾（DOM 序 ≠ 逻辑序，与 grid-demo 池化同款）；全量档可廉价修正（挂载按序 insertBefore），留正式版。
3. chunk 调度固定 200 行/帧，未做时间预算自适应（本意是让数字可复现；正式版可按帧剩余预算调整）。
4. 挂载中途数据变化走 reconcile 同步补齐（丢弃剩余 chunk 计划）——语义正确但会一次性付清挂载成本，极端场景（挂载中 regenerate）未优化。
5. a11y：行保留 role=row、DOM 序天然有序（优于 grid-demo 池化乱序），但 cell 仍无 role/aria（与 grid-demo 同级简化）。

## 对方向决策的含义（回填 03 文档的依据）

1. **§3.3「任意速度零白屏」被 screencast 证伪**：快拖及以上（≳57 行/步）两档 × cv0/cv1 四组，拖拽期间表体全部 ~100% 白——与渲染档、c-v 无关，是「合成器先行上屏新 offset + 新暴露区瓦片未光栅化」的通用物理；慢拖（≲30 行/步）满行，松手 ≤600ms 追平。总高缩小买到的不是「零白屏」，而是「白屏只在快甩时出现且松手即恢复」。两档在目标区间滚动体验依旧同级——但同级的原因变了：不是都不白，是白法一样（边界同在 ~30-60 行/步）。
2. **§3.1 成本叙事修正**：全量渲染的真实成本不在挂载（0.053ms/行，5000 行同步 242ms / 分块首块 14ms），在**编辑扩散**（O(挂载 cell)）与常驻内存（105k 节点 + 91.6k effect）。「甜点 ≤500 / 可用 ~5000」的包线在滚动维度成立，在编辑维度 5000 行需先做分片——档位承诺应以分片后的数字重述。
3. **c-v 从「兜底手段」升为「默认必开」**：挂载墙钟 3.6-4.6×、极速拖拽主线程 2.1×——两个硬收益（挂载墙钟是决定性的）。paint-hold 副作用初版称「未观察到」，但证据出自停顿截图、不足为凭（教训 10）；可站住的旁证 = cv0/cv1 拖拽中帧同样全白（白的机制与 c-v 无关），wheel 惯性段的 paint-hold 复测留待正式版。
4. **core 层第三个幸存数据点**：signal/command 0 改动，store 仅删虚拟化耦合面（-82 行）——「渲染器可替换」在 DOM 系内部再次成立（DOM 虚拟化 / canvas / DOM 全量三渲染器同 core）。

## 真实手感复测

作者 2026-09-05 反馈「极限拖滚动条全程白屏」——**已证实**（教训 10 的 screencast 复核：快拖及以上拖拽期间表体 ~100% 白；初版「应全程满行」是我方停顿截图的测量错误，不是作者环境问题）。仍待手感确认：慢拖应满行（≲30 行/步的手部速度）、快甩白但松手即满（≤600ms）、5000 行编辑一处的可感冻结（预期 ~1.2s，`?rows=1000` 对比）、`?cv=0` 挂载肉眼可见的慢（3.4s vs 0.9s）。
