// model.ts — 业务 model 类型定义（architecture.md §3 / §6）
// 全项目契约：M1-1 冻结点后不轻改。.pdproj 的 project.json 即 ProjectModel 的序列化（§7.1）。
//
// 设计要点：
// - 轴四态、刻度「待拟合」、映射参数 a/b 一律不存储，由 selectors 派生（铁律 2、§6.2）
// - 数据点只存像素坐标；数据坐标永远由 pixel + calibration 即时计算（铁律 2）
// - 图像像素不进入 model（处理轨常驻 Worker，§3 决策 4）；model 只存 ImageRef 元信息

export type AxisId = 'x' | 'y'

export type ScaleType = 'linear' | 'log'

export type ChartType = 'scatter' | 'bar' | 'manual'

/** 柱状序列扫描方向（§4.4），仅 chartType = 'bar' 有意义，默认向下 */
export type BarScanDirection = 'up' | 'down' | 'left' | 'right'

/** 三族六种互斥工具（§6.1） */
export type ToolId =
  | 'drawXAxis'
  | 'drawYAxis'
  | 'markTickX'
  | 'markTickY'
  | 'extractMarker'
  | 'imageEdit'

export interface PixelPoint {
  x: number
  y: number
}

/**
 * 刻度（§4.3 两点制）。
 * pos：当前沿轴位置（图像像素；X 轴取 x，Y 轴取 y）。
 * at：用户点击的完整位置——拟合从这一行（列）开始逐行扫描（§4.3）；
 *     未拟合时刻度就画在 at，拟合后画在轴线上的投影 (pos, axisLine)。
 * fittedPos：拟合吸附后的精确位置；pos !== fittedPos → 派生「待拟合」，
 *            因此移动刻度后自动回到待拟合态、刻度值保留（§6.2），无需额外状态位。
 */
export interface Tick {
  id: string
  pos: number
  at: PixelPoint
  fittedPos: number | null
  value: number | null
}

/** 单轴校准。四态（未设置/轴线已画/已校准/已跳过）由 axisStatus selector 派生（§6.2）。 */
export interface AxisCalibration {
  /** 显式跳过标记，写入文件；导出中该轴整列不出现（§6.2、F1.1） */
  skipped: boolean
  /** 拟合后轴线位置：X 轴 = y 常量，Y 轴 = x 常量；强制水平/垂直横贯全图（§4.2） */
  axisLine: number | null
  /** 恰好 ≤2 个（§4.3）；拟合刻度按钮门控 = 恰好 2 个且待拟合 */
  ticks: Tick[]
  scaleType: ScaleType
}

/** 数据点：只存像素坐标与点名；数据坐标由 selector 即时计算（铁律 2） */
export interface SeriesPoint {
  id: string
  pixel: PixelPoint
  name: string
}

export interface Series {
  id: string
  name: string
  chartType: ChartType
  barDirection: BarScanDirection
  /** 柱状序列沿扫描方向的搜索范围（px，§4.4） */
  barSpan: number
  /** 散点序列的吸附窗口半径（px，窗口 (2r+1)²，§4.4）；调到刚好框住一个标记，网格/文字不进窗口 */
  scatterRadius: number
  /** 点命名前缀，默认取序列名（§7.2） */
  pointPrefix: string
  points: SeriesPoint[]
  /** 自动编号计数器，单调递增不复用（删除点后避免重名） */
  nextPointSeq: number
}

/** 图像元信息；像素数据不进主线程 model（§5.1 处理轨常驻 Worker） */
export interface ImageRef {
  /** 导入文件名（含扩展名）；导出建议名规则在 io 层计算（§7.3） */
  name: string
  sourceType: 'file' | 'pdf' | 'pdproj'
  /** 处理轨（当前有效）分辨率 */
  width: number
  height: number
  /** PDF 来源定位信息，用于导出文件名规则 {PDF名}-p{页码}-img{序号}-digitized（§7.3） */
  pdf?: { fileName: string; page: number; imageIndex: number }
}

export interface ProjectModel {
  version: 1
  image: ImageRef | null
  calibration: Record<AxisId, AxisCalibration>
  series: Series[]
  activeSeriesId: string | null
}

export function newId(): string {
  return crypto.randomUUID()
}

export function createAxisCalibration(): AxisCalibration {
  return { skipped: false, axisLine: null, ticks: [], scaleType: 'linear' }
}

export const DEFAULT_BAR_SPAN = 40
export const DEFAULT_SCATTER_RADIUS = 8

export function createSeries(name: string, chartType: ChartType): Series {
  return {
    id: newId(),
    name,
    chartType,
    barDirection: 'down',
    barSpan: DEFAULT_BAR_SPAN,
    scatterRadius: DEFAULT_SCATTER_RADIUS,
    pointPrefix: name,
    points: [],
    nextPointSeq: 1,
  }
}

export function createEmptyModel(): ProjectModel {
  return {
    version: 1,
    image: null,
    calibration: { x: createAxisCalibration(), y: createAxisCalibration() },
    series: [],
    activeSeriesId: null,
  }
}
