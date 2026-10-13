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
  type Series,
  type ToolId,
} from './model'
import { canSkipAxis, toolFallback } from './selectors'
import { workerRefinePoints } from '../worker/workerClient'

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
    s.ui = { ...createFreshUi(), activeTool: s.ui.activeTool, pdfGallery: s.ui.pdfGallery, batchPick: s.ui.batchPick }
  })
}

/** 恢复 .pdproj 完整工程（§7.1）：model 整体替换，UI 回到全新态（PDF 会话保留，可继续选页） */
export function restoreProject(model: ProjectModel): void {
  set((s) => {
    s.model = model
    s.ui = { ...createFreshUi(), pdfGallery: s.ui.pdfGallery }
  })
  setStatus('工程已恢复（图像 + 校准 + 取点）')
}

/** 裁剪确认后：保留图像元信息（更新尺寸），清空校准与取点（§6.6） */
export function resetModelKeepingImage(next?: Partial<ImageRef>): void {
  set((s) => {
    const image = s.model.image ? { ...s.model.image, ...next } : null
    s.model = { ...createEmptyModel(), image }
    s.ui.pendingMarkers = []
    s.ui.refineOutlines = []
    s.ui.selectedPointId = null
    s.ui.selectedTickId = null
    s.ui.selectedAxis = null
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
    s.ui.pendingMarkers = []
    s.ui.selectedPointId = null
    s.ui.selectedTickId = null
    s.ui.selectedAxis = null
    s.ui.draftLine = null
  })
}

// 当前工具的门控失效（跳过轴、删除轴线/序列、换图…）时自动回退，避免停留在不可用工具上继续操作
useStore.subscribe((state) => {
  const next = toolFallback(state)
  if (next) setActiveTool(next)
})

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

/** 逐页渲染的缩略图到达 */
export function addPdfThumb(thumb: NonNullable<UiState['pdfGallery']>['thumbs'][number]): void {
  set((s) => {
    s.ui.pdfGallery?.thumbs.push(thumb)
  })
}

export function setPdfDialogOpen(open: boolean): void {
  set((s) => {
    s.ui.pdfDialogOpen = open
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

/** 删除轴线：连带清除该轴全部刻度与刻度值（同重画的级联语义）；已取点保留，数据坐标随之失效 */
export function deleteAxisLine(axis: AxisId): void {
  set((s) => {
    const cal = s.model.calibration[axis]
    if (cal.ticks.some((t) => t.id === s.ui.selectedTickId)) s.ui.selectedTickId = null
    cal.axisLine = null
    cal.ticks = []
    if (s.ui.selectedAxis === axis) s.ui.selectedAxis = null
    s.ui.debugOverlay = null
  })
  setStatus(`已删除 ${axis.toUpperCase()} 轴线及其刻度`)
}

export function selectAxis(axis: AxisId | null): void {
  set((s) => {
    s.ui.selectedAxis = axis
  })
}

/** 刻度拟合扫描半宽（按轴，取整并钳制到 2–60px） */
export function setTickScanHalf(axis: AxisId, half: number): void {
  if (!Number.isFinite(half)) return
  set((s) => {
    s.ui.tickScanHalf[axis] = Math.min(60, Math.max(2, Math.round(half)))
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

/** 切换线性/对数：两个刻度值在新类型下含义不同，一并清空（刻度位置保留） */
export function setScaleType(axis: AxisId, scaleType: ScaleType): void {
  const cal = get().model.calibration[axis]
  if (cal.scaleType === scaleType) return
  const hadValues = cal.ticks.some((t) => t.value !== null)
  set((s) => {
    const c = s.model.calibration[axis]
    c.scaleType = scaleType
    for (const t of c.ticks) t.value = null
  })
  if (hadValues) setStatus(`已切换为${scaleType === 'log' ? '对数' : '线性'}轴，请重新输入两个刻度值`)
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

/** 拖动刻度：at = 新的点击位置，pos = 沿轴分量；pos 偏离 fittedPos 即派生回「待拟合」，
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

export function setCropBusy(busy: boolean): void {
  set((s) => {
    s.ui.cropBusy = busy
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

/** 新建序列必须显式选择图表类型（决定 Confirm 的 refine 方式，§6.5） */
export function addSeries(chartType: ChartType, name?: string): string {
  const n = get().model.series.length + 1
  const series = createSeries(name ?? `序列 ${n}`, chartType)
  set((s) => {
    s.model.series.push(series)
    s.model.activeSeriesId = series.id
  })
  return series.id
}

/**
 * 换前缀：仍是自动命名（旧前缀 + 纯数字序号）的点一并改成新前缀；手动改过名的点保持不变。
 * 点名在确认时固化，不做这一步的话改前缀只影响之后的新点。
 */
function applyPointPrefix(series: Series, prefix: string): void {
  const old = series.pointPrefix
  for (const p of series.points) {
    const rest = p.name.slice(old.length)
    if (p.name.startsWith(old) && /^\d+$/.test(rest)) p.name = prefix + rest
  }
  series.pointPrefix = prefix
}

/** 改序列名；前缀仍是默认值（= 旧序列名）时跟着改 */
export function renameSeries(id: string, name: string): void {
  set((s) => {
    const series = s.model.series.find((x) => x.id === id)
    if (!series) return
    if (series.pointPrefix === series.name) applyPointPrefix(series, name)
    series.name = name
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

/** 柱状扫描范围（px，取整并钳制到 5–500） */
export function setBarSpan(id: string, span: number): void {
  if (!Number.isFinite(span)) return
  set((s) => {
    const series = s.model.series.find((x) => x.id === id)
    if (series) series.barSpan = Math.min(500, Math.max(5, Math.round(span)))
  })
}

/** 散点吸附窗口半径（px，取整并钳制到 1–60） */
export function setScatterRadius(id: string, radius: number): void {
  if (!Number.isFinite(radius)) return
  set((s) => {
    const series = s.model.series.find((x) => x.id === id)
    if (series) series.scatterRadius = Math.min(60, Math.max(1, Math.round(radius)))
  })
}

export function setPointPrefix(id: string, prefix: string): void {
  set((s) => {
    const series = s.model.series.find((x) => x.id === id)
    if (series) applyPointPrefix(series, prefix)
  })
}

// ---------------------------------------------------------------- 取点（§6.3）

/** 替换为单个标记（null = 清空）；非批量模式点击空白、单测走这里 */
export function setPendingMarker(p: PixelPoint | null): void {
  set((s) => {
    s.ui.pendingMarkers = p ? [p] : []
  })
}

/** 批量模式点击空白：追加一个标记，返回其下标 */
export function addPendingMarker(p: PixelPoint): number {
  set((s) => {
    s.ui.pendingMarkers.push(p)
  })
  return get().ui.pendingMarkers.length - 1
}

export function movePendingMarker(index: number, p: PixelPoint): void {
  set((s) => {
    if (index >= 0 && index < s.ui.pendingMarkers.length) s.ui.pendingMarkers[index] = p
  })
}

/** 撤掉最后放下的一个标记 */
export function popPendingMarker(): void {
  set((s) => {
    s.ui.pendingMarkers.pop()
  })
}

/** 只决定点击空白是追加还是替换；切换时不动已放下的标记 */
export function setBatchPick(on: boolean): void {
  set((s) => {
    s.ui.batchPick = on
  })
}

/**
 * 提交原语：把像素点按顺序提交为已确认点（编号连续），选中最后一个，返回新点 id。
 * 需要显式活动序列（F6.3 反隐式 last()）；无序列时 no-op + 状态栏提示。
 * refine（scatter/bar 分支）由 confirmMarkerRefined 在调用前完成（§6.3）。
 */
function commitPoints(seriesId: string, pixels: PixelPoint[]): string[] {
  const ids = pixels.map(() => newId())
  set((s) => {
    const target = s.model.series.find((x) => x.id === seriesId)
    if (!target) return
    pixels.forEach((pixel, i) => {
      target.points.push({ id: ids[i], pixel: { ...pixel }, name: `${target.pointPrefix}${target.nextPointSeq}` })
      target.nextPointSeq += 1
    })
    if (ids.length > 0) s.ui.selectedPointId = ids[ids.length - 1]
  })
  return ids
}

/** 取走全部待确认标记（立即清空，在途期间新放的标记属于下一批，不会被重复提交） */
function takePending(): { series: Series; pts: PixelPoint[] } | null {
  const { model, ui } = get()
  if (ui.pendingMarkers.length === 0) return null
  const series = model.series.find((x) => x.id === model.activeSeriesId)
  if (!series) {
    setStatus('请先在序列面板新建并选中一个序列')
    return null
  }
  const pts = ui.pendingMarkers
  set((s) => {
    s.ui.pendingMarkers = []
  })
  return { series, pts }
}

/** 同步按原位置提交全部待确认标记（manual 路径；单测用，不经 Worker）；返回最后一个新点 id */
export function confirmMarker(): string | null {
  const taken = takePending()
  if (!taken) return null
  return commitPoints(taken.series.id, taken.pts).at(-1) ?? null
}

const DIR_LABEL: Record<BarScanDirection, string> = { down: '向下', up: '向上', right: '向右', left: '向左' }

/**
 * Confirm 主路径（§6.3）：一次提交全部待确认标记，按活动序列 chartType 决定是否 refine——
 * scatter → Worker 暗度质心；bar → Worker 沿 barDirection 扫描；manual → 原位提交。
 * 一批点一次 Worker 请求，按点击顺序编号。未找到特征或 Worker 失败时按原位提交并内联提示
 * （铁律 5：不丢弃用户的点击数据）；refine 在途期间若换图则丢弃结果。
 */
export async function confirmMarkerRefined(): Promise<string[]> {
  const taken = takePending()
  if (!taken) return []
  const { series, pts } = taken
  if (series.chartType === 'manual') {
    const ids = commitPoints(series.id, pts)
    if (ids.length > 0) setStatus(`已确认 ${nameRange(series.id, ids)}（手动：按点击位置提交，不吸附）`)
    return ids
  }
  const mode = series.chartType
  const image = get().model.image
  try {
    const refined = await workerRefinePoints(
      pts.map((p, i) => ({
        refId: String(i),
        x: p.x,
        y: p.y,
        mode,
        ...(mode === 'bar'
          ? { barDirection: series.barDirection, barSpan: series.barSpan }
          : { scatterRadius: series.scatterRadius }),
      })),
    )
    if (get().model.image !== image) return []
    const ids = commitPoints(series.id, refined.map((r) => ({ x: r.x, y: r.y })))
    set((s) => {
      s.ui.refineOutlines = ids.flatMap((pointId, i) => {
        const r = refined[i]
        return r.outline ? [{ pointId, at: { x: r.x, y: r.y }, outline: r.outline }] : []
      })
    })
    const missed = ids.flatMap((id, i) => (refined[i].snapped ? [] : [{ id, reason: refined[i].reason }]))
    const moved = refined.map((r, i) => Math.hypot(r.x - pts[i].x, r.y - pts[i].y))
    if (ids.length > 0) setStatus(confirmSummary(series, ids, missed, moved))
    return ids
  } catch (err) {
    if (get().model.image !== image) return []
    const ids = commitPoints(series.id, pts)
    if (ids.length > 0) {
      setStatus(`refine 失败，已按原位提交（${err instanceof Error ? err.message : String(err)}）`)
    }
    return ids
  }
}

function pointNames(seriesId: string, ids: string[]): string {
  const pts = get().model.series.find((x) => x.id === seriesId)?.points ?? []
  return ids.map((id) => pts.find((p) => p.id === id)?.name ?? '').join('、')
}

/** 单点 = 点名；多点 = "N 个点（首–尾）" */
function nameRange(seriesId: string, ids: string[]): string {
  if (ids.length === 1) return pointNames(seriesId, ids)
  return `${ids.length} 个点（${pointNames(seriesId, [ids[0]])}–${pointNames(seriesId, [ids[ids.length - 1]])}）`
}

/** 每次 Confirm 都给出结果：吸附到哪类特征、移动了多少（铁律 4：吸附与否必须可见） */
function confirmSummary(
  series: Series,
  ids: string[],
  missed: { id: string; reason?: string }[],
  moved: number[],
): string {
  const bar = series.chartType === 'bar'
  const barMiss = `未找到柱边缘（${DIR_LABEL[series.barDirection]} ${series.barSpan}px 内无明显跳变）`
  const miss = bar ? barMiss : [...new Set(missed.map((m) => m.reason ?? '未找到标记'))].join('；')
  if (ids.length === 1) {
    const name = pointNames(series.id, ids)
    if (missed.length > 0) return `已确认 ${name}：${miss}，已按原位置提交；可调整参数后删掉重取`
    return `已确认 ${name}：已吸附到${bar ? '柱边缘' : '标记重心'}（移动 ${moved[0].toFixed(1)}px）`
  }
  if (missed.length === 0) {
    const max = Math.max(...moved)
    return `已确认 ${nameRange(series.id, ids)}，全部已吸附（最大移动 ${max.toFixed(1)}px）`
  }
  const names = pointNames(series.id, missed.map((m) => m.id))
  return `已确认 ${ids.length} 个点，其中 ${names} 未吸附（${miss}），已按原位置提交`
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

/** 拖动已确认点（markerTool：按下选中、超过拖动阈值后跟随指针） */
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
