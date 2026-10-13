// tickFitter.ts — 刻度定位（§4.3 两点制；v1.4 改为 C++ TickFitter 的多行策略）
// 阶段一（定位）：由面板「拟合刻度」按钮显式触发（门控：该轴恰好 2 个刻度）。
// 每个点击位置：
//   1. 起始行：点击所在行（X 轴刻度；Y 轴刻度为列，下同）。该行无刻度（例如点在轴线上）时
//      向两侧逐行寻找最近的有刻度行（±seedSearch）。
//   2. 逐行定位：沿轴方向 ±scanHalf 取剖面，半深 (max+min)/2 以下的连续区段即谷。
//      窗口内出现多个深谷 → 报错（窗口内有多根刻度/文字，请调小窗口）；
//      谷触及窗口边缘 → 报错（被截断，中心不可信）。
//   3. 长度范围：从起始行向两侧扩展，直到该行不再是同一根刻度（无谷/多谷/中心漂移），最多 ±maxExtent 行。
//   4. 各行中心做 MAD 稳健合并（3·MAD 剔除离群后取平均），即刻度在轴线上的投影位置。
// 纯函数，零 DOM 依赖；gray 由调用方（Worker）传入。坐标约定见 gray.ts。
import type { AxisId, PixelPoint } from '../state/model'
import { grayAtIndex } from './gray'

export const TICK_FITTER_DEFAULTS = {
  /** 沿轴方向的扫描半宽（px）；UI 可按轴调整 */
  scanHalf: 10,
  minContrast: 25,
  /** 与最深谷相比，深度达到该比例的谷视为「同等深度」，两个以上即判定为多谷 */
  strongValleyRatio: 0.75,
  /** 起始行无刻度时，向两侧寻找起始行的最大行数（越过轴线的粗线宽） */
  seedSearch: 6,
  /** 从起始行向两侧扩展的最大行数 */
  maxExtent: 40,
  /** 相邻行中心相对起始行中心的最大漂移（px），超出视为离开了这根刻度 */
  maxDrift: 1.5,
} as const

export interface TickFitDiagnostics {
  /** 每个刻度实际参与定位的区域（图像坐标） */
  scanBands: { x: number; y: number; w: number; h: number }[]
  /** 候选刻度线位置（成功 = 精确定位；多谷 = 每个谷；无谷 = 点击位置），供内联可视化（铁律 5） */
  candidateLines: { axis: AxisId; pos: number }[]
  /** 逐行定位结果（每行一个中心点） */
  samplePoints: PixelPoint[]
}

export interface TickFitInput {
  id: string
  /** 用户点击的完整位置（含垂直于轴的分量，决定起始行） */
  at: PixelPoint
}

export type TickFitResult =
  | { ok: true; fitted: Record<string, number>; diagnostics: TickFitDiagnostics }
  | { ok: false; error: string; diagnostics: TickFitDiagnostics }

type RowResult =
  | { kind: 'ok'; center: number }
  | { kind: 'none' }
  | { kind: 'multi'; centers: number[] }
  | { kind: 'clipped' }

/**
 * 在一行（垂直于轴的坐标 = 像素下标 iv）上，沿轴方向以 iu0 为中心 ±H 定位刻度谷。
 * 返回的 center 为沿轴方向的连续坐标。
 */
function locateRow(
  gray: Uint8Array,
  width: number,
  height: number,
  axis: AxisId,
  iu0: number,
  iv: number,
  H: number,
): RowResult {
  const D = TICK_FITTER_DEFAULTS
  const n = 2 * H + 1
  const prof = new Array<number>(n)
  let pMax = 0
  let pMin = 255
  for (let k = 0; k < n; k++) {
    const iu = iu0 - H + k
    const v = axis === 'x' ? grayAtIndex(gray, width, height, iu, iv) : grayAtIndex(gray, width, height, iv, iu)
    prof[k] = v
    if (v > pMax) pMax = v
    if (v < pMin) pMin = v
  }
  const contrast = pMax - pMin
  if (contrast < D.minContrast) return { kind: 'none' }

  const halfDepth = Math.floor((pMax + pMin) / 2)
  const runs: { l: number; r: number; depth: number }[] = []
  for (let k = 0; k < n; k++) {
    if (prof[k] >= halfDepth) continue
    let r = k
    let runMin = prof[k]
    while (r + 1 < n && prof[r + 1] < halfDepth) {
      r++
      if (prof[r] < runMin) runMin = prof[r]
    }
    runs.push({ l: k, r, depth: pMax - runMin })
    k = r
  }
  const strong = runs.filter((run) => run.depth >= contrast * D.strongValleyRatio)
  const toCenter = (run: { l: number; r: number }) => iu0 - H + (run.l + run.r) / 2 + 0.5
  if (strong.length > 1) return { kind: 'multi', centers: strong.map(toCenter) }
  const run = strong[0]
  if (run.l === 0 || run.r === n - 1) return { kind: 'clipped' }
  return { kind: 'ok', center: toCenter(run) }
}

function robustMean(values: number[]): number {
  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const med = median(values)
  const mad = median(values.map((v) => Math.abs(v - med)))
  const tol = 3 * Math.max(mad, 0.5)
  const kept = values.filter((v) => Math.abs(v - med) <= tol)
  return kept.reduce((sum, v) => sum + v, 0) / kept.length
}

export function fitTicks(
  gray: Uint8Array,
  width: number,
  height: number,
  axis: AxisId,
  ticks: TickFitInput[],
  scanHalf: number = TICK_FITTER_DEFAULTS.scanHalf,
): TickFitResult {
  const D = TICK_FITTER_DEFAULTS
  const H = Math.max(2, Math.round(scanHalf))
  const diag: TickFitDiagnostics = { scanBands: [], candidateLines: [], samplePoints: [] }
  const fitted: Record<string, number> = {}

  // (u, v) = (沿轴, 垂直于轴)；X 轴刻度沿 x 方向定位、逐行(y)扫描，Y 轴相反
  const toXY = (u: number, v: number): PixelPoint => (axis === 'x' ? { x: u, y: v } : { x: v, y: u })
  const band = (u0: number, v0: number, v1: number) =>
    axis === 'x'
      ? { x: u0 - H, y: v0, w: 2 * H + 1, h: v1 - v0 + 1 }
      : { x: v0, y: u0 - H, w: v1 - v0 + 1, h: 2 * H + 1 }

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]
    const label = `第 ${i + 1} 个刻度`
    const clickU = axis === 'x' ? t.at.x : t.at.y
    const clickV = axis === 'x' ? t.at.y : t.at.x
    const iu0 = Math.floor(clickU)
    const iv0 = Math.floor(clickV)

    // 1. 起始行：点击行优先，否则向两侧找最近的有刻度行；遇到多谷/截断立即报错（不越过去找别的刻度）
    let seedRow = -1
    let seedCenter = 0
    let failure: RowResult | null = null
    for (let d = 0; d <= D.seedSearch && seedRow < 0 && !failure; d++) {
      for (const iv of d === 0 ? [iv0] : [iv0 - d, iv0 + d]) {
        const res = locateRow(gray, width, height, axis, iu0, iv, H)
        if (res.kind === 'ok') {
          seedRow = iv
          seedCenter = res.center
          break
        }
        if (res.kind !== 'none') {
          failure = res
          break
        }
      }
    }

    if (seedRow < 0) {
      diag.scanBands.push(band(iu0, iv0 - D.seedSearch, iv0 + D.seedSearch))
      if (failure?.kind === 'multi') {
        for (const c of failure.centers) diag.candidateLines.push({ axis, pos: c })
        return {
          ok: false,
          error: `${label}：扫描窗口（±${H}px）内有 ${failure.centers.length} 条暗线（相邻刻度或文字），请调小扫描窗口，或点在刻度线本身上`,
          diagnostics: diag,
        }
      }
      diag.candidateLines.push({ axis, pos: clickU })
      if (failure?.kind === 'clipped') {
        return {
          ok: false,
          error: `${label}：刻度线触及扫描窗口边缘（±${H}px），请点得更靠近刻度线，或调大扫描窗口`,
          diagnostics: diag,
        }
      }
      return {
        ok: false,
        error: `${label}：点击处附近未找到刻度线，请点在刻度线上（离轴线稍远一点）`,
        diagnostics: diag,
      }
    }

    // 2. 长度范围：从起始行向两侧扩展，直到不再是同一根刻度
    const centers = [seedCenter]
    diag.samplePoints.push(toXY(seedCenter, seedRow + 0.5))
    let vMin = seedRow
    let vMax = seedRow
    for (const dir of [1, -1]) {
      for (let k = 1; k <= D.maxExtent; k++) {
        const iv = seedRow + dir * k
        const res = locateRow(gray, width, height, axis, iu0, iv, H)
        if (res.kind !== 'ok' || Math.abs(res.center - seedCenter) > D.maxDrift) break
        centers.push(res.center)
        diag.samplePoints.push(toXY(res.center, iv + 0.5))
        if (iv < vMin) vMin = iv
        if (iv > vMax) vMax = iv
      }
    }

    // 3. 稳健合并 → 投影到轴线上的位置
    const refined = robustMean(centers)
    fitted[t.id] = refined
    diag.scanBands.push(band(iu0, vMin, vMax))
    diag.candidateLines.push({ axis, pos: refined })
  }

  return { ok: true, fitted, diagnostics: diag }
}
