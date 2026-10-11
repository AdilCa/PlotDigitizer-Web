// refine.test.ts — 点优化（§4.4）合成灰度图单测
import { describe, expect, it } from 'vitest'
import { refineBar, refineScatter, REFINE_DEFAULTS } from '../src/engine/refine'

function makeGray(w: number, h: number, fill = 255): Uint8Array {
  return new Uint8Array(w * h).fill(fill)
}

/** 实心圆点（模拟散点 marker） */
function dot(gray: Uint8Array, w: number, cx: number, cy: number, r: number, val = 0): void {
  const h = gray.length / w
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) gray[y * w + x] = val
    }
  }
}

describe('refineScatter：暗度质心（r=8）', () => {
  it('偏心点击吸附到圆点中心', () => {
    const W = 100
    const H = 100
    const gray = makeGray(W, H)
    dot(gray, W, 50, 60, 4)
    const out = refineScatter({ x: 54, y: 64 }, gray, W, H)
    expect(Math.abs(out.x - 50)).toBeLessThanOrEqual(1)
    expect(Math.abs(out.y - 60)).toBeLessThanOrEqual(1)
  })

  it('窗口内全白（无特征）→ 原样返回，不凭空位移', () => {
    const W = 100
    const H = 100
    const gray = makeGray(W, H)
    const out = refineScatter({ x: 30, y: 30 }, gray, W, H)
    expect(out).toEqual({ x: 30, y: 30 })
  })

  it('边缘点：窗口越界部分按白处理，质心仍落在点上', () => {
    const W = 100
    const H = 100
    const gray = makeGray(W, H)
    dot(gray, W, 3, 3, 3)
    const out = refineScatter({ x: 2, y: 2 }, gray, W, H)
    expect(Math.abs(out.x - 3)).toBeLessThanOrEqual(1.5)
    expect(Math.abs(out.y - 3)).toBeLessThanOrEqual(1.5)
  })
})

describe('refineBar：由外向内首个强跳变 + 多剖面投票', () => {
  it('默认向下：点在柱顶上方 → 吸附到柱顶边缘', () => {
    const W = 100
    const H = 200
    const gray = makeGray(W, H)
    // 柱子：y=120..199, x=40..60 黑色实心
    for (let y = 120; y < 200; y++) for (let x = 40; x <= 60; x++) gray[y * W + x] = 0
    const out = refineBar({ x: 50, y: 100 }, gray, W, H) // 柱顶上方 20px
    expect(Math.abs(out.y - 120)).toBeLessThanOrEqual(1)
    expect(out.x).toBe(50)
  })

  it('方向向上：点在柱底下方 → 吸附到柱底边缘', () => {
    const W = 100
    const H = 200
    const gray = makeGray(W, H)
    for (let y = 50; y <= 120; y++) for (let x = 40; x <= 60; x++) gray[y * W + x] = 0
    const out = refineBar({ x: 50, y: 140 }, gray, W, H, 'up')
    expect(Math.abs(out.y - 120)).toBeLessThanOrEqual(1)
  })

  it('斜边不误判：点击水平偏离柱边 3px，投票仍锁柱顶', () => {
    const W = 100
    const H = 200
    const gray = makeGray(W, H)
    for (let y = 120; y < 200; y++) for (let x = 40; x <= 60; x++) gray[y * W + x] = 0
    // 点击 x=43（柱内偏左），±5px 剖面大多仍落在柱体上
    const out = refineBar({ x: 43, y: 100 }, gray, W, H)
    expect(Math.abs(out.y - 120)).toBeLessThanOrEqual(1)
  })

  it('扫描全程无跳变 → 原样返回', () => {
    const W = 100
    const H = 200
    const gray = makeGray(W, H)
    const out = refineBar({ x: 50, y: 50 }, gray, W, H)
    expect(out).toEqual({ x: 50, y: 50 })
  })

  it('投票剖面偏移配置符合 §4.4（±5px 含 0）', () => {
    expect(REFINE_DEFAULTS.barProfileOffsets).toContain(0)
    expect(Math.min(...REFINE_DEFAULTS.barProfileOffsets)).toBe(-5)
    expect(Math.max(...REFINE_DEFAULTS.barProfileOffsets)).toBe(5)
  })
})
