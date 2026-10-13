// markerTool.ts — marker 取点工具（extractMarker，§6.3：唯一取点交互方式）
// 空白处按下 = 放置标记（实心 ink），拖动微调；批量模式下追加，否则替换为单个标记。
// Confirm（Enter / 面板按钮）一次提交全部标记并自动进入下一个。
// 曲线序列：空白处按住拖动 = 沿曲线涂抹一笔（§4.6）；在笔迹末端附近按下接着涂，别处按下重新开始。
// 未确认标记：按下拖动即移动；已有点：按下 = 选中（焦点环），按住拖动超过阈值后跟随指针移动。
// Delete / Esc / 方向键等键盘部分在 App.tsx。
import type { PixelPoint } from '../state/model'
import { useStore } from '../state/store'
import {
  addPendingMarker,
  beginCurveStroke,
  extendCurveStroke,
  movePendingMarker,
  movePointTo,
  selectPoint,
  selectTick,
  setPendingMarker,
} from '../state/commands'
import { screenLengthToImage } from '../render/viewport'
import { hitPoint } from './hitTest'

/** 已有点开始移动前的拖动阈值（屏幕像素），防止单击选中时的手抖改动坐标 */
export const POINT_DRAG_THRESHOLD = 3

/** 命中半径（屏幕像素，M3-3） */
const HIT_RADIUS = 8

/** 涂抹笔迹的取点间隔（屏幕像素）：更密只是多存点，曲线提取本身按弧长重采样 */
const STROKE_SPACING = 2

let press:
  | { kind: 'point'; id: string; start: PixelPoint; offset: PixelPoint; threshold: number; moved: boolean }
  | { kind: 'pending'; index: number; offset: PixelPoint }
  | { kind: 'stroke'; spacing: number }
  | null = null

/** 最上层（最后放下）的未确认标记优先 */
function hitPending(pts: PixelPoint[], img: PixelPoint, radius: number): number {
  for (let i = pts.length - 1; i >= 0; i--) {
    if (Math.hypot(pts[i].x - img.x, pts[i].y - img.y) <= radius) return i
  }
  return -1
}

export function dragStart(img: PixelPoint): void {
  const s = useStore.getState()
  const vp = s.ui.viewport
  const radius = screenLengthToImage(vp, HIT_RADIUS)

  const pi = hitPending(s.ui.pendingMarkers, img, radius)
  if (pi >= 0) {
    const p = s.ui.pendingMarkers[pi]
    press = { kind: 'pending', index: pi, offset: { x: p.x - img.x, y: p.y - img.y } }
    return
  }

  const hit = hitPoint(s.model, img, radius)
  if (hit) {
    selectPoint(hit.point.id)
    press = {
      kind: 'point',
      id: hit.point.id,
      start: img,
      offset: { x: hit.point.pixel.x - img.x, y: hit.point.pixel.y - img.y },
      threshold: screenLengthToImage(vp, POINT_DRAG_THRESHOLD),
      moved: false,
    }
    return
  }

  // 空白：放置标记 / 曲线序列开始涂抹；同时取消点/刻度选中
  selectPoint(null)
  selectTick(null)
  const series = s.model.series.find((x) => x.id === s.model.activeSeriesId)
  if (series?.chartType === 'curve') {
    // 在未确认笔迹末端一个笔刷半径内按下 = 接着涂；否则重新开始一笔
    const last = s.ui.curveStroke.at(-1)
    if (!last || Math.hypot(last.x - img.x, last.y - img.y) > series.curveRadius) beginCurveStroke(img)
    else extendCurveStroke(img)
    press = { kind: 'stroke', spacing: screenLengthToImage(vp, STROKE_SPACING) }
    return
  }
  let index = 0
  if (s.ui.batchPick) {
    index = addPendingMarker(img)
  } else {
    setPendingMarker(img)
  }
  press = { kind: 'pending', index, offset: { x: 0, y: 0 } }
}

export function dragMove(img: PixelPoint): void {
  if (!press) return
  if (press.kind === 'stroke') {
    const last = useStore.getState().ui.curveStroke.at(-1)
    if (!last || Math.hypot(last.x - img.x, last.y - img.y) >= press.spacing) extendCurveStroke(img)
    return
  }
  if (press.kind === 'pending') {
    movePendingMarker(press.index, { x: img.x + press.offset.x, y: img.y + press.offset.y })
    return
  }
  if (!press.moved && Math.hypot(img.x - press.start.x, img.y - press.start.y) < press.threshold) return
  press.moved = true
  movePointTo(press.id, { x: img.x + press.offset.x, y: img.y + press.offset.y })
}

export function dragEnd(): void {
  press = null
}
