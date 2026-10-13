// markerBlob.test.ts — 散点 refine（§4.4）：颜色分割 + 连通块重心，合成抗锯齿图单测
import { describe, expect, it } from 'vitest'
import { estimateBackground, scatterPatchRect, type Rgb } from '../src/engine/markerBlob'
import { scatterRefineAt } from './helpers/scatter'

type Img = { rgba: Uint8ClampedArray; W: number; H: number }
type Shape = (x: number, y: number) => boolean

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLUE: Rgb = { r: 31, g: 119, b: 180 }

function makeImg(W: number, H: number, c: Rgb = WHITE): Img {
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) rgba.set([c.r, c.g, c.b, 255], i * 4)
  return { rgba, W, H }
}

/** 4×4 超采样按覆盖率混色，模拟抗锯齿边缘 */
function paint(img: Img, c: Rgb, inside: Shape): void {
  for (let y = 0; y < img.H; y++) {
    for (let x = 0; x < img.W; x++) {
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

const disk = (cx: number, cy: number, r: number): Shape => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r

const refineAt = (img: Img, pt: { x: number; y: number }, r = 8) => scatterRefineAt(img.rgba, img.W, img.H, pt, r)

function expectNear(out: { x: number; y: number; snapped: boolean }, cx: number, cy: number, tol: number): void {
  expect(out.snapped).toBe(true)
  expect(Math.hypot(out.x - cx, out.y - cy)).toBeLessThan(tol)
}

describe('refineScatter：孤立标记取重心', () => {
  it('偏心点击（右下 4–5px）→ 抗锯齿实心圆的亚像素重心', () => {
    const img = makeImg(120, 120)
    paint(img, BLUE, disk(50.3, 60.7, 4))
    expectNear(refineAt(img, { x: 54.5, y: 65 }), 50.3, 60.7, 0.1)
  })

  it('灰底 + 淡色标记：背景不参与权重，不会被拉回点击处', () => {
    const img = makeImg(120, 120, { r: 240, g: 240, b: 240 })
    paint(img, { r: 173, g: 216, b: 230 }, disk(60, 60, 3.5))
    expectNear(refineAt(img, { x: 64.5, y: 63.5 }), 60, 60, 0.15)
  })

  it('搜索框比标记小、整个落在标记里：背景取全图，照样找到整个标记的重心', () => {
    const img = makeImg(120, 120)
    paint(img, BLUE, disk(60, 60, 10))
    expectNear(refineAt(img, { x: 66, y: 57 }, 2), 60, 60, 0.1)
  })

  it('标记只需碰到搜索框：框外的大部分也算进重心', () => {
    const img = makeImg(120, 120)
    paint(img, BLUE, disk(70, 60, 5))
    // 框 = [52, 68]，圆左缘 65 在框内
    expectNear(refineAt(img, { x: 60.5, y: 60.5 }, 8), 70, 60, 0.1)
  })

  it('搜索框边界与 refineWindow 一致：标记离框差 1px 就找不到', () => {
    const block = (x0: number): Shape => (x, y) => x >= x0 && x < x0 + 4 && y >= 58 && y < 62
    const inside = makeImg(120, 120)
    paint(inside, BLUE, block(68)) // 框 = 像素 52..68
    expect(refineAt(inside, { x: 60.5, y: 60.5 }).snapped).toBe(true)
    const outside = makeImg(120, 120)
    paint(outside, BLUE, block(69))
    expect(refineAt(outside, { x: 60.5, y: 60.5 }).snapped).toBe(false)
  })

  it('空心圆环：填孔后取外轮廓重心', () => {
    const img = makeImg(120, 120)
    paint(img, BLUE, (x, y) => {
      const d = Math.hypot(x - 60.4, y - 59.6)
      return d <= 6 && d >= 4.5
    })
    expectNear(refineAt(img, { x: 63, y: 55 }), 60.4, 59.6, 0.1)
  })

  it('十字标记（细笔画）', () => {
    const img = makeImg(120, 120)
    paint(img, BLUE, (x, y) => (Math.abs(x - 60) <= 1 && Math.abs(y - 60) <= 5) || (Math.abs(y - 60) <= 1 && Math.abs(x - 60) <= 5))
    expectNear(refineAt(img, { x: 63.5, y: 62.5 }), 60, 60, 0.1)
  })

  it('框内两个分开的标记：取离点击最近的', () => {
    const img = makeImg(120, 120)
    paint(img, BLUE, disk(54, 60, 3))
    paint(img, BLUE, disk(66, 60, 3))
    expectNear(refineAt(img, { x: 63, y: 60.5 }), 66, 60, 0.1)
    expectNear(refineAt(img, { x: 57.5, y: 60.5 }), 54, 60, 0.1)
  })

  it('不同颜色挨在一起：按点击处的标记色分割，另一色不进重心', () => {
    const img = makeImg(120, 120)
    paint(img, { r: 255, g: 150, b: 200 }, disk(56, 60, 4))
    paint(img, { r: 150, g: 90, b: 200 }, disk(63.5, 60, 4))
    expectNear(refineAt(img, { x: 53, y: 62 }), 56, 60, 0.3)
  })
})

describe('refineScatter：连线 / 成串重叠 → 最近的内切圆圆心', () => {
  it('同色细线穿过标记（偏离圆心 1.5px）', () => {
    const img = makeImg(160, 120)
    paint(img, BLUE, (_, y) => Math.abs(y - 61.5) <= 0.75)
    paint(img, BLUE, disk(80, 60, 4.5))
    expectNear(refineAt(img, { x: 84, y: 64 }), 80, 60, 0.5)
  })

  it('同色折线穿过空心圆（内部被切成两半、带浅色底）：两半各自填孔，回到实心圆的圆心', () => {
    const img = makeImg(160, 120)
    paint(img, { r: 235, g: 200, b: 220 }, disk(80.4, 60.3, 4.5)) // JPEG 晕开的浅色内部
    paint(img, { r: 190, g: 50, b: 130 }, (x, y) => {
      const d = Math.hypot(x - 80.4, y - 60.3)
      return d <= 5.5 && d >= 4
    })
    paint(img, { r: 190, g: 50, b: 130 }, (x, y) => Math.abs(y - 60.3 - 0.3 * (x - 80.4)) <= 1)
    for (const [dx, dy] of [[0, 0], [4, 3], [-3, -4], [5, -2], [-4, 4]]) {
      expectNear(refineAt(img, { x: 80.4 + dx, y: 60.3 + dy }), 80.4, 60.3, 0.3)
    }
  })

  it('折线止于空心圆（末端点）：只有一侧有线，偏差仍 < 0.5px', () => {
    const img = makeImg(160, 120)
    paint(img, { r: 190, g: 50, b: 130 }, (x, y) => {
      const d = Math.hypot(x - 80, y - 60)
      return d <= 5.5 && d >= 4
    })
    paint(img, { r: 190, g: 50, b: 130 }, (x, y) => x <= 80 && Math.abs(y - 60 + (x - 80)) <= 1)
    expectNear(refineAt(img, { x: 83, y: 58 }), 80, 60, 0.5)
  })

  it('同色折线穿过空心圆（内部被切成两半、带浅色底）：两半各自填孔，回到实心圆的圆心', () => {
    const img = makeImg(160, 120)
    paint(img, { r: 235, g: 200, b: 220 }, disk(80.4, 60.3, 4.5)) // JPEG 晕开的浅色内部
    paint(img, { r: 190, g: 50, b: 130 }, (x, y) => {
      const d = Math.hypot(x - 80.4, y - 60.3)
      return d <= 5.5 && d >= 4
    })
    paint(img, { r: 190, g: 50, b: 130 }, (x, y) => Math.abs(y - 60.3 - 0.3 * (x - 80.4)) <= 1)
    for (const [dx, dy] of [[0, 0], [4, 3], [-3, -4], [5, -2], [-4, 4]]) {
      expectNear(refineAt(img, { x: 80.4 + dx, y: 60.3 + dy }), 80.4, 60.3, 0.3)
    }
  })

  it('折线止于空心圆（末端点）：只有一侧有线，偏差仍 < 0.5px', () => {
    const img = makeImg(160, 120)
    paint(img, { r: 190, g: 50, b: 130 }, (x, y) => {
      const d = Math.hypot(x - 80, y - 60)
      return d <= 5.5 && d >= 4
    })
    paint(img, { r: 190, g: 50, b: 130 }, (x, y) => x <= 80 && Math.abs(y - 60 + (x - 80)) <= 1)
    expectNear(refineAt(img, { x: 83, y: 58 }), 80, 60, 0.5)
  })

  it('同色标记连成串（间距 6px、半径 4，伸出读取范围）：点哪个吸哪个', () => {
    const img = makeImg(200, 120)
    for (let k = 0; k < 20; k++) paint(img, BLUE, disk(40 + 6 * k, 60, 4))
    for (const k of [8, 9, 10]) {
      expectNear(refineAt(img, { x: 40 + 6 * k + 1.5, y: 62 }), 40 + 6 * k, 60, 0.5)
    }
  })

  it('两三个重叠标记整体在读取范围内：不取整团重心，取离点击最近的那个', () => {
    const img = makeImg(120, 120)
    for (const cx of [54, 60, 66]) paint(img, BLUE, disk(cx, 60, 4))
    expectNear(refineAt(img, { x: 67.5, y: 62 }), 66, 60, 0.8)
    expectNear(refineAt(img, { x: 60.5, y: 63 }), 60, 60, 0.5)
  })
})

describe('refineScatter：找不到时按原位置返回并说明原因', () => {
  it('搜索框内只有背景色', () => {
    const img = makeImg(120, 120)
    paint(img, BLUE, disk(90, 90, 4))
    const out = refineAt(img, { x: 30.5, y: 30.5 })
    expect(out).toMatchObject({ x: 30.5, y: 30.5, snapped: false })
    expect(out.reason).toContain('只有背景色')
  })

  it('只碰到细线（坐标轴、网格）', () => {
    const img = makeImg(160, 120)
    paint(img, { r: 0, g: 0, b: 0 }, (x) => Math.abs(x - 80) <= 1)
    const out = refineAt(img, { x: 84.5, y: 60.5 })
    expect(out.snapped).toBe(false)
    expect(out.reason).toContain('线条')
  })

  it('点击在图像外', () => {
    const img = makeImg(50, 50)
    expect(refineAt(img, { x: -100, y: 20 }).snapped).toBe(false)
  })
})

describe('辅助', () => {
  it('outline：凸包包住整个标记、不大出一圈像素', () => {
    const img = makeImg(120, 120)
    paint(img, BLUE, disk(60, 60, 4))
    const out = refineAt(img, { x: 62, y: 62 })
    const xs = out.outline!.map((p) => p.x)
    const ys = out.outline!.map((p) => p.y)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(55)
    expect(Math.max(...xs)).toBeLessThanOrEqual(65)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(55)
    expect(Math.max(...ys)).toBeLessThanOrEqual(65)
  })

  it('estimateBackground：取面积最大的颜色（灰色绘图区占多数时取灰色）', () => {
    const img = makeImg(100, 100)
    paint(img, { r: 235, g: 235, b: 235 }, (x, y) => x > 20 && y > 20)
    paint(img, BLUE, disk(50, 50, 6))
    const bg = estimateBackground(img.rgba, img.W, img.H)
    expect(Math.hypot(bg.r - 235, bg.g - 235, bg.b - 235)).toBeLessThan(1)
  })

  it('scatterPatchRect：搜索框外留出 max(24, 2r)，钳制在图像内', () => {
    expect(scatterPatchRect({ x: 100.7, y: 100.2 }, 8, 1000, 1000)).toEqual({ x: 68, y: 68, w: 65, h: 65 })
    expect(scatterPatchRect({ x: 5, y: 5 }, 8, 1000, 1000)).toEqual({ x: 0, y: 0, w: 38, h: 38 })
  })
})
