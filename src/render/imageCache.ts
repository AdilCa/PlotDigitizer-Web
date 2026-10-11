// imageCache.ts — 显示轨（§5.1 / §5.2）
// 结构：源（File/PDF 区域渲染回调）→ 缩放级重采样缓存（LRU，128MB 共享预算）。
// 渲染每帧 acquireLevel() 同步取"当前最合适的已生成级"；目标级缺失时异步生成，
// 期间用就近低级代替（渐进清晰，类似地图），生成完成通知重绘。
// 显示轨是资源而非业务数据：不进 store，由本模块持有并显式 close()（§5.3）。

/** 缩放级缓存总预算（§5.4：128MB） */
export const LEVEL_BUDGET_BYTES = 128 * 1024 * 1024
/** 最小缩放级宽度（低于此无意义） */
export const MIN_LEVEL_WIDTH = 256

export interface ImageSourceInfo {
  /** 图像（= model 像素坐标系）尺寸 */
  width: number
  height: number
}

/** 按目标宽度解码/重采样出覆盖完整图像范围的 bitmap（File：createImageBitmap crop+resize；PDF：区域渲染，M4 接入） */
export type LevelDecoder = (targetWidth: number, targetHeight: number) => Promise<ImageBitmap>

// ---------------------------------------------------------------- 纯函数（可单测）

export function nextPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, n)))
}

/** 预算允许的最大级宽度：levelW²·(H/W)·4 ≤ budget */
export function maxLevelWidthByBudget(imageWidth: number, imageHeight: number): number {
  return Math.floor(Math.sqrt((LEVEL_BUDGET_BYTES * imageWidth) / (4 * imageHeight)))
}

/**
 * 目标缩放级宽度：图像在屏幕上占 imageWidth·scale css px，
 * 清晰度达标需要 imageWidth·scale·dpr 源像素密度；量化到 2 的幂，
 * 上限 min(原图宽, 预算上限)，下限 min(256, 原图宽)（不放大超过原生分辨率）。
 */
export function chooseLevelWidth(
  imageWidth: number,
  imageHeight: number,
  scale: number,
  dpr: number,
): number {
  const needed = imageWidth * scale * dpr
  const upper = Math.min(imageWidth, maxLevelWidthByBudget(imageWidth, imageHeight))
  const lower = Math.min(MIN_LEVEL_WIDTH, imageWidth)
  return Math.max(lower, Math.min(nextPow2(Math.ceil(needed)), upper))
}

export function levelBytes(width: number, height: number): number {
  return width * height * 4
}

// ---------------------------------------------------------------- LRU 缓存（纯类，可单测）

export interface Level {
  width: number
  bitmap: ImageBitmap
  bytes: number
  lastUsed: number
}

export class LruLevelCache {
  private levels = new Map<number, Level>()
  private clock = 0
  private totalBytes = 0

  constructor(private readonly budgetBytes: number) {}

  get total(): number {
    return this.totalBytes
  }

  get size(): number {
    return this.levels.size
  }

  get widthList(): number[] {
    return [...this.levels.keys()]
  }

  insert(width: number, height: number, bitmap: ImageBitmap): void {
    const existing = this.levels.get(width)
    if (existing) this.remove(width)
    const bytes = levelBytes(width, height)
    this.levels.set(width, { width, bitmap, bytes, lastUsed: ++this.clock })
    this.totalBytes += bytes
    this.evictIfNeeded()
  }

  /** 取"最合适的已生成级"：优先 ≤target 的最大级，否则最小可用级（渐进清晰） */
  acquire(targetWidth: number): Level | null {
    let lower: Level | null = null
    let upper: Level | null = null
    for (const l of this.levels.values()) {
      if (l.width <= targetWidth && (!lower || l.width > lower.width)) lower = l
      if (l.width > targetWidth && (!upper || l.width < upper.width)) upper = l
    }
    const pick = lower ?? upper
    if (pick) pick.lastUsed = ++this.clock
    return pick
  }

  has(width: number): boolean {
    return this.levels.has(width)
  }

  clear(): void {
    for (const l of this.levels.values()) l.bitmap.close()
    this.levels.clear()
    this.totalBytes = 0
  }

  private remove(width: number): void {
    const l = this.levels.get(width)
    if (!l) return
    l.bitmap.close()
    this.levels.delete(width)
    this.totalBytes -= l.bytes
  }

  private evictIfNeeded(): void {
    while (this.totalBytes > this.budgetBytes && this.levels.size > 1) {
      let oldest: Level | null = null
      for (const l of this.levels.values()) {
        if (!oldest || l.lastUsed < oldest.lastUsed) oldest = l
      }
      if (!oldest) break
      this.remove(oldest.width)
    }
  }
}

// ---------------------------------------------------------------- 模块单例（主线程显示轨）

interface Source {
  info: ImageSourceInfo
  decode: LevelDecoder
}

let source: Source | null = null
let cache = new LruLevelCache(LEVEL_BUDGET_BYTES)
const pending = new Map<number, Promise<void>>()
const listeners = new Set<() => void>()

/** 生成完成/源变更时通知（CanvasView 订阅以触发重绘） */
export function onDisplayTrackChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(): void {
  for (const fn of listeners) fn()
}

/**
 * 设置显示轨源。seed：Worker 回传的缩略图（裁剪路径 §5.3），作为初始级避免全量重解码。
 * 旧源各级显式 close() 释放（§5.3 步骤 4）。
 */
export function setDisplaySource(
  info: ImageSourceInfo,
  decode: LevelDecoder,
  seed?: ImageBitmap,
): void {
  cache.clear()
  pending.clear()
  source = { info, decode }
  if (seed) cache.insert(seed.width, seed.height, seed)
  notify()
}

export function clearDisplaySource(): void {
  cache.clear()
  pending.clear()
  source = null
  notify()
}

/** 供单测注入/检查 */
export function _levelCacheForTest(): LruLevelCache {
  return cache
}

/**
 * 每帧调用：返回当前最合适的显示 bitmap（可能为低级暂代），
 * 并异步补齐目标级（LRU 预算内；同一级去重）。
 */
export function acquireLevel(scale: number, dpr: number): ImageBitmap | null {
  if (!source) return null
  const { info, decode } = source
  const target = chooseLevelWidth(info.width, info.height, scale, dpr)
  const avail = cache.acquire(target)
  if (!cache.has(target) && !pending.has(target)) {
    const height = Math.max(1, Math.round((target * info.height) / info.width))
    const p = decode(target, height)
      .then((bitmap) => {
        cache.insert(target, height, bitmap)
      })
      .catch(() => {
        /* 解码失败：保留现有级，下帧重试（pending 已清除） */
      })
      .finally(() => {
        pending.delete(target)
        notify()
      })
    pending.set(target, p)
  }
  return avail?.bitmap ?? null
}
