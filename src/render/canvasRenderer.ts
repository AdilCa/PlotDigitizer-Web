// canvasRenderer.ts — 分层绘制（§3）
// 铁律 1：渲染层是纯函数 render(state) → canvas，自身不持有任何业务数据。
// 分两步：
//   buildScene(state, viewport) → Scene   纯函数，可单测
//   paint(ctx, scene, ...)                唯一副作用出口，仅执行绘制
// 图层顺序：底图 → 调试扫描带 → 校准（轴线/刻度）→ 数据点 → 吸附轮廓 → 吸附范围 → 当前 marker → 调试点线。
// 叠加层图形尺寸屏幕空间恒定（§5.2）：buildScene 内以 1/scale 把屏幕像素换算回图像空间，
// 因此缩放时点标记半径、线宽的屏幕像素尺寸不变。
// 视觉规范：doc/ui-style-draft.md §3.2/§3.3（单色仪器风 + 画布语义色 + 序列色盘）。

import type { AxisCalibration, AxisId } from '../state/model'
import type { AppState, DebugOverlay } from '../state/store'
import { tickAnchor, tickFitted } from '../state/selectors'
import { refineWindow } from '../engine/refine'
import type { Viewport } from './viewport'

// ---------------------------------------------------------------- 设计 token（ui-style-draft §3）

export const CANVAS_COLORS = {
  ink: '#1F1F1E',
  success: '#2F9E44',
  warning: '#E8890C',
  danger: '#D64545',
  workbench: '#E9E9E6',
  white: '#FFFFFF',
} as const

/** 序列色盘（多序列区分为功能性用色，§3.3） */
export const SERIES_COLORS = [
  '#4F46E5',
  '#2F9E44',
  '#E8890C',
  '#D64545',
  '#0CA678',
  '#1971C2',
  '#AE3EC9',
  '#66A80F',
] as const

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]
}

/** 屏幕空间恒定尺寸（px，§5.2） */
export const SCREEN_SIZE = {
  axisWidth: 2,
  selectedAxisWidth: 10,
  tickRadius: 5,
  markerRadius: 4,
  focusRingGap: 2,
  focusRingWidth: 2,
  sampleRadius: 3,
  candidateWidth: 2,
  markerCrossWidth: 1.5,
} as const

// ---------------------------------------------------------------- 图元（图像坐标 + 已换算的图像空间尺寸）

export type Primitive =
  | {
      kind: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      color: string
      width: number
      dash?: number[]
      alpha: number
    }
  | {
      kind: 'circle'
      x: number
      y: number
      r: number
      fill: string | null
      stroke: string | null
      strokeWidth: number
      alpha: number
    }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string | null; stroke: string | null; strokeWidth: number; alpha: number }
  | { kind: 'polygon'; points: { x: number; y: number }[]; stroke: string; strokeWidth: number; alpha: number }

export interface Scene {
  image: { width: number; height: number } | null
  primitives: Primitive[]
}

// ---------------------------------------------------------------- buildScene（纯函数）

/** px(screenPx)：屏幕像素 → 图像空间尺寸（屏幕空间恒定的实现手段） */
export function buildScene(state: AppState, vp: Viewport): Scene {
  const image = state.model.image
  if (!image) return { image: null, primitives: [] }
  const px = (screenPx: number) => screenPx / vp.scale
  const out: Primitive[] = []

  pushDebugOverlay(state.ui.debugOverlay, px, out)
  pushAxis(state, 'x', px, out)
  pushAxis(state, 'y', px, out)
  pushPoints(state, px, out)
  pushRefineOutlines(state, px, out)
  pushRefineWindows(state, px, out)
  pushPendingMarker(state, px, out)
  pushDraftLine(state, px, out)
  pushCropOverlay(state, px, out)

  return { image: { width: image.width, height: image.height }, primitives: out }
}

/** 裁剪选框（§5.3：显示轨矢量叠加层，实时预览零像素运算；类微信截图：遮罩 + 边框 + 八向手柄） */
function pushCropOverlay(state: AppState, px: (n: number) => number, out: Primitive[]): void {
  const box = state.ui.cropBox
  const image = state.model.image!
  if (state.ui.activeTool !== 'imageEdit' || !box) return
  const { width: W, height: H } = image
  const shade = CANVAS_COLORS.ink
  const shadeRect = (x: number, y: number, w: number, h: number): Primitive => ({
    kind: 'rect', x, y, w, h, fill: shade, stroke: null, strokeWidth: 0, alpha: 0.3,
  })
  // 四向遮罩（避开选框内部）
  if (box.y > 0) out.push(shadeRect(0, 0, W, box.y))
  if (box.y + box.h < H) out.push(shadeRect(0, box.y + box.h, W, H - box.y - box.h))
  if (box.x > 0) out.push(shadeRect(0, box.y, box.x, box.h))
  if (box.x + box.w < W) out.push(shadeRect(box.x + box.w, box.y, W - box.x - box.w, box.h))
  // 边框（已确认将替换时 warning 描边预告，铁律 3）
  out.push({
    kind: 'rect', x: box.x, y: box.y, w: box.w, h: box.h,
    fill: null,
    stroke: state.ui.cropArmed ? CANVAS_COLORS.warning : CANVAS_COLORS.white,
    strokeWidth: px(1.5),
    alpha: 1,
  })
  // 八向手柄：白色方块 + ink 描边，屏幕恒定 10px
  const hs = px(10)
  for (const cx of [box.x, box.x + box.w / 2, box.x + box.w]) {
    for (const cy of [box.y, box.y + box.h / 2, box.y + box.h]) {
      if (cx === box.x + box.w / 2 && cy === box.y + box.h / 2) continue // 中心无手柄
      out.push({
        kind: 'rect', x: cx - hs / 2, y: cy - hs / 2, w: hs, h: hs,
        fill: CANVAS_COLORS.white, stroke: CANVAS_COLORS.ink, strokeWidth: px(1.5), alpha: 1,
      })
    }
  }
}

function pushDebugOverlay(
  overlay: DebugOverlay | null,
  px: (n: number) => number,
  out: Primitive[],
): void {
  if (!overlay) return
  for (const b of overlay.scanBands ?? []) {
    out.push({ kind: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, fill: CANVAS_COLORS.ink, stroke: null, strokeWidth: 0, alpha: 0.1 })
  }
  for (const p of overlay.samplePoints ?? []) {
    out.push({ kind: 'circle', x: p.x, y: p.y, r: px(SCREEN_SIZE.sampleRadius), fill: CANVAS_COLORS.ink, stroke: null, strokeWidth: 0, alpha: 0.7 })
  }
  for (const p of overlay.inliers ?? []) {
    out.push({ kind: 'circle', x: p.x, y: p.y, r: px(SCREEN_SIZE.sampleRadius), fill: CANVAS_COLORS.success, stroke: null, strokeWidth: 0, alpha: 0.9 })
  }
  for (const p of overlay.outliers ?? []) {
    out.push({ kind: 'circle', x: p.x, y: p.y, r: px(SCREEN_SIZE.sampleRadius), fill: CANVAS_COLORS.danger, stroke: null, strokeWidth: 0, alpha: 0.9 })
  }
  for (const c of overlay.candidateLines ?? []) {
    const span = 1e6 // 候选线横贯（裁剪由 canvas 视口自然完成）
    const [x1, y1, x2, y2] =
      c.axis === 'x' ? [0, c.pos, span, c.pos] : [c.pos, 0, c.pos, span]
    out.push({ kind: 'line', x1, y1, x2, y2, color: CANVAS_COLORS.warning, width: px(SCREEN_SIZE.candidateWidth), dash: [px(6), px(4)], alpha: 1 })
  }
}

/** 选中标记 = 白色外圈 + ink 描边（ui-style §3.2），压在主图元下方 */
function pushSelectionRing(x: number, y: number, r: number, px: (n: number) => number, out: Primitive[]): void {
  const outer = r + px(SCREEN_SIZE.focusRingGap) + px(SCREEN_SIZE.focusRingWidth)
  out.push({ kind: 'circle', x, y, r: outer, fill: CANVAS_COLORS.white, stroke: null, strokeWidth: 0, alpha: 1 })
  out.push({ kind: 'circle', x, y, r: outer, fill: null, stroke: CANVAS_COLORS.ink, strokeWidth: px(SCREEN_SIZE.focusRingWidth), alpha: 1 })
}

function pushAxis(state: AppState, axis: AxisId, px: (n: number) => number, out: Primitive[]): void {
  const cal: AxisCalibration = state.model.calibration[axis]
  const image = state.model.image!
  if (cal.skipped || cal.axisLine === null) return
  // 替换预告（铁律 3）：正在用画轴工具拖草稿线且该轴已有轴线 → 既有轴线 warning 高亮，松开即替换
  const d = state.ui.draftLine
  const replacing =
    d !== null &&
    (d.a.x !== d.b.x || d.a.y !== d.b.y) &&
    ((axis === 'x' && state.ui.activeTool === 'drawXAxis') ||
      (axis === 'y' && state.ui.activeTool === 'drawYAxis'))
  // 拟合成功轴线：success 实线 2px（屏幕恒定），强制水平/垂直横贯全图（§4.2）
  const [x1, y1, x2, y2] =
    axis === 'x'
      ? [0, cal.axisLine, image.width, cal.axisLine]
      : [cal.axisLine, 0, cal.axisLine, image.height]
  if (state.ui.selectedAxis === axis) {
    // 选中轴线：下方加一条宽的半透明 ink 光晕（Delete 删除）
    out.push({ kind: 'line', x1, y1, x2, y2, color: CANVAS_COLORS.ink, width: px(SCREEN_SIZE.selectedAxisWidth), alpha: 0.25 })
  }
  out.push({
    kind: 'line',
    x1, y1, x2, y2,
    color: replacing ? CANVAS_COLORS.warning : CANVAS_COLORS.success,
    width: px(SCREEN_SIZE.axisWidth),
    alpha: 1,
  })

  for (const t of cal.ticks) {
    // 未拟合画在点击处，拟合后吸附到轴线上的投影（§4.3）
    const { x: cx, y: cy } = tickAnchor(cal, axis, t)
    const r = px(SCREEN_SIZE.tickRadius)
    if (state.ui.selectedTickId === t.id) pushSelectionRing(cx, cy, r, px, out)
    const fitted = tickFitted(t)
    // 拟合成功 → success 实心（实心刻度）；未拟合 → ink 空心（§4.3 空心 → 实心）
    out.push({
      kind: 'circle',
      x: cx,
      y: cy,
      r,
      fill: fitted ? CANVAS_COLORS.success : null,
      stroke: fitted ? CANVAS_COLORS.success : CANVAS_COLORS.ink,
      strokeWidth: px(SCREEN_SIZE.axisWidth),
      alpha: 1,
    })
  }
}

function pushPoints(state: AppState, px: (n: number) => number, out: Primitive[]): void {
  const r = px(SCREEN_SIZE.markerRadius)
  state.model.series.forEach((series, index) => {
    const color = seriesColor(index)
    for (const p of series.points) {
      const selected = state.ui.selectedPointId === p.id
      if (selected) pushSelectionRing(p.pixel.x, p.pixel.y, r, px, out)
      // 已确认 40% 透明（铁律 4：全程可见）；选中时实色
      out.push({
        kind: 'circle',
        x: p.pixel.x,
        y: p.pixel.y,
        r,
        fill: color,
        stroke: selected ? CANVAS_COLORS.ink : null,
        strokeWidth: selected ? px(SCREEN_SIZE.focusRingWidth) : 0,
        alpha: selected ? 1 : 0.4,
      })
    }
  })
}

/**
 * 吸附范围可视化（取点工具，scatter / bar 序列）：每个未确认标记画出 Confirm 时 refine 实际读取的像素范围；
 * 光标处画浅色预览，点下去之前就能把窗口调到刚好框住一个标记。
 */
function pushRefineWindows(state: AppState, px: (n: number) => number, out: Primitive[]): void {
  if (state.ui.activeTool !== 'extractMarker') return
  const series = state.model.series.find((x) => x.id === state.model.activeSeriesId)
  if (!series || series.chartType === 'manual') return
  const params =
    series.chartType === 'scatter'
      ? ({ mode: 'scatter', radius: series.scatterRadius } as const)
      : ({ mode: 'bar', direction: series.barDirection, span: series.barSpan } as const)
  const box = (p: { x: number; y: number }, alpha: number): Primitive => ({
    kind: 'rect',
    ...refineWindow(p, params),
    fill: null,
    stroke: CANVAS_COLORS.warning,
    strokeWidth: px(1),
    alpha,
  })
  const pending = state.ui.pendingMarkers
  for (const m of pending) out.push(box(m, 0.9))
  const h = state.ui.hoverImage
  if (h && !pending.some((m) => Math.hypot(m.x - h.x, m.y - h.y) < px(SCREEN_SIZE.markerRadius))) {
    out.push(box(h, 0.45))
  }
}

/** 最近一次 Confirm 的散点吸附轮廓：显示 refine 实际抓到了哪块像素；点被移动 / 删除后不再画 */
function pushRefineOutlines(state: AppState, px: (n: number) => number, out: Primitive[]): void {
  if (state.ui.activeTool !== 'extractMarker') return
  for (const o of state.ui.refineOutlines) {
    const p = state.model.series.flatMap((s) => s.points).find((q) => q.id === o.pointId)
    if (!p || p.pixel.x !== o.at.x || p.pixel.y !== o.at.y) continue
    out.push({ kind: 'polygon', points: o.outline, stroke: CANVAS_COLORS.success, strokeWidth: px(1), alpha: 0.9 })
  }
}

function pushPendingMarker(state: AppState, px: (n: number) => number, out: Primitive[]): void {
  const r = px(SCREEN_SIZE.markerRadius)
  const arm = r * 0.9
  const w = px(SCREEN_SIZE.markerCrossWidth)
  // 未确认 marker：ink 实心 + 中心十字（ui-style §3.2）
  for (const m of state.ui.pendingMarkers) {
    out.push({ kind: 'circle', x: m.x, y: m.y, r, fill: CANVAS_COLORS.ink, stroke: null, strokeWidth: 0, alpha: 1 })
    out.push({ kind: 'line', x1: m.x - arm, y1: m.y, x2: m.x + arm, y2: m.y, color: CANVAS_COLORS.white, width: w, alpha: 1 })
    out.push({ kind: 'line', x1: m.x, y1: m.y - arm, x2: m.x, y2: m.y + arm, color: CANVAS_COLORS.white, width: w, alpha: 1 })
  }
}

/** 画轴工具的手绘草稿线：ink 虚线 2px（ui-style §3.2 交互预览） */
function pushDraftLine(state: AppState, px: (n: number) => number, out: Primitive[]): void {
  const d = state.ui.draftLine
  if (!d) return
  out.push({
    kind: 'line',
    x1: d.a.x,
    y1: d.a.y,
    x2: d.b.x,
    y2: d.b.y,
    color: CANVAS_COLORS.ink,
    width: px(SCREEN_SIZE.axisWidth),
    dash: [px(8), px(5)],
    alpha: 1,
  })
}

// ---------------------------------------------------------------- paint（唯一副作用出口）

/**
 * 执行绘制。bitmap 为显示轨当前缩放级（M1-6 imageCache 提供），
 * 绘制到完整图像坐标范围；高倍放大（≥8×）关闭平滑，便于像素级对齐（§1）。
 */
export function paint(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  vp: Viewport,
  bitmap: ImageBitmap | null,
  dpr: number,
  cssSize: { width: number; height: number },
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = CANVAS_COLORS.workbench
  ctx.fillRect(0, 0, cssSize.width, cssSize.height)

  ctx.setTransform(dpr * vp.scale, 0, 0, dpr * vp.scale, dpr * vp.offsetX, dpr * vp.offsetY)
  if (bitmap && scene.image) {
    // 透明底图铺白，与 Worker 灰度化（同样铺白）看到的一致
    ctx.fillStyle = CANVAS_COLORS.white
    ctx.fillRect(0, 0, scene.image.width, scene.image.height)
    ctx.imageSmoothingEnabled = vp.scale < 8
    ctx.drawImage(bitmap, 0, 0, scene.image.width, scene.image.height)
    ctx.imageSmoothingEnabled = true
  }

  for (const p of scene.primitives) {
    ctx.globalAlpha = p.alpha
    switch (p.kind) {
      case 'line':
        ctx.strokeStyle = p.color
        ctx.lineWidth = p.width
        ctx.setLineDash(p.dash ?? [])
        ctx.beginPath()
        ctx.moveTo(p.x1, p.y1)
        ctx.lineTo(p.x2, p.y2)
        ctx.stroke()
        break
      case 'circle':
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        if (p.fill) {
          ctx.fillStyle = p.fill
          ctx.fill()
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke
          ctx.lineWidth = p.strokeWidth
          ctx.setLineDash([])
          ctx.stroke()
        }
        break
      case 'rect':
        if (p.fill) {
          ctx.fillStyle = p.fill
          ctx.fillRect(p.x, p.y, p.w, p.h)
        }
        if (p.stroke) {
          ctx.strokeStyle = p.stroke
          ctx.lineWidth = p.strokeWidth
          ctx.strokeRect(p.x, p.y, p.w, p.h)
        }
        break
      case 'polygon':
        if (p.points.length < 2) break
        ctx.strokeStyle = p.stroke
        ctx.lineWidth = p.strokeWidth
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.moveTo(p.points[0].x, p.points[0].y)
        for (const q of p.points.slice(1)) ctx.lineTo(q.x, q.y)
        ctx.closePath()
        ctx.stroke()
        break
    }
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}
