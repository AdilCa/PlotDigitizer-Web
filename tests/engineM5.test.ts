// engineM5.test.ts — M5-4：engine 单测补全
// ① log 轴大动态范围数值稳定性（§9 风险 4）；② axisFitter 对比度门控；
// ③ 真实夹具回归（tests/fixtures/large-4000x3000.png，node 侧最小 PNG 解码，零新增依赖）。
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyMapping, solveMapping } from '../src/engine/geometry'
import { fitAxis } from '../src/engine/axisFitter'
import { fitTicks } from '../src/engine/tickFitter'
import { refineBar } from '../src/engine/refine'
import { toGray } from '../src/engine/gray'
import { compositeOnWhite, decodePngGray, decodePngRgba } from './helpers/png'
import { scatterRefineAt } from './helpers/scatter'

// ---------------------------------------------------------------- geometry：log 轴大动态范围（§9 风险 4）

describe('geometry：log 轴大动态范围', () => {
  it('10⁻²–10⁵ 跨 7 个 decade 逐 decade 往返，相对误差 < 1e-9', () => {
    const m = solveMapping(200, 0.01, 3800, 100000, 'log')!
    for (let e = -2; e <= 5; e++) {
      const pos = 200 + ((e + 2) / 7) * 3600
      const v = applyMapping(m, pos)
      expect(Math.abs(v / 10 ** e - 1)).toBeLessThan(1e-9)
    }
  })

  it('10⁻⁶–10⁶ 跨 12 个 decade：中间范围无 NaN/Infinity 且严格单调', () => {
    const m = solveMapping(0, 1e-6, 3600, 1e6, 'log')!
    let prev = 0
    for (let pos = 0; pos <= 3600; pos += 300) {
      const v = applyMapping(m, pos)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(prev)
      prev = v
    }
    // 中间 decade 精度：pos=1800 → 10⁰ = 1
    expect(Math.abs(applyMapping(m, 1800) - 1)).toBeLessThan(1e-9)
  })

  it('log 轴像素对称性：刻度位置往返还原（pos → value → 反解）', () => {
    const m = solveMapping(601.5, 0.1, 3401.5, 10000, 'log')!
    // 反解 pos = (log10(v) - a) / b，验证刻度像素无漂移
    for (const v of [0.1, 1, 10, 100, 1000, 10000]) {
      const pos = (Math.log10(v) - m.a) / m.b
      expect(Math.abs(applyMapping(m, pos) / v - 1)).toBeLessThan(1e-12)
    }
  })
})

// ---------------------------------------------------------------- axisFitter：对比度门控（§4.2 minContrast=25）

describe('axisFitter：对比度与有效点门控', () => {
  it('低对比线（灰度差 20 < 25）→ 全部剖面被门控 → ok:false', () => {
    const W = 400
    const H = 300
    const gray = new Uint8Array(W * H).fill(255)
    for (let x = 50; x < 350; x++) {
      for (let y = 148; y <= 152; y++) gray[y * W + x] = 235 // 差 20，低于 minContrast
    }
    const r = fitAxis(gray, W, H, 'x', { x: 50, y: 150 }, { x: 350, y: 150 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('有效采样点不足')
  })

  it('边界：灰度差恰好 = 25（minContrast）→ 通过门控 → ok:true', () => {
    const W = 400
    const H = 300
    const gray = new Uint8Array(W * H).fill(255)
    for (let x = 50; x < 350; x++) {
      for (let y = 148; y <= 152; y++) gray[y * W + x] = 230 // 差 25，等于门控阈值
    }
    const r = fitAxis(gray, W, H, 'x', { x: 50, y: 150 }, { x: 350, y: 150 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Math.abs(r.position - 150)).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------- 真实夹具回归（§9：4000×3000 路径）

describe('真实夹具回归：large-4000x3000.png', () => {
  // X 轴线 y=2800 x∈[200,3800] 8px 黑线；刻度 x=600..3400 步 400；Y 轴线 x=200
  const fixture = path.resolve('tests/fixtures/large-4000x3000.png')
  let img: { rgba: Uint8ClampedArray; gray: Uint8Array; width: number; height: number } | null = null

  function load() {
    if (!img) {
      const d = decodePngRgba(fixture)
      const rgba = compositeOnWhite(d.rgba)
      img = { rgba, gray: toGray(rgba, d.width, d.height), width: d.width, height: d.height }
    }
    return img
  }

  it('解码尺寸正确', () => {
    const { width, height } = load()
    expect(width).toBe(4000)
    expect(height).toBe(3000)
  })

  it('fitAxis：手绘斜线拟合出 X 轴线 y≈2800', () => {
    const { gray, width, height } = load()
    const r = fitAxis(gray, width, height, 'x', { x: 400, y: 2795 }, { x: 3600, y: 2805 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Math.abs(r.position - 2800)).toBeLessThanOrEqual(2)
  })

  it('fitTicks：点击 (600,2815)/(3400,2815) → fitted≈600/3400', () => {
    const { gray, width, height } = load()
    const r = fitTicks(gray, width, height, 'x', [
      { id: 't1', at: { x: 600, y: 2815 } },
      { id: 't2', at: { x: 3400, y: 2815 } },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Math.abs(r.fitted.t1 - 600)).toBeLessThanOrEqual(2)
      expect(Math.abs(r.fitted.t2 - 3400)).toBeLessThanOrEqual(2)
    }
  })

  it('refineScatter：点击 8px 粗 Y 轴线旁 (207,1500)，按成块物体吸附到线中心 x≈200', () => {
    const { rgba, width, height } = load()
    const out = scatterRefineAt(rgba, width, height, { x: 207, y: 1500 })
    expect(out.snapped).toBe(true)
    expect(Math.abs(out.x - 200)).toBeLessThanOrEqual(1)
    expect(Math.abs(out.y - 1500)).toBeLessThanOrEqual(8)
  })
})

describe('真实夹具回归：test2.png（EIS 淡彩散点）', () => {
  const d = decodePngRgba(path.resolve('tests/fixtures/test2.png'))
  const rgba = compositeOnWhite(d.rgba)
  const at = (x: number, y: number) => scatterRefineAt(rgba, d.width, d.height, { x, y })

  it.each([
    { x: 243, y: 144 },
    { x: 269, y: 144 },
    { x: 320, y: 162 },
  ])('孤立标记 ≈ ($x, $y)：从四个方向偏离 3–5px 点击，都收敛到同一重心（±0.3px）', (c) => {
    const outs = [at(c.x + 4.5, c.y + 3.5), at(c.x - 3.5, c.y - 2.5), at(c.x + 3, c.y - 4), at(c.x - 4, c.y + 3)]
    for (const o of outs) {
      expect(o.snapped).toBe(true)
      expect(Math.hypot(o.x - outs[0].x, o.y - outs[0].y)).toBeLessThan(0.3)
    }
    expect(Math.hypot(outs[0].x - c.x, outs[0].y - c.y)).toBeLessThan(1.5)
  })
})

describe('真实夹具回归：test1.png（被同色折线穿过的空心圆，直径约 11px）', () => {
  const d = decodePngRgba(path.resolve('tests/fixtures/test1.png'))
  const rgba = compositeOnWhite(d.rgba)
  const at = (x: number, y: number) => scatterRefineAt(rgba, d.width, d.height, { x, y })

  // 圆心参考值：圆环上下（或左右）边缘半高位置的中点，手工读像素得出
  it.each([
    { name: '网纹柱上的首点', x: 163, y: 401, ref: null },
    { name: '折线拐点', x: 265, y: 200, ref: null },
    { name: '水平线段左端', x: 368, y: 174, ref: { x: 368.5, y: 174.27 } },
    { name: '水平线段右端', x: 470, y: 174, ref: null },
    { name: '末端点', x: 572, y: 73, ref: { x: 573.5, y: 73.0 } },
  ])('$name ≈ ($x, $y)：六个方向偏离点击都收敛到同一圆心（±0.35px）', ({ x, y, ref }) => {
    const outs = [[0, 0], [4, 3], [-3, -4], [5, -2], [-4, 4], [0, 6]].map(([dx, dy]) => at(x + dx + 0.5, y + dy + 0.5))
    for (const o of outs) {
      expect(o.snapped).toBe(true)
      expect(Math.hypot(o.x - outs[0].x, o.y - outs[0].y)).toBeLessThan(0.35)
    }
    if (ref) expect(Math.hypot(outs[0].x - ref.x, outs[0].y - ref.y)).toBeLessThan(0.6)
  })
})

describe('真实夹具回归：test1.png（被同色折线穿过的空心圆，直径约 11px）', () => {
  const d = decodePngRgba(path.resolve('tests/fixtures/test1.png'))
  const rgba = compositeOnWhite(d.rgba)
  const at = (x: number, y: number) => scatterRefineAt(rgba, d.width, d.height, { x, y })

  // 圆心参考值：圆环上下（或左右）边缘半高位置的中点，手工读像素得出
  it.each([
    { name: '网纹柱上的首点', x: 163, y: 401, ref: null },
    { name: '折线拐点', x: 265, y: 200, ref: null },
    { name: '水平线段左端', x: 368, y: 174, ref: { x: 368.5, y: 174.27 } },
    { name: '水平线段右端', x: 470, y: 174, ref: null },
    { name: '末端点', x: 572, y: 73, ref: { x: 573.5, y: 73.0 } },
  ])('$name ≈ ($x, $y)：六个方向偏离点击都收敛到同一圆心（±0.35px）', ({ x, y, ref }) => {
    const outs = [[0, 0], [4, 3], [-3, -4], [5, -2], [-4, 4], [0, 6]].map(([dx, dy]) => at(x + dx + 0.5, y + dy + 0.5))
    for (const o of outs) {
      expect(o.snapped).toBe(true)
      expect(Math.hypot(o.x - outs[0].x, o.y - outs[0].y)).toBeLessThan(0.35)
    }
    if (ref) expect(Math.hypot(outs[0].x - ref.x, outs[0].y - ref.y)).toBeLessThan(0.6)
  })
})

describe('真实夹具回归：test1.png（粉色网纹柱，软边）', () => {
  const fixture = path.resolve('tests/fixtures/test1.png')
  let img: { gray: Uint8Array; width: number; height: number } | null = null
  function load() {
    if (!img) img = decodePngGray(fixture)
    return img
  }

  it.each([
    { x: 259, top: 290 },
    { x: 135, top: 71 },
    { x: 585, top: 136 },
  ])('refineBar 向下：柱 x=$x 的柱顶 ≈ $top，起点在柱顶上方 2–30px 都一致', ({ x, top }) => {
    const { gray, width, height } = load()
    for (const dy of [2, 7.3, 15, 30]) {
      const out = refineBar({ x, y: top - dy }, gray, width, height, 'down', 40)
      expect(out.snapped).toBe(true)
      expect(Math.abs(out.y - top)).toBeLessThanOrEqual(1.5)
    }
  })
})
