// refine.test.ts — 柱状 refine 与 refine 范围可视化（§4.4）合成灰度图单测；散点见 markerBlob.test.ts
import { describe, expect, it } from 'vitest'
import { refineBar, refineWindow, REFINE_DEFAULTS } from '../src/engine/refine'

function makeGray(w: number, h: number, fill = 255): Uint8Array {
  return new Uint8Array(w * h).fill(fill)
}

describe('refineBar：±5px 平均剖面 + 首个跳变区段取最大', () => {
  it('默认向下：点在柱顶上方 → 吸附到柱顶边缘（像素 119/120 之间 = 120.0）', () => {
    const W = 100
    const H = 200
    const gray = makeGray(W, H)
    // 柱子：y=120..199, x=40..60 黑色实心
    for (let y = 120; y < 200; y++) for (let x = 40; x <= 60; x++) gray[y * W + x] = 0
    for (const y0 of [100, 100.4, 100.9, 117.2]) {
      const out = refineBar({ x: 50, y: y0 }, gray, W, H) // 与起点小数部分无关
      expect(out).toEqual({ x: 50, y: 120, snapped: true })
    }
  })

  it('方向向上：点在柱底下方 → 吸附到柱底边缘（像素 120/121 之间 = 121.0）', () => {
    const W = 100
    const H = 200
    const gray = makeGray(W, H)
    for (let y = 50; y <= 120; y++) for (let x = 40; x <= 60; x++) gray[y * W + x] = 0
    const out = refineBar({ x: 50, y: 140 }, gray, W, H, 'up')
    expect(out.y).toBe(121)
  })

  it('点击靠近柱边：平均剖面仍有足够跳变', () => {
    const W = 100
    const H = 200
    const gray = makeGray(W, H)
    for (let y = 120; y < 200; y++) for (let x = 40; x <= 60; x++) gray[y * W + x] = 0
    const out = refineBar({ x: 43, y: 100 }, gray, W, H)
    expect(out.y).toBe(120)
  })

  it('软边（每像素 Δ=8，低于单像素旧阈值 40）：取跳变区段内梯度最大处', () => {
    const W = 100
    const H = 200
    const gray = makeGray(W, H)
    // 柱顶 6 像素渐变，最陡处在 y=116/117 之间
    const ramp = [240, 225, 180, 120, 90, 80]
    for (let y = 114; y < 200; y++) {
      const v = y - 114 < ramp.length ? ramp[y - 114] : 80
      for (let x = 30; x <= 70; x++) gray[y * W + x] = v
    }
    const out = refineBar({ x: 50, y: 90 }, gray, W, H)
    expect(out.snapped).toBe(true)
    expect(out.y).toBe(117)
  })

  it('扫描范围内无跳变 → 原样返回，snapped=false；范围参数生效', () => {
    const W = 100
    const H = 200
    const gray = makeGray(W, H)
    expect(refineBar({ x: 50, y: 50 }, gray, W, H)).toEqual({ x: 50, y: 50, snapped: false })
    for (let y = 120; y < 200; y++) for (let x = 40; x <= 60; x++) gray[y * W + x] = 0
    expect(refineBar({ x: 50, y: 60 }, gray, W, H, 'down', 40).snapped).toBe(false)
    expect(refineBar({ x: 50, y: 60 }, gray, W, H, 'down', 80).y).toBe(120)
  })

  it('平均剖面半宽符合 §4.4（±5px）', () => {
    expect(REFINE_DEFAULTS.barHalfWidth).toBe(5)
  })
})

describe('refineWindow：可视化范围与实际作用范围一致', () => {
  it('scatter：以点击像素为中心的 (2r+1)² 搜索框（与 refineScatter 的搜索框同一公式）', () => {
    for (const r of [3, 8, 15]) {
      const win = refineWindow({ x: 100.7, y: 100.2 }, { mode: 'scatter', radius: r })
      expect(win).toEqual({ x: 100 - r, y: 100 - r, w: 2 * r + 1, h: 2 * r + 1 })
    }
  })

  it.each(['down', 'up', 'left', 'right'] as const)('bar %s：条带 = 扫描方向 span × 垂直 ±barHalfWidth', (dir) => {
    const hw = REFINE_DEFAULTS.barHalfWidth
    const win = refineWindow({ x: 100.5, y: 100.5 }, { mode: 'bar', direction: dir, span: 30 })
    const vertical = dir === 'down' || dir === 'up'
    expect(vertical ? win.w : win.h).toBe(2 * hw + 1)
    expect(vertical ? win.h : win.w).toBe(31)
    // 窗口必须从点击像素起、朝扫描方向延伸
    expect(win.x <= 100 && 100 < win.x + win.w && win.y <= 100 && 100 < win.y + win.h).toBe(true)
    const far = { down: [100, 130], up: [100, 70], right: [130, 100], left: [70, 100] }[dir]
    expect(far[0] >= win.x && far[0] < win.x + win.w && far[1] >= win.y && far[1] < win.y + win.h).toBe(true)
  })
})
