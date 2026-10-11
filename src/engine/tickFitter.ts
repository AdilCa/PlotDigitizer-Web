// tickFitter.ts — 刻度定位（§4.3 两点制，v1.2 修订）
// 阶段一（定位）：由面板「拟合刻度」按钮显式触发（门控：该轴恰好 2 个刻度）。
// 每个点击位置 → 沿轴方向（与 AxisFitter 方向互换）取灰度剖面，
// 用同样的半深中点谷值中心法找刻度线中心；全部成功才返回拟合结果。
// 注意：剖面取在用户点击的刻度位置上（点击在刻度线本身、偏离轴线），
// 因此不会把轴线本身误当刻度谷值。
// 纯函数，零 DOM 依赖；gray 由调用方（Worker）传入。
import type { AxisId, PixelPoint } from '../state/model'

export const TICK_FITTER_DEFAULTS = {
  scanHalf: 35,
  minContrast: 25,
} as const

export interface TickFitDiagnostics {
  /** 每个刻度的剖面包络（图像坐标） */
  scanBands: { x: number; y: number; w: number; h: number }[]
  /** 候选刻度线位置（成功 = 精确定位；失败 = 点击近似位置），供内联可视化（铁律 5） */
  candidateLines: { axis: AxisId; pos: number }[]
  /** 用户点击位置（诊断对照） */
  userClicks: PixelPoint[]
}

export interface TickFitInput {
  id: string
  /** 用户点击的完整位置（含垂直于轴的分量，决定剖面取样行/列） */
  at: PixelPoint
}

export type TickFitResult =
  | { ok: true; fitted: Record<string, number>; diagnostics: TickFitDiagnostics }
  | { ok: false; error: string; diagnostics: TickFitDiagnostics }

function grayAt(gray: Uint8Array, width: number, height: number, x: number, y: number): number {
  const px = Math.trunc(x)
  const py = Math.trunc(y)
  if (px < 0 || px >= width || py < 0 || py >= height) return 255
  return gray[py * width + px]
}

export function fitTicks(
  gray: Uint8Array,
  width: number,
  height: number,
  axis: AxisId,
  ticks: TickFitInput[],
  scanHalf: number = TICK_FITTER_DEFAULTS.scanHalf,
): TickFitResult {
  const diag: TickFitDiagnostics = { scanBands: [], candidateLines: [], userClicks: [] }
  const fitted: Record<string, number> = {}

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]
    diag.userClicks.push(t.at)

    // 剖面沿轴方向（方向互换：X 轴刻度 → 水平剖面；Y 轴刻度 → 垂直剖面）
    diag.scanBands.push(
      axis === 'x'
        ? { x: t.at.x - scanHalf, y: t.at.y - 3, w: scanHalf * 2, h: 6 }
        : { x: t.at.x - 3, y: t.at.y - scanHalf, w: 6, h: scanHalf * 2 },
    )

    let pMax = 0
    let pMin = 255
    let minIdx = 0
    const prof: number[] = []
    for (let s = -scanHalf; s <= scanHalf; s++) {
      const val =
        axis === 'x'
          ? grayAt(gray, width, height, t.at.x + s, t.at.y)
          : grayAt(gray, width, height, t.at.x, t.at.y + s)
      prof.push(val)
      if (val > pMax) pMax = val
      if (val < pMin) {
        pMin = val
        minIdx = prof.length - 1
      }
    }

    if (pMax - pMin < TICK_FITTER_DEFAULTS.minContrast) {
      // 失败：候选线画在点击近似位置，错误文字上状态栏（不弹窗，铁律 5）
      diag.candidateLines.push({ axis, pos: axis === 'x' ? t.at.x : t.at.y })
      return {
        ok: false,
        error: `第 ${i + 1} 个刻度处未找到刻度线（对比度不足）：请点击更靠近刻度线中心的位置`,
        diagnostics: diag,
      }
    }

    // 半深中点谷值中心（同 AxisFitter）
    const halfDepth = Math.floor((pMax + pMin) / 2)
    let leftIdx = minIdx
    let rightIdx = minIdx
    while (leftIdx > 0 && prof[leftIdx] < halfDepth) leftIdx--
    while (rightIdx < prof.length - 1 && prof[rightIdx] < halfDepth) rightIdx++
    const centerS = (leftIdx + rightIdx) / 2 - scanHalf

    const refined = (axis === 'x' ? t.at.x : t.at.y) + centerS
    fitted[t.id] = refined
    diag.candidateLines.push({ axis, pos: refined })
  }

  return { ok: true, fitted, diagnostics: diag }
}
