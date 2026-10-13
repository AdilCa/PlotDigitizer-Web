// Inspector.tsx — 右侧检查器面板（248px，§6.2 校准状态的常驻落点）
// 组成：校准检查清单（整行可点击跳工具，铁律 4 引导）+ 每轴编辑块（scaleType / 跳过 / 刻度行 /
// 拟合按钮 / 映射参数）+ 序列/点列表（M5-1）+ PDF 会话入口（重新打开选页弹窗）+ 导出表单。
// 拟合按钮 = 门控置灰 + tooltip 原因（铁律 5）；拟合在 Worker 执行（§3 决策 4）。
import { useState } from 'react'
import { useStore } from '../state/store'
import type { AxisId, BarScanDirection, ChartType, ScaleType, Series, Tick, ToolId } from '../state/model'
import { seriesColor } from '../render/canvasRenderer'
import {
  addSeries,
  applyTickFit,
  confirmMarkerRefined,
  deleteAxisLine,
  deletePoint,
  deleteSeries,
  deleteTick,
  renamePoint,
  renameSeries,
  selectPoint,
  selectTick,
  setActiveSeries,
  setActiveTool,
  setAxisSkipped,
  setBarDirection,
  setBarSpan,
  setBatchPick,
  setScatterRadius,
  setChartType,
  setCurveRadius,
  setCurveStep,
  setDebugOverlay,
  setNudgeStep,
  setPointPrefix,
  setScaleType,
  setStatus,
  setTickScanHalf,
  setTickValue,
} from '../state/commands'
import {
  axisIssue,
  axisMapping,
  axisPhase,
  canSkipAxis,
  gateFor,
  isAxisCalibrated,
  tickFitted,
  type AxisPhase,
} from '../state/selectors'
import { workerFitTicks, WorkerRequestError } from '../worker/workerClient'
import type { TickFitDiagnostics } from '../engine/tickFitter'
import { defaultExportForm, runExport, runSaveProject, type ExportForm } from '../io/exporter'
import { PdfSessionBlock } from './PdfDialog'

const AXIS_LABEL: Record<AxisId, string> = { x: 'X', y: 'Y' }

const TOOL_LABEL: Partial<Record<ToolId, string>> = {
  drawXAxis: '画 X 轴',
  drawYAxis: '画 Y 轴',
  markTickX: '标 X 刻度',
  markTickY: '标 Y 刻度',
  extractMarker: '取点',
}

// ---------------------------------------------------------------- 检查清单

const PHASE_BADGE: Record<AxisPhase, { text: string; cls: string }> = {
  unset: { text: '未设置', cls: 'badge-gray' },
  skipped: { text: '已跳过', cls: 'badge-gray' },
  needTicks: { text: '缺刻度', cls: 'badge-warn' },
  pendingFit: { text: '待拟合', cls: 'badge-warn' },
  needValues: { text: '缺刻度值', cls: 'badge-warn' },
  invalid: { text: '校准无效', cls: 'badge-warn' },
  calibrated: { text: '已校准 ✓', cls: 'badge-ok' },
}

function ChecklistRow({
  label,
  badgeCls,
  badgeText,
  tool,
}: {
  label: string
  badgeCls: string
  badgeText: string
  /** 点击跳转的工具（ui-style §4：清单行可点击跳转）；门控禁用时不跳并显示原因 */
  tool?: ToolId
}) {
  const state = useStore.getState()
  const gate = tool ? gateFor(state, tool) : null
  const clickable = gate !== null && gate.enabled
  const reason = gate !== null && !gate.enabled ? gate.reason : undefined
  return (
    <div
      className={`insp-row${clickable ? ' clickable' : ''}`}
      title={tool ? (clickable ? `点击切换到「${TOOL_LABEL[tool] ?? tool}」工具` : reason) : undefined}
      onClick={clickable && tool ? () => setActiveTool(tool) : undefined}
    >
      <span>{label}</span>
      <span className={`badge ${badgeCls}`}>{badgeText}</span>
    </div>
  )
}

function Checklist() {
  const hasImage = useStore((s) => s.model.image !== null)
  const calibration = useStore((s) => s.model.calibration)
  const pointCount = useStore((s) => s.model.series.reduce((n, sr) => n + sr.points.length, 0))
  const phaseX = axisPhase(calibration.x)
  const phaseY = axisPhase(calibration.y)
  // 轴行跳转目标：未设置 → 画轴；已画 → 标刻度；已跳过 → 不跳（在下方轴块中取消跳过）
  const jumpTool = (phase: AxisPhase, axis: AxisId): ToolId | undefined =>
    phase === 'unset' ? (axis === 'x' ? 'drawXAxis' : 'drawYAxis')
    : phase === 'skipped' ? undefined
    : axis === 'x' ? 'markTickX' : 'markTickY'
  return (
    <div className="insp-checklist">
      <ChecklistRow
        label="图像"
        badgeCls={hasImage ? 'badge-ok' : 'badge-gray'}
        badgeText={hasImage ? '已加载' : '未加载'}
      />
      <ChecklistRow
        label="X 轴"
        badgeCls={PHASE_BADGE[phaseX].cls}
        badgeText={PHASE_BADGE[phaseX].text}
        tool={jumpTool(phaseX, 'x')}
      />
      <ChecklistRow
        label="Y 轴"
        badgeCls={PHASE_BADGE[phaseY].cls}
        badgeText={PHASE_BADGE[phaseY].text}
        tool={jumpTool(phaseY, 'y')}
      />
      <ChecklistRow
        label="已取点"
        badgeCls="badge-gray"
        badgeText={`${pointCount} 点`}
        tool="extractMarker"
      />
    </div>
  )
}

// ---------------------------------------------------------------- 刻度行

function TickRow({ axis, tick, index }: { axis: AxisId; tick: Tick; index: number }) {
  const selected = useStore((s) => s.ui.selectedTickId === tick.id)
  const fitted = tickFitted(tick)
  return (
    <div
      className={`tick-row${selected ? ' selected' : ''}`}
      onClick={() => selectTick(tick.id)}
      data-testid={`tick-row-${axis}-${index}`}
    >
      <span className={`tick-dot ${fitted ? 'dot-solid' : 'dot-hollow'}`} title={fitted ? '已拟合' : '待拟合'} />
      <span className="tick-pos" title="沿轴位置（图像像素）">
        {Math.round(tick.pos)}px
      </span>
      <input
        className="tick-value"
        type="number"
        placeholder="刻度值"
        value={tick.value ?? ''}
        data-testid={`tick-value-${axis}-${index}`}
        onChange={(e) => {
          const v = e.target.valueAsNumber
          if (!Number.isNaN(v)) setTickValue(axis, tick.id, v)
        }}
      />
      <button
        className="btn-del"
        title="删除这个刻度（选中后也可按 Delete）"
        data-testid={`tick-delete-${axis}-${index}`}
        onClick={(e) => {
          e.stopPropagation()
          deleteTick(axis, tick.id)
        }}
      >
        删除
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- 拟合按钮

function FitButton({ axis }: { axis: AxisId }) {
  const label = AXIS_LABEL[axis]
  // 订阅稳定分支引用，门控在渲染期计算（zustand 选择器不得返回新建对象，否则触发 React #185）
  const cal = useStore((s) => s.model.calibration[axis])
  void cal // 订阅用；gate 计算依赖最新 state
  const gate = gateFor(useStore.getState(), axis === 'x' ? 'fitTickX' : 'fitTickY')
  return (
    <button
      className="btn-primary fit-btn"
      disabled={!gate.enabled}
      title={gate.enabled ? `对 2 个 ${label} 刻度执行精确定位（Worker）` : gate.reason}
      data-testid={`fit-${axis}`}
      onClick={() => void runFit(axis)}
    >
      拟合 {label} 轴刻度
    </button>
  )
}

function ScanHalfField({ axis }: { axis: AxisId }) {
  const half = useStore((s) => s.ui.tickScanHalf[axis])
  return (
    <label
      className="insp-field"
      title="拟合时沿轴方向的搜索半径。窗口内出现多根刻度（如次刻度、标注文字）时调小"
    >
      <span>扫描窗口 ±px</span>
      <input
        className="tick-value"
        type="number"
        min={2}
        max={60}
        step={1}
        value={half}
        data-testid={`scan-half-${axis}`}
        onChange={(e) => setTickScanHalf(axis, e.target.valueAsNumber)}
      />
    </label>
  )
}

/** 拟合流程（§4.3）：全部成功才应用（空心→实心）；失败内联错误 + 诊断叠加（铁律 5） */
async function runFit(axis: AxisId): Promise<void> {
  const s = useStore.getState()
  const label = AXIS_LABEL[axis]
  const cal = s.model.calibration[axis]
  setStatus(`正在拟合 ${label} 轴刻度…`)
  try {
    const r = await workerFitTicks(
      axis,
      cal.ticks.map((t) => ({ id: t.id, at: t.at })),
      s.ui.tickScanHalf[axis],
    )
    applyTickFit(axis, r.fitted)
    setDebugOverlay(null)
    setStatus(`${label} 轴刻度已拟合（空心 → 实心）。接下来：输入两个 ${label} 刻度值`)
  } catch (err) {
    const diag =
      err instanceof WorkerRequestError ? (err.diagnostics as TickFitDiagnostics | undefined) : undefined
    if (diag) {
      setDebugOverlay({
        scanBands: diag.scanBands,
        candidateLines: diag.candidateLines,
        samplePoints: diag.samplePoints,
      })
    }
    setStatus(err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------- 单轴编辑块

function AxisBlock({ axis }: { axis: AxisId }) {
  const label = AXIS_LABEL[axis]
  // 订阅稳定分支引用；派生值（phase / mapping / skipGate）在渲染期即时计算，
  // 避免 zustand 选择器每次返回新建对象导致 React #185 无限重渲染。
  const cal = useStore((s) => s.model.calibration[axis])
  const otherSkipped = useStore((s) => s.model.calibration[axis === 'x' ? 'y' : 'x'].skipped)
  void otherSkipped
  const phase = axisPhase(cal)
  const mapping = axisMapping(cal)
  const issue = axisIssue(cal)
  const skipGate = canSkipAxis(useStore.getState().model, axis)

  return (
    <div className="axis-block" data-testid={`axis-block-${axis}`}>
      <div className="axis-head">
        <span className="axis-title">{label} 轴</span>
        <span className={`badge ${PHASE_BADGE[phase].cls}`}>{PHASE_BADGE[phase].text}</span>
      </div>

      {cal.axisLine !== null && (
        <div className="insp-field">
          <span title="拟合后的轴线位置（图像像素）">轴线 {Math.round(cal.axisLine)}px</span>
          <button
            className="btn-del"
            title="删除轴线，连带清除该轴刻度与刻度值；已取点保留（画轴工具下单击轴线选中后也可按 Delete）"
            data-testid={`axis-delete-${axis}`}
            onClick={() => deleteAxisLine(axis)}
          >
            删除轴线
          </button>
        </div>
      )}

      <label className="insp-field">
        <span>刻度类型</span>
        <select
          value={cal.scaleType}
          disabled={cal.skipped}
          onChange={(e) => setScaleType(axis, e.target.value as ScaleType)}
        >
          <option value="linear">线性</option>
          <option value="log">对数</option>
        </select>
      </label>

      <label
        className={`insp-field checkbox${skipGate.enabled || cal.skipped ? '' : ' disabled'}`}
        title={!skipGate.enabled && !cal.skipped ? skipGate.reason : '跳过后导出中该轴整列不出现'}
      >
        <input
          type="checkbox"
          checked={cal.skipped}
          disabled={!cal.skipped && !skipGate.enabled}
          onChange={(e) => setAxisSkipped(axis, e.target.checked)}
        />
        <span>跳过此轴</span>
      </label>

      {!cal.skipped && cal.axisLine !== null && (
        <>
          <div className="tick-list">
            {cal.ticks.map((t, i) => (
              <TickRow key={t.id} axis={axis} tick={t} index={i} />
            ))}
            {cal.ticks.length < 2 && (
              <div className="tick-hint">用「标 {label} 刻度」工具在刻度线处点击（{cal.ticks.length}/2）</div>
            )}
          </div>
          <ScanHalfField axis={axis} />
          <FitButton axis={axis} />
          {issue && (
            <div className="axis-issue" data-testid={`axis-issue-${axis}`}>
              {issue}
            </div>
          )}
        </>
      )}

      {mapping && (
        <div className="mapping-info" title="value = a + b·pos（log 轴在 log₁₀ 域）">
          a = {mapping.a.toPrecision(6)}，b = {mapping.b.toPrecision(6)}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 取点区块（§6.5，M5-1 完整版）
// 序列列表：色点（色盘 §3.3）+ 行内改名 + 点数 badge + 删除；点中行 = 切换当前序列。
// 点列表（当前序列）：行内改名（决策 #20）+ 像素坐标 + 删除；点中行 = 选中（方向键微调）。

function SeriesRow({ sr, index, active }: { sr: Series; index: number; active: boolean }) {
  return (
    <div
      className={`series-row${active ? ' active' : ''}`}
      data-testid={`series-row-${index}`}
      title={active ? '当前序列' : '点击切换为当前序列'}
      onClick={() => setActiveSeries(sr.id)}
    >
      <span className="series-dot" style={{ background: seriesColor(index) }} />
      <input
        className="series-name"
        value={sr.name}
        data-testid={`series-name-${index}`}
        title="序列名（导出时作为默认点前缀）；点击同时切换为当前序列"
        onChange={(e) => renameSeries(sr.id, e.target.value)}
      />
      <span className="badge badge-gray">{sr.points.length} 点</span>
      <button
        className="tick-del"
        title="删除该序列及其全部点"
        data-testid={`series-delete-${index}`}
        onClick={(e) => {
          e.stopPropagation()
          deleteSeries(sr.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

function PointRow({ sr, index }: { sr: Series; index: number }) {
  const p = sr.points[index]
  const selected = useStore((s) => s.ui.selectedPointId === p.id)
  return (
    <div
      className={`point-row${selected ? ' selected' : ''}`}
      data-testid={`point-row-${index}`}
      title="点击选中（方向键微调）；删除请用 × 或 Delete"
      onClick={() => selectPoint(p.id)}
    >
      <input
        className="point-name"
        value={p.name}
        data-testid={`point-name-${index}`}
        title="点名（导出标识，§7.2）；点击同时选中该点"
        onChange={(e) => renamePoint(p.id, e.target.value)}
      />
      <span className="point-pos" title="图像像素坐标">
        {Math.round(p.pixel.x)},{Math.round(p.pixel.y)}
      </span>
      <button
        className="tick-del"
        title="删除该点"
        data-testid={`point-delete-${index}`}
        onClick={(e) => {
          e.stopPropagation()
          deletePoint(p.id)
        }}
      >
        ×
      </button>
    </div>
  )
}

const CHART_TYPE_LABEL: Record<ChartType, string> = {
  scatter: '散点',
  bar: '柱状',
  curve: '曲线',
  manual: '手动',
}

const CHART_TYPE_TITLE: Record<ChartType, string> = {
  scatter: '确认时按颜色分割出点击附近的标记，吸附到它的重心（搜索范围可调）',
  bar: '确认时从点击处沿扫描方向寻找柱边缘',
  curve: '沿曲线涂抹一笔，确认时按曲线颜色沿笔迹提取一串点',
  manual: '按点击位置原样提交，不做吸附',
}

const PICK_HINT: Record<ChartType, string> = {
  scatter: '点击标记附近放置，Enter 确认吸附',
  bar: '在柱顶外侧点击，Enter 确认',
  curve: '沿曲线按住拖动涂抹一笔，Enter 提取',
  manual: '点击目标位置，Enter 确认',
}

/** 选定图表类型就是要开始取点：直接进入取点工具；门控不通过时只在状态栏说明还差什么 */
function enterPickTool(chartType: ChartType): void {
  const s = useStore.getState()
  if (s.ui.activeTool === 'extractMarker') return
  const gate = gateFor(s, 'extractMarker')
  if (!gate.enabled || s.ui.cropBusy) {
    setStatus(`序列已就绪，但还不能取点：${gate.enabled ? '正在裁剪' : gate.reason}`)
    return
  }
  setActiveTool('extractMarker')
  setStatus(`已切换到取点工具：${PICK_HINT[chartType]}`)
}

function NewSeriesPicker() {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button className="btn-ghost" data-testid="add-series" onClick={() => setOpen(true)}>
        + 新建序列
      </button>
    )
  }
  return (
    <div className="insp-field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <span>选择图表类型：</span>
      <div className="new-series-types">
        {(['scatter', 'bar', 'curve', 'manual'] as const).map((t) => (
          <button
            key={t}
            className="btn-ghost"
            title={CHART_TYPE_TITLE[t]}
            data-testid={`new-series-${t}`}
            onClick={() => {
              addSeries(t)
              setOpen(false)
              enterPickTool(t)
            }}
          >
            {CHART_TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      <button className="btn-ghost" onClick={() => setOpen(false)}>
        取消
      </button>
    </div>
  )
}

function ExtractBlock() {
  const series = useStore((s) => s.model.series)
  const activeId = useStore((s) => s.model.activeSeriesId)
  const pending = useStore((s) => s.ui.pendingMarkers.length)
  const batchPick = useStore((s) => s.ui.batchPick)
  const nudgeStep = useStore((s) => s.ui.nudgeStep)
  const strokeLen = useStore((s) => s.ui.curveStroke.length)
  const active = series.find((x) => x.id === activeId) ?? null
  const curve = active?.chartType === 'curve'
  // 曲线点多，点列表默认折叠成一行摘要；展开状态只跟着当前序列，切走再切回即折叠
  const [expandedSeries, setExpandedSeries] = useState<string | null>(null)
  const pointsExpanded = active !== null && expandedSeries === active.id

  return (
    <div className="axis-block" data-testid="extract-block">
      <div className="axis-head">
        <span className="axis-title">取点</span>
        <span className="badge badge-gray" data-testid="point-count">
          已确认 {active?.points.length ?? 0} 个
        </span>
      </div>

      <div className="series-list">
        {series.length === 0 && <div className="tick-hint">先新建序列并选择图表类型，才能取点</div>}
        {series.map((sr, i) => (
          <SeriesRow key={sr.id} sr={sr} index={i} active={sr.id === activeId} />
        ))}
        <NewSeriesPicker />
      </div>

      {active && (
        <>
          <label className="insp-field">
            <span>图表类型</span>
            <select
              value={active.chartType}
              data-testid="chart-type"
              onChange={(e) => {
                const t = e.target.value as ChartType
                setChartType(active.id, t)
                enterPickTool(t)
              }}
            >
              <option value="scatter">散点</option>
              <option value="bar">柱状</option>
              <option value="curve">曲线（涂抹提取）</option>
              <option value="manual">手动（不 refine）</option>
            </select>
          </label>
          {active.chartType === 'scatter' && (
            <label
              className="insp-field"
              title="确认时在橙色方框内找离点击最近的标记（标记碰到方框即可，可以比方框大），按颜色分割出整个标记后取重心；框内有多个标记时取离点击最近的；确认后吸附所用的像素轮廓以绿色显示"
            >
              <span>搜索半径 px</span>
              <input
                className="tick-value"
                type="number"
                min={1}
                max={60}
                step={1}
                value={active.scatterRadius}
                data-testid="scatter-radius"
                onChange={(e) => setScatterRadius(active.id, e.target.valueAsNumber)}
              />
            </label>
          )}
          {active.chartType === 'bar' && (
            <>
              <label className="insp-field">
                <span>扫描方向</span>
                <select
                  value={active.barDirection}
                  data-testid="bar-direction"
                  onChange={(e) => setBarDirection(active.id, e.target.value as BarScanDirection)}
                >
                  <option value="down">向下（点在柱顶上方）</option>
                  <option value="up">向上（点在柱底下方）</option>
                  <option value="left">向左（点在柱右端右侧）</option>
                  <option value="right">向右（点在柱左端左侧）</option>
                </select>
              </label>
              <label className="insp-field" title="从点击处沿扫描方向搜索柱边缘的距离（图像像素）；画布上橙色条带即扫描范围">
                <span>扫描范围 px</span>
                <input
                  className="tick-value"
                  type="number"
                  min={5}
                  max={500}
                  step={5}
                  value={active.barSpan}
                  data-testid="bar-span"
                  onChange={(e) => setBarSpan(active.id, e.target.valueAsNumber)}
                />
              </label>
            </>
          )}

          {active.chartType === 'curve' && (
            <>
              <div className="tick-hint">
                在画布上沿曲线按住拖动涂抹一笔（盖住线即可，不用描准），Enter 提取；在笔迹末端按下可接着涂，Esc 清除笔迹
              </div>
              <label
                className="insp-field"
                title="涂抹笔刷半径（图像像素）。只在这条带子里找曲线：盖住目标线即可，越窄越不容易蹭到旁边的线、图例和文字"
              >
                <span>笔刷半径 px</span>
                <input
                  className="tick-value"
                  type="number"
                  min={2}
                  max={60}
                  step={1}
                  value={active.curveRadius}
                  data-testid="curve-radius"
                  onChange={(e) => setCurveRadius(active.id, e.target.valueAsNumber)}
                />
              </label>
              <label className="insp-field" title="沿笔迹每隔多少像素取一个点（图像像素）；越小点越密">
                <span>采样间隔 px</span>
                <input
                  className="tick-value"
                  type="number"
                  min={1}
                  max={50}
                  step={1}
                  value={active.curveStep}
                  data-testid="curve-step"
                  onChange={(e) => setCurveStep(active.id, e.target.valueAsNumber)}
                />
              </label>
            </>
          )}

          {active.points.length > 0 && curve && (
            <div className="point-list-summary" data-testid="point-list-summary">
              <span>
                {active.points.length} 个点（{active.points[0].name}–{active.points[active.points.length - 1].name}）
              </span>
              <button
                className="btn-ghost"
                title={pointsExpanded ? '收起点列表' : '展开逐点列表（改名、选中）；单个点也可以直接在画布上点选、拖动、Delete 删除'}
                data-testid="point-list-toggle"
                onClick={() => setExpandedSeries(pointsExpanded ? null : active.id)}
              >
                {pointsExpanded ? '收起' : '展开'}
              </button>
            </div>
          )}
          {active.points.length > 0 && (!curve || pointsExpanded) && (
            <div className="point-list">
              {active.points.map((_, i) => (
                <PointRow key={active.points[i].id} sr={active} index={i} />
              ))}
            </div>
          )}
        </>
      )}

      {curve ? (
        <button
          className="btn-primary"
          disabled={strokeLen < 2}
          title={strokeLen < 2 ? '先在画布上沿曲线涂抹一笔' : '按曲线颜色沿笔迹提取一串点（Enter）；Esc 清除笔迹'}
          data-testid="confirm-curve"
          onClick={() => void confirmMarkerRefined()}
        >
          提取曲线（Enter）
        </button>
      ) : (
        <>
          <button
            className={batchPick ? 'btn-ghost btn-toggle on' : 'btn-ghost btn-toggle'}
            aria-pressed={batchPick}
            title={
              batchPick
                ? '批量取点已开启：连续点击放置多个标记，确认一次全部拟合；再点关闭'
                : '开启后连续点击放置多个标记（例如每根柱子一个），确认一次全部拟合'
            }
            data-testid="batch-pick"
            onClick={() => setBatchPick(!batchPick)}
          >
            批量取点{batchPick ? '：开' : '：关'}
          </button>

          <button
            className="btn-primary"
            disabled={pending === 0}
            title={
              pending === 0
                ? '先在画布上点击放置标记'
                : pending === 1
                  ? '提交当前标记并自动进入下一个（Enter）'
                  : `按放置顺序提交全部 ${pending} 个标记（Enter）；Delete 撤掉最后一个，Esc 全部取消`
            }
            data-testid="confirm-marker"
            onClick={() => void confirmMarkerRefined()}
          >
            {pending > 1 ? `确认 ${pending} 个点（Enter）` : '确认点（Enter）'}
          </button>
        </>
      )}

      <label className="insp-field" title="方向键移动选中点的步进（Shift ×10）">
        <span>方向键步进</span>
        <input
          className="tick-value"
          type="number"
          min={0.1}
          step={1}
          value={nudgeStep}
          data-testid="nudge-step"
          onChange={(e) => {
            const v = e.target.valueAsNumber
            if (!Number.isNaN(v)) setNudgeStep(v)
          }}
        />
      </label>
    </div>
  )
}

// ---------------------------------------------------------------- 导出区块（§7.2/§7.3，M4-6/7：内联展开表单，非模态）

function ExportBlock() {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<ExportForm | null>(null)
  const hasImage = useStore((s) => s.model.image !== null)
  const calibration = useStore((s) => s.model.calibration)
  const series = useStore((s) => s.model.series)
  // 门控在渲染期计算（选择器纪律 #7：不返回新建对象）
  const gate = gateFor(useStore.getState(), 'export')
  void hasImage
  void calibration
  void series

  const xCalibrated = isAxisCalibrated(calibration.x)
  const yCalibrated = isAxisCalibrated(calibration.y)

  const toggle = () => {
    if (!open && gate.enabled) setForm(defaultExportForm())
    setOpen(!open)
  }

  const exportDisabled = !form || form.fileName.trim() === ''
  const exportTitle = !form
    ? '需至少校准一个轴'
    : form.fileName.trim() === ''
      ? '文件名不能为空'
      : `导出 ${form.fileName}.md 与标注截图 PNG`

  return (
    <div className="axis-block" data-testid="export-block">
      <div className="axis-head">
        <span className="axis-title">导出</span>
        <button
          className="btn-ghost"
          disabled={!gate.enabled}
          title={gate.enabled ? '展开导出表单' : gate.enabled === false ? gate.reason : ''}
          data-testid="export-toggle"
          onClick={toggle}
        >
          {open ? '收起' : '展开'}
        </button>
      </div>

      {open && form && (
        <>
          <label className="insp-field">
            <span>文件名</span>
            <input
              className="tick-value"
              value={form.fileName}
              data-testid="export-filename"
              onChange={(e) => setForm({ ...form, fileName: e.target.value })}
            />
          </label>
          <label className="insp-field">
            <span>表标题</span>
            <input
              className="tick-value"
              value={form.title}
              data-testid="export-title"
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          {xCalibrated && (
            <label className="insp-field">
              <span>X 数值名</span>
              <input
                className="tick-value"
                value={form.axisNames.x ?? ''}
                data-testid="export-xname"
                onChange={(e) =>
                  setForm({ ...form, axisNames: { ...form.axisNames, x: e.target.value } })
                }
              />
            </label>
          )}
          {yCalibrated && (
            <label className="insp-field">
              <span>Y 数值名</span>
              <input
                className="tick-value"
                value={form.axisNames.y ?? ''}
                data-testid="export-yname"
                onChange={(e) =>
                  setForm({ ...form, axisNames: { ...form.axisNames, y: e.target.value } })
                }
              />
            </label>
          )}
          {series.map((sr) => (
            <label className="insp-field" key={sr.id}>
              <span>{sr.name} 前缀</span>
              <input
                className="tick-value"
                value={sr.pointPrefix}
                data-testid={`export-prefix-${sr.id}`}
                onChange={(e) => setPointPrefix(sr.id, e.target.value)}
              />
            </label>
          ))}
          <button
            className="btn-primary"
            disabled={exportDisabled}
            title={exportTitle}
            data-testid="export-run"
            onClick={() => void runExport(form)}
          >
            导出 MD + PNG
          </button>
          <button
            className="btn-ghost"
            title="打包为 .pdproj（store-only zip：project.json + image.png，§7.1）"
            data-testid="save-project"
            onClick={() => void runSaveProject()}
          >
            保存工程 (.pdproj)
          </button>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 面板

export default function Inspector() {
  return (
    <aside className="inspector">
      <div className="insp-section-title">校准检查清单</div>
      <Checklist />
      <div className="insp-section-title">坐标轴</div>
      <AxisBlock axis="x" />
      <AxisBlock axis="y" />
      <div className="insp-section-title">数据提取</div>
      <ExtractBlock />
      <PdfSessionBlock />
      <div className="insp-section-title">导出</div>
      <ExportBlock />
    </aside>
  )
}
