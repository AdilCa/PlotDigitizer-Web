// M1-7 验收单测：magic bytes 文件类型分流（§7.3 / §7.1）
import { describe, expect, it } from 'vitest'
import { classifyBytes } from '../src/io/fileAccess'

const bytes = (...xs: number[]) => new Uint8Array(xs)

describe('classifyBytes（magic bytes 分流）', () => {
  it('PK\\x03\\x04 → pdproj（store-only zip 容器）', () => {
    expect(classifyBytes(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('pdproj')
  })

  it('%PDF → pdf', () => {
    expect(classifyBytes(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37))).toBe('pdf')
  })

  it('PNG / JPEG / GIF / BMP / WebP(RIFF) → image', () => {
    expect(classifyBytes(bytes(0x89, 0x50, 0x4e, 0x47))).toBe('image') // PNG
    expect(classifyBytes(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image') // JPEG
    expect(classifyBytes(bytes(0x47, 0x49, 0x46, 0x38))).toBe('image') // GIF
    expect(classifyBytes(bytes(0x42, 0x4d))).toBe('image') // BMP
    expect(classifyBytes(bytes(0x52, 0x49, 0x46, 0x46))).toBe('image') // RIFF
  })

  it('未知魔数 → unknown；过短输入不越界', () => {
    expect(classifyBytes(bytes(0x00, 0x01, 0x02, 0x03))).toBe('unknown')
    expect(classifyBytes(bytes(0x50))).toBe('unknown')
    expect(classifyBytes(bytes())).toBe('unknown')
  })
})
