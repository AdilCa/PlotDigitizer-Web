// tickTool.ts — 标刻度工具（markTickX / markTickY，§4.3 两点制）
// 裸左键：命中既有刻度（按显示位置）→ 选中，拖动超过阈值后移动；空白 → 新增刻度
// （恰好 2 个上限由命令层拒绝，无静默替换）并立即进入拖动。
// 移动后 pos 偏离 fittedPos，自动回到「待拟合」（§6.2，无需额外状态位）：
//   未拟合刻度画在点击处，自由拖动（保持按下时的相对偏移）；
//   已拟合刻度画在轴线上，只沿轴移动，at 保留原来的垂直分量——拟合仍从刻度线本身那一行开始，不会落到轴线上。
import type { AxisId, PixelPoint } from '../state/model'
import { useStore } from '../state/store'
import { addTick, moveTickPoint, selectTick } from '../state/commands'
import { tickAnchor, tickFitted } from '../state/selectors'
import { screenLengthToImage } from '../render/viewport'
import { hitTick } from './hitTest'
import { POINT_DRAG_THRESHOLD } from './markerTool'

let drag: {
  id: string
  start: PixelPoint
  offset: PixelPoint
  /** 已拟合刻度：只沿轴移动，垂直分量固定为原 at */
  alongOnly: boolean
  perp: number
  threshold: number
  moved: boolean
} | null = null

export function dragStart(axis: AxisId, img: PixelPoint): void {
  const s = useStore.getState()
  const cal = s.model.calibration[axis]
  const vp = s.ui.viewport
  const hit = hitTick(cal, axis, img, screenLengthToImage(vp, 8)) // 屏幕恒定 8px 命中半径
  if (hit) {
    selectTick(hit.id)
    const anchor = tickAnchor(cal, axis, hit)
    drag = {
      id: hit.id,
      start: img,
      offset: { x: anchor.x - img.x, y: anchor.y - img.y },
      alongOnly: tickFitted(hit),
      perp: axis === 'x' ? hit.at.y : hit.at.x,
      threshold: screenLengthToImage(vp, POINT_DRAG_THRESHOLD),
      moved: false,
    }
    return
  }
  // 空白处新增（满 2 个时 addTick 拒绝并置状态栏提示，返回 null）
  const id = addTick(axis, img)
  drag = id ? { id, start: img, offset: { x: 0, y: 0 }, alongOnly: false, perp: 0, threshold: 0, moved: true } : null
}

export function dragMove(axis: AxisId, img: PixelPoint): void {
  if (!drag) return
  if (!drag.moved && Math.hypot(img.x - drag.start.x, img.y - drag.start.y) < drag.threshold) return
  drag.moved = true
  const p = { x: img.x + drag.offset.x, y: img.y + drag.offset.y }
  if (drag.alongOnly) {
    if (axis === 'x') p.y = drag.perp
    else p.x = drag.perp
  }
  moveTickPoint(axis, drag.id, p)
}

export function dragEnd(): void {
  drag = null
}
