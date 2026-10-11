# PlotDigitizer-CC 代码与构建臃肿度审计报告

> 只读审计，未修改任何文件。所有结论附 file:line 证据。
> 代码基线：`src/` 下约 6200 行 C++/QML（44 个编译单元），构建产物 132 MB（`tools/` 25 MB、QML 11 MB、42 个 DLL）。
> **总结论：代码量本身不算臃肿，真正的"胖"在构建/部署侧；但存在约 650+ 行（>10%）确认死代码和一个明显的性能热点。**

---

## 一、确认的死代码（大赢，约 650 行，均可安全删除）

以下每项都经过全库 grep 验证，除自身文件外**零调用点**：

| 文件 | 行数 | 证据 |
|---|---|---|
| `src/algo/LineDetector.{h,cpp}` | 167 | 仅自引用（`LineDetector.h:10`、`LineDetector.cpp:16,82`），无任何外部调用 |
| `src/algo/DataPointExtractor.{h,cpp}` | 183 | 仅自引用；`DataPointExtractor.cpp:3` 还 `#include <opencv2/geometry/2d.hpp>` |
| `src/algo/ColorExtractor.{h,cpp}` | 92 | 仅自引用（`ColorExtractor.cpp:9,62`） |
| `src/commands/AdjustCommand.{h,cpp}` | 81 | 全库无 `new AdjustCommand` |
| `src/commands/ExtractDataCommand.{h,cpp}` | 62 | 全库无 `new ExtractDataCommand` |
| `ImageUtils::cvMatToQImage` + `qPixmapToCvMat` | ~39 | 声明/定义后无人调用（`ImageUtils.cpp:20-71`） |
| `src/core/Project.cpp` | 3 | 空编译单元，只剩一句注释；`reset()` 已在 `Project.h:74` 内联 |

### 死成员/API（小赢，散布各文件）

- `ImageViewer::zoomIn()/zoomOut()`（`ImageViewer.cpp:48-70`，22 行）— 从未调用，缩放走 `wheelEvent`；`removeOverlay()`（:98）— 只调 `clearOverlays`；`updateDisplayTransform()`（`ImageViewer.h:69`）— 声明了但从未定义/调用。
- `AxisEditOverlay::fitRequested`、`TickEditOverlay::fitRequested` 信号 — 从不发射；`TickEditOverlay::setSelectedIndex()`（`TickEditOverlay.cpp:59`）— 无人调用。
- `DataExtractOverlay` 的 mask 预览功能整个是死的：`setMaskPreview()` 无人调用，只有 `clearMaskPreview()` 被调（`WizardController.cpp:72`），`m_maskPreview` 永远为空 → `DataExtractOverlay.cpp:136` 的绘制分支不可达。连带 `setMarkerSize`（键盘 +/- 直接改成员）、`markerShapeToString()`（:46-61）、`dataPoints()` getter、`markerConfirmed` 信号均无消费方。
- `DebugOverlay::clear()`（`DebugOverlay.cpp:39`）— 无人调用。
- `WizardController::currentStep()`/`undoStack()` getter（`WizardController.h:33,37`）— 无人调用。
- `DataSeries::guidePoints`/`sampleColor`（`Project.h:35,39`）— 无生产代码写入，只在 `ProjectIO.cpp:123-136,237-249` 和 `CsvExporter.cpp:97` 序列化/读回，是一条没有源头的数据通路。

---

## 二、部署重量（最大的一块，~35-40 MB 可裁）

1. **【大赢】`tools/` 整个目录被原样拷贝**（`CMakeLists.txt:139-148` `copy_directory`），但运行只需要 `pdfimages.exe` 一个程序。`MainWindow.cpp:266` 和 `PdfExtractor.cpp` 只引用 pdfimages。当前 25 MB 里：11 个其他 poppler 工具（pdfattach/pdftocairo/pdftotext… 约 0.6 MB）+ `zstd.exe` 确定无用；`libcrypto-3-x64.dll`（7.4 MB）、`libcurl/libssh2`（1 MB）、`cairo/pixman`（1.6 MB）、`poppler-glib/poppler-cpp`（0.6 MB）、重复的 `libexpat/libtiff/zstd`（各两份，约 1.3 MB）几乎肯定不是 pdfimages 的依赖。**诚实声明**：精确白名单需要用 Dependency Walker 或干净目录实测验证（pdfimages 至少需要 poppler.dll 6.2 MB + freetype/fontconfig + 编解码库），保守可裁 12–15 MB，乐观接近 18 MB。
2. **【中赢】OpenCV DLL 用 `file(GLOB ... bin/*.dll)` 全量拷贝**（`CMakeLists.txt:152`），实际链接只有 `core imgproc`（`CMakeLists.txt:21`，CLAUDE.md 正确，README 说含 geometry 是错的）。`libopencv_geometry500.dll`、`libopencv_flann500.dll` 是白拷的。
3. **【小赢】windeployqt 拷贝了全部 6 套 Qt QuickControls2 样式**（Material/Universal/Fusion/Imagine/FluentWinUI3/Windows，见 build/ 目录），而 `main.cpp:23` 强制 `QQuickStyle::setStyle("Basic")`。样式 DLL+Impl 合计数 MB，可在 deploy 后删除或写裁剪脚本。
4. MinGW 运行时（libstdc++/libgcc/libwinpthread）由 windeployqt 拷、libgomp 由 CMake 单独拷（:159-170），都必要，无冗余。

---

## 三、运行时性能热点（中赢，修复成本极低）

- **【明确 bug 级浪费】`WizardController::refinePointScatter`/`refinePointBar`**（`WizardController.cpp:230,241`）在每次调用时都对整张图做 `ImageUtils::qImageToGray`（RGB888 转换 + BGR2GRAY + clone 三次全图遍历），而 `onRefineDataClicked`（:275）对**每个数据点**各调一次 → N 个点的 refine = N 次全图转换。修复只需把 gray 提到循环外一次。50 点 × 2000×1500 图时这是秒级 vs 毫秒级的差别。
- **【中】拖拽数据点时的事件链过重**：`DataExtractOverlay` 每次 mouseMove 都 `emit pointsChanged`（`DataExtractOverlay.cpp:221`）→ `onPointsEdited`（`WizardController.cpp:261-267`）重建坐标系 + 重算全部 dataPoints + `updateStepPanel` + `updateImageViewerOverlays`（后者 `clearOverlays` 后再 set 4 个 overlay，每次 set 都触发 `update()`）。可按需合并为一次脏标记。
- **【小】`ImageViewer::paintEvent`**（:112-155）无缩放缓存：`m_cachedPixmap` 缓存的是未缩放原图，每次重绘（平移每个 mousemove、叠加层任何 `update()`）都做全图缩放绘制。图表尺寸下可接受，但叠加层 `update()` 会连锁重绘底层整图。
- **【小】7 个叠加层是叠放的全尺寸透明 QWidget**，全部开 `mouseTracking`，每次鼠标移动要过 8 个 widget 的 mouseMove；`AxisEditOverlay::mousePressEvent` 每次点击还打 qDebug（`AxisEditOverlay.cpp:99`）。
- **【小】状态栏坐标标签每个 mousemove 都 `setText`**（`MainWindow.cpp:193`），引发状态栏整栏重绘。

---

## 四、重复模式（中/小赢）

1. **箭头键 nudge 逻辑复制了 3 份**：`AxisEditOverlay.cpp:202-226`、`TickEditOverlay.cpp:200-225`、`DataExtractOverlay.cpp:248-285` — 完全相同的 shift-step + 四方向 switch，可上移到 `OverlayWidget`。
2. **可见性逻辑双头管理**：`MainWindow::onStepChanged`（`MainWindow.cpp:223-230`）和 `WizardController::updateOverlayVisibility`（`WizardController.cpp:46-77`）都在切换同一批叠加层的 `setVisible`，两处会互相覆盖，属于职责不清而非单纯重复。
3. **marker 形状映射两套并行表示**：`StepPanel.cpp:7-9` 的索引数组和 `DataExtractOverlay.cpp:31-61` 的字符串 switch 必须手工保持同步，易错位。
4. **QML 内部重复**（`StepPanel.qml`）：+/- 步进按钮复制 4 份（:112-115, 126-129, 185-188, 198-201）；ComboBox 的 background+indicator Canvas 复制 2 份（:154-161, 168-175）；"?" 帮助图标模式 3 份（:34-44, 96-106, 131-144）。文件已用 `component StepRow` 和独立按钮组件证明了正确做法，照抄即可。
5. 点小重复：`AxisEditOverlay.cpp:121-124` 与 :162-165 同文件内点到线距离算两遍；`WizardController::computeOrigin`（:110-118）手算直线交点，而 `QLineF::intersects()` 三行可替代。

---

## 五、Theme.h 的僵尸样式（中赢，~180/327 行）

`main.cpp:36` 全局应用 `kGlobalTheme`，但 UI 已全面 QML 化，Widgets 侧只剩 `PdfImageDialog` 的 QDialogButtonBox（内部 QPushButton）。全库无 `setProperty("class", ...)`（grep 零命中），所以 `Theme.h` 中 primary/warning/success/nav-btn/file-btn 五套按钮变体（:146-235，约 90 行）以及 QGroupBox（:96-112）、QComboBox（:237-267）、QSpinBox/QDoubleSpinBox（:269-306）、QCheckBox（:308-325）选择器**全部匹配不到任何控件**。

---

## 六、OpenCV 依赖诚实评估

实际用到的 API 面（live 代码）：`cv::Mat`（当作灰度字节缓冲）、`cv::cvtColor`（仅 `ImageUtils.cpp:16,64` 的 RGB→Gray/转换）。所有重量级 API——`inRange`（ColorExtractor）、`morphologyEx/findContours/moments/arcLength`（DataPointExtractor）、`Canny/HoughLinesP/fitLine`（LineDetector）——**全部位于死代码中**。

- **可以替换**：把 `qImageToGray` 换成 `image.convertToFormat(QImage::Format_Grayscale8)` + `constBits()`（甚至零拷贝），live 代码即可完全脱离 OpenCV，甩掉 4 个 OpenCV DLL（约 25-30 MB）和自编译 MinGW OpenCV 的构建依赖。
- **反方观点（诚实陈述）**：Qt 灰度转换与 cv::COLOR_BGR2GRAY 系数一致（Rec.601），结果基本等价；但如果路线图上有颜色掩膜提取（ColorExtractor 显然是为这写的半成品），保留 OpenCV 的维护成本很低。**决策建议取决于产品方向：砍掉自动提取路线就删 OpenCV，保留就先把死代码删掉再留 OpenCV。**

---

## 七、不属于臃肿的部分（如实说明）

- `OverlayWidget` 基类把坐标变换、命中半径、axisColor 收敛得干净，三个编辑叠加层的结构是合理的。
- `StepPanelBridge` 虽然样板多（177 行 getter/setter），但这是 Q_PROPERTY 机制的固有成本，职责隔离正确；QML 侧组件化（PrimaryButton/GhostButton/StepRow）是良好范例。
- `TickFitter` 的两阶段设计 + 保存 perp 区段支持 re-fit，复杂度是问题本身固有的，注释充分。
- Undo 命令模式本身用得对（`DrawAxisCommand`/`MarkTickCommand` 有真实 push 点）。
- `ImageUtils` 的 `.copy()` 所有权处理正确；`ProjectIO` 的 JSON schema 和 hash 校验是健壮性而非臃肿。

---

## 八、仓库卫生（附带）

- `src/qml/resources_rc.py`（23 KB，PyQt5 pyrcc 产物）和 `test/test1.png test2.png`（330 KB）是未跟踪的误放文件，不应进 src/。
- README 与 CLAUDE.md 关于 OpenCV 模块的说法不一致（实测 core+imgproc）。

---

## 建议的优化优先级

1. **删死代码**（第一节清单，~650 行，零风险，半天内完成）
2. **修 refine 的每点全图转换**（第三节第 1 条，十几行改动，用户可感知）
3. **tools/ 白名单化**（第二节第 1 条，裁 12-18 MB，需实测依赖）
4. **OpenCV 去留决策**（第六节，连带 CMake GLOB 修正）
5. nudge 逻辑上移 + Theme.h 裁剪 + QML 组件化（小赢合集）

**总评**：这个项目不是"烂胖"，而是典型的演化残留——三整条功能线（ColorExtractor 颜色掩膜、DataPointExtractor 自动提取、LineDetector 霍夫检测）已停用但代码还在，加上部署脚本图省事全量拷贝。清掉死代码后代码库约 5500 行，架构是健康紧凑的。
