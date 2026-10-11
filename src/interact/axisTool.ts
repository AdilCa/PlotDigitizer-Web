// axisTool.ts — 画轴工具（drawXAxis / drawYAxis，§4.2）
// 裸左键拖出一条近似线段 → 松开即把线段发给 Worker 拟合（§3 决策 4），
// 成功：setAxisLine（重画自动级联删除刻度）+ 诊断叠加清除；
// 失败：诊断叠加（扫描带 + 采样点）+ 状态栏内联错误（铁律 5），轴线保持不变。
// 替换预告（铁律 3）：该轴已有轴线时，拖动全程轴线以 warning 色高亮 + 状态栏预告，
// 松开即执行，不做二次确认（预告方案，区别于裁剪的二次确认）。
import type { AxisId, PixelPoint } from '../state/model'
import { useStore } from '../state/store'
import { setAxisLine, setDebugOverlay, setDraftLine, setStatus } from '../state/commands'
import { workerFitAxis, WorkerRequestError } from '../worker/workerClient'
import type { AxisFitDiagnostics } from '../engine/axisFitter'

/** 手绘线段最小长度（图像像素），更短视为误触直接取消 */
export const MIN_AXIS_DRAG = 20

let dragStart_: PixelPoint | null = null

export function dragStart(axis: AxisId, img: PixelPoint): void {
  dragStart_ = img
  const cal = useStore.getState().model.calibration[axis]
  const label = axis === 'x' ? 'X' : 'Y'
  if (cal.axisLine !== null) {
    setStatus(`松开将替换现有 ${label} 轴线及其刻度（已取点保留并自动重算）`) // 铁律 3 预告
  }
  setDraftLine({ a: img, b: img })
}

export function dragMove(img: PixelPoint): void {
  if (!dragStart_) return
  setDraftLine({ a: dragStart_, b: img })
}

export async function dragEnd(axis: AxisId, img: PixelPoint): Promise<void> {
  const a = dragStart_
  dragStart_ = null
  setDraftLine(null)
  if (!a) return
  const label = axis === 'x' ? 'X' : 'Y'
  if (Math.hypot(img.x - a.x, img.y - a.y) < MIN_AXIS_DRAG) {
    setStatus(null) // 误触：取消，无副作用
    return
  }
  setStatus(`正在拟合 ${label} 轴线…`)
  try {
    const r = await workerFitAxis(axis, a, img)
    setAxisLine(axis, r.position)
    setDebugOverlay(null)
    setStatus(
      `${label} 轴线已拟合（位置 ${Math.round(r.position)}px）。接下来：标出 2 个 ${label} 轴刻度`,
    )
  } catch (err) {
    const diag =
      err instanceof WorkerRequestError ? (err.diagnostics as AxisFitDiagnostics | undefined) : undefined
    if (diag) {
      setDebugOverlay({ scanBands: [diag.scanBand], samplePoints: diag.samplePoints })
    }
    setStatus(err instanceof Error ? err.message : String(err)) // 内联错误，轴线不变（铁律 5）
  }
}
