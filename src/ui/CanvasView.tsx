// CanvasView.tsx — 主画布组件
// 订阅 store，任何状态变更经 rAF 合帧重绘（渲染层不持有数据，铁律 1）；
// 平移/缩放仅变换 viewport 矩阵重绘，零像素运算（§5.2）；
// 底图经 imageCache 按当前缩放级取显示轨 bitmap（渐进清晰，§5.2）。
import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { setViewport } from '../state/commands'
import { buildScene, paint } from '../render/canvasRenderer'
import { acquireLevel, onDisplayTrackChange } from '../render/imageCache'
import { fitToContainer, type Viewport } from '../render/viewport'
import { useViewportControls } from '../interact/viewportControls'
import { toolDragHandlers } from '../interact/tools'
import type { ImageRef } from '../state/model'

export default function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useViewportControls(canvasRef, toolDragHandlers)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let lastImage: ImageRef | null = null

    const repaint = () => {
      raf = 0
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      const pw = Math.round(w * dpr)
      const ph = Math.round(h * dpr)
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      const state = useStore.getState()

      // 换图/裁剪后自动适应视口（一次性，避免循环）
      if (state.model.image !== lastImage) {
        lastImage = state.model.image
        if (lastImage) {
          const fitted: Viewport = fitToContainer(lastImage, { width: w, height: h })
          setViewport(fitted)
          return // setViewport 触发订阅，下一帧以新视口重绘
        }
      }

      const vp = state.ui.viewport
      const bitmap = acquireLevel(vp.scale, dpr)
      paint(ctx, buildScene(state, vp), vp, bitmap, dpr, { width: w, height: h })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(repaint)
    }

    const unsub = useStore.subscribe(schedule)
    const unsubDisplay = onDisplayTrackChange(schedule)
    const ro = new ResizeObserver(schedule)
    ro.observe(canvas)
    schedule()
    return () => {
      unsub()
      unsubDisplay()
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return <canvas ref={canvasRef} className="main-canvas" />
}
