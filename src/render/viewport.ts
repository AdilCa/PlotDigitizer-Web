// viewport.ts — 缩放/平移变换（§3：渲染层唯一坐标换算入口）
// 纯函数模块，零依赖；任何"屏幕 ↔ 图像"坐标换算都必须经过这里。
//
// 变换语义：screen = image × scale + offset（offset 单位 = 屏幕像素）
// 叠加层图形尺寸屏幕空间恒定（§5.2）：需要图像坐标尺寸时用 screenLengthToImage 换算。

import type { PixelPoint } from '../state/model'

export interface Viewport {
  scale: number
  offsetX: number
  offsetY: number
}

export const MIN_SCALE = 0.02
export const MAX_SCALE = 40

export function identityViewport(): Viewport {
  return { scale: 1, offsetX: 0, offsetY: 0 }
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function imageToScreen(vp: Viewport, p: PixelPoint): PixelPoint {
  return { x: p.x * vp.scale + vp.offsetX, y: p.y * vp.scale + vp.offsetY }
}

export function screenToImage(vp: Viewport, p: PixelPoint): PixelPoint {
  return { x: (p.x - vp.offsetX) / vp.scale, y: (p.y - vp.offsetY) / vp.scale }
}

/** 屏幕长度 → 图像长度（屏幕空间恒定尺寸/命中半径换算回图像坐标，§5.2、hitTest） */
export function screenLengthToImage(vp: Viewport, length: number): number {
  return length / vp.scale
}

/** 平移：dx/dy 为屏幕像素增量；只变矩阵，不做任何像素运算（§5.2） */
export function panBy(vp: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { ...vp, offsetX: vp.offsetX + dxScreen, offsetY: vp.offsetY + dyScreen }
}

/** 缩放：保持 pivot（屏幕坐标）下的图像点不动 */
export function zoomAt(vp: Viewport, pivotScreen: PixelPoint, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor)
  if (scale === vp.scale) return vp
  const img = screenToImage(vp, pivotScreen)
  return {
    scale,
    offsetX: pivotScreen.x - img.x * scale,
    offsetY: pivotScreen.y - img.y * scale,
  }
}

/** 滚轮缩放系数（deltaY 原生值 → 平滑指数因子） */
export function wheelZoomFactor(deltaY: number): number {
  return Math.pow(1.0015, -deltaY)
}

/** 初次加载：等比缩放使图像完整落入容器并居中 */
export function fitToContainer(
  image: { width: number; height: number },
  container: { width: number; height: number },
  padding = 24,
): Viewport {
  const availW = Math.max(1, container.width - padding * 2)
  const availH = Math.max(1, container.height - padding * 2)
  const scale = clampScale(Math.min(availW / image.width, availH / image.height))
  return {
    scale,
    offsetX: (container.width - image.width * scale) / 2,
    offsetY: (container.height - image.height * scale) / 2,
  }
}
