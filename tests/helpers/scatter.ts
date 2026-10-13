// scatter.ts — 测试侧模拟 Worker 的散点 refine：按 scatterPatchRect 从整图 RGBA 切出局部块再调用 engine
import type { PixelPoint } from '../../src/state/model'
import { estimateBackground, refineScatter, scatterPatchRect, type Rgb } from '../../src/engine/markerBlob'

export function scatterRefineAt(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  pt: PixelPoint,
  r = 8,
  bg: Rgb = estimateBackground(rgba, width, height),
) {
  const rect = scatterPatchRect(pt, r, width, height)
  const data = new Uint8ClampedArray(rect.w * rect.h * 4)
  for (let y = 0; y < rect.h; y++) {
    const from = ((rect.y + y) * width + rect.x) * 4
    data.set(rgba.subarray(from, from + rect.w * 4), y * rect.w * 4)
  }
  return refineScatter(pt, { data, ...rect }, bg, r)
}
