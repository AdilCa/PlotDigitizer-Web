// commands.ts — intent 封装层
// 交互层（interact/）与 UI 只发 intent；只有这里改 model（铁律 1 单向流）。
// 可用性校验以 selectors 门控为唯一校验源（§6.1）；本层仅在数据完整性受威胁时
// 兜底（双跳、刻度上限、log 轴非正值、无活动序列），并以状态栏文字反馈（铁律 5）。
import { useStore, createFreshUi, type CropBox, type DebugOverlay, type UiState, type Viewport } from './store'
import {
  createEmptyModel,
  createSeries,
  newId,
  type AxisId,
  type BarScanDirection,
  type ChartType,
  type ImageRef,
  type PixelPoint,
  type ProjectModel,
  type ScaleType,
  type ToolId,
} from './model'
import { canSkipAxis } from './selectors'
import { workerRefinePoint } from '../worker/workerClient'

const set = useStore.setState
const get = useStore.getState

function setStatus(message: string | null): void {
  set((s) => {
    s.ui.statusMessage = message
  })
}

// ---------------------------------------------------------------- 图像 / 全局

/** 加载新图 = 全量重置 model（§6.6、F3.4）；预告由调用方（UI）在确认前完成（铁律 3） */
export function loadImage(ref: ImageRef): void {
  set((s) => {
    s.model = { ...createEmptyModel(), image: ref }
    s.ui = { ...createFreshUi(), activeTool: s.ui.activeTool }
  })
}

/** 恢复 .pdproj 完整工程（§7.1）：model 整体替换，UI 回到全新态 */
export function restoreProject(model: ProjectModel): void {
  set((s) => {
    s.model = model
    s.ui = createFreshUi()
  })
  setStatus('工程已恢复（图像 + 校准 + 取点）')
}export function resetModelKeepingImage(next?: Partial<ImageRef>): void {
  set((s) => {
    const image = s.model.image ? { ...s.model.image, ...next } : null
    s.model = { ...createEmptyModel(), image }
    s.ui.pendingMarker = null
    s.ui.selectedPointId = null
    s.ui.selectedTickId = null
  })
}

export function resetAll(): void {
  set((s) => {
    s.model = createEmptyModel()
    s.ui = createFreshUi()
  })
}

// ---------------------------------------------------------------- 工具与视口

/** 切换工具不清空任何已确认数据（铁律 4）；未确认的临时标记/选中态/草稿线清除 */
export function setActiveTool(tool: ToolId): void {
  set((s) => {
    s.ui.activeTool = tool
    s.ui.pendingMarker = null
    s.ui.selectedPointId = null
    s.ui.selectedTickId = null
    s.ui.draftLine = null
  })
}

/** 画轴工具草稿线（拖动全程更新；松开时由 axisTool 清除） */
export function setDraftLine(line: { a: PixelPoint; b: PixelPoint } | null): void {
  set((s) => {
    s.ui.draftLine = line
  })
}

/** 方向键步进（§6.3：面板可调，默认 1px，Shift ×10 在使用处实现） */
export function setNudgeStep(step: number): void {
  if (!(step > 0)) return
  set((s) => {
    s.ui.nudgeStep = step
  })
}

/** 光标处图像坐标（hover 读数）；离开画布置 null */
export function setHoverImage(p: PixelPoint | null): void {
  set((s) => {
    s.ui.hoverImage = p
  })
}

/** 加载新文件的预告态（§6.6、铁律 3；确认/取消由 io/fileAccess 调回） */
export function setPendingImportName(name: string | null): void {
  set((s) => {
    s.ui.pendingImportName = name
  })
}

/** PDF 会话图库（§5.5）：打开/关闭 PDF 时由 pdfSession 设置 */
export function setPdfGallery(gallery: UiState['pdfGallery']): void {
  set((s) => {
    s.ui.pdfGallery = gallery
  })
}

export function setViewport(viewport: Viewport): void {
  set((s) => {
    s.ui.viewport = viewport
  })
}

/** Fit 诊断叠加：engine 产出后由调用方设置；成功/换工具时清除（铁律 5 内联反馈的画布部分） */
export function setDebugOverlay(overlay: DebugOverlay | null): void {
  set((s) => {
    s.ui.debugOverlay = overlay
  })
}

export { setStatus }

// ---------------------------------------------------------------- 轴与刻度（§6.2 / §6.4）

/**
 * 画出/重画轴线（pos：X 轴 = y 常量，Y 轴 = x 常量）。
 * 重画级联删除该轴全部刻度及刻度值（一个逻辑操作，§6.2）；已取点保留，数据坐标经铁律 2 自动重算。
 * 替换预告由 UI 在调用前完成（铁律 3）。
 */
export function setAxisLine(axis: AxisId, pos: number): void {
  set((s) => {
    const cal = s.model.calibration[axis]
    cal.axisLine = pos
    cal.ticks = []
  })
}

/** 显式跳过/取消跳过（§6.2）；两轴同时跳过被拒绝并内联反馈 */
export function setAxisSkipped(axis: AxisId, skipped: boolean): void {
  if (skipped && !canSkipAxis(get().model, axis).enabled) {
    setStatus('不允许两轴同时跳过（将失去坐标语义）')
    return
  }
  set((s) => {
    s.model.calibration[axis].skipped = skipped
  })
}

export function setScaleType(axis: AxisId, scaleType: ScaleType): void {
  set((s) => {
    s.model.calibration[axis].scaleType = scaleType
  })
}

/** 标刻度：每轴恰好 2 个；标满后点击空白不新增（§6.4，无静默替换，F2.3）。
 *  at = 用户点击的完整位置；pos = 沿轴分量（X 轴取 at.x，Y 轴取 at.y）。 */
export function addTick(axis: AxisId, at: PixelPoint): string | null {
  const cal = get().model.calibration[axis]
  if (cal.ticks.length >= 2) {
    setStatus('每轴恰好 2 个刻度；请先删除或移动既有刻度')
    return null
  }
  const id = newId()
  const pos = axis === 'x' ? at.x : at.y
  set((s) => {
    s.model.calibration[axis].ticks.push({ id, pos, at, fittedPos: null, value: null })
    s.ui.selectedTickId = id
  })
  return id
}

/** 拖动刻度：at 跟随指针，pos = 沿轴分量；pos 偏离 fittedPos 即派生回「待拟合」，
 *  刻度值保留（§6.2）。 */
export function moveTickPoint(axis: AxisId, tickId: string, at: PixelPoint): void {
  const pos = axis === 'x' ? at.x : at.y
  set((s) => {
    const t = s.model.calibration[axis].ticks.find((t) => t.id === tickId)
    if (t) {
      t.at = at
      t.pos = pos
    }
  })
}

/** 只改沿轴位置（程序化移动/旧接口兼容）；at 同步为轴线上的投影点。 */
export function moveTick(axis: AxisId, tickId: string, pos: number): void {
  set((s) => {
    const t = s.model.calibration[axis].ticks.find((t) => t.id === tickId)
    if (t) {
      t.pos = pos
      if (axis === 'x') t.at = { x: pos, y: t.at.y }
      else t.at = { x: t.at.x, y: pos }
    }
  })
}

export function deleteTick(axis: AxisId, tickId: string): void {
  set((s) => {
    const cal = s.model.calibration[axis]
    cal.ticks = cal.ticks.filter((t) => t.id !== tickId)
    if (s.ui.selectedTickId === tickId) s.ui.selectedTickId = null
  })
}

/** 刻度值录入；log 轴刻度值必须 >0（内联校验，铁律 5）。
 *  录入即清除旧状态消息——状态栏回退到实时引导（铁律 4），避免「接下来该做的」滞后。 */
export function setTickValue(axis: AxisId, tickId: string, value: number): void {
  const cal = get().model.calibration[axis]
  if (cal.scaleType === 'log' && value <= 0) {
    setStatus('对数轴刻度值必须 > 0')
    return
  }
  set((s) => {
    const t = s.model.calibration[axis].ticks.find((t) => t.id === tickId)
    if (t) t.value = value
    s.ui.statusMessage = null
  })
}

/**
 * 拟合结果应用（由 M2-5 拟合流程在 engine/tickFitter 成功后调用）：
 * 刻度吸附到精确位置（空心 → 实心，§4.3）。
 */
export function applyTickFit(axis: AxisId, fitted: Readonly<Record<string, number>>): void {
  set((s) => {
    for (const t of s.model.calibration[axis].ticks) {
      const p = fitted[t.id]
      if (p !== undefined) {
        t.pos = p
        t.fittedPos = p
      }
    }
  })
}

/** 拟合失败或刻度失效时清除吸附标记（保持 pos，空心化） */
export function invalidateTickFit(axis: AxisId): void {
  set((s) => {
    for (const t of s.model.calibration[axis].ticks) t.fittedPos = null
  })
}

// ---------------------------------------------------------------- 裁剪（§5.3 / §6.6）

export function setCropBox(box: CropBox | null): void {
  set((s) => {
    s.ui.cropBox = box
  })
}

export function setCropArmed(armed: boolean): void {
  set((s) => {
    s.ui.cropArmed = armed
  })
}

/** 放弃选框：无副作用（§6.6） */
export function clearCrop(): void {
  set((s) => {
    s.ui.cropBox = null
    s.ui.cropArmed = false
  })
}

// ---------------------------------------------------------------- 序列（§6.5）

export function addSeries(name?: string, chartType: ChartType = 'scatter'): string {
  const n = get().model.series.length + 1
  const series = createSeries(name ?? `序列 ${n}`, chartType)
  set((s) => {
    s.model.series.push(series)
    s.model.activeSeriesId = series.id
  })
  return series.id
}

export function renameSeries(id: string, name: string): void {
  set((s) => {
    const series = s.model.series.find((x) => x.id === id)
    if (series) series.name = name
  })
}

export function deleteSeries(id: string): void {
  set((s) => {
    const idx = s.model.series.findIndex((x) => x.id === id)
    if (idx < 0) return
    const removed = s.model.series[idx]
    s.model.series.splice(idx, 1)
    if (s.model.activeSeriesId === id) {
      s.model.activeSeriesId = s.model.series[Math.min(idx, s.model.series.length - 1)]?.id ?? null
    }
    if (removed.points.some((p) => p.id === s.ui.selectedPointId)) {
      s.ui.selectedPointId = null
    }
  })
}

export function setActiveSeries(id: string): void {
  set((s) => {
    if (s.model.series.some((x) => x.id === id)) s.model.activeSeriesId = id
  })
}

/** 切换 chartType 只影响该序列后续输入的 refine 方式（§6.5） */
export function setChartType(id: string, chartType: ChartType): void {
  set((s) => {
    const series = s.model.series.find((x) => x.id === id)
    if (series) series.chartType = chartType
  })
}

export function setBarDirection(id: string, dir: BarScanDirection): void {
  set((s) => {
    const series = s.model.series.find((x) => x.id === id)
    if (series) series.barDirection = dir
  })
}

export function setPointPrefix(id: string, prefix: string): void {
  set((s) => {
    const series = s.model.series.find((x) => x.id === id)
    if (series) series.pointPrefix = prefix
  })
}

// ---------------------------------------------------------------- 取点（§6.3）

export function setPendingMarker(p: PixelPoint | null): void {
  set((s) => {
    s.ui.pendingMarker = p
  })
}

/**
 * 提交原语：把像素点提交为已确认点并自动进入下一个。
 * 需要显式活动序列（F6.3 反隐式 last()）；无序列时 no-op + 状态栏提示。
 * refine（scatter/bar 分支）由 confirmMarkerRefined 在调用前完成（§6.3）。
 */
export function confirmMarkerAt(pixel: PixelPoint): string | null {
  const { model } = get()
  const series = model.series.find((x) => x.id === model.activeSeriesId)
  if (!series) {
    setStatus('请先在序列面板新建并选中一个序列')
    return null
  }
  const id = newId()
  set((s) => {
    const target = s.model.series.find((x) => x.id === series.id)!
    target.points.push({
      id,
      pixel: { ...pixel },
      name: `${target.pointPrefix}${target.nextPointSeq}`,
    })
    target.nextPointSeq += 1
    s.ui.pendingMarker = null
    s.ui.selectedPointId = id
  })
  return id
}

/** 同步提交当前标记原位置（manual 路径；单测用，不经 Worker） */
export function confirmMarker(): string | null {
  const { ui } = get()
  if (!ui.pendingMarker) return null
  return confirmMarkerAt(ui.pendingMarker)
}

/**
 * Confirm 主路径（§6.3）：按活动序列 chartType 决定是否 refine——
 * scatter → Worker 暗度质心；bar → Worker 沿 barDirection 扫描；manual → 原位提交。
 * Worker 失败时按原位提交并内联提示（铁律 5：不丢弃用户的点击数据）。
 */
export async function confirmMarkerRefined(): Promise<string | null> {
  const { model, ui } = get()
  const pt = ui.pendingMarker
  if (!pt) return null
  const series = model.series.find((x) => x.id === model.activeSeriesId)
  if (!series) {
    setStatus('请先在序列面板新建并选中一个序列')
    return null
  }
  if (series.chartType === 'manual') return confirmMarker()
  try {
    const refined = await workerRefinePoint(
      pt,
      series.chartType,
      series.chartType === 'bar' ? series.barDirection : undefined,
    )
    return confirmMarkerAt(refined)
  } catch (err) {
    const committed = confirmMarkerAt(pt)
    if (committed) {
      setStatus(`refine 失败，已按原位提交（${err instanceof Error ? err.message : String(err)}）`)
    }
    return committed
  }
}

// ---------------------------------------------------------------- 已有点编辑（§6.3，F2.1）

export function selectPoint(id: string | null): void {
  set((s) => {
    s.ui.selectedPointId = id
  })
}

export function selectTick(id: string | null): void {
  set((s) => {
    s.ui.selectedTickId = id
  })
}

function findPoint(s: { model: ReturnType<typeof createEmptyModel> }, id: string) {
  for (const series of s.model.series) {
    const p = series.points.find((p) => p.id === id)
    if (p) return p
  }
  return null
}

/** 方向键步进移动（默认 1px，Shift ×10；步进值面板可调，§6.3） */
export function movePointBy(id: string, dx: number, dy: number): void {
  set((s) => {
    const p = findPoint(s, id)
    if (p) {
      p.pixel.x += dx
      p.pixel.y += dy
    }
  })
}

/** 双击抓起后放下（单击或 Enter） */
export function movePointTo(id: string, pixel: PixelPoint): void {
  set((s) => {
    const p = findPoint(s, id)
    if (p) p.pixel = { ...pixel }
  })
}

/** 显式删除入口（替代撤销，铁律 3） */
export function deletePoint(id: string): void {
  set((s) => {
    for (const series of s.model.series) {
      const idx = series.points.findIndex((p) => p.id === id)
      if (idx >= 0) {
        series.points.splice(idx, 1)
        break
      }
    }
    if (s.ui.selectedPointId === id) s.ui.selectedPointId = null
  })
}

export function renamePoint(id: string, name: string): void {
  set((s) => {
    const p = findPoint(s, id)
    if (p) p.name = name
  })
}
