// axisFitter.ts — 轴线精确定位（§4.2，移植自 C++ src/algo/AxisFitter.cpp）
// 输入：手绘近似线段（两个端点）、gray、垂直搜索半径 scan±（默认 35）
// 输出：强制水平/垂直、横贯全图的轴线位置 + 诊断（扫描带、全部采样点位置）
// 流程：10–20px 多步长集成采样 → 对比度门控（<25 跳过）→ 半深中点谷值中心 →
//       中位数定位置（天然抗离群，不剔点）；有效采样点 <4 → 报错（内联反馈，铁律 5）
// 纯函数，零 DOM 依赖；gray 由调用方（Worker）传入，绝不在此转换图像。
import type { AxisId, PixelPoint } from '../state/model'
import { grayAtIndex } from './gray'

export const AXIS_FITTER_DEFAULTS = {
  minStep: 10,
  maxStep: 20,
  minSamples: 6,
  minContrast: 25,
  minValidPositions: 4,
  scanHalf: 35,
} as const

export interface AxisFitDiagnostics {
  /** 覆盖全部采样剖面的包络矩形（图像坐标） */
  scanBand: { x: number; y: number; w: number; h: number }
  /** 全部有效采样点的精确定位（中位数不剔点，无内点/外点之分） */
  samplePoints: PixelPoint[]
}

export type AxisFitResult =
  | { ok: true; position: number; diagnostics: AxisFitDiagnostics }
  | { ok: false; error: string; diagnostics: AxisFitDiagnostics }

export function fitAxis(
  gray: Uint8Array,
  width: number,
  height: number,
  axis: AxisId,
  a: PixelPoint,
  b: PixelPoint,
  scanHalf: number = AXIS_FITTER_DEFAULTS.scanHalf,
): AxisFitResult {
  const D = AXIS_FITTER_DEFAULTS
  const lineLen = Math.hypot(b.x - a.x, b.y - a.y)

  // 诊断扫描带：手绘线包络沿垂直方向扩展 ±scanHalf
  const diag: AxisFitDiagnostics = {
    scanBand:
      axis === 'x'
        ? {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y) - scanHalf,
            w: Math.abs(b.x - a.x),
            h: Math.abs(b.y - a.y) + scanHalf * 2,
          }
        : {
            x: Math.min(a.x, b.x) - scanHalf,
            y: Math.min(a.y, b.y),
            w: Math.abs(b.x - a.x) + scanHalf * 2,
            h: Math.abs(b.y - a.y),
          },
    samplePoints: [],
  }

  if (lineLen < 1) {
    return { ok: false, error: '手绘线段太短，请沿轴线拖出一条近似线段', diagnostics: diag }
  }

  const positions: number[] = []

  // 多步长集成采样：step 从 10 到 20 逐一遍历
  for (let step = D.minStep; step <= D.maxStep; step++) {
    const nSamples = Math.max(D.minSamples, Math.floor(lineLen / step))
    for (let i = 0; i < nSamples; i++) {
      const frac = i / Math.max(1, nSamples - 1)
      const px = a.x + (b.x - a.x) * frac
      const py = a.y + (b.y - a.y) * frac
      const ix = Math.floor(px)
      const iy = Math.floor(py)

      // 垂直于轴方向取灰度剖面（X 轴 → 垂直剖面；Y 轴 → 水平剖面）
      let pMax = 0
      let pMin = 255
      let minIdx = 0
      const prof: number[] = []
      for (let s = -scanHalf; s <= scanHalf; s++) {
        const val = axis === 'x' ? grayAtIndex(gray, width, height, ix, iy + s) : grayAtIndex(gray, width, height, ix + s, iy)
        prof.push(val)
        if (val > pMax) pMax = val
        if (val < pMin) {
          pMin = val
          minIdx = prof.length - 1
        }
      }

      // 剖面对比度门控：max - min < 25 视为该处无轴线，跳过
      if (pMax - pMin < D.minContrast) continue

      // 谷值中心（半深中点法）：向两侧扩展至半深 (max+min)/2 处，取左右边界中点
      const halfDepth = Math.floor((pMax + pMin) / 2)
      let leftIdx = minIdx
      let rightIdx = minIdx
      while (leftIdx > 0 && prof[leftIdx] < halfDepth) leftIdx--
      while (rightIdx < prof.length - 1 && prof[rightIdx] < halfDepth) rightIdx++
      const centerS = (leftIdx + rightIdx) / 2 - scanHalf

      if (axis === 'x') {
        const pos = iy + centerS + 0.5
        positions.push(pos)
        diag.samplePoints.push({ x: px, y: pos })
      } else {
        const pos = ix + centerS + 0.5
        positions.push(pos)
        diag.samplePoints.push({ x: pos, y: py })
      }
    }
  }

  if (positions.length < D.minValidPositions) {
    return {
      ok: false,
      error: `有效采样点不足（${positions.length}/${D.minValidPositions}）：请沿轴线重画，或先裁剪/放大使轴线更清晰`,
      diagnostics: diag,
    }
  }

  // 中位数定位置（天然抗离群，不剔点；偶数取上中位数，与 C++ std::sort + [size/2] 一致）
  positions.sort((m, n) => m - n)
  const median = positions[positions.length >> 1]
  return { ok: true, position: median, diagnostics: diag }
}
