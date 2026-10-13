import { describe, expect, it } from 'vitest'
import { labelFontSize, placeLabel } from '../src/render/annotatedLabel'

const IMG = { width: 800, height: 600 }
const TEXT = { width: 40, height: 12 }

describe('标注截图点名摆放', () => {
  it('默认在标记右上方', () => {
    const at = placeLabel({ x: 400, y: 300 }, 5, TEXT, IMG)
    expect(at.x).toBeGreaterThan(400)
    expect(at.y).toBeLessThan(300)
  })

  it('靠右边界翻到左侧，靠上边界翻到下方，文字完整落在图内', () => {
    const at = placeLabel({ x: 790, y: 3 }, 5, TEXT, IMG)
    expect(at.x + TEXT.width).toBeLessThan(790)
    expect(at.y - TEXT.height).toBeGreaterThan(3)
  })

  it('图比文字还窄时钳在左边缘', () => {
    const at = placeLabel({ x: 10, y: 300 }, 5, TEXT, { width: 30, height: 600 })
    expect(at.x).toBe(0)
  })

  it('字号随标记半径缩放，最小 11px', () => {
    expect(labelFontSize(4)).toBe(11)
    expect(labelFontSize(10)).toBe(26)
  })
})
