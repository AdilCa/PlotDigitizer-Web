// refine.ts — 点优化（§4.4）
// scatter → 暗度质心（r=8，gray 由调用方传入，绝不在此转换图像——修复 C++ 性能 bug）；
// bar → 沿序列级设置方向（上/下/左/右，默认向下）由外向内扫，取从起点出发首个
//        超过阈值的强跳变（|Δgray| 最大处）= 柱顶/柱端边缘；垂直方向 ±5px 多剖面投票（中位数）；
// manual → 不调用本模块任何函数，按标记原位置提交（§6.3）。
// 纯函数，零 DOM 依赖；Worker 批量接口按点数组调用（§5.2）。
import type { BarScanDirection, PixelPoint } from '../state/model'

export const REFINE_DEFAULTS = {
  scatterRadius: 8,
  barSpan: 40,
  /** 强跳变阈值 |Δgray|（相邻像素灰度差） */
  barThreshold: 40,
  /** 投票剖面的垂直偏移（px，含 0） */
  barProfileOffsets: [-5, -2, 0, 2, 5],
} as const

function grayAt(gray: Uint8Array, width: number, height: number, x: number, y: number): number {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || px >= width || py < 0 || py >= height) return 255
  return gray[py * width + px]
}

/**
 * scatter：以"暗度"= 255−gray 为权重求 (2r+1)² 窗口质心。
 * 窗口内全白（无特征）时原样返回——refine 永远不制造凭空位移。
 */
export function refineScatter(
  pt: PixelPoint,
  gray: Uint8Array,
  width: number,
  height: number,
  r: number = REFINE_DEFAULTS.scatterRadius,
): PixelPoint {
  let sumW = 0
  let sumX = 0
  let sumY = 0
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = pt.x + dx
      const y = pt.y + dy
      const wgt = 255 - grayAt(gray, width, height, x, y)
      if (wgt > 0) {
        sumW += wgt
        sumX += wgt * x
        sumY += wgt * y
      }
    }
  }
  if (sumW === 0) return { ...pt }
  return { x: sumX / sumW, y: sumY / sumW }
}

const DIR_VEC: Record<BarScanDirection, PixelPoint> = {
  down: { x: 0, y: 1 },
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
}

/** 单剖面：从起点沿 dir 扫描，返回首个 |Δgray| ≥ threshold 的跳变位置（沿轴距离），无则 null */
function scanProfile(
  pt: PixelPoint,
  perpOffset: number,
  dir: BarScanDirection,
  gray: Uint8Array,
  width: number,
  height: number,
  span: number,
  threshold: number,
): number | null {
  const v = DIR_VEC[dir]
  // 垂直于扫描方向的单位向量
  const u = { x: -v.y, y: v.x }
  const ox = pt.x + u.x * perpOffset
  const oy = pt.y + u.y * perpOffset
  let prev = grayAt(gray, width, height, ox, oy)
  for (let k = 1; k <= span; k++) {
    const cur = grayAt(gray, width, height, ox + v.x * k, oy + v.y * k)
    if (Math.abs(cur - prev) >= threshold) return k - 0.5 // 跳变沿中点
    prev = cur
  }
  return null
}

/**
 * bar：由外向内（dir）首个强跳变 = 柱边缘；±5px 多剖面投票取中位数（防斜边误判）。
 * 所有剖面都无跳变 → 原样返回。
 */
export function refineBar(
  pt: PixelPoint,
  gray: Uint8Array,
  width: number,
  height: number,
  dir: BarScanDirection = 'down',
  span: number = REFINE_DEFAULTS.barSpan,
): PixelPoint {
  const D = REFINE_DEFAULTS
  const votes: number[] = []
  for (const off of D.barProfileOffsets) {
    const k = scanProfile(pt, off, dir, gray, width, height, span, D.barThreshold)
    if (k !== null) votes.push(k)
  }
  if (votes.length === 0) return { ...pt }
  votes.sort((a, b) => a - b)
  const median = votes[votes.length >> 1]
  const v = DIR_VEC[dir]
  return { x: pt.x + v.x * median, y: pt.y + v.y * median }
}
