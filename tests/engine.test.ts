// M1-5 验收单测：Rec.601 灰度化（§4.1）
import { describe, expect, it } from 'vitest'
import { toGray } from '../src/engine/gray'
import { shouldReleaseOriginal, thumbSize } from '../src/worker/protocol'

function rgbaOf(...pixels: [number, number, number][]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b], i) => {
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 255
  })
  return out
}

describe('toGray（Rec.601，与 cv::COLOR_BGR2GRAY 一致）', () => {
  it('纯色转换：红 76 / 绿 150 / 蓝 29 / 白 255 / 黑 0', () => {
    const gray = toGray(rgbaOf([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]), 5, 1)
    expect([...gray]).toEqual([76, 150, 29, 255, 0])
  })

  it('中性灰恒等（128 → 128）', () => {
    const gray = toGray(rgbaOf([128, 128, 128]), 1, 1)
    expect(gray[0]).toBe(128)
  })

  it('输入长度不符时报错', () => {
    expect(() => toGray(new Uint8ClampedArray(8), 2, 2)).toThrow()
  })
})

describe('处理轨释放分支（§5.4，M1-9）', () => {
  it('长边 >4096 释放原图，否则常驻', () => {
    expect(shouldReleaseOriginal(4096, 3000)).toBe(false)
    expect(shouldReleaseOriginal(4097, 100)).toBe(true)
    expect(shouldReleaseOriginal(8000, 6000)).toBe(true)
  })
})

describe('显示轨缩略图尺寸（§5.1）', () => {
  it('长边 ≤2048 不缩放；超出按比例缩到 2048', () => {
    expect(thumbSize(2000, 1500)).toEqual({ width: 2000, height: 1500 })
    expect(thumbSize(4000, 3000)).toEqual({ width: 2048, height: 1536 })
    expect(thumbSize(8000, 1000)).toEqual({ width: 2048, height: 256 })
  })
})
