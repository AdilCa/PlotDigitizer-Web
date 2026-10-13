// pdfSession.ts — PDF 会话缓存（§5.5）
// PDF.js 封装：拖入 PDF → 打开选页弹窗，逐页渲染缩略图（先开窗、边渲染边出现）；
// 选中页按需渲染大预览；导入 = 整页按所选 DPI 渲染为位图，走 M1 双轨路径。
// 裁剪不在这里做：导入后在画布上用图像编辑工具裁剪（§6.6，裁剪唯一入口）。
// PDFDocumentProxy 句柄在加载新 PDF 前保活（模块态，不进 store；store 只放缩略图元信息），
// 可随时重新打开弹窗选下一页，无需重新解析。
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { addPdfThumb, setPdfDialogOpen, setPdfGallery, setStatus } from '../state/commands'
import { dpiAllowed, PDF_MAX_EDGE } from './pdfImport'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

let doc: pdfjs.PDFDocumentProxy | null = null
let fileName = ''
let imageCounter = 0

const THUMB_WIDTH = 132

async function renderToCanvas(page: pdfjs.PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff' // PDF 页面默认白底；透明底会在画布上显示成工作台灰
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas
}

/** 打开 PDF：建立会话并打开选页弹窗，随后逐页补齐缩略图 */
export async function openPdf(file: File): Promise<void> {
  closePdf()
  const data = new Uint8Array(await file.arrayBuffer())
  const opened = await pdfjs.getDocument({ data }).promise
  doc = opened
  fileName = file.name
  imageCounter = 0
  setPdfGallery({ fileName, pageCount: opened.numPages, thumbs: [] })
  setPdfDialogOpen(true)
  setStatus(`PDF 已打开（${opened.numPages} 页）：选择一页导入`)

  for (let p = 1; p <= opened.numPages; p++) {
    if (doc !== opened) return // 期间换了 PDF
    const page = await opened.getPage(p)
    const base = page.getViewport({ scale: 1 })
    const canvas = await renderToCanvas(page, THUMB_WIDTH / base.width)
    page.cleanup()
    if (doc !== opened) return
    addPdfThumb({
      page: p,
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      widthPt: base.width,
      heightPt: base.height,
    })
  }
}

export function closePdf(): void {
  if (doc) void doc.destroy()
  doc = null
  fileName = ''
  imageCounter = 0
  setPdfGallery(null)
  setPdfDialogOpen(false)
}

/** 弹窗大预览：整页适配到 box（CSS 像素），按设备像素比渲染保证清晰 */
export async function renderPreview(pageNum: number, box: { width: number; height: number }): Promise<string> {
  if (!doc) throw new Error('无 PDF 会话')
  const page = await doc.getPage(pageNum)
  const base = page.getViewport({ scale: 1 })
  const fit = Math.min(box.width / base.width, box.height / base.height)
  const canvas = await renderToCanvas(page, fit * (window.devicePixelRatio || 1))
  page.cleanup()
  return canvas.toDataURL('image/png')
}

/** 整页按 DPI 渲染为 PNG（导入用） */
export async function renderPageImage(pageNum: number, dpi: number): Promise<Blob> {
  if (!doc) throw new Error('无 PDF 会话')
  const page = await doc.getPage(pageNum)
  const base = page.getViewport({ scale: 1 })
  if (!dpiAllowed({ widthPt: base.width, heightPt: base.height }, dpi)) {
    throw new Error(`${dpi} DPI 下长边超过 ${PDF_MAX_EDGE}px，请选更低的 DPI`)
  }
  const canvas = await renderToCanvas(page, dpi / 72)
  page.cleanup()
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob((b) => r(b), 'image/png'))
  if (!blob) throw new Error('页面渲染失败')
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
