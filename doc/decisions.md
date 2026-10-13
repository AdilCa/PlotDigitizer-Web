# 决策记录（Decisions Log）

跨里程碑的关键设计/实现决策。每次做出偏离文档、修正模型契约、或在多个合理方案中定夺的决策时，追加一条。
新条目加在对应里程碑小节末尾；推翻旧决策时不删除原条目，新增一条并注明「替代 #N」。

格式：`日期 | 决策 | 理由 | 影响面`

---

## M1（图像导入与画布基座）

| # | 日期 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 1 | 2026-10 | 渲染层不持有业务数据；ImageBitmap 等不可序列化资源由 `imageCache` 模块持有（模块级缓存），不进 store | store 需保持可序列化（.pdproj 持久化）；immer 不适合持有 GPU 资源 | `src/render/imageCache.ts`、CanvasView |
| 2 | 2026-10 | 图像 magic bytes 分流：PK→.pdproj、%PDF→pdf、其余按位图 | 无扩展名依赖，拖拽/打开同路径 | `src/io/fileAccess.ts` |
| 3 | 2026-10 | Playwright 中键拖动后必须 `mouse.up({button:'middle'})`，默认只释放左键 | 框架行为坑，已写入 e2e 用例 | `e2e/m1-large.spec.ts` |

## M2（校准工具组）

| # | 日期 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 4 | 2026-10 | TickFitter 按 architecture.md §4.3 **v1.2 简化版**（半深中点谷值中心、方向互换），**不**移植 C++ TickFitter.cpp 的 extent+MAD 复杂版 | 文档 v1.2 已显式修订；两点制下复杂鲁棒统计无收益 | `src/engine/tickFitter.ts` |
| 5 | 2026-10 | `Tick` 增补 `at: PixelPoint` 字段（用户点击完整位置），`pos` 仍为沿轴分量 | 拟合剖面必须在点击行/列取样，避开轴线自身暗色；`pos` 单数值无法还原剖面位置 | `model.ts`、`commands.addTick(axis, at)` 签名变更（数字 → 对象） |
| 6 | 2026-10 | 轴替换预告方案：拖动全程既有轴线 warning 高亮 + 状态栏文字预告，**松开即执行，不做二次确认** | 裁剪才是二次确认场景（破坏不可逆）；重画轴已有点保留、自动重算，预告足够 | `axisTool.ts`、`canvasRenderer.pushAxis` |
| 7 | 2026-10 | zustand 选择器纪律：**禁止返回新建对象/数组**（gateFor、axisMapping 等），改为订阅稳定分支引用 + 渲染期派生 | 新建对象导致 useSyncExternalStore 无限重渲染（React #185），M2 实测踩坑修复 | `src/ui/*.tsx` 全部组件 |
| 8 | 2026-10 | `setTickValue` 录入即清空 statusMessage，状态栏回退到 `nextActionHint` 实时引导 | 事件消息在完成动作后会滞后（铁律 4 要求状态栏永远回答「现在该做什么」） | `commands.ts`、App 状态栏 |
| 9 | 2026-10 | Worker fit 请求失败时 reject `WorkerRequestError`（携带 engine diagnostics），UI catch 后画扫描带/候选线 + 状态栏内联错误 | 铁律 5：Fit 失败内联可视化，零弹窗 | `workerClient.ts`、`axisTool.ts`、`Inspector.runFit` |

## M3（数据提取）

| # | 日期 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 10 | 2026-10 | 双击检测必须走原生 `dblclick` 事件，不能用 `pointerdown.detail`（规范上恒为 0） | E2E 实测「已抓起」不触发；已沉淀为 viewportControls.onToolDoubleClick | `viewportControls.ts`、`markerTool.ts` |
| 11 | 2026-10 | Confirm 拆两层：同步原语 `confirmMarkerAt/confirmMarker`（manual 路径、单测不经 Worker）+ 异步包装 `confirmMarkerRefined`（scatter/bar 走 Worker refine，失败按原位提交并内联提示） | 命令层保持同步可测；Worker 失败不丢弃用户点击数据（铁律 5） | `commands.ts`、Inspector Confirm 按钮、Enter 键 |
| 12 | 2026-10 | M3 的序列 UI 只做最小可用版（下拉切换 + 新建 + chartType/扫描方向 + 已确认计数）；完整序列列表（重命名/删除/分组工作流）仍属 M5-1 | plan.md 分工如此；避免 M3 范围蔓延 | `Inspector.tsx` ExtractBlock |
| 13 | 2026-10 | refineBar「首个强跳变」落地为：首条 \|Δgray\| ≥ 40 的跳变沿中点，±5px 五条剖面（-5/-2/0/2/5）中位数投票；全部剖面无跳变则原样返回 | §4.4 伪代码的歧义点取与 AxisFitter 一致的中位数抗离群风格 | `engine/refine.ts` |
| 14 | 2026-10 | 抓起态（grabbedId）是 markerTool 模块级瞬态，不进 store；切换工具/换图经 store 订阅自动放下 | 纯交互态无持久化价值；订阅比反向 import 更干净（避免 interact→state 循环依赖） | `markerTool.ts` |

## M4（PDF + IO + 导出）

| # | 日期 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 15 | 2026-10 | .pdproj 的 zip 容器**手写 store-only 读写器**（`io/zipStore.ts`，~150 行含 CRC32），不引入 fflate 等依赖 | STORE 格式简单且自写自读；保持零新增依赖、体积 ≈ 原图 | `io/zipStore.ts`、`io/projectFile.ts` |
| 16 | 2026-10 | pdfjs-dist **动态 import**（`await import('../pdf/pdfSession')`），主包不含 PDF.js | pdfjs 按需拆分后主包 203kB / PDF 块 366kB，打开 PDF 才付加载成本 | `fileAccess.ts`、构建产物 |
| 17 | 2026-10 | 导出保存双对话框（MD、PNG 各一次 showSaveFilePicker），API 不可用时回退 `<a download>` | File System Access 无法从文件句柄取父目录；浏览器记住上次目录，第二次起一键确认（§7.3 允许）；E2E 靠回退路径捕获 | `io/exporter.ts` |
| 18 | 2026-10 | PDF 区域坐标系统一为 **96 DPI 页像素**，渲染时换算 pt（72/96）+ 页面边界钳制 | E2E 实测区域渲染尺寸偏差 25%（坐标系混淆 bug）；钳制防拖出预览边界 | `pdf/pdfSession.ts` |
| 19 | 2026-10 | 加载重置预告（含 PDF 区域再导入）统一走 `pendingImport` 单通道：ui 只存文件名，File 本体在 fileAccess 模块态 | File 不可序列化、不该进 immer；预告 UI 与 CropBar 同风格 | `fileAccess.ts`、App ImportBar |
| 20 | 2026-10 | 个别点改名（§7.2 点列表）延后到 M5-1 序列/点列表一并做；M4 导出表单只覆盖点前缀与轴数值名 | 避免在 Inspector 里长出一个半成品点列表 | plan M5-1 |

## M5（打磨与总验收）

| # | 日期 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 21 | 2026-10 | 序列/点列表的行内输入框**不** stopPropagation 单击：点名字输入框 = 同时切换序列/选中点 | E2E 实测 stopPropagation 让输入框截获了行点击（行 90% 面积是输入框），「点行切换」失效；点输入框即选中反而更符合直觉 | `Inspector.tsx` SeriesRow/PointRow |
| 22 | 2026-10 | 补齐 interaction-spec §3 缺口：Esc 分级取消（pending marker → 点/刻度选中）；Delete 在取点工具无选中时删当前序列最后一个已确认标记 | M3 只做了「删除选中点」；M5-3 快捷键定稿时按规格补齐 | `App.tsx` 键盘分发 |
| 23 | 2026-10 | engine 夹具回归在 node 侧用**自写最小 PNG 解码器**（8bit RGB/RGBA：zlib inflate + 5 种 scanline unfilter），不引入 pngjs 等依赖 | 与 #15（zipStore）同一原则：格式简单、自写自读、零新增依赖 | `tests/engineM5.test.ts` |
| 24 | 2026-10 | 校准检查清单行整行可点击跳转到对应工具（未设置→画轴；已画→标刻度；已跳过→不跳），门控禁用时只显示原因不跳转 | ui-style §4「清单行可点击跳转」的落地方式；跳转同样受门控约束（铁律 5） | `Inspector.tsx` ChecklistRow |
| 25 | 2026-10 | M5-6（PWA 离线）不做：可选项且不计入工时，当前无离线使用需求 | plan.md 标注「排期富余再做」；避免无需求的功能负担 | plan.md M5-6 保持 ⬜ |

## 评审修订（代码审查 + 实际使用反馈）

| # | 日期 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 26 | 2026-10-11 | **替代 #4**：TickFitter 改用 C++ 多行策略——点击行起逐行定位（点击行无刻度时向两侧找 ±6 行），每行半深法取谷；同一行出现 ≥2 个同等深度的谷 → 报错「请调小扫描窗口」；谷触及窗口边缘 → 报错；向两侧扩展到不再是同一根刻度为止（≤40 行、中心漂移 ≤1.5px），各行中心 3·MAD 剔除后取平均。扫描窗口按轴可调，默认 ±10px（原 ±35） | 单行全局最小在次刻度场景下会吸到相邻刻度（实测点 400 得 380）；点击行落在轴线上直接失败；多谷静默选一个违背铁律 5 | `engine/tickFitter.ts`、`ui.tickScanHalf`、Inspector 扫描窗口输入框 |
| 27 | 2026-10-11 | 像素坐标约定：像素 (i, j) 覆盖 [i, i+1)×[j, j+1)，中心 (i+0.5, j+0.5)；engine 内连续坐标 → 下标一律 `floor`，输出一律连续坐标 | 原实现 trunc/round 混用，结果随点击小数部分漂移、柱顶有 0.5–1px 系统偏差；与渲染层 `drawImage(0,0)` 对齐 | `engine/gray.ts`（`grayAtIndex`）、axisFitter、tickFitter、refine |
| 28 | 2026-10-11 | **替代 #13**：refineBar 改为垂直扫描方向 ±5px 取**平均剖面**，取首个 \|Δ\| ≥ 10 的跳变区段内梯度最大处（像素边界）；扫描范围为序列级参数 `barSpan`（默认 40）；未找到边缘时按原位提交并在状态栏说明 | 旧判定要求相邻像素 \|Δ\| ≥ 40，软边/网纹柱（test1.png）0/8 次吸附；新判定 test1.png 三组柱子全部命中 | `engine/refine.ts`、`Series.barSpan`、Worker `RefineItem.barSpan` / `snapped` |
| 29 | 2026-10-11 | **替代 #10、#14**：取消双击与抓起态。已确认点按下即选中，按住拖动超过 3 屏幕像素后移动（保持按下时的相对偏移）；刻度同理 | 双击抓起与单击拖动效果重复，且多一种模式要记；阈值防止单击选中时手抖改坐标 | `markerTool.ts`、`tickTool.ts`、`viewportControls.ts`、App 键盘 |
| 30 | 2026-10-11 | 轴线可删除：面板「删除轴线」按钮；画轴工具下短按轴线选中（光晕高亮）后按 Delete。删除连带清除该轴刻度与刻度值，已取点保留 | 用户反馈找不到删除入口；级联语义与重画轴一致 | `commands.deleteAxisLine`、`ui.selectedAxis`、axisTool、renderer |
| 31 | 2026-10-11 | 刻度显示位置：未拟合画在用户点击处 `at`，拟合成功后吸附到轴线上的投影；命中测试按显示位置。拖动已拟合刻度只沿轴移动、`at` 保留原垂直分量 | 与 C++ TickEditOverlay 一致；原实现一点击就画到轴线上，拖动后 `at` 落在轴线行导致拟合失败 | `selectors.tickAnchor`、hitTest、tickTool、renderer |
| 32 | 2026-10-11 | 「已校准」= 刻度、值齐全**且映射可解**；不可解（两刻度同位置 / 同值 / log 非正）为新阶段 `invalid`，面板与状态栏给出原因。切换线性/对数时清空两个刻度值 | 原实现徽标显示已校准但导出/hover 静默缺列；切换类型后旧值语义失效 | `selectors.isAxisCalibrated/axisIssue/axisPhase`、`geometry.solveMapping`、`commands.setScaleType` |
| 33 | 2026-10-11 | 取点门控要求有当前序列；新建序列必须选图表类型（散点/柱状/手动）。当前工具门控失效时（跳过轴、删除序列/轴线、换图）自动回退到画轴工具 | 无序列时取点没有意义；换图保留 activeTool 曾绕过门控 | `selectors.gateFor/toolFallback`、`commands.addSeries(chartType, name?)`、Inspector 新建序列 |
| 34 | 2026-10-11 | 裁剪单一来源：选框外扩为整数像素矩形一次算好（`cropPixelRect`）；Worker 校验请求时的图像尺寸、回传累计 `region`，主线程直接采用；在途期间禁用确认/工具切换/加载新文件 | 原实现主线程与 Worker 各自累加 region，连按两次会双重累加；分别 round 可越界 1px | `cropTool.ts`、Worker crop 协议、`fileAccess.rebindDisplayAfterCrop` |
| 35 | 2026-10-11 | 改点前缀时，仍是自动命名（旧前缀+纯数字）的已有点同步改名，手动改过名的点不动；改序列名时，前缀仍等于旧序列名则跟随 | 点名在 Confirm 时固化，原实现导出表单改前缀只影响之后的新点，对已取点无效 | `commands.setPointPrefix/renameSeries` |
| 36 | 2026-10-11 | 批量取点用面板显式开关（不用 Shift+点击之类的隐藏操作）；开关只影响点击空白追加/替换，Confirm 永远提交全部未确认标记，一批一次 Worker 请求 | owner：隐藏操作久不用会忘；开关不丢已放标记，关掉也能一次确认；Worker 协议本就是批量接口，无需改动 | `ui.pendingMarkers/batchPick`、markerTool、`commands.confirmMarkerRefined`、Inspector「批量取点」 |
| 37 | 2026-10-11 | 导出标注截图标出点名；画布不显示 | owner 选择；画布上点密时名字会挤 | Worker `renderAnnotated`、`render/annotatedLabel.ts` |
| 38 | 2026-10-11 | **替代 #18**：PDF 导入改为选页弹窗（缩略图 + 大预览，对齐 C++ PdfImageDialog 的交互）+ 整页按 DPI（150/300/600）导入；删除检查器内联图库的预览框选 | 预览框选是画布外的第二个裁剪入口，违背"只在画布上的图像编辑工具里裁剪"；不提取嵌入图片是因为矢量图表没有嵌入位图，整页渲染两种都适用 | `pdf/pdfSession.ts`、`pdf/pdfImport.ts`、`ui/PdfDialog.tsx`、`fileAccess.importPdfPage` |
| 39 | 2026-10-11 | 铁律 5「零弹窗」的唯一例外：PDF 选页弹窗（页内遮罩层）。错误与反馈仍一律内联 | owner 明确要求弹窗选页；选页是一次性的选择任务，不是反馈 | `ui/PdfDialog.tsx`；弹窗打开时 App 画布快捷键让位 |
| 40 | 2026-10-11 | 换图 / 恢复 .pdproj 保留 PDF 会话（`ui.pdfGallery`） | 原实现 `loadImage` 重置整个 UI 状态，导入一页后图库即消失，会话缓存形同虚设 | `commands.loadImage/restoreProject` |
| 41 | 2026-10-11 | 「散点/折线」改名「散点」；吸附半径改为序列级参数 `scatterRadius`（默认 8）；取点工具下画布画出 refine 实际读取范围（散点方框 / 柱状条带） | owner 无拟合线需求，质心法在折线拐点会偏；窗口可见可调后，用户能把窗口收到刚好框住一个标记，网格/文字不进窗口 | `engine/refine.refineWindow`、`Series.scatterRadius`、renderer `pushRefineWindows`、Inspector「吸附半径」 |
| 42 | 2026-10-11 | 图像读回灰度前一律先铺白底（Worker 灰度化、导出 PNG、标注截图；画布绘制同样铺白）；每次 Confirm 都在状态栏报告结果（已吸附 + 移动距离 / 未吸附原因 / 手动不吸附） | 透明像素读回为 (0,0,0,0) 会被当成纯黑，质心被整窗"黑"拉平、点原地不动，看起来像没拟合；原实现吸附成功时没有任何反馈，用户无从判断是否执行了 refine | Worker `drawOnWhite`、renderer `paint`、`commands.confirmSummary` |
| 43 | 2026-10-11 | **替代暗度质心**：散点 refine 改为颜色分割 + 点击处连通块重心（背景色取全图直方图峰值；标记色取点击附近物体最浓处；半程阈值掩膜；孤立块填孔取 α 加权重心；连线 / 成串 / 粘连时取距离变换上离点击最近的内切圆圆心再局部求重心）。Worker 不常驻 RGBA，按点读局部块；「吸附半径」改名「搜索半径」，标记碰到搜索框即可；确认后画布显示吸附所用像素的凸包 | `255−gray` 权重不扣背景：灰底 / JPEG 噪声的背景权重铺满窗口，把重心拉回点击处，点停在标记边缘；C++ 的 `localMax` 扣除法在窗口落进标记里时失效。owner 的图（EIS 多温度谱）标记成串重叠、四色挤在原点附近，必须能分开同色串和异色标记。模板匹配（方案 B）操作复杂，owner 不要 | `engine/markerBlob.ts`、Worker `refineScatterBatch`、`ui.refineOutlines`、renderer `pushRefineOutlines` |
| 44 | 2026-10-11 | 填孔不再限于孤立块：碰到读取范围边界的块同样填不连边框、面积 ≤ πr² 的封闭区 | test1.png 的空心圆（直径约 11px）被同色折线穿过，块连着线碰到边界，原规则不填孔，圆内被线切开的碎片留空，距离变换峰值落在折线进出圆环的交汇处，落点随点击方向偏 2–5px；填孔后六个方向点击收敛到同一圆心（±0.2px） | `engine/markerBlob.ts` 填孔段、`engineM5` test1 空心圆回归 |
