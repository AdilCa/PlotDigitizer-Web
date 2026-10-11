// tickTool.ts — 标刻度工具（markTickX / markTickY，§4.3 两点制）
// 裸左键：命中既有刻度 → 选中并拖动；空白 → 新增刻度（恰好 2 个上限由命令层拒绝，
// 无静默替换）并立即进入拖动。拖动时刻 at 跟随指针，pos = 沿轴分量，
// pos 偏离 fittedPos 自动回到「待拟合」（§6.2，无需额外状态位）。
import type { AxisId, PixelPoint } from '../state/model'
import { useStore } from '../state/store'
import { addTick, moveTickPoint, selectTick } from '../state/commands'
import { screenLengthToImage } from '../render/viewport'
import { hitTick } from './hitTest'

let draggingTickId: string | null = null

export function dragStart(axis: AxisId, img: PixelPoint): void {
  const s = useStore.getState()
  const cal = s.model.calibration[axis]
  const tol = screenLengthToImage(s.ui.viewport, 8) // 屏幕恒定 8px 命中半径
  const hit = hitTick(cal, axis, img, tol)
  if (hit) {
    draggingTickId = hit.id
    selectTick(hit.id)
    return
  }
  // 空白处新增（满 2 个时 addTick 拒绝并置状态栏提示，返回 null）
  draggingTickId = addTick(axis, img)
}

export function dragMove(axis: AxisId, img: PixelPoint): void {
  if (draggingTickId) moveTickPoint(axis, draggingTickId, img)
}

export function dragEnd(): void {
  draggingTickId = null
}
