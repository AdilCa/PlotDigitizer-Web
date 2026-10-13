// hitTest.test.ts — 画布图元命中测试
import { describe, expect, it } from 'vitest'
import { hitAxisLine, hitPoint, hitTick } from '../src/interact/hitTest'
import { createEmptyModel } from '../src/state/model'
import type { AxisCalibration } from '../src/state/model'

function calWithTick(): AxisCalibration {
  const model = createEmptyModel()
  const cal = model.calibration.x
  cal.axisLine = 500
  cal.ticks.push({ id: 't1', pos: 200, at: { x: 200, y: 512 }, fittedPos: null, value: null })
  return cal
}

describe('hitTick：刻度命中（按显示位置：未拟合 = 点击处，已拟合 = 轴线上的投影）', () => {
  it('X 轴未拟合：命中点击处 at=(200,512) 附近，轴线上不命中', () => {
    const cal = calWithTick()
    expect(hitTick(cal, 'x', { x: 203, y: 514 }, 8)?.id).toBe('t1')
    expect(hitTick(cal, 'x', { x: 200, y: 500 }, 8)).toBeNull()
  })

  it('X 轴已拟合：命中 (pos, axisLine)，原点击处不再命中', () => {
    const cal = calWithTick()
    cal.ticks[0].pos = 201
    cal.ticks[0].fittedPos = 201
    expect(hitTick(cal, 'x', { x: 204, y: 502 }, 8)?.id).toBe('t1')
    expect(hitTick(cal, 'x', { x: 200, y: 512 }, 8)).toBeNull()
  })

  it('欧氏距离容差', () => {
    const cal = calWithTick()
    // (206, 518) 距 (200, 512) ≈ 8.49 > 8 → 不命中；(204, 516) ≈ 5.66 → 命中
    expect(hitTick(cal, 'x', { x: 206, y: 518 }, 8)).toBeNull()
    expect(hitTick(cal, 'x', { x: 204, y: 516 }, 8)?.id).toBe('t1')
  })

  it('Y 轴未拟合：命中点击处 at', () => {
    const model = createEmptyModel()
    const cal = model.calibration.y
    cal.axisLine = 300
    cal.ticks.push({ id: 'u1', pos: 700, at: { x: 250, y: 700 }, fittedPos: null, value: null })
    expect(hitTick(cal, 'y', { x: 252, y: 698 }, 8)?.id).toBe('u1')
    expect(hitTick(cal, 'y', { x: 300, y: 700 }, 8)).toBeNull()
  })

  it('hitAxisLine：按垂直距离命中，跳过的轴不命中', () => {
    const cal = calWithTick()
    expect(hitAxisLine(cal, 'x', { x: 1234, y: 506 }, 8)).toBe(true)
    expect(hitAxisLine(cal, 'x', { x: 10, y: 509 }, 8)).toBe(false)
    cal.skipped = true
    expect(hitAxisLine(cal, 'x', { x: 10, y: 500 }, 8)).toBe(false)
  })

  it('无轴线 → 不命中', () => {
    const model = createEmptyModel()
    const cal = model.calibration.x
    cal.ticks.push({ id: 't1', pos: 200, at: { x: 200, y: 512 }, fittedPos: null, value: null })
    expect(hitTick(cal, 'x', { x: 200, y: 500 }, 8)).toBeNull()
  })
})

describe('hitPoint：数据点命中（§6.3，M3-3 屏幕恒定半径换算）', () => {
  function modelWithPoints(): ReturnType<typeof createEmptyModel> {
    const model = createEmptyModel()
    const s1 = { ...model.series } // 占位避免 lint
    void s1
    model.series.push({
      id: 's1',
      name: 'A',
      chartType: 'scatter',
      barDirection: 'down',
      barSpan: 40,
      scatterRadius: 8,
      curveRadius: 10,
      curveStep: 4,
      pointPrefix: 'A',
      nextPointSeq: 2,
      points: [
        { id: 'p1', pixel: { x: 100, y: 100 }, name: 'A1' },
        { id: 'p2', pixel: { x: 300, y: 100 }, name: 'A2' },
      ],
    })
    model.series.push({
      id: 's2',
      name: 'B',
      chartType: 'scatter',
      barDirection: 'down',
      barSpan: 40,
      scatterRadius: 8,
      curveRadius: 10,
      curveStep: 4,
      pointPrefix: 'B',
      nextPointSeq: 1,
      points: [{ id: 'p3', pixel: { x: 108, y: 108 }, name: 'B1' }],
    })
    return model
  }

  it('命中最近点，跨序列', () => {
    const model = modelWithPoints()
    expect(hitPoint(model, { x: 102, y: 101 }, 8)?.point.id).toBe('p1')
    // (106,106) 距 p1 ≈ 8.49，距 p3 ≈ 2.83 → p3（不同序列更近）
    expect(hitPoint(model, { x: 106, y: 106 }, 8)?.point.id).toBe('p3')
  })

  it('容差外不命中；空模型不命中', () => {
    const model = modelWithPoints()
    expect(hitPoint(model, { x: 200, y: 200 }, 8)).toBeNull()
    expect(hitPoint(createEmptyModel(), { x: 100, y: 100 }, 8)).toBeNull()
  })
})
