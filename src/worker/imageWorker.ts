// imageWorker.ts — Worker 入口（§5.2 渲染管线 / §3 决策 4）
// 持有的可变状态仅限处理轨像素与源句柄：
//   gray（常驻，1B/px）、background（全图背景色，散点 refine 用）、
//   bitmap（原图 RGBA；长边 >4096 灰度化后即释放，§5.4；散点 refine / 曲线提取按需读局部块）、
//   sourceFile（File 句柄，供释放分支重解码）、
//   region（当前图像在原图坐标系中的位置与尺寸，多次裁剪累计；不受降采样影响）。
// 业务 model 只在主线程；本 Worker 不存任何校准/取点数据。
import { toGray } from '../engine/gray'
import { fitAxis } from '../engine/axisFitter'
import { fitTicks } from '../engine/tickFitter'
import { refineBar, type RefineResult } from '../engine/refine'
import { estimateBackground, refineScatter, scatterPatchRect, type Rgb, type RgbaPatch } from '../engine/markerBlob'
import { curvePatchRect, traceCurve } from '../engine/curveTrace'
import { labelFontSize, placeLabel } from '../render/annotatedLabel'
import {
  PROCESS_TRACK_RELEASE_EDGE,
  shouldReleaseOriginal,
  thumbSize,
  type CropRect,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol'

interface Region {
  x: number
  y: number
  w: number
  h: number
}

let sourceFile: Blob | null = null
let bitmap: ImageBitmap | null = null
let gray: Uint8Array | null = null
let background: Rgb = { r: 255, g: 255, b: 255 }
/** 当前（处理轨）图像尺寸 = 算法/model 像素坐标系 */
let width = 0
let height = 0
/** 当前图像在原图坐标系中的区域（累计裁剪） */
let region: Region = { x: 0, y: 0, w: 0, h: 0 }

function disposeImage(): void {
  bitmap?.close()
  bitmap = null
  gray = null
  sourceFile = null
  region = { x: 0, y: 0, w: 0, h: 0 }
}

/** 透明底 PNG 先铺白：getImageData 读回的透明像素是 (0,0,0,0)，不铺白会被当成纯黑，refine 全部失效 */
function drawOnWhite(ctx: OffscreenCanvasRenderingContext2D, src: ImageBitmap): void {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, src.width, src.height)
  ctx.drawImage(src, 0, 0)
}

function rasterizeToGray(bmp: ImageBitmap): Uint8Array {
  const oc = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = oc.getContext('2d')!
  drawOnWhite(ctx, bmp)
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  background = estimateBackground(data, bmp.width, bmp.height)
  return toGray(data, bmp.width, bmp.height)
}

/** 按矩形读铺白后的 RGBA 局部块（ctx 复用，一批请求只建一次） */
function readPatch(
  ctx: OffscreenCanvasRenderingContext2D,
  src: ImageBitmap,
  rect: { x: number; y: number; w: number; h: number },
): RgbaPatch {
  if (rect.w <= 0 || rect.h <= 0) return { data: new Uint8ClampedArray(0), ...rect }
  ctx.canvas.width = rect.w
  ctx.canvas.height = rect.h
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, rect.w, rect.h)
  ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  return { data: ctx.getImageData(0, 0, rect.w, rect.h).data, ...rect }
}

/** 取处理轨原图执行 fn；已释放分支（>4096）重解码一次，用完释放 */
async function withSource<T>(fn: (src: ImageBitmap, ctx: OffscreenCanvasRenderingContext2D) => T): Promise<T> {
  const src = bitmap ?? (await decodeRegionFromSource())
  const srcIsTemp = bitmap === null
  const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!
  try {
    return fn(src, ctx)
  } finally {
    if (srcIsTemp) src.close()
  }
}

/** 散点 refine：每个点按 scatterPatchRect 读一块局部 RGBA */
function refineScatterBatch(items: { x: number; y: number; r: number }[]): Promise<RefineResult[]> {
  return withSource((src, ctx) =>
    items.map((it) => refineScatter(it, readPatch(ctx, src, scatterPatchRect(it, it.r, width, height)), background, it.r)),
  )
}

/** 曲线提取：按笔迹外接框读一块局部 RGBA */
function handleTraceCurve(stroke: { x: number; y: number }[], radius: number, step: number) {
  return withSource((src, ctx) =>
    traceCurve(stroke, readPatch(ctx, src, curvePatchRect(stroke, radius, width, height)), background, radius, step),
  )
}

/** 获取当前处理轨原图；已释放（>4096）时从 File 句柄按累计区域重解码（§5.4），用完由调用方释放 */
async function decodeRegionFromSource(): Promise<ImageBitmap> {
  if (!sourceFile) throw new Error('Worker 无图像源')
  const full = await createImageBitmap(sourceFile)
  if (region.x === 0 && region.y === 0 && region.w === full.width && region.h === full.height) {
    return full
  }
  const cropped = await createImageBitmap(full, region.x, region.y, region.w, region.h)
  full.close()
  return cropped
}

async function handleLoadImage(file: Blob): Promise<{ width: number; height: number }> {
  disposeImage()
  sourceFile = file
  const bmp = await createImageBitmap(file)
  width = bmp.width
  height = bmp.height
  region = { x: 0, y: 0, w: width, h: height }
  gray = rasterizeToGray(bmp)
  // 处理轨释放分支（§5.4）：以一次性重解码延迟（~100–300ms）换 ~200MB 常驻内存
  if (shouldReleaseOriginal(width, height)) {
    bmp.close()
  } else {
    bitmap = bmp
  }
  return { width, height }
}

async function handleCrop(
  rect: CropRect,
  base: { width: number; height: number },
): Promise<{ width: number; height: number; thumbnail: ImageBitmap; region: CropRect }> {
  // rect 为当前图像坐标系（= model 像素坐标系）
  if (base.width !== width || base.height !== height) {
    throw new Error('图像已变化，本次裁剪已作废，请重新框选')
  }
  if (rect.x < 0 || rect.y < 0 || rect.w < 1 || rect.h < 1 || rect.x + rect.w > width || rect.y + rect.h > height) {
    throw new Error(`裁剪矩形越界：${rect.x},${rect.y} ${rect.w}×${rect.h}（图像 ${width}×${height}）`)
  }
  const src = bitmap ?? (await decodeRegionFromSource())
  const srcIsTemp = bitmap === null

  let next = await createImageBitmap(src, rect.x, rect.y, rect.w, rect.h)
  if (srcIsTemp) src.close()

  // 累计区域（当前坐标 → 原图坐标；k 含历史降采样因子）
  const k = region.w / width
  region = {
    x: region.x + rect.x * k,
    y: region.y + rect.y * k,
    w: rect.w * k,
    h: rect.h * k,
  }

  // 裁剪结果长边仍 >4096 时先降采样，控制处理轨内存（§5.3 步骤 3）
  if (Math.max(next.width, next.height) > PROCESS_TRACK_RELEASE_EDGE) {
    const d = PROCESS_TRACK_RELEASE_EDGE / Math.max(next.width, next.height)
    const down = await createImageBitmap(next, {
      resizeWidth: Math.round(next.width * d),
      resizeHeight: Math.round(next.height * d),
    })
    next.close()
    next = down
  }

  bitmap?.close()
  gray = rasterizeToGray(next)
  width = next.width
  height = next.height

  // 显示轨缩略图（§5.3 步骤 3：Worker 回传，主线程零像素运算）
  const ts = thumbSize(width, height)
  const thumbnail =
    ts.width === width && ts.height === height
      ? await createImageBitmap(next) // 独立副本：thumbnail 将被 transfer
      : await createImageBitmap(next, { resizeWidth: ts.width, resizeHeight: ts.height })

  // 裁剪结果 ≤4096 必然常驻（>4096 已在上方降采样）；分支保留以备阈值调整
  if (shouldReleaseOriginal(width, height)) {
    next.close()
    bitmap = null
  } else {
    bitmap = next
  }
  return { width, height, thumbnail, region: { ...region } }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data
  try {
    switch (req.type) {
      case 'loadImage': {
        const r = await handleLoadImage(req.file)
        const resp: WorkerResponse = { id: req.id, reqType: 'loadImage', ok: true, ...r }
        self.postMessage(resp)
        break
      }
      case 'crop': {
        const r = await handleCrop(req.rect, req.base)
        const resp: WorkerResponse = { id: req.id, reqType: 'crop', ok: true, ...r }
        self.postMessage(resp, { transfer: [r.thumbnail] })
        break
      }
      case 'dispose': {
        disposeImage()
        const resp: WorkerResponse = { id: req.id, reqType: 'dispose', ok: true }
        self.postMessage(resp)
        break
      }
      case 'exportImagePng': {
        // 当前处理轨（已释放分支从源按累计区域重解码，§5.4）→ PNG 字节
        const src = bitmap ?? (await decodeRegionFromSource())
        const srcIsTemp = bitmap === null
        const oc = new OffscreenCanvas(src.width, src.height)
        drawOnWhite(oc.getContext('2d')!, src)
        if (srcIsTemp) src.close()
        const blob = await oc.convertToBlob({ type: 'image/png' })
        const png = await blob.arrayBuffer()
        const resp: WorkerResponse = { id: req.id, reqType: 'exportImagePng', ok: true, png }
        self.postMessage(resp, { transfer: [png] })
        break
      }
      case 'renderAnnotated': {
        // §7.2：处理轨分辨率离屏重绘底图 + 全序列标记叠加（与屏幕缩放无关）
        const src = bitmap ?? (await decodeRegionFromSource())
        const srcIsTemp = bitmap === null
        const oc = new OffscreenCanvas(src.width, src.height)
        const ctx = oc.getContext('2d')!
        drawOnWhite(ctx, src)
        if (srcIsTemp) src.close()
        // 标记半径随分辨率缩放（≈ 屏幕 4px @ 100% 显示比例的观感）
        const r = Math.max(4, Math.round(Math.max(src.width, src.height) / 400))
        for (const m of req.markers) {
          ctx.beginPath()
          ctx.arc(m.x, m.y, r, 0, Math.PI * 2)
          ctx.fillStyle = m.color
          ctx.fill()
          ctx.lineWidth = Math.max(1.5, r / 3)
          ctx.strokeStyle = '#FFFFFF'
          ctx.stroke()
        }
        // 点名：序列色文字 + 白色描边，任意底色上可读；标记全部画完再画文字，避免被相邻标记压住
        const fontSize = labelFontSize(r)
        ctx.font = `600 ${fontSize}px system-ui, "Microsoft YaHei", sans-serif`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.lineJoin = 'round'
        ctx.lineWidth = Math.max(2, fontSize / 4)
        ctx.strokeStyle = '#FFFFFF'
        for (const m of req.markers) {
          if (!m.name) continue
          const size = { width: ctx.measureText(m.name).width, height: fontSize * 0.8 }
          const at = placeLabel(m, r, size, { width: src.width, height: src.height })
          ctx.strokeText(m.name, at.x, at.y)
          ctx.fillStyle = m.color
          ctx.fillText(m.name, at.x, at.y)
        }
        const blob = await oc.convertToBlob({ type: 'image/png' })
        const png = await blob.arrayBuffer()
        const resp: WorkerResponse = { id: req.id, reqType: 'renderAnnotated', ok: true, png }
        self.postMessage(resp, { transfer: [png] })
        break
      }
      case 'refinePoints': {
        if (!gray) throw new Error('Worker 无灰度数据，请先加载图像')
        const scatter = req.items.filter((it) => it.mode === 'scatter')
        const scattered = scatter.length
          ? await refineScatterBatch(scatter.map((it) => ({ x: it.x, y: it.y, r: it.scatterRadius ?? 8 })))
          : []
        let si = 0
        const refined = req.items.map((it) => {
          const out =
            it.mode === 'scatter'
              ? scattered[si++]
              : refineBar({ x: it.x, y: it.y }, gray!, width, height, it.barDirection ?? 'down', it.barSpan)
          return { refId: it.refId, ...out }
        })
        const resp: WorkerResponse = { id: req.id, reqType: 'refinePoints', ok: true, refined }
        self.postMessage(resp)
        break
      }
      case 'traceCurve': {
        if (!gray) throw new Error('Worker 无图像数据，请先加载图像')
        const r = await handleTraceCurve(req.stroke, req.radius, req.step)
        const resp: WorkerResponse = { id: req.id, reqType: 'traceCurve', ok: true, ...r }
        self.postMessage(resp)
        break
      }
      case 'fitAxis': {
        if (!gray) throw new Error('Worker 无灰度数据，请先加载图像')
        const r = fitAxis(gray, width, height, req.axis, req.a, req.b, req.scanRadius)
        if (r.ok) {
          const resp: WorkerResponse = {
            id: req.id,
            reqType: 'fitAxis',
            ok: true,
            position: r.position,
            diagnostics: r.diagnostics,
          }
          self.postMessage(resp)
        } else {
          const resp: WorkerResponse = {
            id: req.id,
            reqType: 'fitAxis',
            ok: false,
            error: r.error,
            diagnostics: r.diagnostics,
          }
          self.postMessage(resp)
        }
        break
      }
      case 'fitTicks': {
        if (!gray) throw new Error('Worker 无灰度数据，请先加载图像')
        const r = fitTicks(gray, width, height, req.axis, req.ticks, req.scanHalf)
        if (r.ok) {
          const resp: WorkerResponse = {
            id: req.id,
            reqType: 'fitTicks',
            ok: true,
            fitted: r.fitted,
            diagnostics: r.diagnostics,
          }
          self.postMessage(resp)
        } else {
          const resp: WorkerResponse = {
            id: req.id,
            reqType: 'fitTicks',
            ok: false,
            error: r.error,
            diagnostics: r.diagnostics,
          }
          self.postMessage(resp)
        }
        break
      }
    }
  } catch (err) {
    const resp: WorkerResponse = {
      id: req.id,
      reqType: req.type,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(resp)
  }
}

export {}

/** 测试探针：gray buffer 是否已建立（M2/M3 的算法请求将消费它） */
export function _hasGrayForTest(): boolean {
  return gray !== null
}
