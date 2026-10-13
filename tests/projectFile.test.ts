// projectFile.test.ts — zipStore + .pdproj 读写（§7.1）
import { describe, expect, it } from 'vitest'
import { crc32, readZip, writeZip } from '../src/io/zipStore'
import { buildProjectBlob, parseProject, parseProjectJson, serializeProject } from '../src/io/projectFile'
import { createEmptyModel, createSeries } from '../src/state/model'

describe('zipStore：store-only zip 读写', () => {
  it('round-trip：多条目、二进制数据、CRC 正确', async () => {
    const a = new TextEncoder().encode('{"hello":"世界"}')
    const b = new Uint8Array([0, 1, 2, 255, 254, 128])
    const zip = writeZip([
      { name: 'project.json', data: a },
      { name: 'image.png', data: b },
    ])
    // PK 魔数
    expect([zip[0], zip[1], zip[2], zip[3]]).toEqual([0x50, 0x4b, 0x03, 0x04])
    const entries = readZip(zip)
    expect(entries.map((e) => e.name)).toEqual(['project.json', 'image.png'])
    expect(new TextDecoder().decode(entries[0].data)).toBe('{"hello":"世界"}')
    expect([...entries[1].data]).toEqual([0, 1, 2, 255, 254, 128])
    expect(crc32(entries[0].data)).toBe(crc32(a))
  })

  it('体积 ≈ 内容总和（store-only 零压缩开销）', () => {
    const big = new Uint8Array(10000).fill(7)
    const zip = writeZip([{ name: 'image.png', data: big }])
    expect(zip.length).toBeLessThan(10000 + 200)
  })

  it('拒绝非 zip / 结构损坏', () => {
    expect(() => readZip(new Uint8Array([1, 2, 3, 4, 5]))).toThrow('不是 zip')
    const zip = writeZip([{ name: 'a.txt', data: new Uint8Array([65]) }])
    expect(() => readZip(zip.slice(0, zip.length - 22))).toThrow('结尾目录')
  })
})

describe('projectFile：.pdproj 工程读写', () => {
  function sampleModel() {
    const model = createEmptyModel()
    model.image = { name: 'test1.png', sourceType: 'file', width: 800, height: 600 }
    model.calibration.x.axisLine = 500
    model.calibration.x.ticks.push(
      { id: 't1', pos: 100, at: { x: 100, y: 500 }, fittedPos: 100, value: 0 },
      { id: 't2', pos: 700, at: { x: 700, y: 500 }, fittedPos: 700, value: 60 },
    )
    const s = createSeries('A', 'scatter')
    s.points.push({ id: 'p1', pixel: { x: 300, y: 400 }, name: 'A1' })
    model.series.push(s)
    model.activeSeriesId = s.id
    return model
  }

  it('round-trip：model 全量（校准/刻度值/序列/点/活动序列）', async () => {
    const model = sampleModel()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // 伪 PNG 头，读写不验内容
    const blob = buildProjectBlob(model, png)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const back = parseProject(bytes)
    expect(back.imagePng).toEqual(png)
    expect(back.model).toEqual(model) // 深相等：Tick.at 等新字段也随 JSON 自然序列化
  })

  it('版本/结构校验：非 v1、缺字段、坏 JSON 均拒绝', () => {
    const enc = new TextEncoder()
    expect(() => parseProjectJson(enc.encode('{"version":2}'))).toThrow('版本')
    expect(() => parseProjectJson(enc.encode('{"version":1}'))).toThrow('校准')
    expect(() => parseProjectJson(enc.encode('not json'))).toThrow('JSON')
    const model = sampleModel()
    expect(parseProjectJson(serializeProject(model))).toEqual(model)
  })
})
