// M1-1 验收单测：轴四态、两点映射、铁律 2 级联与缓存、门控、点操作语义
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, createFreshUi } from '../src/state/store'
import { createEmptyModel, type ImageRef } from '../src/state/model'
import {
  axisMapping,
  axisStatus,
  axisValueAt,
  dataPointsOf,
  gateFor,
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
    const sid = cmd.addSeries('A')
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
    cmd.addSeries('A')
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
    cmd.addSeries('A')
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
    cmd.addSeries('A')
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

  it('取点/导出需 ≥1 轴已校准；刻度上限为 2', () => {
    cmd.loadImage(IMG)
    expect(gateFor(state(), 'extractMarker').enabled).toBe(false)
    calibrateX()
    expect(gateFor(state(), 'extractMarker').enabled).toBe(true)
    expect(gateFor(state(), 'export').enabled).toBe(true)
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

describe('取点语义（§6.3 / §6.5）', () => {
  it('Confirm 自动编号（前缀+序号），序号不复用', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.addSeries('A')
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
    cmd.addSeries('A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    const pid = cmd.confirmMarker()!
    cmd.movePointBy(pid, 10, 0) // Shift 粗调由 UI 层换算步进
    const dp = dataPointsOf(state().model, state().model.activeSeriesId!)
    expect(dp[0].x).toBeCloseTo(6)
  })

  it('删除序列后活动序列转移', () => {
    cmd.loadImage(IMG)
    const s1 = cmd.addSeries('A')
    const s2 = cmd.addSeries('B')
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
    cmd.addSeries('A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    cmd.confirmMarker()

    cmd.loadImage({ ...IMG, name: 'test2.png' })
    const m = state().model
    expect(m.image!.name).toBe('test2.png')
    expect(m.calibration.x.axisLine).toBeNull()
    expect(m.series).toHaveLength(0)
    expect(state().ui.pendingMarker).toBeNull()
  })

  it('裁剪确认（resetModelKeepingImage）保留图像元信息、清空校准与点', () => {
    cmd.loadImage(IMG)
    calibrateX()
    cmd.addSeries('A')
    cmd.resetModelKeepingImage({ width: 1000, height: 750 })
    const m = state().model
    expect(m.image).toMatchObject({ name: 'test1.png', width: 1000, height: 750 })
    expect(m.calibration.x.ticks).toHaveLength(0)
    expect(m.series).toHaveLength(0)
  })
})
