// engineFit.test.ts — geometry / axisFitter / tickFitter 合成灰度图单测
import { describe, expect, it } from 'vitest'
import { solveMapping, applyMapping } from '../src/engine/geometry'
import { fitAxis } from '../src/engine/axisFitter'
import { fitTicks } from '../src/engine/tickFitter'

// ---------------------------------------------------------------- 合成灰度图 helpers

function makeGray(w: number, h: number, fill = 255): Uint8Array {
  return new Uint8Array(w * h).fill(fill)
}

/** 画水平线（含厚度，以 cy 为中心） */
function hLine(gray: Uint8Array, w: number, x1: number, x2: number, cy: number, thick = 3, val = 0): void {
  const hLen = gray.length / w
  for (let y = Math.max(0, cy - (thick >> 1)); y <= Math.min(hLen - 1, cy + (thick >> 1)); y++) {
    for (let x = x1; x <= x2; x++) gray[y * w + x] = val
  }
}

/** 画垂直线（含厚度，以 cx 为中心） */
function vLine(gray: Uint8Array, w: number, y1: number, y2: number, cx: number, thick = 3, val = 0): void {
  const hLen = gray.length / w
  for (let x = Math.max(0, cx - (thick >> 1)); x <= Math.min(w - 1, cx + (thick >> 1)); x++) {
    for (let y = y1; y <= Math.min(y2, hLen - 1); y++) gray[y * w + x] = val
  }
}

// ---------------------------------------------------------------- geometry

describe('geometry：两点解析映射（§4.5）', () => {
  it('线性轴：value = a + b·pos', () => {
    const m = solveMapping(100, 0, 200, 10, 'linear')!
    expect(m.b).toBeCloseTo(0.1)
    expect(m.a).toBeCloseTo(-10)
    expect(applyMapping(m, 150)).toBeCloseTo(5)
  })

  it('log 轴：log₁₀ 域求解，取值 10^(a+b·pos)', () => {
    const m = solveMapping(0, 1, 100, 100, 'log')!
    expect(applyMapping(m, 50)).toBeCloseTo(10)
  })

  it('退化：两刻度同位置 → null；两刻度值相同 → null；log 轴非正值 → null', () => {
    expect(solveMapping(100, 0, 100, 10, 'linear')).toBeNull()
    expect(solveMapping(100, 5, 200, 5, 'linear')).toBeNull()
    expect(solveMapping(100, 5, 200, 5, 'log')).toBeNull()
    expect(solveMapping(0, 0, 100, 100, 'log')).toBeNull()
    expect(solveMapping(0, -1, 100, 100, 'log')).toBeNull()
  })
})

// ---------------------------------------------------------------- axisFitter

describe('axisFitter：手绘线段 → 轴线精确定位（§4.2）', () => {
  it('斜手绘线拟合出水平轴位置（y=500 横线）', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    hLine(gray, W, 100, 700, 500, 5)
    // 手绘线从 (100, 492) 到 (700, 508)：明显歪斜
    const r = fitAxis(gray, W, H, 'x', { x: 100, y: 492 }, { x: 700, y: 508 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.position).toBeGreaterThanOrEqual(498)
      expect(r.position).toBeLessThanOrEqual(502)
      expect(r.diagnostics.samplePoints.length).toBeGreaterThanOrEqual(4)
      expect(r.diagnostics.scanBand.h).toBeGreaterThan(35 * 2) // 扫描带含 ±scanHalf
    }
  })

  it('Y 轴：竖线 x=300', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    vLine(gray, W, 100, 900, 300, 5)
    const r = fitAxis(gray, W, H, 'y', { x: 294, y: 100 }, { x: 306, y: 900 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Math.abs(r.position - 300)).toBeLessThanOrEqual(2)
  })

  it('空白图 → ok:false（有效采样点不足）', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    const r = fitAxis(gray, W, H, 'x', { x: 100, y: 500 }, { x: 700, y: 500 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('有效采样点不足')
  })

  it('中位数抗离群：混入一条远离的噪线不影响主位置', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    hLine(gray, W, 100, 700, 500, 5)
    // 噪线：只覆盖手绘线一小段（~10% 采样点）
    hLine(gray, W, 100, 150, 470, 3)
    const r = fitAxis(gray, W, H, 'x', { x: 100, y: 495 }, { x: 700, y: 505 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(Math.abs(r.position - 500)).toBeLessThanOrEqual(2)
  })

  it('手绘线段太短 → ok:false', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    hLine(gray, W, 100, 700, 500, 5)
    const r = fitAxis(gray, W, H, 'x', { x: 400, y: 500 }, { x: 400.5, y: 500 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('太短')
  })
})

// ---------------------------------------------------------------- tickFitter

describe('tickFitter：点击位置 → 刻度线精确定位（§4.3）', () => {
  it('X 轴刻度：竖刻度线在 x=200/600，点击 (205, 512) → fitted≈200', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    hLine(gray, W, 100, 700, 500, 5) // X 轴线（点击行 y=512 避开它）
    vLine(gray, W, 500, 530, 200, 3) // 刻度线 1
    vLine(gray, W, 500, 530, 600, 3) // 刻度线 2
    const r = fitTicks(gray, W, H, 'x', [
      { id: 't1', at: { x: 205, y: 512 } },
      { id: 't2', at: { x: 595, y: 512 } },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Math.abs(r.fitted.t1 - 200)).toBeLessThanOrEqual(1)
      expect(Math.abs(r.fitted.t2 - 600)).toBeLessThanOrEqual(1)
      expect(r.diagnostics.candidateLines).toHaveLength(2)
      // 逐行定位：刻度 y=500..530 去掉被轴线覆盖的 498..502 行
      expect(r.diagnostics.samplePoints.length).toBeGreaterThan(20)
    }
  })

  it('像素中心约定：3px 宽刻度占 x=199..201，中心 = 200.5，与点击小数部分无关', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    vLine(gray, W, 505, 530, 200, 3)
    const results = [195, 197.3, 200.9, 204.6].map((x) => {
      const r = fitTicks(gray, W, H, 'x', [{ id: 't', at: { x, y: 515.7 } }])
      expect(r.ok).toBe(true)
      return r.ok ? r.fitted.t : NaN
    })
    for (const v of results) expect(v).toBe(200.5)
  })

  it('点击行落在轴线上：自动转到最近的刻度行（不再报对比度不足）', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    hLine(gray, W, 100, 700, 500, 5) // 轴线 498..502
    vLine(gray, W, 500, 512, 300, 3)
    const r = fitTicks(gray, W, H, 'x', [{ id: 't', at: { x: 303, y: 500.2 } }])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fitted.t).toBe(300.5)
  })

  it('次刻度：点在主刻度上、窗口内只有它 → 定位到主刻度（不会被相邻次刻度吸走）', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    hLine(gray, W, 100, 700, 500, 3)
    vLine(gray, W, 501, 520, 400, 3) // 主刻度（长）
    vLine(gray, W, 501, 510, 380, 3) // 次刻度（短）
    vLine(gray, W, 501, 510, 420, 3)
    // 默认 ±10：窗口 390..410，不含次刻度
    const r1 = fitTicks(gray, W, H, 'x', [{ id: 't', at: { x: 400, y: 505 } }])
    expect(r1.ok && r1.fitted.t).toBe(400.5)
    // 点在次刻度以下的行（只有主刻度延伸到这里）→ 也是主刻度
    const r2 = fitTicks(gray, W, H, 'x', [{ id: 't', at: { x: 400, y: 515 } }], 35)
    expect(r2.ok && r2.fitted.t).toBe(400.5)
  })

  it('窗口内多根同等深度刻度 → 报错提示调小窗口，候选线逐一标出', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    vLine(gray, W, 501, 510, 380, 3)
    vLine(gray, W, 501, 520, 400, 3)
    vLine(gray, W, 501, 510, 420, 3)
    const r = fitTicks(gray, W, H, 'x', [{ id: 't', at: { x: 400, y: 505 } }], 35)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('3 条暗线')
      expect(r.error).toContain('调小扫描窗口')
      expect(r.diagnostics.candidateLines).toHaveLength(3)
    }
  })

  it('刻度线触及窗口边缘 → 报错（中心不可信）', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    vLine(gray, W, 501, 520, 400, 9) // 396..404
    const r = fitTicks(gray, W, H, 'x', [{ id: 't', at: { x: 407, y: 510 } }], 4)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('窗口边缘')
  })

  it('Y 轴刻度：横刻度线在 y=300，点击 (215, 305) → fitted≈300', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    hLine(gray, W, 200, 230, 300, 3)
    // Y 轴剖面取点击列（x=215 须与刻度线 x∈[200,230] 相交）
    const r = fitTicks(gray, W, H, 'y', [{ id: 't1', at: { x: 215, y: 305 } }])
    expect(r.ok).toBe(true)
    if (r.ok) expect(Math.abs(r.fitted.t1 - 300)).toBeLessThanOrEqual(1)
  })

  it('点击空白处 → ok:false（未找到刻度线），错误文案带刻度序号', () => {
    const W = 800
    const H = 1000
    const gray = makeGray(W, H)
    vLine(gray, W, 500, 530, 200, 3)
    const r = fitTicks(gray, W, H, 'x', [
      { id: 't1', at: { x: 205, y: 512 } },
      { id: 't2', at: { x: 400, y: 512 } }, // 空白
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('第 2 个刻度')
      expect(r.diagnostics.candidateLines.length).toBeGreaterThanOrEqual(1)
    }
  })
})
