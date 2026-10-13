// selectors.ts — 派生数据层（铁律 2：派生数据自动级联重算）
// 所有派生值由 model 即时计算；带引用缓存，输入分支不变时直接复用结果。
// immer 保证未修改的分支保持引用相等，因此缓存键 = 分支引用。
import { applyMapping, solveMapping, type MappingParams } from '../engine/geometry'
import type {
  AxisCalibration,
  AxisId,
  PixelPoint,
  ProjectModel,
  Series,
  Tick,
  ToolId,
} from './model'
import type { AppState } from './store'

// ---------------------------------------------------------------- 轴状态（§6.2）

export type AxisStatus = 'unset' | 'skipped' | 'lineDrawn' | 'calibrated'

/** 刻度是否已吸附到拟合位置（移动后 pos 偏离 fittedPos → 自动回到待拟合） */
export function tickFitted(t: Tick): boolean {
  return t.fittedPos !== null && t.fittedPos === t.pos
}

/** 刻度在画布上的位置：未拟合 = 用户点击处 at；已拟合 = 轴线上的投影 (pos, axisLine) */
export function tickAnchor(cal: AxisCalibration, axis: AxisId, t: Tick): PixelPoint {
  if (!tickFitted(t) || cal.axisLine === null) return t.at
  return axis === 'x' ? { x: t.pos, y: cal.axisLine } : { x: cal.axisLine, y: t.pos }
}

/** 两刻度均已拟合且已输入值时的映射；退化（同位置/同值/log 非正）为 null */
function solvedMapping(cal: AxisCalibration): MappingParams | null {
  if (cal.skipped || cal.axisLine === null || cal.ticks.length !== 2) return null
  const [t1, t2] = cal.ticks
  if (!tickFitted(t1) || !tickFitted(t2) || t1.value === null || t2.value === null) return null
  return solveMapping(t1.pos, t1.value, t2.pos, t2.value, cal.scaleType)
}

/** 「已校准」完整条件（§6.2）：恰好 2 刻度 + 均已拟合 + 两刻度值均已输入 + 映射可解 */
export function isAxisCalibrated(cal: AxisCalibration): boolean {
  return solvedMapping(cal) !== null
}

/** 刻度、值都齐了但映射不可解时的原因（供面板与状态栏内联提示）；否则 null */
export function axisIssue(cal: AxisCalibration): string | null {
  if (cal.skipped || cal.axisLine === null || cal.ticks.length !== 2) return null
  const [t1, t2] = cal.ticks
  if (!tickFitted(t1) || !tickFitted(t2) || t1.value === null || t2.value === null) return null
  if (t1.pos === t2.pos) return '两个刻度拟合到了同一位置，请把其中一个移到另一根刻度上'
  if (t1.value === t2.value) return '两个刻度值相同，无法确定比例'
  if (cal.scaleType === 'log' && (t1.value <= 0 || t2.value <= 0)) return '对数轴刻度值必须 > 0'
  return null
}

export function axisStatus(cal: AxisCalibration): AxisStatus {
  if (cal.skipped) return 'skipped'
  if (cal.axisLine === null) return 'unset'
  return isAxisCalibrated(cal) ? 'calibrated' : 'lineDrawn'
}

// ---------------------------------------------------------------- 轴阶段（铁律 4 引导）

export type AxisPhase =
  | 'unset' // 未画轴线
  | 'skipped' // 显式跳过
  | 'needTicks' // 轴线已画，刻度不足 2 个
  | 'pendingFit' // 2 个刻度但未全部拟合（空心）
  | 'needValues' // 已拟合但刻度值未录全
  | 'invalid' // 都齐了但映射不可解（axisIssue 给出原因）
  | 'calibrated'

/** 比 axisStatus 更细的单轴引导态：lineDrawn 拆为 needTicks / pendingFit / needValues / invalid */
export function axisPhase(cal: AxisCalibration): AxisPhase {
  if (cal.skipped) return 'skipped'
  if (cal.axisLine === null) return 'unset'
  if (cal.ticks.length < 2) return 'needTicks'
  if (!cal.ticks.every(tickFitted)) return 'pendingFit'
  if (!cal.ticks.every((t) => t.value !== null)) return 'needValues'
  return isAxisCalibrated(cal) ? 'calibrated' : 'invalid'
}

/**
 * 全局下一步引导（铁律 4：状态栏一句话回答「现在该做什么」）。
 * 优先级与推荐路径一致：图像 → X 轴 → Y 轴 → 取点。
 */
export function nextActionHint(state: AppState): string {
  const { model } = state
  if (model.image === null) return '拖入图片开始'
  for (const [axis, label] of [['x', 'X'], ['y', 'Y']] as const) {
    const cal = model.calibration[axis]
    switch (axisPhase(cal)) {
      case 'unset':
        return `画 ${label} 轴线，或在面板中显式跳过`
      case 'needTicks':
        return `标出 2 个 ${label} 轴刻度`
      case 'pendingFit':
        return `点击「拟合 ${label} 轴刻度」`
      case 'needValues':
        return `输入两个 ${label} 刻度值`
      case 'invalid':
        return `${label} 轴校准无效：${axisIssue(cal)}`
      // skipped / calibrated：该轴已完成，继续检查下一轴
    }
  }
  if (!anyAxisCalibrated(model)) return '两轴均已跳过，无法取点（请恢复至少一个轴）'
  return model.activeSeriesId === null ? '新建序列并选择图表类型，然后取点' : '开始取点'
}

// ---------------------------------------------------------------- 映射（§4.5）

export type AxisMapping = MappingParams

/**
 * 两点解析求解 value = a + b·pos（§4.3 两点制：无最小二乘、无残差）。
 * 求解实现收敛在 engine/geometry.ts；此处只做校准态门控。
 */
export function axisMapping(cal: AxisCalibration): AxisMapping | null {
  return solvedMapping(cal)
}

export { applyMapping }

export function axisValueAt(cal: AxisCalibration, pos: number): number | null {
  const m = axisMapping(cal)
  return m ? applyMapping(m, pos) : null
}

// ---------------------------------------------------------------- 数据点派生（铁律 2）

export interface DataPoint {
  pointId: string
  name: string
  pixel: PixelPoint
  /** 仅当 X 轴已校准时存在；跳过轴整列不出现（§4.5、F1.1） */
  x?: number
  y?: number
}

let dataPointsCache: {
  calibration: ProjectModel['calibration']
  series: Series
  out: DataPoint[]
} | null = null

/**
 * 派生数据点：像素坐标 + 已校准轴的数据坐标。
 * 缓存键 = calibration 与 series 的引用；任何变更经 immer 产生新引用即自动失效。
 */
export function dataPointsOf(model: ProjectModel, seriesId: string): readonly DataPoint[] {
  const series = model.series.find((s) => s.id === seriesId)
  if (!series) return []
  if (
    dataPointsCache &&
    dataPointsCache.calibration === model.calibration &&
    dataPointsCache.series === series
  ) {
    return dataPointsCache.out
  }
  const mx = axisMapping(model.calibration.x)
  const my = axisMapping(model.calibration.y)
  const out: DataPoint[] = series.points.map((p) => ({
    pointId: p.id,
    name: p.name,
    pixel: p.pixel,
    ...(mx ? { x: applyMapping(mx, p.pixel.x) } : {}),
    ...(my ? { y: applyMapping(my, p.pixel.y) } : {}),
  }))
  dataPointsCache = { calibration: model.calibration, series, out }
  return out
}

// ---------------------------------------------------------------- 门控（§6.1，唯一校验源）

export type GateResult = { enabled: true } | { enabled: false; reason: string }

const OK: GateResult = { enabled: true }
const no = (reason: string): GateResult => ({ enabled: false, reason })

export type GateOp =
  | 'imageEdit'
  | 'drawXAxis'
  | 'drawYAxis'
  | 'markTickX'
  | 'markTickY'
  | 'fitTickX'
  | 'fitTickY'
  | 'extractMarker'
  | 'export'

function gateMarkTick(cal: AxisCalibration, label: string): GateResult {
  if (cal.skipped) return no(`${label} 轴已显式跳过`)
  if (cal.axisLine === null) return no(`请先画 ${label} 轴线`)
  return OK
}

function gateFitTick(cal: AxisCalibration, label: string): GateResult {
  if (cal.skipped) return no(`${label} 轴已显式跳过`)
  if (cal.axisLine === null) return no(`请先画 ${label} 轴线`)
  if (cal.ticks.length !== 2) return no(`需要恰好 2 个刻度（当前 ${cal.ticks.length} 个）`)
  if (cal.ticks.every(tickFitted)) return no('刻度已拟合；移动或增删刻度后才需重新拟合')
  return OK
}

export function anyAxisCalibrated(model: ProjectModel): boolean {
  return isAxisCalibrated(model.calibration.x) || isAxisCalibrated(model.calibration.y)
}

/** 操作可用性（§6.1 表）。按钮可用 = 操作必然可执行；不可用 = 置灰 + tooltip 原因（铁律 5） */
export function gateFor(state: AppState, op: GateOp): GateResult {
  const { model } = state
  const imageLoaded = model.image !== null
  switch (op) {
    case 'imageEdit':
    case 'drawXAxis':
    case 'drawYAxis':
      return imageLoaded ? OK : no('请先加载图像')
    case 'markTickX':
      return gateMarkTick(model.calibration.x, 'X')
    case 'markTickY':
      return gateMarkTick(model.calibration.y, 'Y')
    case 'fitTickX':
      return gateFitTick(model.calibration.x, 'X')
    case 'fitTickY':
      return gateFitTick(model.calibration.y, 'Y')
    case 'extractMarker':
      if (!anyAxisCalibrated(model)) return no('需至少校准一个轴')
      return model.activeSeriesId !== null ? OK : no('请先新建序列并选择图表类型')
    case 'export':
      return anyAxisCalibrated(model) ? OK : no('需至少校准一个轴')
  }
}

const TOOL_GATE: Record<ToolId, GateOp> = {
  drawXAxis: 'drawXAxis',
  drawYAxis: 'drawYAxis',
  markTickX: 'markTickX',
  markTickY: 'markTickY',
  extractMarker: 'extractMarker',
  imageEdit: 'imageEdit',
}

/** 工具可用性总表：工具可用性本身承担引导职能（§6.1） */
export function toolEnabled(state: AppState): Record<ToolId, GateResult> {
  const out = {} as Record<ToolId, GateResult>
  for (const tool of Object.keys(TOOL_GATE) as ToolId[]) {
    out[tool] = gateFor(state, TOOL_GATE[tool])
  }
  return out
}

/**
 * 当前工具的门控失效时（跳过轴、删除轴线/序列、换图…）应回退到的工具；无需回退返回 null。
 * 未加载图像时所有工具都不可用，保持原样（加载后再判断）。
 */
export function toolFallback(state: AppState): ToolId | null {
  const tool = state.ui.activeTool
  if (state.model.image === null || gateFor(state, TOOL_GATE[tool]).enabled) return null
  return tool === 'markTickY' ? 'drawYAxis' : 'drawXAxis'
}

/** 跳过轴的反向门控：不允许两轴同时跳过（§6.2，无坐标语义） */
export function canSkipAxis(model: ProjectModel, axis: AxisId): GateResult {
  const other: AxisId = axis === 'x' ? 'y' : 'x'
  if (model.calibration[other].skipped) return no('不允许两轴同时跳过')
  return OK
}

/** 是否已有校准/取点工作（§6.6：裁剪与换图前需视觉预告，铁律 3） */
export function hasWork(model: ProjectModel): boolean {
  return (
    model.calibration.x.axisLine !== null ||
    model.calibration.y.axisLine !== null ||
    model.calibration.x.skipped ||
    model.calibration.y.skipped ||
    model.series.some((s) => s.points.length > 0)
  )
}
