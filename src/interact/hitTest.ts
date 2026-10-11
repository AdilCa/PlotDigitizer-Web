// hitTest.ts — 画布图元命中测试（图像坐标，容差由屏幕恒定像素换算）
import type { AxisCalibration, AxisId, PixelPoint, ProjectModel, SeriesPoint, Tick } from '../state/model'

/**
 * 命中刻度：刻度中心 = { X 轴: (t.pos, axisLine), Y 轴: (axisLine, t.pos) }（§4.3），
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
    const cx = axis === 'x' ? t.pos : cal.axisLine
    const cy = axis === 'x' ? cal.axisLine : t.pos
    const d = Math.hypot(p.x - cx, p.y - cy)
    if (d <= bestD) {
      bestD = d
      best = t
    }
  }
  return best
}

/**
 * 命中数据点（§6.3：单击选中 / 双击抓起）：全部序列中距 p 最近且 ≤ tol 的点。
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
