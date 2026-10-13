// cropTool.ts — 裁剪工具（§5.3 / §6.6：类微信截图交互）
// 拖动创建选框、八向手柄调整范围、Enter / 确认按钮执行；放弃选框（Esc/取消）无副作用。
// 选框为显示轨矢量叠加层（ui.cropBox），创建与拖动全程零像素运算；
// 确认后主线程只把选框像素矩形发给 Worker，Worker 重建双轨并回传缩略图。
// 已有校准/取点时需二次确认（铁律 3 预告，cropArmed）。
import type { PixelPoint } from '../state/model'
import { useStore, type CropBox } from '../state/store'
import { hasWork } from '../state/selectors'
import {
  clearCrop,
  resetModelKeepingImage,
  setCropArmed,
  setCropBox,
  setCropBusy,
  setStatus,
} from '../state/commands'
import { screenLengthToImage } from '../render/viewport'
import { workerCrop } from '../worker/workerClient'
import { rebindDisplayAfterCrop } from '../io/fileAccess'

// ---------------------------------------------------------------- 纯函数（可单测）

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export type CropZone = { type: 'handle'; handle: HandleId } | { type: 'move' } | { type: 'none' }

/** 选框最小边长（图像像素） */
export const MIN_CROP_SIZE = 4

interface ImageBounds {
  width: number
  height: number
}

/** 由拖动起止点构造规范化选框（允许反向拖动） */
export function normalizeBox(a: PixelPoint, b: PixelPoint): CropBox {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

export function clampBoxToImage(box: CropBox, img: ImageBounds): CropBox {
  const x = Math.max(0, Math.min(box.x, img.width))
  const y = Math.max(0, Math.min(box.y, img.height))
  return {
    x,
    y,
    w: Math.max(0, Math.min(box.w, img.width - x)),
    h: Math.max(0, Math.min(box.h, img.height - y)),
  }
}

/** 八向手柄中心位置（图像坐标） */
export function handleCenter(box: CropBox, handle: HandleId): PixelPoint {
  const { x, y, w, h } = box
  const cx = x + w / 2
  const cy = y + h / 2
  switch (handle) {
    case 'nw': return { x, y }
    case 'n': return { x: cx, y }
    case 'ne': return { x: x + w, y }
    case 'e': return { x: x + w, y: cy }
    case 'se': return { x: x + w, y: y + h }
    case 's': return { x: cx, y: y + h }
    case 'sw': return { x, y: y + h }
    case 'w': return { x, y: cy }
  }
}

const HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** 命中测试：先八向手柄（tol 为图像坐标容差，由屏幕恒定半径换算），再框内移动，否则无 */
export function hitCropZone(box: CropBox, p: PixelPoint, tol: number): CropZone {
  for (const h of HANDLES) {
    const c = handleCenter(box, h)
    if (Math.abs(p.x - c.x) <= tol && Math.abs(p.y - c.y) <= tol) {
      return { type: 'handle', handle: h }
    }
  }
  if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) {
    return { type: 'move' }
  }
  return { type: 'none' }
}

/** 手柄拖动：固定对侧边/角，拖动侧吸附到指针位置（钳制图像范围 + 最小尺寸） */
export function applyHandleDrag(
  orig: CropBox,
  handle: HandleId,
  p: PixelPoint,
  img: ImageBounds,
): CropBox {
  let { x, y, w, h } = orig
  const right = x + w
  const bottom = y + h
  const px = Math.max(0, Math.min(p.x, img.width))
  const py = Math.max(0, Math.min(p.y, img.height))

  if (handle.includes('w')) x = Math.min(px, right - MIN_CROP_SIZE)
  if (handle.includes('e')) w = Math.max(MIN_CROP_SIZE, px - x)
  if (handle.includes('n')) y = Math.min(py, bottom - MIN_CROP_SIZE)
  if (handle.includes('s')) h = Math.max(MIN_CROP_SIZE, py - y)
  if (handle.includes('w')) w = right - x
  if (handle.includes('n')) h = bottom - y

  return clampBoxToImage({ x, y, w, h }, img)
}

/**
 * 选框 → 发给 Worker 的整数像素矩形：外扩到完整像素（floor 起点、ceil 终点）后钳制在图像内，
 * 保证 x+w ≤ width、y+h ≤ height（不会因分别取整多出 1px 透明边）。
 */
export function cropPixelRect(box: CropBox, img: ImageBounds): CropBox {
  const x0 = Math.max(0, Math.floor(box.x))
  const y0 = Math.max(0, Math.floor(box.y))
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w))
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

/** 整体移动：选框保持在图像范围内 */
export function moveBox(orig: CropBox, dx: number, dy: number, img: ImageBounds): CropBox {
  return {
    x: Math.max(0, Math.min(orig.x + dx, img.width - orig.w)),
    y: Math.max(0, Math.min(orig.y + dy, img.height - orig.h)),
    w: orig.w,
    h: orig.h,
  }
}

// ---------------------------------------------------------------- 交互（由 interact/tools.ts 分发）

let dragCtx:
  | { mode: 'create' | 'move' | HandleId; anchor: PixelPoint; orig: CropBox }
  | null = null

export function dragStart(img: PixelPoint): void {
  const s = useStore.getState()
  const image = s.model.image
  if (!image || s.ui.cropBusy) return
  const box = s.ui.cropBox
  if (box) {
    const tol = screenLengthToImage(s.ui.viewport, 8) // 屏幕恒定 8px 命中半径
    const zone = hitCropZone(box, img, tol)
    if (zone.type === 'handle') {
      dragCtx = { mode: zone.handle, anchor: img, orig: box }
      return
    }
    if (zone.type === 'move') {
      dragCtx = { mode: 'move', anchor: img, orig: box }
      return
    }
  }
  dragCtx = { mode: 'create', anchor: img, orig: { x: img.x, y: img.y, w: 0, h: 0 } }
  setCropBox(dragCtx.orig)
}

export function dragMove(img: PixelPoint): void {
  const ctx = dragCtx
  if (!ctx) return
  const image = useStore.getState().model.image
  if (!image) return
  if (ctx.mode === 'create') {
    setCropBox(clampBoxToImage(normalizeBox(ctx.anchor, img), image))
  } else if (ctx.mode === 'move') {
    setCropBox(moveBox(ctx.orig, img.x - ctx.anchor.x, img.y - ctx.anchor.y, image))
  } else {
    setCropBox(applyHandleDrag(ctx.orig, ctx.mode, img, image))
  }
}

export function dragEnd(): void {
  dragCtx = null
  const box = useStore.getState().ui.cropBox
  // 误触（单击未拖动）产生的微小选框直接丢弃
  if (box && (box.w < MIN_CROP_SIZE || box.h < MIN_CROP_SIZE)) setCropBox(null)
}

// ---------------------------------------------------------------- 执行（§5.3 安全路径）

/**
 * 确认执行裁剪。已有校准/取点数据时首次仅预告（铁律 3），二次确认才执行。
 * 执行后不可回退（v1.3 无撤销）；执行 = 新数据提取任务开始（§6.6）。
 */
export async function executeCrop(): Promise<void> {
  const s = useStore.getState()
  const box = s.ui.cropBox
  const image = s.model.image
  if (!box || !image || s.ui.cropBusy || s.ui.activeTool !== 'imageEdit') return
  if (hasWork(s.model) && !s.ui.cropArmed) {
    setCropArmed(true)
    setStatus('⚠ 裁剪将清除当前校准与已取点（像素坐标系变更），再次确认以执行')
    return
  }
  const rect = cropPixelRect(box, image)
  if (rect.w < MIN_CROP_SIZE || rect.h < MIN_CROP_SIZE) return
  setCropBusy(true)
  setStatus('正在裁剪…')
  try {
    const r = await workerCrop(rect, { width: image.width, height: image.height })
    rebindDisplayAfterCrop(r)
    resetModelKeepingImage({ width: r.width, height: r.height }) // 与换图同一路径全量重置（§6.6）
    clearCrop()
    setStatus('裁剪完成，已开启新数据提取任务')
  } catch (err) {
    setStatus(`裁剪失败：${err instanceof Error ? err.message : String(err)}`) // 内联反馈，铁律 5
  } finally {
    setCropBusy(false)
  }
}

export function cancelCrop(): void {
  if (useStore.getState().ui.cropBusy) return
  clearCrop()
  setStatus(null)
}

/** imageEdit 工具下的键盘处理；返回 true 表示已消费 */
export function handleCropKey(e: KeyboardEvent): boolean {
  const s = useStore.getState()
  if (s.ui.activeTool !== 'imageEdit' || !s.ui.cropBox) return false
  if (e.key === 'Enter') {
    if (!e.repeat) void executeCrop()
    return true
  }
  if (e.key === 'Escape') {
    cancelCrop()
    return true
  }
  return false
}
