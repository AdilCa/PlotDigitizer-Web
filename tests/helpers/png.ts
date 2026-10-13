// png.ts — 测试用最小 PNG 编解码（8bit RGB/RGBA，node 侧，零新增依赖）
import { readFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { toGray } from '../../src/engine/gray'

/** 解码为 RGBA（RGB 图 alpha 补 255；RGBA 图保留原 alpha） */
export function decodePngRgba(file: string): { rgba: Uint8ClampedArray; width: number; height: number } {
  const buf = readFileSync(file)
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const chunk = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8]
      colorType = chunk[9]
    } else if (type === 'IDAT') {
      idat.push(chunk)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`仅支持 8bit RGB/RGBA PNG，实际 bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const bpp = colorType === 2 ? 3 : 4
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const px = new Uint8Array(stride * height)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = px.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
    prev = cur
  }
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = px[i * bpp]
    rgba[i * 4 + 1] = px[i * bpp + 1]
    rgba[i * 4 + 2] = px[i * bpp + 2]
    rgba[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255
  }
  return { rgba, width, height }
}

/** 铺白合成（与 Worker 灰度化前的 drawOnWhite 一致） */
export function compositeOnWhite(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba)
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3] / 255
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(out[i + c] * a + 255 * (1 - a))
    out[i + 3] = 255
  }
  return out
}

/** 解码并按运行时路径（铺白 → Rec.601）转灰度 */
export function decodePngGray(file: string): { gray: Uint8Array; width: number; height: number } {
  const { rgba, width, height } = decodePngRgba(file)
  return { gray: toGray(compositeOnWhite(rgba), width, height), width, height }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 最小 PNG 编码（8bit RGBA，无滤波），用于生成夹具 */
export function encodePngRgba(rgba: Uint8ClampedArray, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
