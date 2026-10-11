// fileAccess.ts — 拖放导入 + 文件选择器（§7.3）
// magic bytes 分流：PK\x03\x04 → .pdproj（恢复工程），%PDF → PDF（M4-1 识别流程），
// 图片魔数/MIME → 直接建双轨。
// 已存在工作时触发「将清除当前校准与已取点」内联预告，确认后全量重置（§6.6、铁律 3）。
import { loadImage, restoreProject, setPendingImportName, setStatus } from '../state/commands'
import { hasWork } from '../state/selectors'
import { useStore } from '../state/store'
import { workerExportImagePng, workerLoadImage } from '../worker/workerClient'
import { setDisplaySource } from '../render/imageCache'
import { buildProjectBlob, parseProject } from './projectFile'
import type { CropBox } from '../state/store'

/** 当前图像源与累计裁剪区域（原图坐标系；与 Worker 侧 region 同步维护，§5.3/§5.4） */
let currentFile: File | null = null
let region = { x: 0, y: 0, w: 0, h: 0 }
let currentDims = { width: 0, height: 0 }

/** 显示轨缩放级解码：原 File + 累计裁剪区域一次性 crop+resize（主线程零像素运算） */
function decodeLevel(w: number, h: number): Promise<ImageBitmap> {
  if (!currentFile) return Promise.reject(new Error('无图像源'))
  return createImageBitmap(currentFile, region.x, region.y, region.w, region.h, {
    resizeWidth: w,
    resizeHeight: h,
  })
}

export type FileKind = 'image' | 'pdf' | 'pdproj' | 'unknown'

/** 纯函数：按 magic bytes 分类（可单测） */
export function classifyBytes(first: Uint8Array): FileKind {
  if (first.length >= 4 && first[0] === 0x50 && first[1] === 0x4b && first[2] === 0x03 && first[3] === 0x04) {
    return 'pdproj' // PK\x03\x04（store-only zip，§7.1）
  }
  if (first.length >= 4 && first[0] === 0x25 && first[1] === 0x50 && first[2] === 0x44 && first[3] === 0x46) {
    return 'pdf' // %PDF
  }
  // PNG
  if (first.length >= 4 && first[0] === 0x89 && first[1] === 0x50 && first[2] === 0x4e && first[3] === 0x47) return 'image'
  // JPEG
  if (first.length >= 3 && first[0] === 0xff && first[1] === 0xd8 && first[2] === 0xff) return 'image'
  // GIF / BMP / WebP(RIFF)
  if (first.length >= 3 && first[0] === 0x47 && first[1] === 0x49 && first[2] === 0x46) return 'image'
  if (first.length >= 2 && first[0] === 0x42 && first[1] === 0x4d) return 'image'
  if (first.length >= 4 && first[0] === 0x52 && first[1] === 0x49 && first[2] === 0x46 && first[3] === 0x46) return 'image'
  return 'unknown'
}

export async function sniffKind(file: File): Promise<FileKind> {
  const buf = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const byMagic = classifyBytes(buf)
  if (byMagic !== 'unknown') return byMagic
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'pdf'
  if (file.name.toLowerCase().endsWith('.pdproj')) return 'pdproj'
  return 'unknown'
}

/**
 * 图片加载主路径（§5.2 渲染管线）：
 * Worker decode → gray（处理轨）；主线程以 File 为源建显示轨（imageCache 按需重采样，零像素运算）。
 * 换图 = 全量重置 model（§6.6，由 commands.loadImage 落实）；预告由调用方完成。
 * pdfInfo：PDF 区域导入的来源定位（§7.3 文件名规则）。
 */
export async function loadImageFile(
  file: File,
  pdfInfo?: { fileName: string; page: number; imageIndex: number },
): Promise<void> {
  const { width, height } = await workerLoadImage(file)
  currentFile = file
  region = { x: 0, y: 0, w: width, h: height }
  currentDims = { width, height }
  setDisplaySource({ width, height }, decodeLevel)
  if (pdfInfo) {
    loadImage({
      name: file.name,
      sourceType: 'pdf',
      width,
      height,
      pdf: pdfInfo,
    })
  } else {
    loadImage({ name: file.name, sourceType: 'file', width, height })
  }
  setStatus(null)
}

/**
 * 裁剪确认后重绑显示轨（§5.3 步骤 3/4）：
 * 累计裁剪区域（当前坐标 → 原图坐标），Worker 回传的缩略图作为种子级，旧资源由 imageCache 显式 close()。
 */
export function rebindDisplayAfterCrop(
  crop: CropBox,
  result: { width: number; height: number; thumbnail: ImageBitmap },
): void {
  const k = region.w / currentDims.width // 含历史降采样因子
  region = {
    x: region.x + crop.x * k,
    y: region.y + crop.y * k,
    w: crop.w * k,
    h: crop.h * k,
  }
  currentDims = { width: result.width, height: result.height }
  setDisplaySource({ width: result.width, height: result.height }, decodeLevel, result.thumbnail)
}

/**
 * 恢复 .pdproj（§7.1）：解包 → 图像走 Worker 双轨 → model 整体替换。
 * 保存的是编辑烘焙后图像，因此恢复路径与普通图片一致（无需重放编辑历史）。
 */
export async function loadProjectFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { model, imagePng } = parseProject(bytes) // 结构/版本错误在此抛出（调用方内联反馈）
  const imgFile = new File([imagePng as unknown as BlobPart], model.image!.name, { type: 'image/png' })
  const { width, height } = await workerLoadImage(imgFile)
  currentFile = imgFile
  region = { x: 0, y: 0, w: width, h: height }
  currentDims = { width, height }
  setDisplaySource({ width, height }, decodeLevel)
  restoreProject(model)
}

/** 打包当前工程为 .pdproj Blob（调用方负责保存；§7.1 体积 ≈ 原图） */
export async function buildProjectFile(): Promise<Blob> {
  const { model } = useStore.getState()
  const png = await workerExportImagePng()
  return buildProjectBlob(model, png)
}

/** 统一入口：拖放 / 文件选择器都走这里 */
export async function importFile(file: File): Promise<void> {
  // §6.6 预告：已有校/取点工作时先内联预告，确认后（confirmPendingImport）才执行
  if (hasWork(useStore.getState().model)) {
    pendingImport = file
    setPendingImportName(file.name)
    return
  }
  await doImport(file)
}

let pendingImport: File | null = null

/** 预告条「仍要加载」（普通文件与 PDF 区域导入共用） */
export function confirmPendingImport(): void {
  const f = pendingImport
  const pdf = pendingPdfRegion
  pendingImport = null
  pendingPdfRegion = null
  setPendingImportName(null)
  if (pdf) {
    void loadImageFile(pdf.file, pdf.pdfInfo).then(() =>
      setStatus(`已导入 ${pdf.file.name}（300 DPI 区域渲染）`),
    )
  } else if (f) {
    void doImport(f)
  }
}

/** 预告条「取消」 */
export function cancelPendingImport(): void {
  pendingImport = null
  pendingPdfRegion = null
  setPendingImportName(null)
  setStatus(null)
}

async function doImport(file: File): Promise<void> {
  try {
    const kind = await sniffKind(file)
    switch (kind) {
      case 'image':
        await loadImageFile(file)
        return
      case 'pdf': {
        const { openPdf } = await import('../pdf/pdfSession') // pdfjs 按需加载（§5.5，不拖累主包）
        await openPdf(file) // 96 DPI 浏览轨 + 会话缓存图库；区域导入由图库面板触发
        return
      }
      case 'pdproj':
        await loadProjectFile(file)
        return
      case 'unknown':
        setStatus(`无法识别的文件类型：${file.name}`)
    }
  } catch (err) {
    setStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`) // 内联反馈，铁律 5
  }
}

/**
 * PDF 图库「导入区域」（§5.5）：300 DPI 区域渲染 → 走图片加载主路径（双轨）。
 * = 加载新图：已有工作时同样先走 §6.6 预告（pendingImport 机制，File 为虚拟命名）。
 */
export async function importPdfRegion(
  page: number,
  rect: { x: number; y: number; w: number; h: number },
): Promise<void> {
  setStatus(`正在按 300 DPI 渲染第 ${page} 页所选区域…`)
  try {
    const { renderRegion, nextImageIndex, currentPdfName } = await import('../pdf/pdfSession')
    const blob = await renderRegion(page, rect)
    const idx = nextImageIndex()
    const stem = currentPdfName().replace(/\.[^.]+$/, '')
    const file = new File([blob], `${stem}-p${page}-img${idx}.png`, { type: 'image/png' })
    const pdfInfo = { fileName: currentPdfName(), page, imageIndex: idx }

    if (hasWork(useStore.getState().model)) {
      // 与拖入新图同一预告路径；确认后执行 loadImageFile(file, pdfInfo)
      pendingPdfRegion = { file, pdfInfo }
      setPendingImportName(file.name)
      return
    }
    await loadImageFile(file, pdfInfo)
    setStatus(`已导入 ${file.name}（300 DPI 区域渲染）`)
  } catch (err) {
    setStatus(`区域渲染失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

let pendingPdfRegion: { file: File; pdfInfo: { fileName: string; page: number; imageIndex: number } } | null = null

/** 拖放导入：图片/PDF/.pdproj 直接拖入窗口即加载（§7.3） */
export function installDropZone(el: HTMLElement): () => void {
  const onDragOver = (e: DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (file) void importFile(file)
  }
  el.addEventListener('dragover', onDragOver)
  el.addEventListener('drop', onDrop)
  return () => {
    el.removeEventListener('dragover', onDragOver)
    el.removeEventListener('drop', onDrop)
  }
}

/** 传统文件选择器（备选入口，§7.3） */
export function openFilePicker(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*,.pdf,.pdproj'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void importFile(file)
  }
  input.click()
}
