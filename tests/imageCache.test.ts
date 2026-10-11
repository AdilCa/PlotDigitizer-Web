// M1-6 验收单测：缩放级选择、LRU 预算、渐进清晰与解码去重
import { beforeEach, describe, expect, it } from 'vitest'
import {
  acquireLevel,
  chooseLevelWidth,
  clearDisplaySource,
  LEVEL_BUDGET_BYTES,
  levelBytes,
  LruLevelCache,
  maxLevelWidthByBudget,
  nextPow2,
  setDisplaySource,
  _levelCacheForTest,
} from '../src/render/imageCache'

function fakeBitmap(w: number, h: number): { bmp: ImageBitmap; isClosed: () => boolean } {
  const state = { closed: false }
  const bmp = {
    width: w,
    height: h,
    close: () => {
      state.closed = true
    },
  } as unknown as ImageBitmap
  return { bmp, isClosed: () => state.closed }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('缩放级选择（纯函数）', () => {
  it('nextPow2', () => {
    expect(nextPow2(1)).toBe(1)
    expect(nextPow2(1025)).toBe(2048)
    expect(nextPow2(2048)).toBe(2048)
  })

  it('量化到 2 的幂，不超过原生分辨率', () => {
    // 4000 宽图，scale 1, dpr 1 → 需要 4000 → 量化 4096 → 钳到原生 4000
    expect(chooseLevelWidth(4000, 3000, 1, 1)).toBe(4000)
    // scale 0.4 → 需要 1600 → 2048
    expect(chooseLevelWidth(4000, 3000, 0.4, 1)).toBe(2048)
    // dpr 2 高分屏需求翻倍
    expect(chooseLevelWidth(4000, 3000, 0.4, 2)).toBe(4096 > 4000 ? 4000 : 4096)
    // 小图不放大超过原生
    expect(chooseLevelWidth(800, 600, 10, 1)).toBe(800)
  })

  it('预算上限约束超大图', () => {
    const maxW = maxLevelWidthByBudget(20000, 20000)
    expect(levelBytes(maxW, maxW)).toBeLessThanOrEqual(LEVEL_BUDGET_BYTES)
    expect(chooseLevelWidth(20000, 20000, 100, 1)).toBeLessThanOrEqual(maxW)
  })
})

describe('LruLevelCache', () => {
  it('acquire 优先取 ≤target 的最大级，否则最小可用级', () => {
    const c = new LruLevelCache(LEVEL_BUDGET_BYTES)
    c.insert(1024, 768, fakeBitmap(1024, 768).bmp)
    c.insert(2048, 1536, fakeBitmap(2048, 1536).bmp)
    c.insert(4096, 3072, fakeBitmap(4096, 3072).bmp)
    expect(c.acquire(1500)!.width).toBe(1024)
    expect(c.acquire(2048)!.width).toBe(2048)
    expect(c.acquire(512)!.width).toBe(1024) // 无更低级 → 最小可用
  })

  it('超出预算时淘汰最久未用级并 close', () => {
    const budget = levelBytes(100, 100) * 2 // 容纳 2 级
    const c = new LruLevelCache(budget)
    const a = fakeBitmap(100, 100)
    const b = fakeBitmap(100, 100)
    const d = fakeBitmap(100, 100)
    c.insert(100, 100, a.bmp)
    c.insert(200, 100, b.bmp) // bytes 按 w*h 计：200*100*4 = 双倍 → 已超
    // insert(200) 后 total = 100²·4 + 200·100·4 = 120000 > 80000 → 淘汰 a
    expect(a.isClosed()).toBe(true)
    c.acquire(200) // 触摸 b，使 a…（a 已淘汰）改为插入第三级淘汰 b
    c.insert(300, 100, d.bmp)
    expect(b.isClosed()).toBe(true)
    expect(d.isClosed()).toBe(false)
    expect(c.total).toBeLessThanOrEqual(budget * 2) // 单级可超预算（至少保留 1 级）
  })
})

describe('模块级 acquireLevel（渐进清晰 + 去重）', () => {
  beforeEach(() => clearDisplaySource())

  it('目标级缺失时异步生成，期间返回就近级；同一级不重复解码', async () => {
    let decodeCalls = 0
    setDisplaySource({ width: 4000, height: 3000 }, async (w, h) => {
      decodeCalls++
      return fakeBitmap(w, h).bmp
    })
    // 首次：无缓存 → null，启动解码
    expect(acquireLevel(1, 1)).toBeNull()
    expect(acquireLevel(1, 1)).toBeNull() // 去重：不再发起
    await flush()
    expect(decodeCalls).toBe(1)
    const bmp = acquireLevel(1, 1)
    expect(bmp).not.toBeNull()
    expect(bmp!.width).toBe(4000) // scale1 → 原生级
  })

  it('seed 缩略图立即可用，目标级生成后接管', async () => {
    const seed = fakeBitmap(2048, 1536)
    setDisplaySource({ width: 4000, height: 3000 }, async (w, h) => fakeBitmap(w, h).bmp, seed.bmp)
    const low = acquireLevel(0.25, 1) // target = 1024；就近 → seed 2048
    expect(low).toBe(seed.bmp)
    await flush()
    const hi = acquireLevel(0.25, 1)
    expect(hi!.width).toBe(1024)
    expect(_levelCacheForTest().has(1024)).toBe(true)
  })

  it('换源时旧级显式 close（§5.3 步骤 4）', () => {
    const old = fakeBitmap(2048, 1536)
    setDisplaySource({ width: 4000, height: 3000 }, async (w, h) => fakeBitmap(w, h).bmp, old.bmp)
    expect(acquireLevel(0.25, 1)).toBe(old.bmp)
    setDisplaySource({ width: 1000, height: 800 }, async (w, h) => fakeBitmap(w, h).bmp)
    expect(old.isClosed()).toBe(true)
    clearDisplaySource()
  })
})
