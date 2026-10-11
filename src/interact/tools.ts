// tools.ts — 工具状态机（§3：三族六种互斥工具，切换只是 store.activeTool 变更）
// 裸拖动永远归当前工具（§6.1）；这里按 activeTool 把拖动分发给对应工具模块。
// M1-8：imageEdit（裁剪）；M2：画轴/标刻度；M3：marker 取点。
import { useStore } from '../state/store'
import { screenToImage } from '../render/viewport'
import { setHoverImage } from '../state/commands'
import type { ToolDragHandlers } from './viewportControls'
import * as crop from './cropTool'
import * as axisTool from './axisTool'
import * as tickTool from './tickTool'
import * as marker from './markerTool'

export const toolDragHandlers: ToolDragHandlers = {
  onToolDragStart(screenPos) {
    const s = useStore.getState()
    const img = screenToImage(s.ui.viewport, screenPos)
    switch (s.ui.activeTool) {
      case 'imageEdit':
        crop.dragStart(img)
        break
      case 'drawXAxis':
        axisTool.dragStart('x', img)
        break
      case 'drawYAxis':
        axisTool.dragStart('y', img)
        break
      case 'markTickX':
        tickTool.dragStart('x', img)
        break
      case 'markTickY':
        tickTool.dragStart('y', img)
        break
      case 'extractMarker':
        marker.dragStart(img)
        break
    }
  },
  onToolDragMove(screenPos) {
    const s = useStore.getState()
    const img = screenToImage(s.ui.viewport, screenPos)
    switch (s.ui.activeTool) {
      case 'imageEdit':
        crop.dragMove(img)
        break
      case 'drawXAxis':
      case 'drawYAxis':
        axisTool.dragMove(img)
        break
      case 'markTickX':
        tickTool.dragMove('x', img)
        break
      case 'markTickY':
        tickTool.dragMove('y', img)
        break
      case 'extractMarker':
        marker.dragMove(img)
        break
    }
  },
  onToolDragEnd(screenPos) {
    const s = useStore.getState()
    const img = screenPos ? screenToImage(s.ui.viewport, screenPos) : null
    switch (s.ui.activeTool) {
      case 'imageEdit':
        crop.dragEnd()
        break
      case 'drawXAxis':
        if (img) void axisTool.dragEnd('x', img)
        break
      case 'drawYAxis':
        if (img) void axisTool.dragEnd('y', img)
        break
      case 'markTickX':
      case 'markTickY':
        tickTool.dragEnd()
        break
      case 'extractMarker':
        marker.dragEnd()
        break
    }
  },
  onHover(screenPos) {
    const s = useStore.getState()
    const img = screenToImage(s.ui.viewport, screenPos)
    setHoverImage(img) // hover 读数数据源（M3-5）
    if (s.ui.activeTool === 'extractMarker') marker.hoverMove(img) // 抓起态跟随
  },
  onHoverEnd() {
    setHoverImage(null)
  },
  onToolDoubleClick(screenPos) {
    const s = useStore.getState()
    if (s.ui.activeTool === 'extractMarker') {
      marker.dblClick(screenToImage(s.ui.viewport, screenPos))
    }
  },
}
