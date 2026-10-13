// M1-1 验收单测：轴四态、两点映射、铁律 2 级联与缓存、门控、点操作语义
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, createFreshUi } from '../src/state/store'
import { createEmptyModel, type ImageRef } from '../src/state/model'
import {
  axisIssue,
  axisMapping,
  axisPhase,
  axisStatus,
  axisValueAt,
  dataPointsOf,
  gateFor,
  isAxisCalibrated,
  nextActionHint,
  toolEnabled,
} from '../src/state/selectors'
import * as cmd from '../src/state/commands'

const IMG: ImageRef = { name: 'test1.png', sourceType: 'file', width: 2000, height: 1500 }

function state() {
  return useStore.getState()
}

/** 构造一条已校准 X 轴：刻度 pos 100→值 0，pos 200→值 10（b = 0.1） */
function calibrateX(): { t1: string; t2: string } {
  cmd.setAxisLine('x', 500)
  const t1 = cmd.addTick('x', { x: 100, y: 500 })!
  const t2 = cmd.addTick('x', { x: 200, y: 500 })!
  cmd.applyTickFit('x', { [t1]: 100, [t2]: 200 })
  cmd.setTickValue('x', t1, 0)
  cmd.setTickValue('x', t2, 10)
  return { t1, t2 }
}

beforeEach(() => {
  useStore.setState({ model: createEmptyModel(), ui: createFreshUi() }, true)
})

describe('轴四态（§6.2）', () => {
  it('未设置 → 轴线已画 → 已校准', () => {
    expect(axisStatus(state().model.calibration.x)).toBe('unset')
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 500)
    expect(axisStatus(state().model.calibration.x)).toBe('lineDrawn')
    calibrateX()
    expect(axisStatus(state().model.calibration.x)).toBe('calibrated')
  })

  it('刻度移动后回到待拟合（警告态），刻度值保留', () => {
    cmd.loadImage(IMG)
    const { t1 } = calibrateX()
    cmd.moveTick('x', t1, 105)
    const cal = state().model.calibration.x
    expect(axisStatus(cal)).toBe('lineDrawn')
    expect(cal.ticks[0].value).toBe(0) // 刻度值保留
    expect(cal.ticks[0].pos).toBe(105)
    expect(cal.ticks[0].fittedPos).toBe(100) // 派生待拟合：pos !== fittedPos
  })

  it('重画轴级联删除刻度，已取点保留', () => {
    cmd.loadImage(IMG)
    calibrateX()
    const sid = cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    cmd.confirmMarker()
    cmd.setAxisLine('x', 480) // 重画
    const m = state().model
    expect(m.calibration.x.ticks).toHaveLength(0)
    expect(axisStatus(m.calibration.x)).toBe('lineDrawn')
    expect(m.series.find((s) => s.id === sid)!.points).toHaveLength(1) // 点保留
  })

  it('显式跳过；不允许两轴同时跳过', () => {
    cmd.loadImage(IMG)
    cmd.setAxisSkipped('x', true)
    expect(axisStatus(state().model.calibration.x)).toBe('skipped')
    cmd.setAxisSkipped('y', true) // 应被拒绝
    expect(axisStatus(state().model.calibration.y)).toBe('unset')
    expect(state().ui.statusMessage).toContain('不允许两轴同时跳过')
  })
})

describe('两点制映射（§4.3 / §4.5）', () => {
  it('线性轴解析求解 value = a + b·pos', () => {
    cmd.loadImage(IMG)
    calibrateX()
    const m = axisMapping(state().model.calibration.x)!
    expect(m.a).toBeCloseTo(-10)
    expect(m.b).toBeCloseTo(0.1)
    expect(axisValueAt(state().model.calibration.x, 150)).toBeCloseTo(5)
  })

  it('log 轴在 log10 域求解，取值 10^(a+b·pos)', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('y', 800)
    cmd.setScaleType('y', 'log')
    const t1 = cmd.addTick('y', { x: 400, y: 0 })!
    const t2 = cmd.addTick('y', { x: 400, y: 100 })!
    cmd.applyTickFit('y', { [t1]: 0, [t2]: 100 })
    cmd.setTickValue('y', t1, 1)
    cmd.setTickValue('y', t2, 100)
    expect(axisValueAt(state().model.calibration.y, 50)).toBeCloseTo(10)
  })

  it('log 轴刻度值 ≤0 被内联拒绝', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('y', 800)
    cmd.setScaleType('y', 'log')
    const t1 = cmd.addTick('y', { x: 400, y: 0 })!
    cmd.setTickValue('y', t1, 0)
    expect(state().model.calibration.y.ticks[0].value).toBeNull()
    expect(state().ui.statusMessage).toContain('必须 > 0')
  })
})

describe('铁律 2：派生数据级联重算与缓存', () => {
  it('校准变更 → 数据坐标自动更新', () => {
    cmd.loadImage(IMG)
    const { t2 } = calibrateX()
    cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    const pid = cmd.confirmMarker()!
    const sid = state().model.activeSeriesId!

    const before = dataPointsOf(state().model, sid)
    expect(before[0].x).toBeCloseTo(5)

    cmd.setTickValue('x', t2, 20) // 校准变更
    const after = dataPointsOf(state().model, sid)
    expect(after[0].x).toBeCloseTo(10) // 级联重算，无旧值残留
    expect(after[0].pointId).toBe(pid)
  })

  it('输入分支未变时返回缓存引用；变更后失效', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    cmd.confirmMarker()
    const sid = state().model.activeSeriesId!

    const a = dataPointsOf(state().model, sid)
    const b = dataPointsOf(state().model, sid)
    expect(b).toBe(a) // 缓存命中：同一引用

    cmd.setStatus(null) // 无关 ui 变更不影响缓存
    expect(dataPointsOf(state().model, sid)).toBe(a)

    cmd.movePointBy(state().model.series[0].points[0].id, 1, 0) // series 分支变更
    const c = dataPointsOf(state().model, sid)
    expect(c).not.toBe(a) // 缓存失效
    expect(c[0].x).toBeCloseTo(5.1)
  })

  it('跳过轴在派生数据中整列不出现（F1.1）', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.setAxisSkipped('y', true)
    cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    cmd.confirmMarker()
    const dp = dataPointsOf(state().model, state().model.activeSeriesId!)
    expect(dp[0].x).toBeCloseTo(5)
    expect('y' in dp[0]).toBe(false)
  })
})

describe('门控（§6.1，唯一校验源）', () => {
  it('未加载图像：画轴/裁剪不可用', () => {
    expect(gateFor(state(), 'drawXAxis').enabled).toBe(false)
    expect(gateFor(state(), 'imageEdit').enabled).toBe(false)
  })

  it('标刻度需先画轴且未跳过；拟合需恰好 2 刻度且待拟合', () => {
    cmd.loadImage(IMG)
    expect(gateFor(state(), 'markTickX').enabled).toBe(false) // 未画轴
    cmd.setAxisLine('x', 500)
    expect(gateFor(state(), 'markTickX').enabled).toBe(true)
    expect(gateFor(state(), 'fitTickX').enabled).toBe(false) // 0 个刻度
    cmd.addTick('x', { x: 100, y: 500 })
    expect(gateFor(state(), 'fitTickX').enabled).toBe(false) // 1 个刻度
    cmd.addTick('x', { x: 200, y: 500 })
    expect(gateFor(state(), 'fitTickX').enabled).toBe(true) // 2 个待拟合
  })

  it('取点需 ≥1 轴已校准 + 当前序列；导出只需校准；刻度上限为 2', () => {
    cmd.loadImage(IMG)
    expect(gateFor(state(), 'extractMarker').enabled).toBe(false)
    calibrateX()
    const g = gateFor(state(), 'extractMarker')
    expect(g.enabled).toBe(false)
    if (!g.enabled) expect(g.reason).toContain('新建序列')
    expect(gateFor(state(), 'export').enabled).toBe(true)
    cmd.addSeries('bar', 'A')
    expect(gateFor(state(), 'extractMarker').enabled).toBe(true)
    expect(state().model.series[0]).toMatchObject({ chartType: 'bar', barSpan: 40 })
    expect(cmd.addTick('x', { x: 300, y: 500 })).toBeNull() // 第 3 个被拒绝
    expect(state().ui.statusMessage).toContain('恰好 2 个刻度')
  })

  it('toolEnabled 覆盖三族六种工具', () => {
    cmd.loadImage(IMG)
    const gates = toolEnabled(state())
    expect(Object.keys(gates)).toHaveLength(6)
    expect(gates.markTickY.enabled).toBe(false)
    expect(gates.drawYAxis.enabled).toBe(true)
  })
})

describe('退化校准：已校准 = 映射可解', () => {
  it('两刻度值相同 → 不算已校准，phase=invalid 并给出原因，取点不可用', () => {
    cmd.loadImage(IMG)
    const { t2 } = calibrateX()
    cmd.setTickValue('x', t2, 0)
    const cal = state().model.calibration.x
    expect(isAxisCalibrated(cal)).toBe(false)
    expect(axisPhase(cal)).toBe('invalid')
    expect(axisIssue(cal)).toContain('刻度值相同')
    expect(axisMapping(cal)).toBeNull()
    expect(gateFor(state(), 'export').enabled).toBe(false)
    expect(nextActionHint(state())).toContain('X 轴校准无效')
  })

  it('两刻度拟合到同一位置 → invalid', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 500)
    const t1 = cmd.addTick('x', { x: 100, y: 510 })!
    const t2 = cmd.addTick('x', { x: 104, y: 510 })!
    cmd.applyTickFit('x', { [t1]: 101.5, [t2]: 101.5 })
    cmd.setTickValue('x', t1, 0)
    cmd.setTickValue('x', t2, 10)
    expect(axisPhase(state().model.calibration.x)).toBe('invalid')
    expect(axisIssue(state().model.calibration.x)).toContain('同一位置')
  })

  it('切换刻度类型清空两个刻度值（先填 0/100 再切对数不会留下非法值）', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.setScaleType('x', 'log')
    const cal = state().model.calibration.x
    expect(cal.ticks.map((t) => t.value)).toEqual([null, null])
    expect(cal.ticks.every((t) => t.fittedPos !== null)).toBe(true) // 位置与拟合保留
    expect(axisPhase(cal)).toBe('needValues')
    expect(state().ui.statusMessage).toContain('重新输入')
  })
})

describe('删除轴线 / 选中轴线', () => {
  it('删除轴线连带清除刻度与刻度值，已取点保留', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    cmd.confirmMarker()
    cmd.selectAxis('x')
    cmd.deleteAxisLine('x')
    const m = state().model
    expect(m.calibration.x.axisLine).toBeNull()
    expect(m.calibration.x.ticks).toHaveLength(0)
    expect(axisStatus(m.calibration.x)).toBe('unset')
    expect(m.series[0].points).toHaveLength(1)
    expect(state().ui.selectedAxis).toBeNull()
  })

  it('切换工具清除轴线选中', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 500)
    cmd.selectAxis('x')
    cmd.setActiveTool('markTickX')
    expect(state().ui.selectedAxis).toBeNull()
  })
})

describe('工具门控失效自动回退', () => {
  it('删除最后一个序列 → 取点工具退回画轴', () => {
    cmd.loadImage(IMG)
    calibrateX()
    const sid = cmd.addSeries('scatter', 'A')
    cmd.setActiveTool('extractMarker')
    cmd.setPendingMarker({ x: 1, y: 1 })
    cmd.deleteSeries(sid)
    expect(state().ui.activeTool).toBe('drawXAxis')
    expect(state().ui.pendingMarkers).toEqual([])
  })

  it('标 Y 刻度时跳过 Y 轴 → 退回画 Y 轴；换图后取点工具不再停留', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('y', 300)
    cmd.setActiveTool('markTickY')
    cmd.setAxisSkipped('y', true)
    expect(state().ui.activeTool).toBe('drawYAxis')

    calibrateX()
    cmd.setAxisSkipped('y', false)
    cmd.addSeries('scatter', 'A')
    cmd.setActiveTool('extractMarker')
    cmd.loadImage({ ...IMG, name: 'test2.png' })
    expect(state().ui.activeTool).toBe('drawXAxis')
  })

  it('扫描窗口按轴设置，取整并钳制', () => {
    expect(state().ui.tickScanHalf).toEqual({ x: 10, y: 10 })
    cmd.setTickScanHalf('x', 6.4)
    cmd.setTickScanHalf('y', 999)
    expect(state().ui.tickScanHalf).toEqual({ x: 6, y: 60 })
  })
})

describe('取点语义（§6.3 / §6.5）', () => {
  it('Confirm 自动编号（前缀+序号），序号不复用', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    const p1 = cmd.confirmMarker()!
    cmd.setPendingMarker({ x: 160, y: 300 })
    cmd.confirmMarker()
    let pts = state().model.series[0].points
    expect(pts.map((p) => p.name)).toEqual(['A1', 'A2'])

    cmd.deletePoint(p1) // 删除 A1
    cmd.setPendingMarker({ x: 170, y: 300 })
    cmd.confirmMarker()
    pts = state().model.series[0].points
    expect(pts.map((p) => p.name)).toEqual(['A2', 'A3']) // 不复用 A1
  })

  it('改前缀：自动命名的已有点跟着改，手动改过名的点不变，之后的新点用新前缀', () => {
    cmd.loadImage(IMG)
    calibrateX()
    const sid = cmd.addSeries('scatter', 'A')
    for (const x of [150, 160, 170]) {
      cmd.setPendingMarker({ x, y: 300 })
      cmd.confirmMarker()
    }
    const pts = () => state().model.series[0].points.map((p) => p.name)
    cmd.renamePoint(state().model.series[0].points[1].id, '峰值')
    cmd.setPointPrefix(sid, 'B')
    expect(pts()).toEqual(['B1', '峰值', 'B3'])
    cmd.setPointPrefix(sid, '') // 逐字删空再输入，中间态不丢序号
    cmd.setPointPrefix(sid, 'C')
    expect(pts()).toEqual(['C1', '峰值', 'C3'])
    cmd.setPendingMarker({ x: 180, y: 300 })
    cmd.confirmMarker()
    expect(pts()).toEqual(['C1', '峰值', 'C3', 'C4'])
  })

  it('改序列名：前缀仍是默认值时跟着改；单独设过前缀后不再跟随', () => {
    cmd.loadImage(IMG)
    calibrateX()
    const sid = cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    cmd.confirmMarker()
    cmd.renameSeries(sid, '组A')
    expect(state().model.series[0]).toMatchObject({ pointPrefix: '组A' })
    expect(state().model.series[0].points[0].name).toBe('组A1')
    cmd.setPointPrefix(sid, 'P')
    cmd.renameSeries(sid, '组B')
    expect(state().model.series[0].points[0].name).toBe('P1')
  })

  it('无活动序列时 Confirm 为 no-op + 状态栏提示（F6.3）', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.setPendingMarker({ x: 150, y: 300 })
    expect(cmd.confirmMarker()).toBeNull()
    expect(state().ui.statusMessage).toContain('新建并选中一个序列')
    expect(state().model.series).toHaveLength(0)
  })

  it('方向键步进移动 + 级联重算', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    const pid = cmd.confirmMarker()!
    cmd.movePointBy(pid, 10, 0) // Shift 粗调由 UI 层换算步进
    const dp = dataPointsOf(state().model, state().model.activeSeriesId!)
    expect(dp[0].x).toBeCloseTo(6)
  })

  it('删除序列后活动序列转移', () => {
    cmd.loadImage(IMG)
    const s1 = cmd.addSeries('scatter', 'A')
    const s2 = cmd.addSeries('scatter', 'B')
    expect(state().model.activeSeriesId).toBe(s2)
    cmd.deleteSeries(s2)
    expect(state().model.activeSeriesId).toBe(s1)
    cmd.deleteSeries(s1)
    expect(state().model.activeSeriesId).toBeNull()
  })
})

describe('换图全量重置（§6.6、F3.4）', () => {
  it('loadImage 清空校准与取点，无旧数据残留', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    cmd.confirmMarker()

    cmd.loadImage({ ...IMG, name: 'test2.png' })
    const m = state().model
    expect(m.image!.name).toBe('test2.png')
    expect(m.calibration.x.axisLine).toBeNull()
    expect(m.series).toHaveLength(0)
    expect(state().ui.pendingMarkers).toEqual([])
  })

  it('裁剪确认（resetModelKeepingImage）保留图像元信息、清空校准与点', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.addSeries('scatter', 'A')
    cmd.resetModelKeepingImage({ width: 1000, height: 750 })
    const m = state().model
    expect(m.image).toMatchObject({ name: 'test1.png', width: 1000, height: 750 })
    expect(m.calibration.x.ticks).toHaveLength(0)
    expect(m.series).toHaveLength(0)
  })
})
