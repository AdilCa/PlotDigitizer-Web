// engineM5.test.ts — M5-4：engine 单测补全
// ① log 轴大动态范围数值稳定性（§9 风险 4）；② axisFitter 对比度门控；
// ③ 真实夹具回归（tests/fixtures/large-4000x3000.png，node 侧最小 PNG 解码，零新增依赖）。
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyMapping, solveMapping } from '../src/engine/geometry'
import { fitAxis } from '../src/engine/axisFitter'
import { fitTicks } from '../src/engine/tickFitter'
import { refineScatter } from '../src/engine/refine'
import { toGray } from '../src/engine/gray'

// ---------------------------------------------------------------- 最小 PNG 解码（8bit RGB/RGBA）

function decodePngGray(file: string): { gray: Uint8Array; width: number; height: number } {
  const buf = readFileSync(file)
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const chunk = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8]
      colorType = chunk[9]
    } else if (type === 'IDAT') {
      idat.push(chunk)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`仅支持 8bit RGB/RGBA PNG，实际 bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const bpp = colorType === 2 ? 3 : 4
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = new Uint8Array(stride * height)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = px.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
    prev = cur
  }
  // 扩成 RGBA 后走引擎同一个 toGray（Rec.601），保证与运行时路径一致
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = px[i * bpp]
    rgba[i * 4 + 1] = px[i * bpp + 1]
    rgba[i * 4 + 2] = px[i * bpp + 2]
    rgba[i * 4 + 3] = 255
  }
  return { gray: toGray(rgba, width, height), width, height }
}

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
  let img: { gray: Uint8Array; width: number; height: number } | null = null

  function load() {
    if (!img) img = decodePngGray(fixture)
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

  it('refineScatter：点击 Y 轴线旁 (207,1500) 吸附到轴线 x≈200', () => {
    const { gray, width, height } = load()
    const out = refineScatter({ x: 207, y: 1500 }, gray, width, height)
    expect(Math.abs(out.x - 200)).toBeLessThanOrEqual(3)
    expect(Math.abs(out.y - 1500)).toBeLessThanOrEqual(8)
  })
})
