// M1-8 验收单测：裁剪选框纯逻辑（§5.3 类微信截图交互）
import { describe, expect, it } from 'vitest'
import {
  applyHandleDrag,
  clampBoxToImage,
  cropPixelRect,
  handleCenter,
  hitCropZone,
  MIN_CROP_SIZE,
  moveBox,
  normalizeBox,
} from '../src/interact/cropTool'

const IMG = { width: 2000, height: 1500 }
const BOX = { x: 10, y: 10, w: 100, h: 50 }

describe('normalizeBox / clampBoxToImage', () => {
  it('反向拖动规范化', () => {
    expect(normalizeBox({ x: 10, y: 10 }, { x: 5, y: 3 })).toEqual({ x: 5, y: 3, w: 5, h: 7 })
  })

  it('钳制到图像范围', () => {
    expect(clampBoxToImage({ x: -20, y: 5, w: 5000, h: 30 }, IMG)).toEqual({ x: 0, y: 5, w: 2000, h: 30 })
  })
})

describe('cropPixelRect：发给 Worker 的整数矩形', () => {
  it('外扩到完整像素：floor 起点、ceil 终点', () => {
    expect(cropPixelRect({ x: 10.4, y: 20.6, w: 50.2, h: 30.1 }, IMG)).toEqual({ x: 10, y: 20, w: 51, h: 31 })
  })

  it('贴右/下边缘的小数选框不越界（旧实现分别 round 会多出 1px 透明边）', () => {
    const r = cropPixelRect({ x: 1899.5, y: 1399.5, w: 100.5, h: 100.5 }, IMG)
    expect(r.x + r.w).toBe(2000)
    expect(r.y + r.h).toBe(1500)
    expect(r).toEqual({ x: 1899, y: 1399, w: 101, h: 101 })
  })

  it('整数选框原样返回', () => {
    expect(cropPixelRect(BOX, IMG)).toEqual(BOX)
  })
})

describe('hitCropZone（八向手柄 / 移动 / 无）', () => {
  it('角与边中点命中手柄', () => {
    expect(hitCropZone(BOX, { x: 10, y: 10 }, 8)).toEqual({ type: 'handle', handle: 'nw' })
    expect(hitCropZone(BOX, { x: 60, y: 12 }, 8)).toEqual({ type: 'handle', handle: 'n' })
    expect(hitCropZone(BOX, { x: 110, y: 60 }, 8)).toEqual({ type: 'handle', handle: 'se' })
    expect(hitCropZone(BOX, { x: 12, y: 35 }, 8)).toEqual({ type: 'handle', handle: 'w' })
  })

  it('框内非手柄 → 移动；框外 → 无', () => {
    expect(hitCropZone(BOX, { x: 60, y: 35 }, 8)).toEqual({ type: 'move' })
    expect(hitCropZone(BOX, { x: 200, y: 200 }, 8)).toEqual({ type: 'none' })
  })

  it('命中容差随缩放换算（屏幕恒定 8px 的调用方语义）', () => {
    expect(hitCropZone(BOX, { x: 10 + 20, y: 10 }, 8)).toEqual({ type: 'move' }) // 超出 tol 不在手柄上
    expect(hitCropZone(BOX, { x: 50, y: 10 }, 8)).toEqual({ type: 'move' }) // 距 n 手柄 10px > 8
    expect(hitCropZone(BOX, { x: 50, y: 10 }, 32)).toEqual({ type: 'handle', handle: 'n' }) // tol 放大后命中
  })
})

describe('applyHandleDrag（固定对侧、最小尺寸、图像钳制）', () => {
  it('se 角拖动扩展', () => {
    expect(applyHandleDrag(BOX, 'se', { x: 150, y: 120 }, IMG)).toEqual({ x: 10, y: 10, w: 140, h: 110 })
  })

  it('nw 角拖动固定右下角', () => {
    expect(applyHandleDrag(BOX, 'nw', { x: 50, y: 56 }, IMG)).toEqual({ x: 50, y: 56, w: 60, h: 4 })
  })

  it('拖出图像被钳制；反向不超过最小尺寸', () => {
    const clamped = applyHandleDrag(BOX, 'se', { x: 5000, y: 5000 }, IMG)
    expect(clamped).toEqual({ x: 10, y: 10, w: 1990, h: 1490 })
    const minW = applyHandleDrag(BOX, 'e', { x: -100, y: 35 }, IMG)
    expect(minW.w).toBe(MIN_CROP_SIZE)
    expect(minW.x).toBe(10)
  })
})

describe('moveBox', () => {
  it('移动并保持选框在图像内', () => {
    expect(moveBox(BOX, -50, -50, IMG)).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(moveBox(BOX, 5000, 5000, IMG)).toEqual({ x: 1900, y: 1450, w: 100, h: 50 })
  })
})

describe('handleCenter 八向', () => {
  it('八位手柄中心', () => {
    expect(handleCenter(BOX, 'nw')).toEqual({ x: 10, y: 10 })
    expect(handleCenter(BOX, 's')).toEqual({ x: 60, y: 60 })
    expect(handleCenter(BOX, 'e')).toEqual({ x: 110, y: 35 })
  })
})
