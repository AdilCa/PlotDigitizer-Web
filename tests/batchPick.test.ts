// 批量取点：连续放置多个标记，Confirm 一次全部 refine，按放置顺序编号
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RefineItem, RefinedItem } from '../src/worker/protocol'

const refineMock = vi.fn<(items: RefineItem[]) => Promise<RefinedItem[]>>()
vi.mock('../src/worker/workerClient', () => ({
  workerRefinePoints: (items: RefineItem[]) => refineMock(items),
}))

const { useStore, createFreshUi } = await import('../src/state/store')
const { createEmptyModel } = await import('../src/state/model')
const cmd = await import('../src/state/commands')
const marker = await import('../src/interact/markerTool')

const IMG = { name: 'bars.png', sourceType: 'file' as const, width: 800, height: 600 }
const state = () => useStore.getState()
const names = () => state().model.series[0].points.map((p) => p.name)
const pixels = () => state().model.series[0].points.map((p) => p.pixel)

/** 柱顶统一吸附到 y=100；x=300 处模拟找不到边缘 */
function barTopsAt100(items: RefineItem[]): Promise<RefinedItem[]> {
  return Promise.resolve(
    items.map((it) =>
      it.x === 300 ? { refId: it.refId, x: it.x, y: it.y, snapped: false } : { refId: it.refId, x: it.x, y: 100, snapped: true },
    ),
  )
}

beforeEach(() => {
  useStore.setState({ model: createEmptyModel(), ui: createFreshUi() }, true)
  refineMock.mockReset()
  cmd.loadImage(IMG)
  cmd.addSeries('bar', 'B')
  cmd.setActiveTool('extractMarker')
})

function click(x: number, y: number): void {
  marker.dragStart({ x, y })
  marker.dragEnd()
}

describe('批量取点交互（markerTool）', () => {
  it('关闭时点击空白替换标记，开启后追加', () => {
    click(100, 200)
    click(150, 200)
    expect(state().ui.pendingMarkers).toEqual([{ x: 150, y: 200 }])
    cmd.setBatchPick(true)
    click(200, 200)
    click(250, 200)
    expect(state().ui.pendingMarkers).toHaveLength(3)
  })

  it('按下已放的未确认标记 = 拖动它，不新增', () => {
    cmd.setBatchPick(true)
    click(100, 200)
    click(200, 200)
    marker.dragStart({ x: 102, y: 201 })
    marker.dragMove({ x: 112, y: 231 })
    marker.dragEnd()
    expect(state().ui.pendingMarkers).toEqual([
      { x: 110, y: 230 },
      { x: 200, y: 200 },
    ])
  })

  it('切换批量开关不动已放下的标记', () => {
    cmd.setBatchPick(true)
    click(100, 200)
    click(200, 200)
    cmd.setBatchPick(false)
    expect(state().ui.pendingMarkers).toHaveLength(2)
  })
})

describe('批量 Confirm（confirmMarkerRefined）', () => {
  it('一次 Worker 请求，按放置顺序提交与编号，状态栏汇总', async () => {
    refineMock.mockImplementation(barTopsAt100)
    cmd.setBatchPick(true)
    for (const x of [500, 100, 200]) click(x, 300)
    const ids = await cmd.confirmMarkerRefined()
    expect(ids).toHaveLength(3)
    expect(refineMock).toHaveBeenCalledTimes(1)
    expect(refineMock.mock.calls[0][0].map((it) => [it.x, it.mode, it.barSpan])).toEqual([
      [500, 'bar', 40],
      [100, 'bar', 40],
      [200, 'bar', 40],
    ])
    expect(names()).toEqual(['B1', 'B2', 'B3'])
    expect(pixels().map((p) => p.x)).toEqual([500, 100, 200])
    expect(pixels().every((p) => p.y === 100)).toBe(true)
    expect(state().ui.pendingMarkers).toEqual([])
    expect(state().ui.selectedPointId).toBe(ids[2])
    expect(state().ui.statusMessage).toBe('已确认 3 个点（B1–B3），全部已吸附（最大移动 200.0px）')
  })

  it('部分未吸附：按原位置提交并点名列出', async () => {
    refineMock.mockImplementation(barTopsAt100)
    cmd.setBatchPick(true)
    for (const x of [100, 300, 500]) click(x, 300)
    await cmd.confirmMarkerRefined()
    expect(pixels()[1]).toEqual({ x: 300, y: 300 })
    expect(state().ui.statusMessage).toContain('其中 B2 未吸附（未找到柱边缘')
  })

  it('refine 在途时新放的标记属于下一批，重复 Confirm 不会重复提交', async () => {
    let release!: () => void
    refineMock.mockImplementation((items) => new Promise((r) => (release = () => void barTopsAt100(items).then(r))))
    cmd.setBatchPick(true)
    click(100, 300)
    click(200, 300)
    const first = cmd.confirmMarkerRefined()
    expect(await cmd.confirmMarkerRefined()).toEqual([]) // 已被取走，无可提交
    click(400, 300)
    release()
    await first
    expect(names()).toEqual(['B1', 'B2'])
    expect(state().ui.pendingMarkers).toEqual([{ x: 400, y: 300 }])
  })

  it('refine 在途期间换图 → 丢弃结果', async () => {
    let release!: () => void
    refineMock.mockImplementation((items) => new Promise((r) => (release = () => void barTopsAt100(items).then(r))))
    click(100, 300)
    const p = cmd.confirmMarkerRefined()
    cmd.loadImage({ ...IMG, name: 'other.png' })
    release()
    expect(await p).toEqual([])
    expect(state().model.series).toHaveLength(0)
  })

  it('Worker 失败：全部按原位置提交', async () => {
    refineMock.mockRejectedValue(new Error('boom'))
    cmd.setBatchPick(true)
    click(100, 300)
    click(200, 300)
    await cmd.confirmMarkerRefined()
    expect(pixels()).toEqual([
      { x: 100, y: 300 },
      { x: 200, y: 300 },
    ])
    expect(state().ui.statusMessage).toContain('refine 失败')
  })

  it('单点确认每次都有结果反馈：吸附显示移动距离，未吸附说明原因，手动说明不吸附', async () => {
    refineMock.mockImplementation(barTopsAt100)
    click(100, 104)
    await cmd.confirmMarkerRefined()
    expect(state().ui.statusMessage).toBe('已确认 B1：已吸附到柱边缘（移动 4.0px）')
    click(300, 200)
    await cmd.confirmMarkerRefined()
    expect(state().ui.statusMessage).toMatch(/^已确认 B2：未找到柱边缘/)
    cmd.setChartType(state().model.activeSeriesId!, 'manual')
    click(400, 200)
    await cmd.confirmMarkerRefined()
    expect(state().ui.statusMessage).toBe('已确认 B3（手动：按点击位置提交，不吸附）')
  })

  it('散点序列把搜索半径传给 Worker', async () => {
    refineMock.mockImplementation(barTopsAt100)
    const sid = state().model.activeSeriesId!
    cmd.setChartType(sid, 'scatter')
    cmd.setScatterRadius(sid, 5)
    click(100, 300)
    await cmd.confirmMarkerRefined()
    expect(refineMock.mock.calls[0][0][0]).toMatchObject({ mode: 'scatter', scatterRadius: 5 })
  })

  it('散点：状态栏用 Worker 给的未吸附原因；吸附轮廓只保留给本批已吸附的点', async () => {
    const sid = state().model.activeSeriesId!
    cmd.setChartType(sid, 'scatter')
    const outline = [{ x: 98, y: 98 }, { x: 103, y: 98 }, { x: 103, y: 103 }]
    refineMock.mockImplementation((items) =>
      Promise.resolve(
        items.map((it) =>
          it.x === 300
            ? { refId: it.refId, x: it.x, y: it.y, snapped: false, reason: '只碰到线条，没有成块的标记' }
            : { refId: it.refId, x: 100.5, y: 100.5, snapped: true, outline },
        ),
      ),
    )
    cmd.setBatchPick(true)
    click(104, 103)
    click(300, 300)
    await cmd.confirmMarkerRefined()
    expect(state().ui.statusMessage).toBe('已确认 2 个点，其中 B2 未吸附（只碰到线条，没有成块的标记），已按原位置提交')
    const [p1] = state().model.series[0].points
    expect(state().ui.refineOutlines).toEqual([{ pointId: p1.id, at: { x: 100.5, y: 100.5 }, outline }])
  })

  it('manual 序列不走 Worker，按原位置批量提交', async () => {
    cmd.setChartType(state().model.activeSeriesId!, 'manual')
    cmd.setBatchPick(true)
    click(100, 300)
    click(200, 300)
    await cmd.confirmMarkerRefined()
    expect(refineMock).not.toHaveBeenCalled()
    expect(names()).toEqual(['B1', 'B2'])
  })

  it('撤掉最后一个未确认标记', () => {
    cmd.setBatchPick(true)
    click(100, 300)
    click(200, 300)
    cmd.popPendingMarker()
    expect(state().ui.pendingMarkers).toEqual([{ x: 100, y: 300 }])
  })
})
