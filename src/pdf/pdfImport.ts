// pdfImport.ts — PDF 整页导入参数（不依赖 pdfjs，UI 可静态引入而不拖累主包，决策 #16）

export const PDF_IMPORT_DPIS = [150, 300, 600] as const
export const PDF_DEFAULT_DPI = 300
/** 导入位图长边上限（px）：超过的 DPI 选项禁用，避免浏览器 canvas 尺寸/内存上限 */
export const PDF_MAX_EDGE = 10000

/** 整页按 DPI 导入的像素尺寸（页面尺寸单位 pt = 1/72 英寸） */
export function importSize(page: { widthPt: number; heightPt: number }, dpi: number): { width: number; height: number } {
  return { width: Math.ceil((page.widthPt / 72) * dpi), height: Math.ceil((page.heightPt / 72) * dpi) }
}

export function dpiAllowed(page: { widthPt: number; heightPt: number }, dpi: number): boolean {
  const s = importSize(page, dpi)
  return Math.max(s.width, s.height) <= PDF_MAX_EDGE
}
