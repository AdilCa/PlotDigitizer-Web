// markerBlob.ts — 散点 refine（§4.4）：颜色分割 → 点击处连通块 → 重心
// 背景色取全图颜色直方图峰值（与窗口位置、大小无关，窗口整个落在标记里也不会估错）；
// 标记色取点击附近物体最浓处；像素"离标记色比离背景色近"即属于标记（半程阈值 = 抗锯齿边缘 50% 覆盖处，边界无偏）。
// 孤立标记 → 填孔后按覆盖率加权求重心（空心、十字、三角都适用）；
// 块碰到读取范围边界（连着线、成串重叠）或面积远大于内切圆（几个标记粘在一起）→
//   距离变换找离点击最近的内切圆圆心，再在半径 R+1 内迭代求重心，线条和相邻标记只贡献很小一部分。
// 纯函数，零 DOM 依赖；像素块由 Worker 按 scatterPatchRect 读出（已铺白）。坐标约定见 gray.ts。
import type { PixelPoint } from '../state/model'
import type { RefineResult } from './refine'

export interface Rgb {
  r: number
  g: number
  b: number
}

/** RGBA 局部块：data 为 w×h×4（已铺白），(x, y) 为块左上角像素在图像中的下标 */
export interface RgbaPatch {
  data: Uint8ClampedArray
  x: number
  y: number
  w: number
  h: number
}

export const SCATTER_DEFAULTS = {
  /** 与背景色的 RGB 距离低于此值视为背景（JPEG 噪声、极浅底纹） */
  noise: 24,
  /** 少于此像素数的块视为噪点 */
  minArea: 3,
  /** 面积 > 此倍数 × 内切圆面积 → 视为多个标记粘连（三角形约 1.65，两圆重叠一半约 1.6–1.9） */
  crowdedAreaRatio: 1.9,
  /** 内切圆半径低于此值的孤立块按细笔画标记（十字、空心）直接求重心，不做粘连判定 */
  thinRadius: 2.5,
  /** 粘连 / 连线路径中，内切圆半径低于此值视为只有线条 */
  lineRadius: 2.5,
} as const

/** Worker 为一个点读取的像素范围：搜索框外再留出 max(24, 2r)，容纳比搜索框大的标记（钳制在图像内） */
export function scatterPatchRect(
  pt: PixelPoint,
  r: number,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const half = r + Math.max(24, 2 * r)
  const ix0 = Math.floor(pt.x)
  const iy0 = Math.floor(pt.y)
  const x0 = Math.max(0, ix0 - half)
  const y0 = Math.max(0, iy0 - half)
  const x1 = Math.min(width, ix0 + half + 1)
  const y1 = Math.min(height, iy0 + half + 1)
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

/** 背景色 = 全图 4bit/通道直方图峰值格内的平均色；超大图隔点采样 */
export function estimateBackground(rgba: Uint8ClampedArray, width: number, height: number): Rgb {
  const n = width * height
  const count = new Uint32Array(4096)
  const sums = new Float64Array(4096 * 3)
  const step = n > 4_000_000 ? 4 : 1
  for (let i = 0; i < n; i += step) {
    const j = i * 4
    const k = ((rgba[j] >> 4) << 8) | ((rgba[j + 1] >> 4) << 4) | (rgba[j + 2] >> 4)
    count[k]++
    sums[k * 3] += rgba[j]
    sums[k * 3 + 1] += rgba[j + 1]
    sums[k * 3 + 2] += rgba[j + 2]
  }
  let best = 0
  for (let k = 1; k < 4096; k++) if (count[k] > count[best]) best = k
  const c = count[best]
  if (c === 0) return { r: 255, g: 255, b: 255 }
  return { r: sums[best * 3] / c, g: sums[best * 3 + 1] / c, b: sums[best * 3 + 2] / c }
}

function dist(data: Uint8ClampedArray, i: number, c: Rgb): number {
  const j = i * 4
  return Math.hypot(data[j] - c.r, data[j + 1] - c.g, data[j + 2] - c.b)
}

const N8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const

/**
 * scatter refine：r 为搜索框半径（框 = refineWindow 的 scatter 窗口）。标记只需碰到搜索框，可以比框大。
 * 失败时按原位置返回，reason 说明原因；成功时 outline 为所用像素的凸包（图像坐标，供画布显示）。
 */
export function refineScatter(pt: PixelPoint, patch: RgbaPatch, bg: Rgb, r: number): RefineResult {
  const D = SCATTER_DEFAULTS
  const { data, w, h } = patch
  const fail = (reason: string): RefineResult => ({ x: pt.x, y: pt.y, snapped: false, reason })
  if (w < 1 || h < 1) return fail('点击位置在图像外')
  const n = w * h

  const dBg = new Float32Array(n)
  for (let i = 0; i < n; i++) dBg[i] = dist(data, i, bg)

  // 搜索框（块内坐标）内离点击最近的前景像素
  const lx = pt.x - patch.x
  const ly = pt.y - patch.y
  const cx = Math.floor(lx)
  const cy = Math.floor(ly)
  const bx0 = Math.max(0, cx - r)
  const bx1 = Math.min(w - 1, cx + r)
  const by0 = Math.max(0, cy - r)
  const by1 = Math.min(h - 1, cy + r)
  let seed = -1
  let bestD2 = Infinity
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = y * w + x
      if (dBg[i] < D.noise) continue
      const d2 = (x + 0.5 - lx) ** 2 + (y + 0.5 - ly) ** 2
      if (d2 < bestD2 || (d2 === bestD2 && dBg[i] > dBg[seed])) {
        bestD2 = d2
        seed = i
      }
    }
  }
  if (seed < 0) return fail(`搜索范围（半径 ${r}px）内只有背景色`)

  // 爬到该物体最浓处：标记色取核心，避开抗锯齿边缘的混合色
  let core = seed
  for (;;) {
    const x = core % w
    const y = (core - x) / w
    let next = core
    for (const [dx, dy] of N8) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      if (dBg[ny * w + nx] > dBg[next]) next = ny * w + nx
    }
    if (next === core) break
    core = next
  }
  const markerColor = averageCoreColor(data, dBg, core, w, h)
  const contrast = Math.hypot(markerColor.r - bg.r, markerColor.g - bg.g, markerColor.b - bg.b)
  if (contrast < D.noise) return fail('标记颜色与背景太接近')

  // 掩膜 + 覆盖率：离标记色的距离 ≤ 半程即属于标记；alpha = 1 − dc/contrast ∈ [0.5, 1]
  const alpha = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const dc = dist(data, i, markerColor)
    if (dc <= contrast / 2) alpha[i] = 1 - dc / contrast
  }
  if (alpha[core] === 0) alpha[core] = 0.5

  // 4-连通泛洪（对角不连，减少经抗锯齿斜边粘到相邻物体）
  const inS = new Uint8Array(n)
  const stack = [core]
  inS[core] = 1
  const visit = (i: number) => {
    if (alpha[i] > 0 && !inS[i]) {
      inS[i] = 1
      stack.push(i)
    }
  }
  let touches = false
  let minX = w
  let maxX = -1
  let minY = h
  let maxY = -1
  let area0 = 0
  while (stack.length > 0) {
    const i = stack.pop()!
    const x = i % w
    const y = (i - x) / w
    area0++
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true
    if (x > 0) visit(i - 1)
    if (x < w - 1) visit(i + 1)
    if (y > 0) visit(i - w)
    if (y < h - 1) visit(i + w)
  }
  if (area0 < D.minArea) return fail('搜索范围内只有零星噪点')

  // 工作区 = 块外接框外扩 1px（带一圈非标记像素，填孔与距离变换都以它为边界）
  const ox = minX - 1
  const oy = minY - 1
  const bw = maxX - minX + 3
  const bh = maxY - minY + 3
  const weight = new Float32Array(bw * bh)
  const isS = (bx: number, by: number) => {
    const x = bx + ox
    const y = by + oy
    return x >= 0 && y >= 0 && x < w && y < h && inS[y * w + x] === 1
  }
  // 填孔：非标记像素按 4-连通分区，不连工作区边框、且面积不超过搜索框内切圆的区 = 空心标记的内部 → 权重 1。
  // 折线穿过空心圆时内部被切成几块，各块都是封闭小孔，照样填上；更大的封闭区是一串标记围出来的空白，不填
  const region = new Int32Array(bw * bh).fill(-1)
  const holeLimit = Math.PI * r * r
  for (let k0 = 0; k0 < bw * bh; k0++) {
    if (region[k0] >= 0 || isS(k0 % bw, (k0 - (k0 % bw)) / bw)) continue
    const members = [k0]
    region[k0] = k0
    let open = false
    for (let q = 0; q < members.length; q++) {
      const k = members[q]
      const bx = k % bw
      const by = (k - bx) / bw
      if (bx === 0 || by === 0 || bx === bw - 1 || by === bh - 1) open = true
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = bx + dx
        const ny = by + dy
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue
        const nk = ny * bw + nx
        if (region[nk] < 0 && !isS(nx, ny)) {
          region[nk] = k0
          members.push(nk)
        }
      }
    }
    if (!open && members.length <= holeLimit) for (const k of members) weight[k] = 1
  }
  let area = 0
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const k = by * bw + bx
      if (isS(bx, by)) weight[k] = alpha[(by + oy) * w + (bx + ox)]
      if (weight[k] > 0) area++
    }
  }

  const dt = distanceTransform(weight, bw, bh)
  let rMax = 0
  for (let k = 0; k < dt.length; k++) if (dt[k] > rMax) rMax = dt[k]

  const toImage = (c: { x: number; y: number }) => ({ x: c.x + ox + patch.x, y: c.y + oy + patch.y })

  if (!touches && (rMax < D.thinRadius || area <= D.crowdedAreaRatio * Math.PI * rMax * rMax)) {
    const c = weightedCentroid(weight, bw, bh, null)
    return { ...toImage(c), snapped: true, outline: convexHull(weight, bw, bh, null).map(toImage) }
  }

  // 粘连 / 连线：距离变换的局部极大 = 各标记的内切圆圆心；取点击处离其内切圆边缘最近的（点在圆内为负）
  const clickB = { x: lx - ox, y: ly - oy }
  let m = -1
  let bestScore = Infinity
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const k = by * bw + bx
      if (dt[k] < D.lineRadius) continue
      let isPeak = true
      for (const [dx, dy] of N8) {
        const nx = bx + dx
        const ny = by + dy
        if (nx >= 0 && ny >= 0 && nx < bw && ny < bh && dt[ny * bw + nx] > dt[k]) {
          isPeak = false
          break
        }
      }
      if (!isPeak) continue
      const score = Math.hypot(bx + 0.5 - clickB.x, by + 0.5 - clickB.y) - dt[k]
      if (score < bestScore) {
        bestScore = score
        m = k
      }
    }
  }
  if (m < 0) return fail('只碰到线条，没有成块的标记')
  const R = dt[m]
  let c = { x: (m % bw) + 0.5, y: Math.floor(m / bw) + 0.5 }
  const disk = { cx: c.x, cy: c.y, r: R + 1 }
  for (let it = 0; it < 10; it++) {
    const next = weightedCentroid(weight, bw, bh, disk)
    const moved = Math.hypot(next.x - disk.cx, next.y - disk.cy)
    disk.cx = next.x
    disk.cy = next.y
    c = next
    if (moved < 0.01) break
  }
  return { ...toImage(c), snapped: true, outline: convexHull(weight, bw, bh, disk).map(toImage) }
}

/** 核心像素 3×3 内浓度接近核心（≥85%）的像素平均色，抗 JPEG 噪声 */
function averageCoreColor(data: Uint8ClampedArray, dBg: Float32Array, core: number, w: number, h: number): Rgb {
  const x0 = core % w
  const y0 = (core - x0) / w
  let r = 0
  let g = 0
  let b = 0
  let k = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = x0 + dx
      const y = y0 + dy
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const i = y * w + x
      if (dBg[i] < 0.85 * dBg[core]) continue
      r += data[i * 4]
      g += data[i * 4 + 1]
      b += data[i * 4 + 2]
      k++
    }
  }
  return { r: r / k, g: g / k, b: b / k }
}

type Disk = { cx: number; cy: number; r: number } | null

const inDisk = (disk: Disk, x: number, y: number) =>
  disk === null || (x + 0.5 - disk.cx) ** 2 + (y + 0.5 - disk.cy) ** 2 <= disk.r * disk.r

function weightedCentroid(weight: Float32Array, bw: number, bh: number, disk: Disk): { x: number; y: number } {
  let sw = 0
  let sx = 0
  let sy = 0
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const wt = weight[y * bw + x]
      if (wt === 0 || !inDisk(disk, x, y)) continue
      sw += wt
      sx += wt * (x + 0.5)
      sy += wt * (y + 0.5)
    }
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw } : disk ? { x: disk.cx, y: disk.cy } : { x: bw / 2, y: bh / 2 }
}

/** 所用像素（方格）的凸包，Andrew 单调链；每行只取最左、最右像素的四个角 */
function convexHull(weight: Float32Array, bw: number, bh: number, disk: Disk): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  for (let y = 0; y < bh; y++) {
    let lo = -1
    let hi = -1
    for (let x = 0; x < bw; x++) {
      if (weight[y * bw + x] === 0 || !inDisk(disk, x, y)) continue
      if (lo < 0) lo = x
      hi = x
    }
    if (lo < 0) continue
    pts.push({ x: lo, y }, { x: lo, y: y + 1 }, { x: hi + 1, y }, { x: hi + 1, y: y + 1 })
  }
  pts.sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: { x: number; y: number }[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: { x: number; y: number }[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** 欧氏距离变换（Felzenszwalb 两趟一维）：weight > 0 的像素到最近 weight = 0 像素的中心距离 */
function distanceTransform(weight: Float32Array, bw: number, bh: number): Float32Array {
  const INF = 1e20
  const f = new Float64Array(bw * bh)
  for (let k = 0; k < f.length; k++) f[k] = weight[k] > 0 ? INF : 0
  const len = Math.max(bw, bh)
  const line = new Float64Array(len)
  const out = new Float64Array(len)
  const v = new Int32Array(len)
  const z = new Float64Array(len + 1)
  const pass = (n: number) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < n; q++) {
      let s = (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++
      out[q] = (q - v[k]) ** 2 + line[v[k]]
    }
  }
  for (let x = 0; x < bw; x++) {
    for (let y = 0; y < bh; y++) line[y] = f[y * bw + x]
    pass(bh)
    for (let y = 0; y < bh; y++) f[y * bw + x] = out[y]
  }
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) line[x] = f[y * bw + x]
    pass(bw)
    for (let x = 0; x < bw; x++) f[y * bw + x] = out[x]
  }
  const dt = new Float32Array(bw * bh)
  for (let k = 0; k < dt.length; k++) dt[k] = Math.sqrt(f[k])
  return dt
}
