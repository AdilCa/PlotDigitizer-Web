// M1-2 验收单测：坐标换算往返、缩放锚点不变性、平移、fitToContainer、手势分类
import { describe, expect, it } from 'vitest'
import {
  clampScale,
  fitToContainer,
  identityViewport,
  imageToScreen,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  screenLengthToImage,
  screenToImage,
  wheelZoomFactor,
  zoomAt,
} from '../src/render/viewport'
import { classifyDragStart } from '../src/interact/viewportControls'

describe('坐标换算（唯一换算入口）', () => {
  it('imageToScreen / screenToImage 往返一致', () => {
    const vp = { scale: 2.5, offsetX: 137, offsetY: -42 }
    const img = { x: 333.25, y: 771.5 }
    const round = screenToImage(vp, imageToScreen(vp, img))
    expect(round.x).toBeCloseTo(img.x, 10)
    expect(round.y).toBeCloseTo(img.y, 10)
  })

  it('screenLengthToImage = 屏幕长度 / scale（屏幕空间恒定尺寸换算，§5.2）', () => {
    const vp = { scale: 4, offsetX: 0, offsetY: 0 }
    expect(screenLengthToImage(vp, 8)).toBe(2)
  })
})

describe('缩放（滚轮锚定光标）', () => {
  it('zoomAt 保持 pivot 下图像点不动', () => {
    const vp = { scale: 1.5, offsetX: 100, offsetY: 60 }
    const pivot = { x: 400, y: 300 }
    const imgAtPivot = screenToImage(vp, pivot)

    const zoomed = zoomAt(vp, pivot, 1.3)
    const pivotAfter = imageToScreen(zoomed, imgAtPivot)
    expect(pivotAfter.x).toBeCloseTo(pivot.x, 8)
    expect(pivotAfter.y).toBeCloseTo(pivot.y, 8)
    expect(zoomed.scale).toBeCloseTo(1.5 * 1.3)
  })

  it('缩放钳制在 [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(1e-4)).toBe(MIN_SCALE)
    expect(clampScale(1e4)).toBe(MAX_SCALE)
    const tiny = zoomAt({ scale: MIN_SCALE, offsetX: 0, offsetY: 0 }, { x: 0, y: 0 }, 0.1)
    expect(tiny.scale).toBe(MIN_SCALE)
  })

  it('wheelZoomFactor：上滚放大、下滚缩小', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
  })
})

describe('平移', () => {
  it('panBy 按屏幕像素增量移动 offset', () => {
    const vp = identityViewport()
    const moved = panBy(vp, 30, -20)
    expect(moved).toMatchObject({ scale: 1, offsetX: 30, offsetY: -20 })
    // 同一图像点平移后屏幕位置同步移动
    const p = { x: 50, y: 50 }
    expect(imageToScreen(moved, p)).toEqual({ x: 80, y: 30 })
  })
})

describe('fitToContainer（初次加载自适应）', () => {
  it('等比缩放并居中，留白 padding', () => {
    const vp = fitToContainer({ width: 4000, height: 3000 }, { width: 1000, height: 800 }, 20)
    expect(vp.scale).toBeCloseTo(960 / 4000)
    // 水平方向贴边（padding），垂直方向居中
    expect(vp.offsetX).toBeCloseTo(20)
    expect(vp.offsetY).toBeCloseTo((800 - 3000 * vp.scale) / 2)
  })

  it('容器比图像小时缩小，比图像大时也按可用空间等比', () => {
    const vp = fitToContainer({ width: 100, height: 100 }, { width: 1000, height: 500 }, 0)
    expect(vp.scale).toBeCloseTo(5)
    expect(vp.offsetX).toBeCloseTo(250)
    expect(vp.offsetY).toBeCloseTo(0)
  })
})

describe('手势分类（§6.1 冲突规则）', () => {
  it('中键 → 平移（无需修饰键）', () => {
    expect(classifyDragStart({ button: 1, spaceHeld: false })).toBe('pan')
  })

  it('空格 + 左键 → 平移；裸左键 → 当前工具', () => {
    expect(classifyDragStart({ button: 0, spaceHeld: true })).toBe('pan')
    expect(classifyDragStart({ button: 0, spaceHeld: false })).toBe('tool')
  })

  it('右键等其他按键忽略', () => {
    expect(classifyDragStart({ button: 2, spaceHeld: false })).toBeNull()
    expect(classifyDragStart({ button: 2, spaceHeld: true })).toBeNull()
  })
})
