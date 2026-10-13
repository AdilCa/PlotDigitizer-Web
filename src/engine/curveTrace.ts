// curveTrace.ts — 曲线提取（§4.6）：用户沿曲线涂抹一笔，笔迹给出走向与先后顺序，算法只管横向定位。
// 1. 笔迹按弧长每 step 像素取一个采样点，切向取前后 ±max(r, 2·step) 弧长的弦方向（抗手抖）
// 2. 曲线色 = 笔刷覆盖范围内非背景像素的颜色直方图峰值（笔迹沿着目标曲线走，它占多数）
// 3. 覆盖率：像素投影到「背景色 → 曲线色」线段上的位置 t（抗锯齿边缘按比例计入），
//    离这条线段太远的颜色（别的曲线、异色交叠处）不计入
// 4. 每个采样点沿法向 ±r 取覆盖率剖面（双线性插值），连续区段 = 候选位置，区段加权重心 = 亚像素横向位置
// 5. 动态规划在全部采样点的候选中选一条横向偏移变化最平滑的链，可跳过采样点（缺口：被别的曲线压住、
//    笔迹偏出曲线），跳过有代价；被跳过的采样点作为「未找到」返回，供画布标出。
//    选完一轮后剔除峰值覆盖率明显偏低的候选再选一轮：黑线遇到灰网格时颜色在同一条线段上，只能靠浓淡区分
// 6. 用相邻选中点的连线方向重新取法向剖面修正一次（弯道处笔迹法向与曲线法向不一致）
// 纯函数，零 DOM 依赖；像素块由 Worker 按 curvePatchRect 读出（已铺白）。坐标约定见 gray.ts。
import type { PixelPoint } from '../state/model'
import type { Rgb, RgbaPatch } from './markerBlob'

export const CURVE_DEFAULTS = {
  radius: 10,
  step: 4,
  /** 与背景色的 RGB 距离低于此值视为背景 */
  noise: 24,
  /** 覆盖率低于此值不计入（淡网格、JPEG 噪声） */
  minCoverage: 0.3,
  /** 离「背景色 → 曲线色」线段的距离上限 = max(colorToleranceMin, 此比例 × 曲线色与背景色的距离)；
   *  放宽到 0.3 时黑线会吃进绿蓝交叠处的深色混色 */
  colorTolerance: 0.15,
  colorToleranceMin: 36,
  /** 剖面采样间隔（px） */
  profileStep: 0.5,
  /** 剖面区段的覆盖率阈值 */
  runThreshold: 0.15,
  /** 每跳过一个采样点的代价（以「一个采样间隔内横向偏移 σ」为单位的平方） */
  gapCost: 4,
  /** 最多连续跳过的采样点数 */
  maxGap: 40,
  /** 第二轮剔除峰值覆盖率 < 此比例 × 首轮选中链峰值中位数的候选 */
  weakPeakRatio: 0.6,
} as const

export interface CurveTraceResult {
  /** 沿笔迹顺序的曲线点（图像坐标） */
  points: PixelPoint[]
  /** 未找到曲线的采样点（笔迹上的位置） */
  misses: PixelPoint[]
  /** 识别出的曲线色；失败时为 null */
  color: Rgb | null
  /** 一个点都没找到时的原因 */
  reason?: string
}

/** Worker 为一笔读取的像素范围：笔迹外接框外扩 r + 2，钳制在图像内 */
export function curvePatchRect(
  stroke: readonly PixelPoint[],
  r: number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  if (stroke.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  const pad = Math.ceil(r) + 2
  const xs = stroke.map((p) => p.x)
  const ys = stroke.map((p) => p.y)
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - pad)
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad)
  const x1 = Math.min(width, Math.floor(Math.max(...xs)) + pad + 1)
  const y1 = Math.min(height, Math.floor(Math.max(...ys)) + pad + 1)
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

interface Sample {
  p: PixelPoint
  /** 单位法向 */
  n: PixelPoint
}

/** 折线按弧长参数化 */
function arcLength(stroke: readonly PixelPoint[]): number[] {
  const s = [0]
  for (let i = 1; i < stroke.length; i++) {
    s.push(s[i - 1] + Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y))
  }
  return s
}

function pointAt(stroke: readonly PixelPoint[], s: readonly number[], at: number): PixelPoint {
  const total = s[s.length - 1]
  const t = Math.min(total, Math.max(0, at))
  let i = 1
  while (i < s.length - 1 && s[i] < t) i++
  const seg = s[i] - s[i - 1]
  const k = seg > 0 ? (t - s[i - 1]) / seg : 0
  return {
    x: stroke[i - 1].x + k * (stroke[i].x - stroke[i - 1].x),
    y: stroke[i - 1].y + k * (stroke[i].y - stroke[i - 1].y),
  }
}

/** 等弧长采样；末端补一个点，保证笔迹两端都被覆盖 */
export function strokeSamples(stroke: readonly PixelPoint[], step: number, r: number): Sample[] {
  const s = arcLength(stroke)
  const total = s[s.length - 1]
  if (!(total > 0)) return []
  const half = Math.max(r, 2 * step)
  const n = Math.max(1, Math.round(total / step))
  const out: Sample[] = []
  for (let k = 0; k <= n; k++) {
    const at = (k / n) * total
    const a = pointAt(stroke, s, at - half)
    const b = pointAt(stroke, s, at + half)
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (!(len > 0)) continue
    const tx = (b.x - a.x) / len
    const ty = (b.y - a.y) / len
    out.push({ p: pointAt(stroke, s, at), n: { x: -ty, y: tx } })
  }
  return out
}

/** 笔刷覆盖范围：沿笔迹每 r/2 弧长盖一个半径 r 的圆章 */
function brushMask(stroke: readonly PixelPoint[], patch: RgbaPatch, r: number): Uint8Array {
  const { w, h } = patch
  const mask = new Uint8Array(w * h)
  const s = arcLength(stroke)
  const total = s[s.length - 1]
  const n = Math.max(1, Math.ceil(total / Math.max(1, r / 2)))
  for (let k = 0; k <= n; k++) {
    const c = pointAt(stroke, s, (k / n) * total)
    const cx = c.x - patch.x
    const cy = c.y - patch.y
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(w - 1, Math.floor(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(h - 1, Math.floor(cy + r))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) mask[y * w + x] = 1
      }
    }
  }
  return mask
}

/** 笔刷范围内非背景像素的 4bit/通道直方图峰值，再取峰值附近像素的平均色 */
function dominantColor(data: Uint8ClampedArray, mask: Uint8Array, bg: Rgb, noise: number): Rgb | null {
  const count = new Uint32Array(4096)
  const sums = new Float64Array(4096 * 3)
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const j = i * 4
    if (Math.hypot(data[j] - bg.r, data[j + 1] - bg.g, data[j + 2] - bg.b) < noise) continue
    const k = ((data[j] >> 4) << 8) | ((data[j + 1] >> 4) << 4) | (data[j + 2] >> 4)
    count[k]++
    sums[k * 3] += data[j]
    sums[k * 3 + 1] += data[j + 1]
    sums[k * 3 + 2] += data[j + 2]
  }
  let best = -1
  for (let k = 0; k < 4096; k++) if (count[k] > 0 && (best < 0 || count[k] > count[best])) best = k
  if (best < 0) return null
  const c0 = { r: sums[best * 3] / count[best], g: sums[best * 3 + 1] / count[best], b: sums[best * 3 + 2] / count[best] }
  // 峰值格可能把一种颜色切在格边上：取离峰值均色 ≤ 32 的全部像素再平均
  let r = 0
  let g = 0
  let b = 0
  let m = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const j = i * 4
    if (Math.hypot(data[j] - c0.r, data[j + 1] - c0.g, data[j + 2] - c0.b) > 32) continue
    r += data[j]
    g += data[j + 1]
    b += data[j + 2]
    m++
  }
  return { r: r / m, g: g / m, b: b / m }
}

/** 覆盖率图：像素在「背景 → 曲线色」线段上的投影位置 t；偏离线段太远或 t 太小记 0 */
function coverageMap(data: Uint8ClampedArray, n: number, bg: Rgb, c: Rgb): Float32Array {
  const D = CURVE_DEFAULTS
  const dr = c.r - bg.r
  const dg = c.g - bg.g
  const db = c.b - bg.b
  const len2 = dr * dr + dg * dg + db * db
  const tol = Math.max(D.colorToleranceMin, D.colorTolerance * Math.sqrt(len2))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const j = i * 4
    const pr = data[j] - bg.r
    const pg = data[j + 1] - bg.g
    const pb = data[j + 2] - bg.b
    const t = Math.min(1, Math.max(0, (pr * dr + pg * dg + pb * db) / len2))
    if (t < D.minCoverage) continue
    if (Math.hypot(pr - t * dr, pg - t * dg, pb - t * db) > tol) continue
    out[i] = t
  }
  return out
}

/** 双线性插值（像素中心 = i + 0.5，块外为 0） */
function sampleBilinear(cov: Float32Array, w: number, h: number, x: number, y: number): number {
  const u = x - 0.5
  const v = y - 0.5
  const i = Math.floor(u)
  const j = Math.floor(v)
  const fu = u - i
  const fv = v - j
  const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : cov[yy * w + xx])
  return (
    at(i, j) * (1 - fu) * (1 - fv) +
    at(i + 1, j) * fu * (1 - fv) +
    at(i, j + 1) * (1 - fu) * fv +
    at(i + 1, j + 1) * fu * fv
  )
}

interface Run {
  /** 沿法向的加权重心偏移（px） */
  offset: number
  /** 区段内最大覆盖率：实线核心接近 1，同色系的浅网格线（黑线遇到灰网格）只有一半左右 */
  peak: number
}

/** 法向剖面上覆盖率连续区段的加权重心；区段宽于 1.6r（大片同色填充、图例块）不算曲线 */
function profileRuns(cov: Float32Array, patch: RgbaPatch, smp: Sample, r: number): Run[] {
  const D = CURVE_DEFAULTS
  const runs: Run[] = []
  let sw = 0
  let so = 0
  let peak = 0
  let start = 0
  let open = false
  const close = (end: number) => {
    if (sw > 0 && end - start <= 1.6 * r) runs.push({ offset: so / sw, peak })
    sw = 0
    so = 0
    peak = 0
    open = false
  }
  const steps = Math.round(r / D.profileStep)
  for (let k = -steps; k <= steps; k++) {
    const o = k * D.profileStep
    const a = sampleBilinear(
      cov,
      patch.w,
      patch.h,
      smp.p.x + smp.n.x * o - patch.x,
      smp.p.y + smp.n.y * o - patch.y,
    )
    if (a > D.runThreshold) {
      if (!open) {
        open = true
        start = o
      }
      sw += a
      so += a * o
      if (a > peak) peak = a
    } else if (open) {
      close(o)
    }
  }
  // 区段碰到剖面端点：曲线可能只露出一半，重心不可信
  if (open) {
    sw = 0
  }
  return runs
}

/**
 * 在全部采样点的候选中选一条链（动态规划）：相邻选中点的横向偏移差按 (Δo)² / (σ²·g) 计代价，
 * g = 两者相隔的采样间隔数；每跳过一个采样点代价 gapCost。返回每个采样点选中的候选下标（-1 = 跳过）。
 */
function chooseChain(cands: Run[][], step: number): number[] {
  const D = CURVE_DEFAULTS
  const sigma = 0.5 * step + 0.5
  const N = cands.length
  const cost: number[][] = cands.map((c) => c.map(() => Infinity))
  const prev: [number, number][][] = cands.map((c) => c.map(() => [-1, -1] as [number, number]))
  for (let i = 0; i < N; i++) {
    for (let a = 0; a < cands[i].length; a++) {
      let best = D.gapCost * i
      let from: [number, number] = [-1, -1]
      for (let j = Math.max(0, i - 1 - D.maxGap); j < i; j++) {
        const g = i - j
        for (let b = 0; b < cands[j].length; b++) {
          if (cost[j][b] === Infinity) continue
          const d = cands[i][a].offset - cands[j][b].offset
          const c = cost[j][b] + (d * d) / (sigma * sigma * g) + D.gapCost * (g - 1)
          if (c < best) {
            best = c
            from = [j, b]
          }
        }
      }
      cost[i][a] = best
      prev[i][a] = from
    }
  }
  let end: [number, number] = [-1, -1]
  let bestEnd = Infinity
  for (let i = 0; i < N; i++) {
    for (let a = 0; a < cands[i].length; a++) {
      const c = cost[i][a] + D.gapCost * (N - 1 - i)
      if (c < bestEnd) {
        bestEnd = c
        end = [i, a]
      }
    }
  }
  const pick = new Array<number>(N).fill(-1)
  for (let cur = end; cur[0] >= 0; cur = prev[cur[0]][cur[1]]) pick[cur[0]] = cur[1]
  return pick
}

/**
 * 沿笔迹提取曲线。stroke 为用户涂抹的折线（图像坐标），r 为笔刷半径，step 为采样间隔。
 * 只要有一个点就返回 points（按笔迹方向排序）；misses 为未找到曲线的采样点。
 */
export function traceCurve(
  stroke: readonly PixelPoint[],
  patch: RgbaPatch,
  bg: Rgb,
  r: number = CURVE_DEFAULTS.radius,
  step: number = CURVE_DEFAULTS.step,
): CurveTraceResult {
  const D = CURVE_DEFAULTS
  const fail = (reason: string, color: Rgb | null = null): CurveTraceResult => ({ points: [], misses: [], color, reason })
  if (patch.w < 1 || patch.h < 1) return fail('笔迹在图像外')
  const total = arcLength(stroke).at(-1) ?? 0
  const samples = total >= 2 * step ? strokeSamples(stroke, step, r) : []
  if (samples.length < 2) return fail('笔迹太短，请沿曲线多涂一段')

  const mask = brushMask(stroke, patch, r)
  const color = dominantColor(patch.data, mask, bg, D.noise)
  if (!color) return fail('笔刷范围内只有背景色')
  if (Math.hypot(color.r - bg.r, color.g - bg.g, color.b - bg.b) < D.noise) return fail('曲线颜色与背景太接近', color)

  const cov = coverageMap(patch.data, patch.w * patch.h, bg, color)
  let cands = samples.map((smp) => profileRuns(cov, patch, smp, r))
  let pick = chooseChain(cands, step)
  // 第二轮：剔除峰值覆盖率远低于这条曲线典型值的候选（同色系浅网格线、抗锯齿残边）后重选
  const peaks = pick.flatMap((a, i) => (a < 0 ? [] : [cands[i][a].peak])).sort((x, y) => x - y)
  if (peaks.length > 0) {
    const minPeak = D.weakPeakRatio * peaks[Math.floor(peaks.length / 2)]
    cands = cands.map((c) => c.filter((run) => run.peak >= minPeak))
    pick = chooseChain(cands, step)
  }

  const found: { i: number; q: PixelPoint }[] = []
  const misses: PixelPoint[] = []
  samples.forEach((smp, i) => {
    if (pick[i] < 0) {
      misses.push(smp.p)
      return
    }
    const o = cands[i][pick[i]].offset
    found.push({ i, q: { x: smp.p.x + smp.n.x * o, y: smp.p.y + smp.n.y * o } })
  })

  // 修正轮：笔迹法向与曲线法向不一致时（弯道、笔迹斜穿），沿相邻点连线的法向重新定位一次
  const points: PixelPoint[] = []
  found.forEach(({ i, q }, k) => {
    const a = found[k - 1]
    const b = found[k + 1]
    let p = q
    const from = a && i - a.i <= 2 ? a.q : q
    const to = b && b.i - i <= 2 ? b.q : q
    const len = Math.hypot(to.x - from.x, to.y - from.y)
    if (len > 0) {
      const n = { x: -(to.y - from.y) / len, y: (to.x - from.x) / len }
      const runs = profileRuns(cov, patch, { p: q, n }, r)
      let best: Run | null = null
      for (const run of runs) if (!best || Math.abs(run.offset) < Math.abs(best.offset)) best = run
      if (best && Math.abs(best.offset) <= 1.5) p = { x: q.x + n.x * best.offset, y: q.y + n.y * best.offset }
    }
    const last = points[points.length - 1]
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.3 * step) return
    points.push(p)
  })
  if (points.length === 0) return { points, misses, color, reason: '笔迹沿线没有找到这种颜色的曲线' }
  return { points, misses, color }
}
