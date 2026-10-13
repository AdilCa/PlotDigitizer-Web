// annotatedLabel.ts — 标注截图点名的摆放（纯函数，Worker 与单测共用）
// 默认放在标记右上方；会越出右/上边界时翻到左侧/下方，保证名字完整落在图内。

export interface LabelBox {
  /** 文字左边缘 x（textAlign = left） */
  x: number
  /** 文字基线 y（textBaseline = alphabetic） */
  y: number
}

/** 字号随标记半径缩放，与标记大小观感一致 */
export function labelFontSize(markerRadius: number): number {
  return Math.max(11, Math.round(markerRadius * 2.6))
}

export function placeLabel(
  m: { x: number; y: number },
  r: number,
  text: { width: number; height: number },
  image: { width: number; height: number },
): LabelBox {
  const gap = r * 1.2
  let x = m.x + gap
  if (x + text.width > image.width) x = m.x - gap - text.width
  let y = m.y - gap
  if (y - text.height < 0) y = m.y + gap + text.height
  return {
    x: Math.min(Math.max(0, x), Math.max(0, image.width - text.width)),
    y: Math.min(Math.max(text.height, y), image.height),
  }
}
