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
