// axisTool.ts — 画轴工具（drawXAxis / drawYAxis，§4.2）
// 裸左键拖出一条近似线段 → 松开即把线段发给 Worker 拟合（§3 决策 4），
// 成功：setAxisLine（重画自动级联删除刻度）+ 诊断叠加清除；
// 失败：诊断叠加（扫描带 + 采样点）+ 状态栏内联错误（铁律 5），轴线保持不变。
// 替换预告（铁律 3）：该轴已有轴线时，拖动全程轴线以 warning 色高亮 + 状态栏预告，
// 松开即执行，不做二次确认（预告方案，区别于裁剪的二次确认）。
// 短按（未拖动）现有轴线 = 选中该轴线（Delete 删除，连带清除刻度）；短按别处 = 取消选中。
import type { AxisId, PixelPoint } from '../state/model'
import { useStore } from '../state/store'
import { selectAxis, setAxisLine, setDebugOverlay, setDraftLine, setStatus } from '../state/commands'
import { screenLengthToImage } from '../render/viewport'
import { workerFitAxis, WorkerRequestError } from '../worker/workerClient'
import type { AxisFitDiagnostics } from '../engine/axisFitter'
import { hitAxisLine } from './hitTest'
import { POINT_DRAG_THRESHOLD } from './markerTool'

/** 手绘线段最小长度（图像像素），更短视为误触直接取消 */
export const MIN_AXIS_DRAG = 20

let press: { a: PixelPoint; clickTol: number; hitTol: number; warned: boolean } | null = null

export function dragStart(_axis: AxisId, img: PixelPoint): void {
  const vp = useStore.getState().ui.viewport
  press = {
    a: img,
    clickTol: screenLengthToImage(vp, POINT_DRAG_THRESHOLD),
    hitTol: screenLengthToImage(vp, 8),
    warned: false,
  }
  setDraftLine({ a: img, b: img })
}

export function dragMove(axis: AxisId, img: PixelPoint): void {
  if (!press) return
  setDraftLine({ a: press.a, b: img })
  if (!press.warned && Math.hypot(img.x - press.a.x, img.y - press.a.y) >= press.clickTol) {
    press.warned = true
    if (useStore.getState().model.calibration[axis].axisLine !== null) {
      const label = axis === 'x' ? 'X' : 'Y'
      setStatus(`松开将替换现有 ${label} 轴线及其刻度（已取点保留并自动重算）`) // 铁律 3 预告
    }
  }
}

export async function dragEnd(axis: AxisId, img: PixelPoint): Promise<void> {
  const p = press
  press = null
  setDraftLine(null)
  if (!p) return
  const a = p.a
  const label = axis === 'x' ? 'X' : 'Y'
  const dist = Math.hypot(img.x - a.x, img.y - a.y)
  if (dist < p.clickTol) {
    if (hitAxisLine(useStore.getState().model.calibration[axis], axis, img, p.hitTol)) {
      selectAxis(axis)
      setStatus(`已选中 ${label} 轴线：按 Delete 删除（连带清除该轴刻度与刻度值，已取点保留）`)
    } else {
      selectAxis(null)
      setStatus(null)
    }
    return
  }
  if (dist < MIN_AXIS_DRAG) {
    setStatus(null) // 误触：取消，无副作用
    return
  }
  selectAxis(null)
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
