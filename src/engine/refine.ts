// refine.ts — 点优化（§4.4）
// scatter → 颜色分割 + 连通块重心，见 markerBlob.ts；本文件只提供其搜索框（refineWindow）；
// bar → 从初始点沿序列级方向（上/下/左/右，默认向下）扫描 span 像素：
//        垂直于扫描方向 ±5px 取平均剖面（抗网纹/噪声），找首个 |Δ| ≥ 阈值的跳变区段，
//        区段内 |Δ| 最大处 = 柱顶/柱端边缘；
// manual → 不调用本模块任何函数，按标记原位置提交（§6.3）。
// 纯函数，零 DOM 依赖；Worker 批量接口按点数组调用（§5.2）。坐标约定见 gray.ts。
import type { BarScanDirection, PixelPoint } from '../state/model'
import { grayAtIndex } from './gray'

export const REFINE_DEFAULTS = {
  scatterRadius: 8,
  barSpan: 40,
  /** 平均剖面上的跳变阈值 |Δgray| */
  barThreshold: 10,
  /** 平均剖面的垂直半宽（px） */
  barHalfWidth: 5,
} as const

/**
 * refine 的作用范围（连续坐标矩形），供画布可视化：
 * scatter = 以点击像素为中心的 (2r+1)² 搜索框（标记碰到即可，可以比框大）；
 * bar = 沿扫描方向 span、垂直 ±barHalfWidth 的条带（与 refineBar 采样一一对应）。
 */
export function refineWindow(
  pt: PixelPoint,
  params: { mode: 'scatter'; radius: number } | { mode: 'bar'; direction: BarScanDirection; span: number },
): { x: number; y: number; w: number; h: number } {
  const ix0 = Math.floor(pt.x)
  const iy0 = Math.floor(pt.y)
  if (params.mode === 'scatter') {
    const r = Math.round(params.radius)
    return { x: ix0 - r, y: iy0 - r, w: 2 * r + 1, h: 2 * r + 1 }
  }
  const v = DIR_VEC[params.direction]
  const u = { x: -v.y, y: v.x }
  const n = Math.max(1, Math.round(params.span))
  const hw = REFINE_DEFAULTS.barHalfWidth
  const xs = [0, n].flatMap((k) => [-hw, hw].map((o) => ix0 + v.x * k + u.x * o))
  const ys = [0, n].flatMap((k) => [-hw, hw].map((o) => iy0 + v.y * k + u.y * o))
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 }
}

/** snapped = false：未找到特征，按原位置返回 */
export interface RefineResult {
  x: number
  y: number
  snapped: boolean
  /** 未吸附原因（scatter） */
  reason?: string
  /** 吸附所用像素的凸包（图像坐标，scatter） */
  outline?: PixelPoint[]
}

const DIR_VEC: Record<BarScanDirection, PixelPoint> = {
  down: { x: 0, y: 1 },
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
}

/**
 * bar：沿 dir 扫描 span 像素，首个跳变区段内梯度最大处 = 柱边缘（两个像素之间的边界）。
 * 无跳变 → 原样返回（snapped = false）。只移动扫描方向上的坐标。
 */
export function refineBar(
  pt: PixelPoint,
  gray: Uint8Array,
  width: number,
  height: number,
  dir: BarScanDirection = 'down',
  span: number = REFINE_DEFAULTS.barSpan,
): RefineResult {
  const D = REFINE_DEFAULTS
  const v = DIR_VEC[dir]
  const u = { x: -v.y, y: v.x }
  const ix0 = Math.floor(pt.x)
  const iy0 = Math.floor(pt.y)
  const n = Math.max(1, Math.round(span))

  const prof = new Array<number>(n + 1)
  for (let k = 0; k <= n; k++) {
    let sum = 0
    for (let o = -D.barHalfWidth; o <= D.barHalfWidth; o++) {
      sum += grayAtIndex(gray, width, height, ix0 + v.x * k + u.x * o, iy0 + v.y * k + u.y * o)
    }
    prof[k] = sum / (2 * D.barHalfWidth + 1)
  }

  let best = -1
  let bestGrad = 0
  for (let k = 1; k <= n; k++) {
    const g = Math.abs(prof[k] - prof[k - 1])
    if (g >= D.barThreshold) {
      if (g > bestGrad) {
        bestGrad = g
        best = k
      }
    } else if (best > 0) {
      break
    }
  }
  if (best < 0) return { x: pt.x, y: pt.y, snapped: false }

  // 像素 k-1 与 k 之间的边界：起点像素中心 + (k − 0.5)·v
  const along = best - 0.5
  return {
    x: v.x === 0 ? pt.x : ix0 + 0.5 + v.x * along,
    y: v.y === 0 ? pt.y : iy0 + 0.5 + v.y * along,
    snapped: true,
  }
}
