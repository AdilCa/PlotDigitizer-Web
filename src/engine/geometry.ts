// geometry.ts — 像素 ↔ 数据线性映射（§4.5）
// 纯函数，零 DOM / 零 store 依赖（engine 层契约）。
// 每轴独立两点解析求解 value = a + b·pos（两点制，无最小二乘、无残差）；
// 对数轴在 log₁₀ 域求解，取数据值时 10^(a+b·pos)。
import type { ScaleType } from '../state/model'

export interface MappingParams {
  a: number
  b: number
  scaleType: ScaleType
}

/**
 * 由两个（刻度位置, 刻度值）对解析求解映射参数。
 * 返回 null 的退化情形：两刻度同位置；log 轴刻度值 ≤0（命令层已内联拦截，此处防御）。
 */
export function solveMapping(
  p1: number,
  v1: number,
  p2: number,
  v2: number,
  scaleType: ScaleType,
): MappingParams | null {
  if (p1 === p2) return null
  if (scaleType === 'log') {
    if (v1 <= 0 || v2 <= 0) return null
    const lv1 = Math.log10(v1)
    const lv2 = Math.log10(v2)
    const b = (lv2 - lv1) / (p2 - p1)
    return { a: lv1 - b * p1, b, scaleType }
  }
  const b = (v2 - v1) / (p2 - p1)
  return { a: v1 - b * p1, b, scaleType }
}

/** 像素位置 → 数据值（log 轴返回 10^(a+b·pos)） */
export function applyMapping(m: MappingParams, pos: number): number {
  const v = m.a + m.b * pos
  return m.scaleType === 'log' ? 10 ** v : v
}
