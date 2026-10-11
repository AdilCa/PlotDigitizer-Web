// zipStore.ts — 零依赖 store-only zip 读写（§7.1：不压缩，zip 只做打包）
// 只支持 STORE（method 0）条目；写入端产出标准 zip（含 CRC32），
// 读取端校验魔数与结构，拒绝压缩条目（本应用自己写出的文件必然是 STORE）。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/** 写 store-only zip（条目顺序即写入顺序） */
export function writeZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  // 固定 DOS 时间戳（1980-01-01），保证同内容输出字节一致（可测）
  const dosTime = 0
  const dosDate = 0x21

  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const crc = crc32(e.data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0x0800, true) // flag: UTF-8 文件名
    local.setUint16(8, 0, true) // method: STORE
    local.setUint16(10, dosTime, true)
    local.setUint16(12, dosDate, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, e.data.length, true)
    local.setUint32(22, e.data.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true) // extra len
    chunks.push(new Uint8Array(local.buffer), nameBytes, e.data)

    const cen = new DataView(new ArrayBuffer(46))
    cen.setUint32(0, 0x02014b50, true)
    cen.setUint16(4, 20, true) // version made by
    cen.setUint16(6, 20, true) // version needed
    cen.setUint16(8, 0x0800, true)
    cen.setUint16(10, 0, true)
    cen.setUint16(12, dosTime, true)
    cen.setUint16(14, dosDate, true)
    cen.setUint32(16, crc, true)
    cen.setUint32(20, e.data.length, true)
    cen.setUint32(24, e.data.length, true)
    cen.setUint16(28, nameBytes.length, true)
    cen.setUint16(30, 0, true) // extra
    cen.setUint16(32, 0, true) // comment
    cen.setUint16(34, 0, true) // disk
    cen.setUint16(36, 0, true) // internal attrs
    cen.setUint32(38, 0, true) // external attrs
    cen.setUint32(42, offset, true)
    central.push(new Uint8Array(cen.buffer), nameBytes)

    offset += 30 + nameBytes.length + e.data.length
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, entries.length, true)
  eocd.setUint16(10, entries.length, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, offset, true)
  eocd.setUint16(20, 0, true)

  const total = offset + centralSize + 22
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of [...chunks, ...central, new Uint8Array(eocd.buffer)]) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

/** 读 store-only zip；拒绝压缩条目与结构损坏（抛 Error 带原因） */
export function readZip(buf: Uint8Array): ZipEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.length < 22 || view.getUint32(0, true) !== 0x04034b50) {
    throw new Error('不是 zip 文件（缺 PK\\x03\\x04 魔数）')
  }
  // 从尾部找 EOCD
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip 结构损坏（缺结尾目录）')
  const count = view.getUint16(eocd + 10, true)
  let pos = view.getUint32(eocd + 16, true)

  const dec = new TextDecoder()
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('zip 中央目录损坏')
    const method = view.getUint16(pos + 10, true)
    if (method !== 0) throw new Error('不支持的压缩条目（.pdproj 应为 store-only）')
    const size = view.getUint32(pos + 20, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const localOff = view.getUint32(pos + 42, true)
    const name = dec.decode(buf.subarray(pos + 46, pos + 46 + nameLen))

    if (view.getUint32(localOff, true) !== 0x04034b50) throw new Error('zip 本地头损坏')
    const localNameLen = view.getUint16(localOff + 26, true)
    const localExtraLen = view.getUint16(localOff + 28, true)
    const dataStart = localOff + 30 + localNameLen + localExtraLen
    entries.push({ name, data: buf.slice(dataStart, dataStart + size) })

    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}
