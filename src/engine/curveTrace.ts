// curveTrace.ts — 曲线提取（§4.6）：用户沿曲线涂抹一笔，笔迹给出走向与先后顺序，算法只管横向定位。
// 1. 笔迹按弧长每 step 像素取一个采样点，切向取前后 ±max(r, 2·step) 弧长的弦方向（抗手抖）
// 2. 曲线色 = 笔刷覆盖范围内非背景像素的颜色直方图峰值（笔迹沿着目标曲线走，它占多数）
// 3. 覆盖率：像素投影到「背景色 → 曲线色」线段上的位置 t（抗锯齿边缘按比例计入），
//    离这条线段太远的非背景色记为异色（别的曲线、异色交叠处，可能压在曲线上）；
//    笔刷内被曲线色围住的小块背景（空心标记内部）填实
// 4. 每个采样点沿法向 ±r 取覆盖率剖面（双线性插值），连续区段 = 候选位置，区段加权重心 = 亚像素横向位置；
//    区段两侧边缘外紧挨异色的记为不可信边缘
// 5. 动态规划在全部采样点的候选中选一条横向偏移变化最平滑的链，可跳过采样点（缺口：被别的曲线压住、
//    笔迹偏出曲线），跳过有代价；被跳过的采样点作为「未找到」返回，供画布标出。
//    选完一轮后剔除峰值覆盖率明显偏低的候选再选一轮：黑线遇到灰网格时颜色在同一条线段上，只能靠浓淡区分；
//    再从两侧都可信的区段学出重心到两侧边缘的距离，被压住一侧的区段按可信边缘重估重心后选第三轮；
//    两侧都被压住的区段只有可行范围，按前后可靠点插值后夹进范围
// 6. 标记串（区段宽）按带宽平滑；细线用相邻选中点的连线方向重新取法向剖面修正一次（弯道处笔迹法向与曲线法向不一致）
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

/**
 * 覆盖率图 cov：像素在「背景 → 曲线色」线段上的投影位置 t；偏离线段太远或 t 太小记 0。
 * 异色图 other：既不是背景、也不在这条线段上的像素（别的曲线、异色交叠处）记 1，即可能压在曲线上的东西
 */
function coverageMap(data: Uint8ClampedArray, n: number, bg: Rgb, c: Rgb): { cov: Float32Array; other: Uint8Array } {
  const D = CURVE_DEFAULTS
  const dr = c.r - bg.r
  const dg = c.g - bg.g
  const db = c.b - bg.b
  const len2 = dr * dr + dg * dg + db * db
  const tol = Math.max(D.colorToleranceMin, D.colorTolerance * Math.sqrt(len2))
  const cov = new Float32Array(n)
  const other = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const j = i * 4
    const pr = data[j] - bg.r
    const pg = data[j + 1] - bg.g
    const pb = data[j + 2] - bg.b
    const t = Math.min(1, Math.max(0, (pr * dr + pg * dg + pb * db) / len2))
    if (Math.hypot(pr - t * dr, pg - t * dg, pb - t * db) > tol) {
      if (Math.hypot(pr, pg, pb) >= D.noise) other[i] = 1
      continue
    }
    if (t >= D.minCoverage) cov[i] = t
  }
  return { cov, other }
}

/**
 * 填孔：背景像素（cov = 0 且非异色）按 4-连通分区，整区落在笔刷范围内、不碰块边、面积 ≤ limit 的区
 * = 空心标记（圆、方、三角）的内部或一串标记互相围出的小空隙。异色像素当墙，不当出口。
 * 边界明显以曲线色为主的孔 → 覆盖率记 1：一串空心标记成为实心带，剖面重心落在带子中线而不是某一侧边框上；
 * 边界以异色为主的孔多半是别的标记的内部 → 记为异色（可能被遮挡），交给剖面的遮挡判定。
 */
function fillHoles(cov: Float32Array, other: Uint8Array, mask: Uint8Array, w: number, h: number, limit: number): void {
  const seen = new Uint8Array(w * h)
  const members: number[] = []
  for (let k0 = 0; k0 < w * h; k0++) {
    if (seen[k0] || cov[k0] > 0 || other[k0]) continue
    members.length = 0
    members.push(k0)
    seen[k0] = 1
    let open = false
    let ownContacts = 0
    let otherContacts = 0
    for (let q = 0; q < members.length; q++) {
      const k = members[q]
      const x = k % w
      const y = (k - x) / w
      if (!mask[k] || x === 0 || y === 0 || x === w - 1 || y === h - 1) open = true
      for (const nk of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
        if (nk < 0 || seen[nk]) continue
        if (cov[nk] > 0) {
          ownContacts++
          continue
        }
        if (other[nk]) {
          otherContacts++
          continue
        }
        seen[nk] = 1
        members.push(nk)
      }
    }
    if (open || members.length > limit) continue
    // 边界以曲线色为主（≥ 3 倍：异色线只是横穿过空心标记、零星 JPEG 色噪）→ 自己的内部；
    // 放宽到 1 倍时，重叠区里别人标记内的小空隙也会被吃进来
    if (ownContacts >= 3 * otherContacts) for (const k of members) cov[k] = 1
    else for (const k of members) other[k] = 1
  }
}

/** 双线性插值（像素中心 = i + 0.5，块外为 0） */
function sampleBilinear(cov: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
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
  /** 区段宽度（px）：实线 = 线宽，标记串 = 标记大小 */
  width: number
  /** 两侧边缘（覆盖率越过阈值处，亚像素）的偏移，lo < hi */
  lo: number
  hi: number
  /** 边缘外侧紧挨的是背景（真边缘）还是异色（可能是被压住的假边缘） */
  loFree: boolean
  hiFree: boolean
  /** 两侧都被压住时重心的可行范围（见 correctOcclusion） */
  range?: [number, number]
}

/** 法向剖面上覆盖率连续区段的加权重心与两侧边缘；区段宽于 1.6r（大片同色填充、图例块）不算曲线 */
function profileRuns(cov: Float32Array, other: Uint8Array, patch: RgbaPatch, smp: Sample, r: number): Run[] {
  const D = CURVE_DEFAULTS
  const ps = D.profileStep
  const steps = Math.round(r / ps)
  const len = 2 * steps + 1
  const A = new Float32Array(len)
  const O = new Float32Array(len)
  for (let k = 0; k < len; k++) {
    const o = (k - steps) * ps
    const x = smp.p.x + smp.n.x * o - patch.x
    const y = smp.p.y + smp.n.y * o - patch.y
    A[k] = sampleBilinear(cov, patch.w, patch.h, x, y)
    O[k] = sampleBilinear(other, patch.w, patch.h, x, y)
  }
  const thr = D.runThreshold
  /** 边缘外 2px 内有异色 → 不可信 */
  const reach = Math.round(2 / ps)
  const occluded = (from: number, dir: number) => {
    for (let s = 0; s < reach; s++) {
      const k = from + dir * s
      if (k < 0 || k >= len) break
      if (O[k] >= 0.5) return true
    }
    return false
  }
  const runs: Run[] = []
  let k = 0
  while (k < len) {
    if (A[k] <= thr) {
      k++
      continue
    }
    const ks = k
    let sw = 0
    let so = 0
    let peak = 0
    while (k < len && A[k] > thr) {
      const o = (k - steps) * ps
      sw += A[k]
      so += A[k] * o
      if (A[k] > peak) peak = A[k]
      k++
    }
    // 区段碰到剖面端点：曲线可能只露出一半，重心不可信
    if (ks === 0 || k === len) continue
    const ke = k - 1
    const lo = (ks - 1 - steps) * ps + ((thr - A[ks - 1]) / (A[ks] - A[ks - 1])) * ps
    const hi = (ke - steps) * ps + ((A[ke] - thr) / (A[ke] - A[k])) * ps
    if (hi - lo > 1.6 * r) continue
    runs.push({
      offset: so / sw,
      peak,
      width: hi - lo,
      lo,
      hi,
      loFree: !occluded(ks - 1, -1),
      hiFree: !occluded(k, 1),
    })
  }
  return runs
}

/**
 * 遮挡修正：从两侧都是真边缘的选中区段学出重心到两侧边缘的距离（标记不对称时两侧不同），
 * 只露出一侧的区段改用「真边缘 ± 该侧距离」估计重心。
 * 两侧都挨着异色且明显变窄：可能两侧都是被压出来的假边缘（上下两条带子都画在它上面），图里没有它的中心，
 *   只知道真实的带子必须盖住露出来的这一段：重心 ∈ [hi − hiSide, lo + loSide]。区段保留重心供动态规划选链，
 *   附上这个范围，选完后由 fillOccludedRanges 从前后可靠点插值再夹进范围。
 * 能学的样本太少时原样返回。
 */
function correctOcclusion(cands: Run[][], pick: number[]): Run[][] {
  const chosen = pick.flatMap((a, i) => (a < 0 ? [] : [cands[i][a]]))
  const clean = chosen.filter((run) => run.loFree && run.hiFree)
  if (clean.length < Math.max(5, 0.2 * chosen.length)) return cands
  const median = (v: number[]) => v.sort((x, y) => x - y)[Math.floor(v.length / 2)]
  const loSide = median(clean.map((run) => run.offset - run.lo))
  const hiSide = median(clean.map((run) => run.hi - run.offset))
  const full = loSide + hiSide
  return cands.map((c) =>
    c.map((run) => {
      if ((run.loFree && run.hiFree) || run.width >= 0.85 * full) return run
      if (run.loFree) return { ...run, offset: run.lo + loSide }
      if (run.hiFree) return { ...run, offset: run.hi - hiSide }
      return { ...run, range: [run.hi - hiSide, run.lo + loSide] as [number, number] }
    }),
  )
}

/**
 * 两侧都被压住的选中区段：在图像坐标里连接前后最近的两个可靠点，取这条连线与本采样点法线的交点
 * （按笔迹偏移插值会把手抖带进来）；只有一侧有可靠点就沿用那一侧相对笔迹的偏移；再夹进可行范围。
 * 前后都没有可靠点时保留重心。返回每个采样点的最终偏移（未选中为 NaN）。
 */
function fillOccludedRanges(cands: Run[][], pick: number[], samples: readonly Sample[]): number[] {
  const N = pick.length
  const off = pick.map((a, i) => (a < 0 ? NaN : cands[i][a].offset))
  const reliable = pick.map((a, i) => a >= 0 && !cands[i][a].range)
  const prev = new Array<number>(N).fill(-1)
  const next = new Array<number>(N).fill(-1)
  for (let i = 0, last = -1; i < N; i++) {
    prev[i] = last
    if (reliable[i]) last = i
  }
  for (let i = N - 1, last = -1; i >= 0; i--) {
    next[i] = last
    if (reliable[i]) last = i
  }
  for (let i = 0; i < N; i++) {
    const range = pick[i] >= 0 ? cands[i][pick[i]].range : undefined
    if (!range) continue
    const a = prev[i]
    const b = next[i]
    const at = (j: number) => ({ x: samples[j].p.x + samples[j].n.x * off[j], y: samples[j].p.y + samples[j].n.y * off[j] })
    const { p, n } = samples[i]
    let o: number
    if (a >= 0 && b >= 0) {
      const A = at(a)
      const B = at(b)
      const dx = B.x - A.x
      const dy = B.y - A.y
      // p + n·o 落在直线 A + t·(B − A) 上；笔迹与连线近乎平行时退回按序号插值
      const den = n.x * dy - n.y * dx
      const t = (i - a) / (b - a)
      o = Math.abs(den) > 1e-6 ? ((A.x - p.x) * dy - (A.y - p.y) * dx) / den : (A.x + t * dx - p.x) * n.x + (A.y + t * dy - p.y) * n.y
    } else if (a >= 0) o = off[a]
    else if (b >= 0) o = off[b]
    else continue
    off[i] = Math.min(range[1], Math.max(range[0], o))
  }
  return off
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

  const { cov, other } = coverageMap(patch.data, patch.w * patch.h, bg, color)
  fillHoles(cov, other, mask, patch.w, patch.h, Math.PI * r * r)
  let cands = samples.map((smp) => profileRuns(cov, other, patch, smp, r))
  let pick = chooseChain(cands, step)
  // 第二轮：剔除峰值覆盖率远低于这条曲线典型值的候选（同色系浅网格线、抗锯齿残边）后重选
  const peaks = pick.flatMap((a, i) => (a < 0 ? [] : [cands[i][a].peak])).sort((x, y) => x - y)
  if (peaks.length > 0) {
    const minPeak = D.weakPeakRatio * peaks[Math.floor(peaks.length / 2)]
    cands = cands.map((c) => c.filter((run) => run.peak >= minPeak))
    pick = chooseChain(cands, step)
  }
  // 第三轮：被别的曲线压住一侧的区段按真边缘重估重心后重选
  const corrected = correctOcclusion(cands, pick)
  if (corrected !== cands) {
    cands = corrected
    pick = chooseChain(cands, step)
  }
  const offsets = fillOccludedRanges(cands, pick, samples)

  const found: { i: number; q: PixelPoint }[] = []
  const misses: PixelPoint[] = []
  samples.forEach((smp, i) => {
    if (pick[i] < 0) {
      misses.push(smp.p)
      return
    }
    const o = offsets[i]
    found.push({ i, q: { x: smp.p.x + smp.n.x * o, y: smp.p.y + smp.n.y * o } })
  })

  // 标记串（空心 / 实心点连成的带子）：带子外沿是一个个标记拼出的锯齿，截面重心随标记周期摆动。
  // 平滑尺度取选中区段宽度中位数的一半（标记间距不超过标记大小，一个周期的摆动被压到 1% 以下）；
  // 对点坐标按笔迹弧长做高斯加权局部线性回归（端点不收缩，笔迹手抖一并抹平）。
  // 细实线宽度只有几像素，尺度小于采样间隔，不平滑
  const widths = found.map(({ i }) => cands[i][pick[i]].width).sort((x, y) => x - y)
  const sigma = 0.5 * (widths[Math.floor(widths.length / 2)] ?? 0)
  if (sigma >= step) {
    const points: PixelPoint[] = []
    found.forEach(({ i }) => {
      let s0 = 0
      let s1 = 0
      let s2 = 0
      let x0 = 0
      let x1 = 0
      let y0 = 0
      let y1 = 0
      for (const f of found) {
        const d = (f.i - i) * step
        if (Math.abs(d) > 3 * sigma) continue
        const wt = Math.exp((-d * d) / (2 * sigma * sigma))
        s0 += wt
        s1 += wt * d
        s2 += wt * d * d
        x0 += wt * f.q.x
        x1 += wt * d * f.q.x
        y0 += wt * f.q.y
        y1 += wt * d * f.q.y
      }
      const det = s0 * s2 - s1 * s1
      const p =
        det > 1e-9 * s0 * s0
          ? { x: (x0 * s2 - x1 * s1) / det, y: (y0 * s2 - y1 * s1) / det }
          : { x: x0 / s0, y: y0 / s0 }
      const last = points[points.length - 1]
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.3 * step) return
      points.push(p)
    })
    return { points, misses, color }
  }

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
      // 只信两侧都是真边缘的区段，被压住的区段已按真边缘估过，重心反而有偏
      const runs = profileRuns(cov, other, patch, { p: q, n }, r).filter((run) => run.loFree && run.hiFree)
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
