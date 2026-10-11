// pdfSession.ts — PDF 会话缓存（§5.5）
// PDF.js 封装：拖入 PDF → 96 DPI 渲染整页缩略图供浏览（不产出巨大位图）；
// 用户框选感兴趣区域后按 300 DPI 只渲染该区域，导入走 M1 双轨路径。
// PDFDocumentProxy 句柄与各页缩略图在窗口关闭/加载新 PDF 前保活（模块态，不进 store；
// store 只放展示用的 dataURL 缩略图元信息）。
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { setPdfGallery, setStatus } from '../state/commands'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfPageThumb {
  page: number // 1-based
  dataUrl: string
  /** 缩略图像素尺寸 */
  width: number
  height: number
  /** 96 DPI 整页像素尺寸（区域框选坐标系） */
  pageWidth: number
  pageHeight: number
}

let doc: pdfjs.PDFDocumentProxy | null = null
let fileName = ''
let imageCounter = 0

const DPI_BROWSE = 96
const DPI_IMPORT = 300
const THUMB_WIDTH = 104

/** 96 DPI 页像素 → pt（PDF viewport 单位） */
const PT_PER_PX96 = 72 / 96

async function renderPage(page: pdfjs.PDFPageProxy, scale: number, region?: { x: number; y: number; w: number; h: number }): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  if (region) {
    // region 以 96 DPI 页像素给出；渲染输出 = region(pt) × scale
    canvas.width = Math.ceil(region.w * PT_PER_PX96 * scale)
    canvas.height = Math.ceil(region.h * PT_PER_PX96 * scale)
  } else {
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
  }
  const ctx = canvas.getContext('2d')!
  const transform = region
    ? [scale, 0, 0, scale, -region.x * PT_PER_PX96 * scale, -region.y * PT_PER_PX96 * scale]
    : undefined
  await page.render({ canvasContext: ctx, viewport, transform }).promise
  return canvas
}

/** 打开 PDF：枚举页面并渲染缩略图（96 DPI 浏览轨） */
export async function openPdf(file: File): Promise<void> {
  closePdf()
  const data = new Uint8Array(await file.arrayBuffer())
  doc = await pdfjs.getDocument({ data }).promise
  fileName = file.name
  imageCounter = 0

  const thumbs: PdfPageThumb[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const browse = page.getViewport({ scale: DPI_BROWSE / 72 })
    const canvas = await renderPage(page, THUMB_WIDTH / browse.width)
    thumbs.push({
      page: p,
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      pageWidth: browse.width,
      pageHeight: browse.height,
    })
    page.cleanup()
  }
  setPdfGallery({ fileName, pageCount: doc.numPages, thumbs })
  setStatus(`PDF 已加载（${doc.numPages} 页）：在图库中选页并框选区域导入`)
}

export function closePdf(): void {
  if (doc) void doc.destroy()
  doc = null
  fileName = ''
  imageCounter = 0
  setPdfGallery(null)
}

/** 区域 300 DPI 渲染（§5.5：只渲染框选区域，避免先得到巨大位图再裁剪） */
export async function renderRegion(
  pageNum: number,
  region: { x: number; y: number; w: number; h: number },
): Promise<Blob> {
  if (!doc) throw new Error('无 PDF 会话')
  const page = await doc.getPage(pageNum)
  // 防御性钳制到页面范围（96 DPI 页像素坐标系）
  const browse = page.getViewport({ scale: DPI_BROWSE / 72 })
  const x = Math.max(0, Math.min(region.x, browse.width))
  const y = Math.max(0, Math.min(region.y, browse.height))
  const clamped = {
    x,
    y,
    w: Math.max(1, Math.min(region.w, browse.width - x)),
    h: Math.max(1, Math.min(region.h, browse.height - y)),
  }
  const canvas = await renderPage(page, DPI_IMPORT / 72, clamped)
  page.cleanup()
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob((b) => r(b), 'image/png'))
  if (!blob) throw new Error('区域渲染失败')
  return blob
}

/** 该 PDF 内下一个图序号（§7.3 文件名规则 {PDF名}-p{页}-img{序号}-digitized） */
export function nextImageIndex(): number {
  imageCounter += 1
  return imageCounter
}

export function currentPdfName(): string {
  return fileName
}

/** 测试探针 */
export function hasPdfSession(): boolean {
  return doc !== null
}
