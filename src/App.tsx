import { useEffect, useRef } from 'react'
import { useStore } from './state/store'
import {
  clearCurveStroke,
  confirmMarkerRefined,
  deleteAxisLine,
  deletePoint,
  deleteTick,
  movePointBy,
  popPendingMarker,
  selectAxis,
  selectPoint,
  selectTick,
  setActiveTool,
  setPendingMarker,
  setStatus,
} from './state/commands'
import { gateFor, hasWork, nextActionHint, axisValueAt, type GateOp } from './state/selectors'
import type { ToolId } from './state/model'
import CanvasView from './ui/CanvasView'
import Inspector from './ui/Inspector'
import { PdfDialog } from './ui/PdfDialog'
import { installDropZone, openFilePicker, confirmPendingImport, cancelPendingImport } from './io/fileAccess'
import { cancelCrop, executeCrop, handleCropKey } from './interact/cropTool'

const TOOLS: { id: ToolId; gate: GateOp; label: string }[] = [
  { id: 'drawXAxis', gate: 'drawXAxis', label: '画 X 轴' },
  { id: 'drawYAxis', gate: 'drawYAxis', label: '画 Y 轴' },
  { id: 'markTickX', gate: 'markTickX', label: '标 X 刻度' },
  { id: 'markTickY', gate: 'markTickY', label: '标 Y 刻度' },
  { id: 'extractMarker', gate: 'extractMarker', label: '取点' },
  { id: 'imageEdit', gate: 'imageEdit', label: '编辑图像' },
]

/** 工具按钮：门控置灰 + tooltip 原因（铁律 5，§6.1）。M5-2 将按 ui-style 规格重做视觉。 */
function ToolButton({ id, gate, label }: { id: ToolId; gate: GateOp; label: string }) {
  const enabled = useStore((s) => gateFor(s, gate).enabled)
  const reason = useStore((s) => {
    const g = gateFor(s, gate)
    return g.enabled ? null : g.reason
  })
  const active = useStore((s) => s.ui.activeTool === id)
  const cropBusy = useStore((s) => s.ui.cropBusy)
  return (
    <button
      className={`tool-btn${active ? ' active' : ''}`}
      disabled={!enabled || cropBusy}
      title={cropBusy ? '正在裁剪…' : (reason ?? label)}
      onClick={() => setActiveTool(id)}
    >
      {label}
    </button>
  )
}

/** 裁剪确认条（情境浮层）：已有校准时二次确认预告（铁律 3，§6.6） */
function CropBar() {
  const visible = useStore((s) => s.ui.activeTool === 'imageEdit' && s.ui.cropBox !== null)
  const armed = useStore((s) => s.ui.cropArmed)
  const busy = useStore((s) => s.ui.cropBusy)
  const work = useStore((s) => hasWork(s.model))
  if (!visible) return null
  return (
    <div className="crop-bar">
      {work && !armed && <span className="crop-warning">⚠ 裁剪将清除当前校准与已取点</span>}
      <button
        className={work && !armed ? 'btn-warning' : 'btn-primary'}
        disabled={busy}
        data-testid="crop-confirm"
        onClick={() => void executeCrop()}
      >
        {busy ? '正在裁剪…' : `${work && !armed ? '仍要裁剪' : '确认裁剪'}（Enter）`}
      </button>
      <button className="btn-ghost" disabled={busy} onClick={cancelCrop}>
        取消（Esc）
      </button>
    </div>
  )
}

/** 加载新文件预告条（§6.6、铁律 3）：已有校准时先预告，确认后全量重置 */
function ImportBar() {
  const name = useStore((s) => s.ui.pendingImportName)
  if (!name) return null
  return (
    <div className="crop-bar" data-testid="import-bar">
      <span className="crop-warning">⚠ 加载「{name}」将清除当前校准与已取点</span>
      <button className="btn-warning" data-testid="confirm-import" onClick={confirmPendingImport}>
        仍要加载
      </button>
      <button className="btn-ghost" onClick={cancelPendingImport}>
        取消
      </button>
    </div>
  )
}

/** hover 读数（§6.3/M3-5）：光标处像素 + 已校准轴的数据坐标；校准变更经铁律 2 即时反映 */
function HoverReadout() {
  const hover = useStore((s) => s.ui.hoverImage)
  const calibration = useStore((s) => s.model.calibration)
  if (!hover) return null
  const parts = [`px (${Math.round(hover.x)}, ${Math.round(hover.y)})`]
  const vx = axisValueAt(calibration.x, hover.x)
  const vy = axisValueAt(calibration.y, hover.y)
  if (vx !== null) parts.push(`X: ${formatNum(vx)}`)
  if (vy !== null) parts.push(`Y: ${formatNum(vy)}`)
  return <span className="hover-readout">{parts.join('　')}</span>
}

function formatNum(v: number): string {
  const a = Math.abs(v)
  if (a !== 0 && (a < 0.001 || a >= 1e6)) return v.toExponential(3)
  return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(3)
}

export default function App() {
  const shellRef = useRef<HTMLDivElement>(null)
  const hasImage = useStore((s) => s.model.image !== null)
  const status = useStore((s) => s.ui.statusMessage ?? nextActionHint(s))

  useEffect(() => {
    const el = shellRef.current
    if (!el) return
    return installDropZone(el)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useStore.getState().ui.pdfDialogOpen) return // 选页弹窗独占键盘
      if (handleCropKey(e)) {
        e.preventDefault()
        return
      }
      // 文本输入聚焦时全局快捷键让位文本编辑（§6.3 焦点规则，v1.2）
      const target = e.target as HTMLElement | null
      const textFocused =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (textFocused) return

      const s = useStore.getState()

      // Enter：取点工具下 Confirm 提交（§6.3）；按住不放的自动重复不重复提交
      if (e.key === 'Enter') {
        if (s.ui.activeTool === 'extractMarker' && (s.ui.pendingMarkers.length > 0 || s.ui.curveStroke.length > 1)) {
          if (!e.repeat) void confirmMarkerRefined()
          e.preventDefault()
          return
        }
      }

      // Delete：删除选中的轴线、点或刻度；取点工具下无选中时删最后一个已确认标记（§3 状态表）
      if (e.key === 'Delete') {
        if (s.ui.selectedAxis) {
          deleteAxisLine(s.ui.selectedAxis)
          e.preventDefault()
          return
        }
        if (s.ui.selectedPointId) {
          deletePoint(s.ui.selectedPointId)
          e.preventDefault()
          return
        }
        if (s.ui.selectedTickId) {
          for (const axis of ['x', 'y'] as const) {
            if (s.model.calibration[axis].ticks.some((t) => t.id === s.ui.selectedTickId)) {
              deleteTick(axis, s.ui.selectedTickId)
              e.preventDefault()
              return
            }
          }
        }
        if (s.ui.activeTool === 'extractMarker' && s.ui.pendingMarkers.length > 0) {
          popPendingMarker()
          setStatus(`已撤掉最后一个未确认标记（剩 ${s.ui.pendingMarkers.length - 1} 个）`)
          e.preventDefault()
          return
        }
        if (s.ui.activeTool === 'extractMarker') {
          const active = s.model.series.find((x) => x.id === s.model.activeSeriesId)
          const last = active?.points[active.points.length - 1]
          if (last) {
            deletePoint(last.id)
            setStatus(`已删除最后一个标记 ${last.name}`)
            e.preventDefault()
            return
          }
        }
      }

      // Esc：清除未确认笔迹 / 取消未确认标记；否则取消点/刻度选中（§3；裁剪的 Esc 已在 handleCropKey 消费）
      if (e.key === 'Escape') {
        if (s.ui.curveStroke.length > 0) {
          clearCurveStroke()
          setStatus('已清除未确认的涂抹笔迹')
          e.preventDefault()
          return
        }
        const n = s.ui.pendingMarkers.length
        if (n > 0) {
          setPendingMarker(null)
          setStatus(n === 1 ? '已取消当前标记' : `已取消 ${n} 个未确认标记`)
          e.preventDefault()
          return
        }
        if (s.ui.selectedPointId || s.ui.selectedTickId || s.ui.selectedAxis) {
          selectPoint(null)
          selectTick(null)
          selectAxis(null)
          e.preventDefault()
          return
        }
      }

      // 方向键：选中点按步进移动（默认 1px，Shift ×10，步进面板可调，§6.3）
      const ARROW: Record<string, [number, number]> = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      }
      const dir = ARROW[e.key]
      if (dir && s.ui.selectedPointId) {
        const step = s.ui.nudgeStep * (e.shiftKey ? 10 : 1)
        movePointBy(s.ui.selectedPointId, dir[0] * step, dir[1] * step)
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app-shell" ref={shellRef}>
      <CanvasView />
      <div className="tool-rail">
        {TOOLS.map((t) => (
          <ToolButton key={t.id} {...t} />
        ))}
        <button className="tool-btn" onClick={openFilePicker}>
          打开
        </button>
      </div>
      <Inspector />
      <CropBar />
      <ImportBar />
      <PdfDialog />
      {!hasImage && <div className="empty-hint">拖入图片 / PDF / .pdproj 开始，或点击左侧「打开」</div>}
      <div className="status-bar">
        <span className="status-text">{status}</span>
        <HoverReadout />
      </div>
    </div>
  )
}
