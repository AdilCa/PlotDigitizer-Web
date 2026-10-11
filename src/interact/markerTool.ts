// markerTool.ts — marker 取点工具（extractMarker，§6.3：唯一取点交互方式）
// 空白处按下 = 放置当前标记（实心 ink），拖动微调；Confirm（Enter / 面板按钮）提交并自动进入下一个。
// 已有点：单击 = 选中（焦点环）；双击 = 抓起跟随鼠标，单击或 Enter 放下（杜绝双击产生重复点）；
// Delete = 删除选中点；方向键按步进移动（步进面板可调，Shift ×10）——键盘部分在 App.tsx。
// 抓起状态（grabbedId）不持久化；切换工具/换图时放下。
import type { PixelPoint } from '../state/model'
import { useStore } from '../state/store'
import {
  movePointTo,
  selectPoint,
  selectTick,
  setPendingMarker,
  setStatus,
} from '../state/commands'
import { screenLengthToImage } from '../render/viewport'
import { hitPoint } from './hitTest'

let grabbedId: string | null = null
let draggingPending = false

/** 是否有点正处于抓起状态（App 键盘分发需要） */
export function isGrabbing(): boolean {
  return grabbedId !== null
}

/** 放下抓起的点（Enter / 再次单击 / 切换工具时由 setActiveTool 间接触发） */
export function dropGrabbed(at?: PixelPoint): void {
  if (!grabbedId) return
  if (at) movePointTo(grabbedId, at)
  grabbedId = null
  setStatus(null)
}

export function dragStart(img: PixelPoint): void {
  const s = useStore.getState()

  // 抓起中再次单击 = 放下（消费这次点击，不产生新标记/选中变化）
  if (grabbedId) {
    dropGrabbed(img)
    return
  }

  const tol = screenLengthToImage(s.ui.viewport, 8) // 屏幕恒定 8px 命中半径（M3-3）
  const hit = hitPoint(s.model, img, tol)
  if (hit) {
    selectPoint(hit.point.id) // 单击 = 选中（焦点环高亮）
    return
  }

  // 空白：放置/拖动当前标记；点击空白同时取消点/刻度选中
  selectPoint(null)
  selectTick(null)
  draggingPending = true
  setPendingMarker(img)
}

/** 双击已有点 = 抓起跟随鼠标（§6.3；pointerdown.detail 恒为 0，只能走 dblclick 事件） */
export function dblClick(img: PixelPoint): void {
  if (grabbedId) {
    dropGrabbed(img)
    return
  }
  const s = useStore.getState()
  const tol = screenLengthToImage(s.ui.viewport, 8)
  const hit = hitPoint(s.model, img, tol)
  if (hit) {
    selectPoint(hit.point.id)
    grabbedId = hit.point.id
    setStatus('已抓起该点：移动鼠标调整位置，单击或 Enter 放下')
  }
}

export function dragMove(img: PixelPoint): void {
  if (grabbedId) {
    movePointTo(grabbedId, img) // 全程触发铁律 2 级联重算，hover 读数即时更新
    return
  }
  if (draggingPending) setPendingMarker(img)
}

export function dragEnd(): void {
  draggingPending = false
  // grabbedId 保持：抓起态跨拖动存续，直到单击或 Enter 放下
}

/** 悬停跟随：抓起态下无拖动也要让点跟随鼠标（双击后未按下的移动） */
export function hoverMove(img: PixelPoint): void {
  if (grabbedId) movePointTo(grabbedId, img)
}

// 切换工具/换图时放下抓起的点（抓起态是取点工具的局部瞬态）
useStore.subscribe((s, prev) => {
  if (grabbedId && (s.ui.activeTool !== prev.ui.activeTool || s.model.image !== prev.model.image)) {
    dropGrabbed()
  }
})
