# PlotDigitizer-CC "卡手"问题诊断报告

> 纯代码阅读分析，未做任何修改。所有结论附 file:line 证据。
> 适用版本：当前 `qml` 分支工作区（含未提交的 TickFitter/DebugOverlay 改动）。
> **一句话总结：核心算法路径是通的，但"状态在步骤间的存活规则"只有读代码才能知道；"卡手"大概率不是某一步慢，而是每一步都在潜意识里担心误操作毁掉上一步的成果，而界面既不保证也不解释。**

---

## 综合诊断：5 个最可能根因（按严重度排序）

**① 状态可见性断裂——"我的东西还在吗？"是贯穿全程的焦虑源（最重）**
显示态（overlay）与模型态（project）在步骤切换时被代码故意拆开：进第 6 步清画布但留数据（F3.1）、marker 确认了就不画（F3.2）、第 7 步什么都不显示（F1.3）、加载后也不恢复（F7.2）。UX 语言这叫 **violation of state visibility**。最糟的单点是 F3.1：一个误点击可以无确认地毁掉整个序列，且界面看起来只是"重新开始了"。

**② 破坏性输入无处不在，且全部无撤销兜底**
第三下点击替换刻度（F2.3）、双击产生重复点/抹掉轴线（F2.1）、右键删除有隐藏前置条件（F2.2）、新图片不清旧校准（F3.4）。撤销栈只保护 Fit 操作，点级别的 `ExtractDataCommand` 写了却没接（F6.1）。用户的防御策略只能是"慢一点、小心点"——**小心翼翼的操作手感就是"卡手"本身**。

**③ 校准返工的成本被隐藏，而非被管理**
重拟合轴/刻度后没有任何代码重算 dataPoints（F3.3），CSV 内部自相矛盾无任何提示；跳过 X 刻度静默生成 dummy 数据（F1.1）。好的向导应在 Back 时明确告知代价，并在校准变更后标记数据"待刷新"。现在的实现是**沉默地做错事**——这比"禁止返回"更伤信任。

**④ "Fit 赌博"循环：错误的反馈形态与重试成本不匹配**
四步校准全靠 draw→Fit→**模态对话框**试错。模态对话框是工作流中断器，每次失败都强制离开心流。配合 F4.2/F5.1（按钮无条件可用、画布无提示），新手会在"画线—弹窗—重画"里循环多次。**把错误信息变成画布上的内联反馈（画出搜索带、标出内点/外点，DebugOverlay 已经能做）即可大幅解压**。

**⑤ 门控与引导不成体系**
哪些步骤可跳、跳了会怎样（F1.1 静默 dummy 数据）、每步该做什么（F5.1），信息缺失或藏在 "?" tooltip、或以弹窗事后告知。步骤器绿灯反映的是 project 状态而非"对当前图片有效"的状态（F3.4 中旧图绿灯全亮）。用户被迫在脑中维护一套只有读代码才知道的规则——认知负担直接转化为卡顿感。

---

## 1. 步骤门控（Step Gating）

**F1.1｜高｜流程+数据完整性：跳过 X 刻度会静默产生垃圾数据**
`WizardController::onNextStep` 允许跳过 X 刻度（`WizardController.cpp:217`，弹"Skip?"询问框），但 `CoordinateSystem::buildFromProject` 在缺 X 刻度时**不报错，而是伪造一组 dummy 值**（`CoordinateSystem.cpp:37-43`：`m_xStart=1.0, m_xStep=1.0`，即 x 数据 = 1,2,3…）。用户若跳过后续直接导出，CSV 会"成功"生成，但非柱状图的 x 坐标全是假索引，全程无任何警告。对比：`onExport` 只在 `buildFromProject` 返回 false 时提示 "Calibrate first."（`WizardController.cpp:341`），而 dummy 路径永远不会触发它。

**F1.2｜中｜流程：门控规则不对称且无解释**
X 刻度可跳过（:217）、Y 刻度强制（:220 "Fit ticks first"）、轴强制 Fit（:211,214）。这个不对称是为 bar 模式设计的，但 UI nowhere 说明"跳过 X 刻度只适用于柱状图"。`StepPanelBridge::applyStepState` 中 MarkXTicks 的 `nextEnabled` 无条件为 true（`StepPanelBridge.cpp:70`），用户不知道跳过的后果。

**F1.3｜高｜反馈：第 7 步叫 "Review & Export" 但没有 Review**
`StepPanelBridge.cpp:89-90` 描述写 "Review extracted data, then click Export CSV"，但代码里这一步只有一个 Export 按钮：无表格、无列表，且画布上**一个点都看不到**（原因见 F3.1——进入第 6 步时画布点被清空，第 7 步没有任何代码把点重新画回来）。用户点 Next 进入第 7 步，面对一张空图和一个导出按钮。

**F1.4｜低｜流程：Back 自由但代价不透明**
`saveOverlayState`（`WizardController.cpp:37-44`）在离开步骤时保存轴线/刻度，Back 本身不丢数据——这一点是好的。但 Back 的代价转移到了别处：重新进入第 6 步会清空画布上的点（见 F3.1），所以"往回改一步"实际上暗藏风险，而 UI 完全不提示。

---

## 2. 交互模式混乱（Interaction Mode Confusion）

**F2.1｜高｜交互：双击 = 说明书撒谎 + 制造重复点**
README（`README.md:153`）承诺"双击：图像适应窗口"，`ImageViewer::mouseDoubleClickEvent`（`ImageViewer.cpp:241-245`）也实现了。但覆盖层吃掉了双击事件（Qt 默认把未处理的 double-click 转成 press 发给覆盖层自己）：
- EditPoints 模式下双击空白 = 添加**两个重叠点**（`DataExtractOverlay.cpp:208` press 加一次，双击转换的 press 再加一次）；
- AxisEditOverlay 下双击会开始画新线，松手时因 <10px 被丢弃（`AxisEditOverlay.cpp:191-193`），用户已画好的近似线被静默抹掉，再点 Fit 弹 "Draw an approximate X axis first."。

**F2.2｜中｜交互：右键删除有隐藏前置条件**
README 说"右键点击删除"（`README.md:112`），但 `DataExtractOverlay.cpp:211` 要求 `m_selectedIdx >= 0`——右键必须先左键选中过的点才能删；直接右键点一个未选中的点，什么都没发生。且左键点空白**只会加点、无法取消选择**（:200-208），唯一的"取消选中"方式是右键（删掉它）或 Delete 键。

**F2.3｜中｜交互：刻度恰好只能点 2 个，第三个点击是"替换"陷阱**
`TickEditOverlay.cpp:130-139`：已有 2 个刻度后，任何左键点击会**替换离得最近的那个刻度**。用户想加第 3 个刻度（或对某个刻度附近空白处误点一下），一个好的刻度就被静默顶掉了，无任何提示、无撤销。失败提示文案 "Place exactly 2 tick marks."（`WizardController.cpp:167`）只在 Fit 时 <2 才出现，不解释为什么不能点第 3 个。

**F2.4｜中｜交互：轴线选中后不能拖，只能方向键微移；微移后画面出现两条分叉的线**
`AxisEditOverlay` 选中态画了端点手柄（`AxisEditOverlay.cpp:82-87`）但两端点都不可抓取；拖动选中线 = 开始画一条新线覆盖旧线。方向键微移 emit `contentChanged` → `updateImageViewerOverlays`（`WizardController.cpp:93-101`）画的是 `project.fittedXAxis`（旧值），而覆盖层画的是自己微移后的 `m_line`——**同一根轴在屏幕上分裂成两条线**，直到重新 Fit 才合并。

**F2.5｜中｜交互：Marker 模式确认后方向键"失灵"**
确认后 `m_markerConfirmed=true`，而 `keyPressEvent` 的微移分支要求 `!m_markerConfirmed`（`DataExtractOverlay.cpp:251`）。用户 Confirm 完想微调，方向键毫无反应，必须先再点一下画布。Escape 清除标记（:263）完全未在文档/UI 中说明。

**F2.6｜低｜交互：添加点的同时立即进入拖拽**
`DataExtractOverlay.cpp:208`：左键按下加点的同一瞬间 `m_dragging=true`，按下与松开之间的轻微抖动就会移动新点（虽然可用 Refine 补救）。

---

## 3. 校准返工成本（Calibration Rework Cost）——最严重的一类

**F3.1｜高｜流程：重新进入"提取数据"步 = 画布清空 + 一次点击全灭**【owner 已确认为 bug】
进入 ExtractData 时：`WizardController.cpp:71-76` 对非 marker 模式执行 `m_dataOverlay->setDataPoints({})`——画布上的点全清空，但 `project.dataSeries.last().pixelPoints` **仍保留旧点**。此时用户看到"我的点没了"的困惑；一旦他点击画布添加一个新点，`onPointsEdited`（:261-264）执行 `ser.pixelPoints = points`（此刻 overlay 只有 1 个点），**整个序列被静默覆盖成 1 个点**。没有任何确认对话框。典型触发路径：提取了 30 个点 → 发现 X 轴画偏了 → Back 回去重画 → Next 回来 → 全没了。

**F3.2｜高｜流程：marker 模式下已确认的点永远不显示**
PlaceMarker 模式的 `paintEvent` 只画当前 marker（`DataExtractOverlay.cpp:139-160`），从不画 `m_points`；`onMarkerConfirmed` 也不往 overlay 的 `m_points` 里写（`WizardController.cpp:295-320` 只追加到 project）。叠加 `setMode()` 每次清空 marker（`DataExtractOverlay.cpp:16-24`）——**每确认一个标记，上一个就从屏幕上消失**，已确认数量 nowhere 显示（状态栏只报像素坐标 :319）。marker 工作流里用户始终处于"刚才那个点存上了吗？"的不安中。

**F3.3｜高｜数据完整性：校准变更不会级联重算数据点**
数据流：`pixelPoints`（像素）→ `dataPoints`（数据坐标）只在 `onPointsEdited`（:265）、`onRefineDataClicked`（:277）、`onMarkerConfirmed`（:309-317）三处换算。重拟合轴/刻度后**没有任何代码重算 dataPoints**。导出时 `CsvExporter.cpp:99-108` 用的是缓存的 `dataPoints` 配上**新**的校准参数表头——CSV 内部自相矛盾，无任何提示。同样，重拟合 X 轴后 origin 重算（:135）但 `xTicks.refinedMarks` 不更新、不提示"刻度可能已偏离轴线"。

**F3.4｜高｜流程：加载新图片不清空旧校准**
`Project::reset()` 存在但**全工程无人调用**（grep 证实）。`WizardController::loadImage`（:23-28）只覆盖 image/path 就跳到第 2 步：旧图的 `fittedXAxis`/`xTicks`/`dataSeries` 全部保留，stepper 上绿灯全亮（全是旧图的），画布上旧轴线画在新图上，`updateImageViewerOverlays` 照画不误。导出 = 旧校准 × 新图片。且 `MainWindow::loadImage`（`MainWindow.cpp:336-340`）和 `closeEvent`（:370-374）都不做脏检查/保存确认，未保存的工作一键蒸发。

**F3.5｜中｜数据完整性：导出行数静默截断**
`CsvExporter.cpp:99` `qMin(pixelPoints.size(), dataPoints.size())`——两个数组长度一旦不一致（marker/manual 混用同一序列即可造成，见 F6.3），多出的行被无声丢弃。

---

## 4. 逐步摩擦（Happy Path 成本）

完整 happy path ≈ **21 + N 次操作**（N = 数据点数）：Open(1) → Next(1) → [拖线、Fit、Next]×2 → [点2下、填2个值、Fit、Next]×2 → N 次点击 → Next → Export(1)。单看尚可，但每一步 Fit 都是一次"赌博"：

**F4.1｜中｜反馈：Fit 失败 = 模态对话框，重试 = 重画 + 再赌**
`WizardController.cpp:128,132,146,167,178` 全部用 `QMessageBox::warning` 阻塞式报错。用户必须点头关闭弹窗、重画、再点 Fit，循环直到成功。唯一的视觉辅助是 Debug Viz 复选框——一个面向开发者的调试开关，普通用户不知道要开它才能看见算法"看见了什么"。

**F4.2｜低｜反馈：Fit 按钮无条件可用**
`StepPanelBridge.cpp:54,61,68,75` 每一步 `fitEnabled = true`，哪怕用户还没画线/点——点了才弹 "Draw an approximate X axis first."。

**F4.3｜低｜交互：10px 以下拖拽被静默丢弃**
`AxisEditOverlay.cpp:191-193`：谨慎地小心拖了 9px 的线直接消失，无提示。

**F4.4｜低｜流程：Value 1 / Value 2 输入模式**
`StepPanel.qml:71-90`：用户要理解"填第二个刻度的值，步长自动算差值"，帮助只藏在 "?" tooltip 里；填反了会得到负 stepValue，无任何校验提示。

---

## 5. 反馈缺口（Feedback Gaps）

**F5.1｜中｜反馈：校准四步 + 手动提取步，画布上零提示**
LoadImage 步有居中提示文字（`ImageViewer.cpp:118-121`）、marker 模式有提示（`DataExtractOverlay.cpp:154-159`），但 DrawXAxis / DrawYAxis / MarkXTicks / MarkYTicks / EditPoints 模式下画布空白处**什么都不画**。每步唯一的说明是侧边栏标题旁 "?" 的 hover tooltip（`StepPanel.qml:34-44`）——用户不看 tooltip 就不知道"这一步该拖线还是点一下、右键有没有用"。

**F5.2｜中｜反馈：confirmMarkerEnabled 闩锁 + 无 marker 也可确认**
`StepPanelBridge::setMarkerInfo` 把 `m_confirmMarkerEnabled` 置 true（`StepPanelBridge.cpp:121-128`）后**没有任何代码把它复位**。`onMarkerConfirmed` 不检查 `hasMarker()`（`WizardController.cpp:295-320`），`setMode()` 清了 `m_hasMarker` 但 `m_markerPt` 保留旧值——重新进入 marker 模式后，不点画布直接点 Confirm，会在上一个（或初始 (0,0)）位置存入一个点。

**F5.3｜低｜反馈：Refine 空点集时静默无操作**
`WizardController.cpp:271-272` 直接 return，按钮常显可点，点了没反应也没提示。

**F5.4｜低｜反馈：校准阶段状态栏不显示数据坐标**
`MainWindow.cpp:188-201` 的数据坐标依赖 `m_coordSys`，而它只在进入第 6 步时构建（`WizardController.cpp:74`）——用户在第 3/4 步微调刻度时，状态栏只有像素坐标，无法即时验证"这个刻度对应的数据值对不对"。

---

## 6. 数据提取中的选择/编辑摩擦

**F6.1｜高｜交互：点的增删拖全部不可撤销**
`QUndoStack` 存在，但只接了 `DrawAxisCommand` 和 `MarkTickCommand`（`WizardController.cpp:136,150,189`）。`ExtractDataCommand` / `AdjustCommand` 两个命令类**写好了却没有任何地方实例化**（grep 证实 commands/ 之外零引用）。误删一个点（右键或 Delete）只能手重点回来；README 宣称"完整的撤销/重做支持"（`README.md:16`）与实际不符。

**F6.2｜中｜交互：拖拽过程全量重算 + 无合并**
`DataExtractOverlay.cpp:221` 拖拽每个 mouse-move 都 emit `pointsChanged` → `onPointsEdited` 用 `cs.buildFromProject` + 全序列 `pixelToData` 重算（`WizardController.cpp:265`）。大图上拖一个点 = 每帧重建坐标系 + 换算全部点；且没有 undo 命令可合并（README 承诺的"键盘微调自动合并撤销步骤"无对应实现）。

**F6.3｜中｜流程：图表类型切换 = 模式硬切 + 序列混用**
`onChartTypeChanged`（`WizardController.cpp:250-259`）只改 `last().chartType` 并切 overlay 模式：manual → marker 时旧点留在序列里（导出时与 marker 点混在一起，配合 F3.5 静默截断）；marker → manual 时 `setDataPoints(pixelPoints)` 把 marker 确认的点和之前 manual 的点混在一起显示。无"新建序列"入口——"Series N" 命名暗示多序列（:252,263,305），实际全程只操作 `last()`。

**F6.4｜中｜流程：第 7 步画布仍可改数据，且行为取决于残留模式**
`DataExtractOverlay` 不检查 `m_editingEnabled`（其 mousePressEvent 无此门，`DataExtractOverlay.cpp:186-214`），`updateOverlayVisibility` 也只在第 6 步调 `setMode`（`WizardController.cpp:64-66`）。第 7 步点击画布仍可增删点（走 `onPointsEdited`，绿灯 `dataOk` 状态变化）；若残留 marker 模式，点击还能放标记但 Confirm 按钮已被隐藏（`StepPanelBridge.cpp:93`）——标记放不下、又没提示为什么。

**F6.5｜低｜交互：命中半径固定 12 屏幕像素**
`OverlayWidget.h:27` `kHitRadius=12` 固定为屏幕像素：高倍放大下点密集时极难点中目标点，低倍缩小下又太容易误抓。

---

## 7. 文件/项目往返

**F7.1｜中｜流程：Save 永远弹保存对话框**
`WizardController::onSave`（:323-329）每次 `getSaveFileName`，不记住上次路径，Ctrl+S 无法"增量保存"。

**F7.2｜中｜流程：加载项目后点的显示同样断裂**
`onLoad`（:330-338）→ `goToStep(savedStep)` → 若存于第 6 步，走 F3.1 同一路径：overlay 点被清空，旧点在 project 里但画布不可见，一点击即覆盖。

**F7.3｜低｜文档与实际不符：Ctrl+= / Ctrl+- 未接线**
README 承诺（`README.md:145-146`），`MainWindow` 只注册了 Ctrl+0（`MainWindow.cpp:68`）；`zoomIn()/zoomOut()` 存在但无连接。

---

## 证据索引

`src/app/WizardController.cpp`、`src/app/MainWindow.cpp`、`src/ui/StepPanelBridge.cpp`、`src/qml/StepPanel.qml`、`src/ui/ImageViewer.cpp`、`src/ui/AxisEditOverlay.cpp`、`src/ui/TickEditOverlay.cpp`、`src/ui/DataExtractOverlay.cpp`、`src/core/CoordinateSystem.cpp`、`src/export/CsvExporter.cpp`、`src/core/Project.h`、`src/commands/`（未接线的 undo 命令）。
