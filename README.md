# PlotDigitizer Web

从论文图表里提取数据点。在浏览器里打开图片或 PDF，标定坐标轴和刻度，然后逐点或沿曲线取出数据，导出为 Markdown 表格和带标注的截图。

仅支持 Chrome / Edge。设计说明见 `doc/architecture.md`。

## 功能

- 画 X / Y 轴并拟合轴线，每轴标两个刻度后拟合，支持线性轴和对数轴，也可以跳过其中一轴
- 取点方式：散点（按颜色吸附到标记重心）、柱状（沿扫描方向找柱边缘）、手动（按点击位置）、曲线（沿曲线涂抹一笔后提取）
- 选定图表类型后自动进入取点工具
- 图片与 PDF 拖入导入；PDF 弹出选页，按 150 / 300 / 600 DPI 整页导入，再用裁剪留下图表
- 导出 Markdown + 标注截图 PNG；工程可存为 `.pdproj`（图像与校准、取点一起保存，拖入即恢复）

## 开发

```bash
npm install
npm run dev
```

常用命令：

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 类型检查并构建 |
| `npm run preview` | 预览构建结果 |
| `npm test` | 单元测试（Vitest） |
| `npm run test:e2e` | 端到端测试（Playwright，需先 `npm run build`；首次运行前执行 `npx playwright install chromium`） |

## 基本流程

1. 拖入图片、PDF 或 `.pdproj`，或点左侧「打开」。
2. 画 X 轴、画 Y 轴，各标两个刻度，点「拟合」，填上刻度值。不需要的轴可以在面板里跳过。
3. 新建序列并选择图表类型，然后取点：散点、柱状、手动是点击放置后按 Enter 确认；曲线是沿曲线按住拖动涂一笔，再按 Enter 提取。
4. 在检查器底部展开导出，保存 Markdown 与标注截图，或保存 `.pdproj`。
