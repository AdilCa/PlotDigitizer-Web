// hitTest.test.ts — 画布图元命中测试
import { describe, expect, it } from 'vitest'
import { hitPoint, hitTick } from '../src/interact/hitTest'
import { createEmptyModel } from '../src/state/model'
import type { AxisCalibration } from '../src/state/model'

function calWithTick(): AxisCalibration {
  const model = createEmptyModel()
  const cal = model.calibration.x
  cal.axisLine = 500
  cal.ticks.push({ id: 't1', pos: 200, at: { x: 200, y: 512 }, fittedPos: null, value: null })
  return cal
}

describe('hitTick：刻度命中（§4.3 刻度中心 = 轴线上的投影点）', () => {
  it('X 轴：命中 (t.pos, axisLine) 附近', () => {
    const cal = calWithTick()
    expect(hitTick(cal, 'x', { x: 203, y: 502 }, 8)?.id).toBe('t1')
    expect(hitTick(cal, 'x', { x: 300, y: 500 }, 8)).toBeNull()
  })

  it('点击处偏离轴线但在容差内仍命中（欧氏距离）', () => {
    const cal = calWithTick()
    // (206, 506) 距 (200, 500) = √(36+36) ≈ 8.49 > 8 → 不命中
    expect(hitTick(cal, 'x', { x: 206, y: 506 }, 8)).toBeNull()
    // (204, 504) 距 (200, 500) ≈ 5.66 ≤ 8 → 命中
    expect(hitTick(cal, 'x', { x: 204, y: 504 }, 8)?.id).toBe('t1')
  })

  it('Y 轴：命中 (axisLine, t.pos)', () => {
    const model = createEmptyModel()
    const cal = model.calibration.y
    cal.axisLine = 300
    cal.ticks.push({ id: 'u1', pos: 700, at: { x: 250, y: 700 }, fittedPos: null, value: null })
    expect(hitTick(cal, 'y', { x: 302, y: 698 }, 8)?.id).toBe('u1')
    expect(hitTick(cal, 'y', { x: 700, y: 300 }, 8)).toBeNull()
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
