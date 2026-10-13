// M1-3 验收单测：buildScene 纯函数 —— 图层、屏幕空间恒定尺寸、语义色、选中/调试叠加
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, createFreshUi } from '../src/state/store'
import { createEmptyModel, type ImageRef } from '../src/state/model'
import * as cmd from '../src/state/commands'
import {
  buildScene,
  CANVAS_COLORS,
  SCREEN_SIZE,
  SERIES_COLORS,
  type Primitive,
} from '../src/render/canvasRenderer'
import { identityViewport } from '../src/render/viewport'

const IMG: ImageRef = { name: 'test1.png', sourceType: 'file', width: 2000, height: 1500 }
const VP1 = identityViewport() // scale = 1

function state() {
  return useStore.getState()
}
function lines(prims: Primitive[]) {
  return prims.filter((p) => p.kind === 'line')
}
function circles(prims: Primitive[]) {
  return prims.filter((p) => p.kind === 'circle')
}

beforeEach(() => {
  useStore.setState({ model: createEmptyModel(), ui: createFreshUi() }, true)
})

describe('无图像 → 空场景', () => {
  it('未加载图像时不产出图元', () => {
    const scene = buildScene(state(), VP1)
    expect(scene.image).toBeNull()
    expect(scene.primitives).toHaveLength(0)
  })
})

describe('校准层（轴线 + 刻度）', () => {
  it('X 轴线：success 实线、横贯全图宽、线宽屏幕恒定', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 500)
    const prims = buildScene(state(), VP1).primitives
    const axis = lines(prims).find((l) => l.kind === 'line' && l.y1 === 500 && l.y2 === 500)!
    expect(axis).toMatchObject({ x1: 0, x2: 2000, color: CANVAS_COLORS.success, width: SCREEN_SIZE.axisWidth })

    const vp4 = { scale: 4, offsetX: 0, offsetY: 0 }
    const axis4 = lines(buildScene(state(), vp4).primitives).find((l) => l.kind === 'line' && l.y1 === 500)!
    expect(axis4.width * 4).toBeCloseTo(SCREEN_SIZE.axisWidth) // 屏幕恒定：图像空间宽 × scale 不变
  })

  it('Y 轴线：垂直、纵贯全图高', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('y', 300)
    const axis = lines(buildScene(state(), VP1).primitives).find((l) => l.kind === 'line' && l.x1 === 300 && l.x2 === 300)!
    expect(axis).toMatchObject({ y1: 0, y2: 1500 })
  })

  it('刻度未拟合 = 空心（ink 描边），拟合后 = success 实心（空心→实心，§4.3）', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 500)
    const t1 = cmd.addTick('x', { x: 100, y: 500 })! // addTick 自动选中 → 同坐标有白色焦点环，按半径区分主图元
    const isTick = (c: Primitive, x: number) =>
      c.kind === 'circle' && c.x === x && Math.abs(c.r - SCREEN_SIZE.tickRadius) < 1e-9
    let tick = circles(buildScene(state(), VP1).primitives).find((c) => isTick(c, 100))!
    expect(tick.fill).toBeNull()
    expect(tick.stroke).toBe(CANVAS_COLORS.ink)

    cmd.applyTickFit('x', { [t1]: 102 })
    tick = circles(buildScene(state(), VP1).primitives).find((c) => isTick(c, 102))!
    expect(tick.fill).toBe(CANVAS_COLORS.success)
  })

  it('刻度位置：未拟合画在点击处 at，拟合后吸附到轴线上的投影', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 500)
    const t1 = cmd.addTick('x', { x: 100, y: 512 })!
    const tickAt = () =>
      circles(buildScene(state(), VP1).primitives).find(
        (c) => c.kind === 'circle' && Math.abs(c.r - SCREEN_SIZE.tickRadius) < 1e-9,
      )!
    expect(tickAt()).toMatchObject({ x: 100, y: 512 })
    cmd.applyTickFit('x', { [t1]: 101.5 })
    expect(tickAt()).toMatchObject({ x: 101.5, y: 500 })
  })

  it('选中轴线：轴线下方有宽的半透明光晕', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 500)
    const halo = () =>
      lines(buildScene(state(), VP1).primitives).find(
        (l) => l.kind === 'line' && l.y1 === 500 && l.width === SCREEN_SIZE.selectedAxisWidth,
      )
    expect(halo()).toBeUndefined()
    cmd.selectAxis('x')
    expect(halo()).toMatchObject({ color: CANVAS_COLORS.ink, alpha: 0.25 })
  })

  it('选中刻度：白圈 + ink 描边焦点环', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 500)
    cmd.addTick('x', { x: 100, y: 500 }) // addTick 自动选中
    const prims = buildScene(state(), VP1).primitives
    const ring = circles(prims).some(
      (c) => c.kind === 'circle' && c.fill === CANVAS_COLORS.white && c.x === 100,
    )
    expect(ring).toBe(true)
  })

  it('跳过的轴不绘制', () => {
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 500)
    cmd.setAxisSkipped('x', true)
    expect(buildScene(state(), VP1).primitives).toHaveLength(0)
  })
})

describe('数据点层（铁律 4：全程可见）', () => {
  it('已确认点 40% 透明、按序列着色、半径屏幕恒定 r=4px', () => {
    cmd.loadImage(IMG)
    cmd.addSeries('scatter', 'A')
    cmd.setPendingMarker({ x: 150, y: 300 })
    cmd.confirmMarker()
    cmd.selectPoint(null) // confirm 自动选中新点；取消选中后才是 40% 透明态

    const isMarker = (c: Primitive) => c.kind === 'circle' && c.x === 150 && c.y === 300
    const p1 = circles(buildScene(state(), VP1).primitives).find(isMarker)!
    expect(p1.fill).toBe(SERIES_COLORS[0])
    expect(p1.alpha).toBeCloseTo(0.4)
    expect(p1.r).toBeCloseTo(SCREEN_SIZE.markerRadius)

    const vp4 = { scale: 4, offsetX: 0, offsetY: 0 }
    const p4 = circles(buildScene(state(), vp4).primitives).find(isMarker)!
    expect(p4.r * 4).toBeCloseTo(SCREEN_SIZE.markerRadius) // 屏幕恒定
  })

  it('不同序列不同颜色；选中点实色 + 焦点环', () => {
    cmd.loadImage(IMG)
    cmd.addSeries('scatter', 'A')
    cmd.addSeries('scatter', 'B')
    cmd.setPendingMarker({ x: 10, y: 10 })
    cmd.confirmMarker() // 入 B（活动序列）
    cmd.setActiveSeries(state().model.series[0].id)
    cmd.setPendingMarker({ x: 20, y: 20 })
    const pid = cmd.confirmMarker()! // 入 A

    let prims = buildScene(state(), VP1).primitives
    const colors = [10, 20].map(
      (x) => circles(prims).find((c) => c.kind === 'circle' && c.x === x && c.y === x)!.fill,
    )
    expect(new Set(colors).size).toBe(2)

    cmd.selectPoint(pid)
    prims = buildScene(state(), VP1).primitives
    // 同坐标的白色焦点环外圈先行，按填充色锁定主图元
    const sel = circles(prims).find(
      (c) => c.kind === 'circle' && c.x === 20 && c.fill === SERIES_COLORS[0],
    )!
    expect(sel.alpha).toBe(1)
    expect(sel.stroke).toBe(CANVAS_COLORS.ink)
  })

  it('当前 marker：ink 实心 + 中心十字', () => {
    cmd.loadImage(IMG)
    cmd.setPendingMarker({ x: 400, y: 400 })
    const prims = buildScene(state(), VP1).primitives
    const dot = circles(prims).find((c) => c.kind === 'circle' && c.x === 400)!
    expect(dot.fill).toBe(CANVAS_COLORS.ink)
    expect(dot.alpha).toBe(1)
    const cross = lines(prims).filter((l) => l.color === CANVAS_COLORS.white)
    expect(cross).toHaveLength(2)
  })
})

describe('吸附范围可视化（取点工具）', () => {
  const windows = (prims: Primitive[]) =>
    prims.filter((p) => p.kind === 'rect' && p.stroke === CANVAS_COLORS.warning)

  function setup(chartType: 'scatter' | 'bar' | 'manual') {
    cmd.loadImage(IMG)
    cmd.setAxisLine('x', 1400)
    const t1 = cmd.addTick('x', { x: 100, y: 1400 })!
    const t2 = cmd.addTick('x', { x: 200, y: 1400 })!
    cmd.applyTickFit('x', { [t1]: 100, [t2]: 200 })
    cmd.setTickValue('x', t1, 0)
    cmd.setTickValue('x', t2, 10)
    const sid = cmd.addSeries(chartType, 'A')
    cmd.setActiveTool('extractMarker')
    return sid
  }

  it('散点：未确认标记周围画出 (2r+1)² 窗口，随半径变化', () => {
    const sid = setup('scatter')
    cmd.setPendingMarker({ x: 400.3, y: 300.8 })
    expect(windows(buildScene(state(), VP1).primitives)).toEqual([
      expect.objectContaining({ x: 392, y: 292, w: 17, h: 17, alpha: 0.9 }),
    ])
    cmd.setScatterRadius(sid, 3)
    expect(windows(buildScene(state(), VP1).primitives)[0]).toMatchObject({ x: 397, y: 297, w: 7, h: 7 })
  })

  it('光标处浅色预览；光标压在未确认标记上时不重复画', () => {
    setup('scatter')
    cmd.setHoverImage({ x: 600, y: 600 })
    expect(windows(buildScene(state(), VP1).primitives)).toEqual([expect.objectContaining({ alpha: 0.45 })])
    cmd.setPendingMarker({ x: 600, y: 600 })
    expect(windows(buildScene(state(), VP1).primitives)).toHaveLength(1)
  })

  it('柱状画扫描条带；手动序列与其他工具不画', () => {
    const sid = setup('bar')
    cmd.setPendingMarker({ x: 400, y: 300 })
    expect(windows(buildScene(state(), VP1).primitives)[0]).toMatchObject({ x: 395, y: 300, w: 11, h: 41 })
    cmd.setChartType(sid, 'manual')
    expect(windows(buildScene(state(), VP1).primitives)).toHaveLength(0)
    cmd.setChartType(sid, 'bar')
    cmd.setActiveTool('drawXAxis')
    cmd.setHoverImage({ x: 600, y: 600 })
    expect(windows(buildScene(state(), VP1).primitives)).toHaveLength(0)
  })
})

describe('调试叠加层（铁律 5 默认行为）', () => {
  it('扫描带 ink 10% / 候选线 warning 虚线 / 内外点 success/danger', () => {
    cmd.loadImage(IMG)
    cmd.setDebugOverlay({
      scanBands: [{ x: 0, y: 490, w: 2000, h: 20 }],
      candidateLines: [{ axis: 'x', pos: 495 }],
      samplePoints: [{ x: 1, y: 2 }],
      inliers: [{ x: 3, y: 4 }],
      outliers: [{ x: 5, y: 6 }],
    })
    const prims = buildScene(state(), VP1).primitives
    const band = prims.find((p) => p.kind === 'rect')!
    expect(band).toMatchObject({ fill: CANVAS_COLORS.ink, alpha: 0.1 })
    const cand = lines(prims).find((l) => l.color === CANVAS_COLORS.warning)!
    expect(cand.dash).toBeDefined()
    expect(circles(prims).some((c) => c.kind === 'circle' && c.fill === CANVAS_COLORS.success)).toBe(true)
    expect(circles(prims).some((c) => c.kind === 'circle' && c.fill === CANVAS_COLORS.danger)).toBe(true)
  })

  it('debugOverlay 为 null 时不产出调试图元', () => {
    cmd.loadImage(IMG)
    expect(buildScene(state(), VP1).primitives.some((p) => p.kind === 'rect')).toBe(false)
  })
})
