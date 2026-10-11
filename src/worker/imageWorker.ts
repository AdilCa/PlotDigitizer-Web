// imageWorker.ts — Worker 入口（§5.2 渲染管线 / §3 决策 4）
// 持有的可变状态仅限处理轨像素与源句柄：
//   gray（常驻，1B/px）、bitmap（原图 RGBA；长边 >4096 灰度化后即释放，§5.4）、
//   sourceFile（File 句柄，供释放分支重解码）、
//   region（当前图像在原图坐标系中的位置与尺寸，多次裁剪累计；不受降采样影响）。
// 业务 model 只在主线程；本 Worker 不存任何校准/取点数据。
import { toGray } from '../engine/gray'
import { fitAxis } from '../engine/axisFitter'
import { fitTicks } from '../engine/tickFitter'
import { refineBar, refineScatter } from '../engine/refine'
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

function rasterizeToGray(bmp: ImageBitmap): Uint8Array {
  const oc = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = oc.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  return toGray(data, bmp.width, bmp.height)
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
): Promise<{ width: number; height: number; thumbnail: ImageBitmap }> {
  // rect 为当前图像坐标系（= model 像素坐标系）
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
  return { width, height, thumbnail }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {  const req = e.data
  try {
    switch (req.type) {
      case 'loadImage': {
        const r = await handleLoadImage(req.file)
        const resp: WorkerResponse = { id: req.id, reqType: 'loadImage', ok: true, ...r }
        self.postMessage(resp)
        break
      }
      case 'crop': {
        const r = await handleCrop(req.rect)
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
        oc.getContext('2d')!.drawImage(src, 0, 0)
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
        ctx.drawImage(src, 0, 0)
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
        const blob = await oc.convertToBlob({ type: 'image/png' })
        const png = await blob.arrayBuffer()
        const resp: WorkerResponse = { id: req.id, reqType: 'renderAnnotated', ok: true, png }
        self.postMessage(resp, { transfer: [png] })
        break
      }
      case 'refinePoints': {
        if (!gray) throw new Error('Worker 无灰度数据，请先加载图像')
        const refined = req.items.map((it) => {
          const pt = { x: it.x, y: it.y }
          const out =
            it.mode === 'scatter'
              ? refineScatter(pt, gray!, width, height)
              : refineBar(pt, gray!, width, height, it.barDirection ?? 'down')
          return { refId: it.refId, x: out.x, y: out.y }
        })
        const resp: WorkerResponse = { id: req.id, reqType: 'refinePoints', ok: true, refined }
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
        const r = fitTicks(gray, width, height, req.axis, req.ticks, req.scanRadius)
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
