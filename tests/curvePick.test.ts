// 曲线涂抹取点（§4.6）：markerTool 涂抹笔迹 → confirmCurve 一次 Worker 请求 → 按笔迹方向编号提交
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PixelPoint } from '../src/state/model'
import type { TracedCurve } from '../src/worker/protocol'

const traceMock = vi.fn<(stroke: PixelPoint[], radius: number, step: number) => Promise<TracedCurve>>()
vi.mock('../src/worker/workerClient', () => ({
  workerRefinePoints: () => Promise.reject(new Error('不应调用')),
  workerTraceCurve: (stroke: PixelPoint[], radius: number, step: number) => traceMock(stroke, radius, step),
}))

const { useStore, createFreshUi } = await import('../src/state/store')
const { createEmptyModel } = await import('../src/state/model')
const cmd = await import('../src/state/commands')
const marker = await import('../src/interact/markerTool')

const IMG = { name: 'curves.png', sourceType: 'file' as const, width: 800, height: 600 }
const state = () => useStore.getState()
const RED = { r: 244, g: 14, b: 16 }

beforeEach(() => {
  useStore.setState({ model: createEmptyModel(), ui: createFreshUi() }, true)
  traceMock.mockReset()
  cmd.loadImage(IMG)
  cmd.addSeries('curve', 'C')
  cmd.setActiveTool('extractMarker')
})

function drag(points: PixelPoint[]): void {
  marker.dragStart(points[0])
  for (const p of points.slice(1)) marker.dragMove(p)
  marker.dragEnd()
}

describe('曲线涂抹交互（markerTool）', () => {
  it('曲线序列下拖动 = 涂抹笔迹，不放标记', () => {
    drag([{ x: 100, y: 100 }, { x: 120, y: 105 }, { x: 140, y: 112 }])
    expect(state().ui.curveStroke).toEqual([{ x: 100, y: 100 }, { x: 120, y: 105 }, { x: 140, y: 112 }])
    expect(state().ui.pendingMarkers).toEqual([])
  })

  it('在笔迹末端一个笔刷半径内按下 = 接着涂；别处按下 = 重新开始', () => {
    drag([{ x: 100, y: 100 }, { x: 140, y: 100 }])
    drag([{ x: 145, y: 103 }, { x: 180, y: 110 }])
    expect(state().ui.curveStroke).toHaveLength(4)
    drag([{ x: 400, y: 400 }, { x: 420, y: 400 }])
    expect(state().ui.curveStroke).toEqual([{ x: 400, y: 400 }, { x: 420, y: 400 }])
  })

  it('切换序列类型 / 换工具丢弃未确认笔迹', () => {
    drag([{ x: 100, y: 100 }, { x: 140, y: 100 }])
    cmd.setChartType(state().model.activeSeriesId!, 'scatter')
    expect(state().ui.curveStroke).toEqual([])
    cmd.setChartType(state().model.activeSeriesId!, 'curve')
    drag([{ x: 100, y: 100 }, { x: 140, y: 100 }])
    cmd.setActiveTool('drawXAxis')
    expect(state().ui.curveStroke).toEqual([])
  })
})

describe('confirmCurve', () => {
  it('按 Worker 返回顺序编号提交，笔刷参数传给 Worker，未找到的采样点留给画布', async () => {
    const sid = state().model.activeSeriesId!
    cmd.setCurveRadius(sid, 6)
    cmd.setCurveStep(sid, 3)
    traceMock.mockResolvedValue({
      points: [{ x: 101, y: 100 }, { x: 104, y: 101 }, { x: 107, y: 102 }],
      misses: [{ x: 120, y: 105 }],
      color: RED,
    })
    drag([{ x: 100, y: 100 }, { x: 130, y: 108 }])
    const ids = await cmd.confirmMarkerRefined()
    expect(traceMock).toHaveBeenCalledWith([{ x: 100, y: 100 }, { x: 130, y: 108 }], 6, 3)
    expect(ids).toHaveLength(3)
    expect(state().model.series[0].points.map((p) => p.name)).toEqual(['C1', 'C2', 'C3'])
    expect(state().ui.curveStroke).toEqual([])
    expect(state().ui.curveMisses).toEqual([{ x: 120, y: 105 }])
    expect(state().ui.statusMessage).toBe(
      '已提取 3 个点（C1–C3），曲线色 #F40E10；1 个采样点未找到曲线（橙点标出：被别的线压住、交叠或笔迹偏出），需要的话手动补点',
    )
  })

  it('一个点都没提取到：不提交，笔迹放回去可直接重试', async () => {
    traceMock.mockResolvedValue({ points: [], misses: [], color: null, reason: '笔刷范围内只有背景色' })
    drag([{ x: 100, y: 100 }, { x: 130, y: 108 }])
    await cmd.confirmMarkerRefined()
    expect(state().model.series[0].points).toEqual([])
    expect(state().ui.curveStroke).toHaveLength(2)
    expect(state().ui.statusMessage).toMatch(/^未提取到曲线：笔刷范围内只有背景色/)
  })

  it('Worker 失败：笔迹放回，状态栏说明原因', async () => {
    traceMock.mockRejectedValue(new Error('Worker 无图像源'))
    drag([{ x: 100, y: 100 }, { x: 130, y: 108 }])
    await cmd.confirmMarkerRefined()
    expect(state().ui.curveStroke).toHaveLength(2)
    expect(state().ui.statusMessage).toBe('曲线提取失败（Worker 无图像源）')
  })

  it('提取在途期间换图：丢弃结果', async () => {
    let resolve!: (r: TracedCurve) => void
    traceMock.mockReturnValue(new Promise((r) => (resolve = r)))
    drag([{ x: 100, y: 100 }, { x: 130, y: 108 }])
    const pending = cmd.confirmMarkerRefined()
    cmd.loadImage({ ...IMG, name: 'other.png' })
    resolve({ points: [{ x: 101, y: 100 }], misses: [], color: RED })
    expect(await pending).toEqual([])
    expect(state().model.series).toEqual([])
  })

  it('笔迹不足两点不发请求', async () => {
    drag([{ x: 100, y: 100 }])
    expect(await cmd.confirmMarkerRefined()).toEqual([])
    expect(traceMock).not.toHaveBeenCalled()
  })
})
