// M1-4 验收单测：渲染性能基准
// 平移/缩放仅变换 viewport 矩阵（零像素运算）由架构保证；
// 此处验证每帧 buildScene 的成本为 O(对象数)，在重负载场景下远低于 16ms 帧预算。
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore, createFreshUi } from '../src/state/store'
import { createEmptyModel, type ImageRef } from '../src/state/model'
import * as cmd from '../src/state/commands'
import { buildScene } from '../src/render/canvasRenderer'

const IMG: ImageRef = { name: 'big.png', sourceType: 'file', width: 4000, height: 3000 }

beforeEach(() => {
  useStore.setState({ model: createEmptyModel(), ui: createFreshUi() }, true)
})

describe('buildScene 性能（M1 门禁：4000×3000 操作 >40fps 的 CPU 侧保障）', () => {
  it('重负载场景（8 序列 × 125 点 + 双轴校准 + 调试叠加）远低于 16ms 帧预算', () => {
    cmd.loadImage(IMG)
    // 双轴校准
    cmd.setAxisLine('x', 2600)
    cmd.setAxisLine('y', 300)
    for (const [axis, line] of [['x', 2600], ['y', 300]] as const) {
      void line
      const t1 = cmd.addTick(axis, axis === 'x' ? { x: 400, y: 2600 } : { x: 300, y: 2800 })!
      const t2 = cmd.addTick(axis, axis === 'x' ? { x: 3600, y: 2600 } : { x: 300, y: 400 })!
      cmd.applyTickFit(axis, { [t1]: axis === 'x' ? 400 : 2800, [t2]: axis === 'x' ? 3600 : 400 })
      cmd.setTickValue(axis, t1, 0)
      cmd.setTickValue(axis, t2, 100)
    }
    // 1000 个已确认点（8 序列）
    for (let s = 0; s < 8; s++) {
      cmd.addSeries('scatter', `S${s}`)
      for (let i = 0; i < 125; i++) {
        cmd.setPendingMarker({ x: 400 + i * 25, y: 400 + s * 100 })
        cmd.confirmMarker()
      }
    }
    // 调试叠加（拟合诊断）
    cmd.setDebugOverlay({
      scanBands: [{ x: 0, y: 2590, w: 4000, h: 20 }],
      samplePoints: Array.from({ length: 64 }, (_, i) => ({ x: i * 60, y: 2600 })),
    })
    cmd.setCropBox({ x: 100, y: 100, w: 1000, h: 800 }) // 裁剪预览叠加也在帧内

    const state = useStore.getState()
    const vp = { scale: 0.5, offsetX: 100, offsetY: 60 }
    // 预热
    for (let i = 0; i < 20; i++) buildScene(state, vp)

    const N = 200
    const t0 = performance.now()
    let prims = 0
    for (let i = 0; i < N; i++) {
      prims = buildScene(state, vp).primitives.length
    }
    const avg = (performance.now() - t0) / N

    expect(prims).toBeGreaterThan(1000) // 确实渲染了全量对象（铁律 4）
    expect(avg).toBeLessThan(8) // 16ms 帧预算的一半以内，留足 paint 余量
  })
})
