// hitTest.ts — 画布图元命中测试（图像坐标，容差由屏幕恒定像素换算）
import type { AxisCalibration, AxisId, PixelPoint, ProjectModel, SeriesPoint, Tick } from '../state/model'
import { tickAnchor } from '../state/selectors'

/**
 * 命中刻度：按画布上的显示位置（tickAnchor：未拟合 = 点击处，已拟合 = 轴线上的投影，§4.3），
 * 欧氏距离 ≤ tol 视为命中；返回最近的一个。
 */
export function hitTick(
  cal: AxisCalibration,
  axis: AxisId,
  p: PixelPoint,
  tolImage: number,
): Tick | null {
  if (cal.axisLine === null) return null
  let best: Tick | null = null
  let bestD = tolImage
  for (const t of cal.ticks) {
    const c = tickAnchor(cal, axis, t)
    const d = Math.hypot(p.x - c.x, p.y - c.y)
    if (d <= bestD) {
      bestD = d
      best = t
    }
  }
  return best
}

/** 命中轴线：X 轴线为水平线 y = axisLine，Y 轴线为垂直线 x = axisLine */
export function hitAxisLine(cal: AxisCalibration, axis: AxisId, p: PixelPoint, tolImage: number): boolean {
  if (cal.axisLine === null || cal.skipped) return false
  return Math.abs((axis === 'x' ? p.y : p.x) - cal.axisLine) <= tolImage
}

/**
 * 命中数据点（§6.3：按下选中、拖动移动）：全部序列中距 p 最近且 ≤ tol 的点。
 * 返回所属序列 id 与点本身。
 */
export function hitPoint(
  model: ProjectModel,
  p: PixelPoint,
  tolImage: number,
): { seriesId: string; point: SeriesPoint } | null {
  let best: { seriesId: string; point: SeriesPoint } | null = null
  let bestD = tolImage
  for (const series of model.series) {
    for (const pt of series.points) {
      const d = Math.hypot(p.x - pt.pixel.x, p.y - pt.pixel.y)
      if (d <= bestD) {
        bestD = d
        best = { seriesId: series.id, point: pt }
      }
    }
  }
  return best
}
