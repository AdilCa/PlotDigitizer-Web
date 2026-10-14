// curveTrace.test.ts — 曲线提取（§4.6）：合成抗锯齿曲线 + 用户实图（tests/fixtures/curves.png，四温度 V–I 曲线）
import { describe, expect, it } from 'vitest'
import { estimateBackground, type Rgb } from '../src/engine/markerBlob'
import { curvePatchRect, strokeSamples, traceCurve, type CurveTraceResult } from '../src/engine/curveTrace'
import type { PixelPoint } from '../src/state/model'
import { compositeOnWhite, decodePngRgba } from './helpers/png'

type Img = { rgba: Uint8ClampedArray; W: number; H: number }

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const RED: Rgb = { r: 230, g: 20, b: 20 }
const BLUE: Rgb = { r: 20, g: 40, b: 210 }

function makeImg(W: number, H: number): Img {
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) rgba.set([WHITE.r, WHITE.g, WHITE.b, 255], i * 4)
  return { rgba, W, H }
}

/** 4×4 超采样按覆盖率混色；box = [x0, y0, x1, y1] 限定扫描范围 */
function paint(img: Img, c: Rgb, inside: (x: number, y: number) => boolean, box?: [number, number, number, number]): void {
  const [bx0, by0, bx1, by1] = box ?? [0, 0, img.W, img.H]
  for (let y = Math.max(0, Math.floor(by0)); y < Math.min(img.H, Math.ceil(by1)); y++) {
    for (let x = Math.max(0, Math.floor(bx0)); x < Math.min(img.W, Math.ceil(bx1)); x++) {
      let hit = 0
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++
      if (hit === 0) continue
      const a = hit / 16
      const j = (y * img.W + x) * 4
      img.rgba[j] = Math.round(c.r * a + img.rgba[j] * (1 - a))
      img.rgba[j + 1] = Math.round(c.g * a + img.rgba[j + 1] * (1 - a))
      img.rgba[j + 2] = Math.round(c.b * a + img.rgba[j + 2] * (1 - a))
    }
  }
}

/** 函数曲线 y = f(x) 的近似法向距离 ≤ half */
function curveShape(f: (x: number) => number, half: number, x0 = -Infinity, x1 = Infinity) {
  return (x: number, y: number) => {
    if (x < x0 || x > x1) return false
    const d = (f(x + 0.01) - f(x - 0.01)) / 0.02
    return Math.abs(y - f(x)) / Math.sqrt(1 + d * d) <= half
  }
}

function trace(img: Img, stroke: PixelPoint[], r = 8, step = 3): CurveTraceResult {
  const rect = curvePatchRect(stroke, r, img.W, img.H)
  const data = new Uint8ClampedArray(rect.w * rect.h * 4)
  for (let y = 0; y < rect.h; y++) {
    const from = ((rect.y + y) * img.W + rect.x) * 4
    data.set(img.rgba.subarray(from, from + rect.w * 4), y * rect.w * 4)
  }
  return traceCurve(stroke, { data, ...rect }, estimateBackground(img.rgba, img.W, img.H), r, step)
}

/** 沿 f 取一笔，整体偏移 (dx, dy) 模拟手涂不准 */
function strokeAlong(f: (x: number) => number, x0: number, x1: number, dx = 0, dy = 0): PixelPoint[] {
  const out: PixelPoint[] = []
  for (let x = x0; x <= x1; x += 5) out.push({ x: x + dx, y: f(x) + dy })
  return out
}

/** 点到曲线 y = f(x) 的最近距离（在 x 方向 ±2px 内搜索） */
function normalDist(f: (x: number) => number, p: PixelPoint): number {
  let d = Infinity
  for (let x = p.x - 2; x <= p.x + 2; x += 0.005) d = Math.min(d, Math.hypot(x - p.x, f(x) - p.y))
  return d
}

const sine = (x: number) => 60 + 25 * Math.sin(x / 30)

describe('traceCurve：合成曲线', () => {
  it('抗锯齿正弦线，笔迹偏 3px：点落在曲线中心 ±0.25px，全程无缺口', () => {
    const img = makeImg(240, 120)
    paint(img, RED, curveShape(sine, 1))
    const out = trace(img, strokeAlong(sine, 20, 220, 0, 3))
    expect(out.misses).toHaveLength(0)
    expect(out.points.length).toBeGreaterThan(60)
    for (const p of out.points) expect(normalDist(sine, p)).toBeLessThan(0.25)
    expect(Math.hypot(out.color!.r - RED.r, out.color!.g - RED.g, out.color!.b - RED.b)).toBeLessThan(10)
  })

  it('点按笔迹方向排序：反向涂抹得到反向点列', () => {
    const img = makeImg(240, 120)
    paint(img, RED, curveShape(sine, 1))
    const out = trace(img, strokeAlong(sine, 20, 220).reverse())
    expect(out.points[0].x).toBeGreaterThan(out.points[out.points.length - 1].x)
  })

  it('近乎竖直的陡段：沿弧长等距采样，陡段不会只剩一两个点', () => {
    const steep = (x: number) => 20 + 100 / (1 + Math.exp(-(x - 120) / 3))
    const img = makeImg(240, 140)
    paint(img, BLUE, curveShape(steep, 1))
    const out = trace(img, strokeAlong(steep, 60, 180, 2, 0).flatMap((p, i, a) => {
      // 陡段手涂会更密：补中间点
      const q = a[i + 1]
      return q ? [p, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }] : [p]
    }))
    const inSteep = out.points.filter((p) => p.y > 40 && p.y < 100)
    expect(inSteep.length).toBeGreaterThan(12)
    for (const p of out.points) expect(normalDist(steep, p)).toBeLessThan(0.35)
  })

  it('异色曲线交叉并压在上面：交叉处留缺口，两侧点都在目标线上', () => {
    const img = makeImg(240, 120)
    const flat = (x: number) => 60 + 0.05 * x
    paint(img, RED, curveShape(flat, 1))
    paint(img, BLUE, (x, y) => Math.abs(x - 120 - (y - 60) * 0.3) <= 1.5)
    const out = trace(img, strokeAlong(flat, 20, 220, 0, 2))
    for (const p of out.points) expect(Math.abs(p.y - flat(p.x))).toBeLessThan(0.3)
    expect(out.misses.length).toBeGreaterThan(0)
    for (const m of out.misses) expect(Math.abs(m.x - 120)).toBeLessThan(6)
    expect(out.points.some((p) => p.x < 110)).toBe(true)
    expect(out.points.some((p) => p.x > 130)).toBe(true)
  })

  it('笔刷范围里蹭到另一条同色平行线：始终沿笔迹覆盖最多的那条，不跳线', () => {
    const img = makeImg(240, 120)
    const a = (x: number) => 50 + 0.1 * x
    const b = (x: number) => 59 + 0.1 * x
    paint(img, RED, curveShape(a, 1))
    paint(img, RED, curveShape(b, 1))
    const out = trace(img, strokeAlong(a, 20, 220, 0, -1), 8, 3)
    expect(out.points.length).toBeGreaterThan(50)
    for (const p of out.points) expect(Math.abs(p.y - a(p.x))).toBeLessThan(0.3)
  })

  it('笔迹末端超出曲线终点：超出部分记为未找到，不硬凑点', () => {
    const img = makeImg(240, 120)
    paint(img, RED, curveShape(sine, 1, 0, 150))
    const out = trace(img, strokeAlong(sine, 20, 220))
    expect(Math.max(...out.points.map((p) => p.x))).toBeLessThan(152)
    expect(out.misses.length).toBeGreaterThan(15)
  })

  /** 沿 f 每 gap px 放一个空心标记：圆（外径 R、线宽 lw）或三角（重心在曲线上） */
  const hollowCircle = (cx: number, cy: number, R: number, lw: number) => (x: number, y: number) =>
    Math.abs(Math.hypot(x - cx, y - cy) - (R - lw / 2)) <= lw / 2
  const hollowTriangle = (cx: number, cy: number, R: number, lw: number) => {
    const inTri = (x: number, y: number, s: number) => {
      // 正三角（尖朝上），外接圆半径 s，重心 (cx, cy)
      const u = y - cy
      return u <= s / 2 && u >= -s && Math.abs(x - cx) <= ((u + s) / 1.5) * (Math.sqrt(3) / 2)
    }
    return (x: number, y: number) => inTri(x, y, R) && !inTri(x, y, R - 2 * lw)
  }
  const hollowSquare = (cx: number, cy: number, R: number, lw: number) => (x: number, y: number) => {
    const m = Math.max(Math.abs(x - cx), Math.abs(y - cy))
    return m <= 0.8 * R && m >= 0.8 * R - lw
  }
  const markersAlong = (img: Img, f: (x: number) => number, x0: number, x1: number, gap: number, shape: typeof hollowCircle) => {
    const ms: ((x: number, y: number) => boolean)[] = []
    for (let x = x0; x <= x1; x += gap) ms.push(shape(x, f(x), 7, 1.5))
    paint(img, RED, (x, y) => ms.some((m) => m(x, y)))
  }

  // 稀疏三角不测：尖角处截面中点离重心 ~3px，属于形状本身，稀疏标记应改用散点模式逐个点
  for (const [name, shape, gap] of [
    ['空心圆', hollowCircle, 5],
    ['空心圆', hollowCircle, 16],
    ['空心三角', hollowTriangle, 5],
  ] as const) {
    it(`${name}串（间距 ${gap}px）：点落在标记中线 ±1.5px，不贴边框`, () => {
      const img = makeImg(260, 120)
      markersAlong(img, sine, 20, 240, gap, shape)
      const out = trace(img, strokeAlong(sine, 25, 235, 0, 3), 12, 3)
      expect(out.points.length).toBeGreaterThan(gap === 5 ? 50 : 20)
      for (const p of out.points) expect(normalDist(sine, p)).toBeLessThan(1.5)
    })
  }

  it('大空心三角斜向密排（外沿锯齿）+ 手抖笔迹：按带宽平滑，不随标记周期摆动', () => {
    const img = makeImg(300, 200)
    const slope = (x: number) => 170 - 0.55 * x
    const ms: ((x: number, y: number) => boolean)[] = []
    for (let x = 20; x <= 280; x += 9) ms.push(hollowTriangle(x, slope(x), 13, 2.5))
    paint(img, RED, (x, y) => ms.some((m) => m(x, y)))
    const stroke = strokeAlong(slope, 30, 270, 0, 3).map((p) => ({ x: p.x, y: p.y + 2 * Math.sin(p.x / 13) }))
    const out = trace(img, stroke, 20, 4)
    expect(out.points.length).toBeGreaterThan(50)
    // 三角重心在 slope 上；带子外沿两侧不对称，允许整体偏一点，但沿线摆动要小
    const res = out.points.filter((p) => p.x > 45 && p.x < 255).map((p) => p.y - slope(p.x))
    const mean = res.reduce((a, b) => a + b, 0) / res.length
    expect(Math.abs(mean)).toBeLessThan(2)
    // 不平滑时摆动 ~2.6px
    for (const d of res) expect(Math.abs(d - mean)).toBeLessThan(0.6)
  })

  it('三条空心标记带向左汇聚、后画的压住先画的：被压住一侧按可见边缘推重心，不贴着露出来的那半边', () => {
    const img = makeImg(500, 360)
    const bands = [
      { f: (x: number) => 330 - 0.0004 * x * x, c: { r: 20, g: 170, b: 200 }, shape: hollowTriangle },
      { f: (x: number) => 330 - 0.0007 * x * x, c: { r: 20, g: 50, b: 210 }, shape: hollowSquare },
      { f: (x: number) => 330 - 0.001 * x * x, c: { r: 140, g: 20, b: 160 }, shape: hollowTriangle },
    ]
    for (const { f, c, shape } of bands) {
      for (let x = 10; x <= 490; x += 8) paint(img, c, shape(x, f(x), 12, 2.5), [x - 14, f(x) - 14, x + 14, f(x) + 14])
    }
    for (const { f } of bands) {
      const stroke = strokeAlong(f, 30, 470, 0, 3).map((p) => ({ x: p.x, y: p.y + 2 * Math.sin(p.x / 13) }))
      const out = trace(img, stroke, 20, 4)
      const inner = out.points.filter((p) => p.x > 50 && p.x < 450)
      expect(inner.length).toBeGreaterThan(70)
      const ds = inner.map((p) => p.y - f(p.x))
      // 不做遮挡修正时被压住的带子一路偏 4–8px（均方根 2.6–4.7）
      expect(Math.sqrt(ds.reduce((a, d) => a + d * d, 0) / ds.length)).toBeLessThan(1.5)
      // x < 140 三条带子间距不到 10px、几乎完全重合，位置信息本来就不够，只要求整体
      inner.forEach((p, i) => {
        if (p.x >= 140) expect(Math.abs(ds[i])).toBeLessThan(2)
      })
    }
  })

  it('空心圆串中间穿一条同色拟合线：仍取中线', () => {
    const img = makeImg(260, 120)
    markersAlong(img, sine, 20, 240, 6, hollowCircle)
    paint(img, RED, curveShape(sine, 0.75))
    const out = trace(img, strokeAlong(sine, 25, 235, 0, -3), 12, 3)
    expect(out.points.length).toBeGreaterThan(50)
    for (const p of out.points) expect(normalDist(sine, p)).toBeLessThan(1.5)
  })

  it('只涂到背景 / 笔迹太短：返回原因，不出点', () => {
    const img = makeImg(240, 120)
    paint(img, RED, curveShape(sine, 1))
    const blank = trace(img, [{ x: 20, y: 110 }, { x: 200, y: 112 }], 4)
    expect(blank.points).toHaveLength(0)
    expect(blank.reason).toContain('背景')
    const short = trace(img, [{ x: 50, y: sine(50) }, { x: 50.5, y: sine(50) }])
    expect(short.points).toHaveLength(0)
    expect(short.reason).toContain('太短')
  })
})

describe('辅助', () => {
  it('strokeSamples：等弧长采样，法向垂直于笔迹', () => {
    const s = strokeSamples([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }], 3, 5)
    expect(s.length).toBe(21)
    expect(s[0].n.x).toBeCloseTo(0)
    expect(Math.abs(s[0].n.y)).toBeCloseTo(1)
    for (let i = 1; i < s.length; i++) {
      expect(Math.hypot(s[i].p.x - s[i - 1].p.x, s[i].p.y - s[i - 1].p.y)).toBeCloseTo(3, 0)
    }
  })

  it('curvePatchRect：笔迹外接框外扩 r+2，钳制在图像内', () => {
    expect(curvePatchRect([{ x: 10.5, y: 20.2 }, { x: 50.9, y: 5 }], 8, 1000, 1000)).toEqual({ x: 0, y: 0, w: 61, h: 31 })
    expect(curvePatchRect([{ x: 100, y: 100 }, { x: 200, y: 150 }], 8, 180, 1000)).toEqual({ x: 90, y: 90, w: 90, h: 71 })
  })
})

describe('traceCurve：实图 curves.png（四温度 V–I 曲线，右下角四线汇合，黑线与边框同色）', () => {
  const { rgba: raw, width, height } = decodePngRgba('tests/fixtures/curves.png')
  const img: Img = { rgba: compositeOnWhite(raw), W: width, H: height }

  const isColor = (x: number, y: number, c: 'K' | 'R' | 'G' | 'B') => {
    const j = (y * width + x) * 4
    const [r, g, b] = [img.rgba[j], img.rgba[j + 1], img.rgba[j + 2]]
    if (c === 'R') return r > 150 && g < 140 && b < 140
    if (c === 'G') return g > 120 && r < 160 && b < 160
    if (c === 'B') return b > 150 && r < 150 && g < 160
    return r < 120 && g < 120 && b < 120
  }
  /** 点到最近同色像素中心的距离 */
  const distToColor = (p: PixelPoint, c: 'K' | 'R' | 'G' | 'B') => {
    let d = Infinity
    for (let y = Math.floor(p.y) - 4; y <= Math.floor(p.y) + 4; y++) {
      for (let x = Math.floor(p.x) - 4; x <= Math.floor(p.x) + 4; x++) {
        if (x >= 0 && y >= 0 && x < width && y < height && isColor(x, y, c)) {
          d = Math.min(d, Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y))
        }
      }
    }
    return d
  }

  // 按图上曲线大致走向手写的笔迹，整体偏移模拟涂抹不准
  const STROKES: Record<'K' | 'R' | 'G' | 'B', [number, number][]> = {
    K: [[82, 27], [130, 44], [190, 66], [250, 87], [280, 102], [292, 116], [298, 130], [304, 160], [310, 188], [322, 211], [334, 226]],
    R: [[154, 28], [220, 57], [268, 79], [292, 98], [298, 112], [304, 138], [310, 167], [322, 203], [328, 213], [334, 222]],
    G: [[226, 29], [262, 55], [286, 76], [298, 101], [304, 125], [316, 173], [334, 218]],
    B: [[262, 20], [280, 43], [298, 75], [310, 117], [322, 162], [334, 206]],
  }
  const EXPECT: Record<'K' | 'R' | 'G' | 'B', Rgb> = {
    K: { r: 22, g: 22, b: 22 },
    R: { r: 244, g: 14, b: 16 },
    G: { r: 8, g: 200, b: 15 },
    B: { r: 12, g: 29, b: 200 },
  }

  const CASES = [
    { dx: 2, dy: -2, r: 8, step: 3 },
    { dx: -4, dy: 3, r: 10, step: 4 },
  ]
  for (const c of ['K', 'R', 'G', 'B'] as const) for (const { dx, dy, r, step } of CASES) {
    it(`${c}（笔迹偏 ${dx},${dy}，r=${r}，step=${step}）：识别出曲线色，≥95% 采样点找到曲线，每个点离同色像素 ≤ 1px`, () => {
      const stroke = STROKES[c].map(([x, y]) => ({ x: x + dx, y: y + dy }))
      const out = trace(img, stroke, r, step)
      const col = out.color!
      expect(Math.hypot(col.r - EXPECT[c].r, col.g - EXPECT[c].g, col.b - EXPECT[c].b)).toBeLessThan(20)
      expect(out.points.length / (out.points.length + out.misses.length)).toBeGreaterThan(0.95)
      for (const p of out.points) expect(distToColor(p, c)).toBeLessThanOrEqual(1)
    })
  }
})
