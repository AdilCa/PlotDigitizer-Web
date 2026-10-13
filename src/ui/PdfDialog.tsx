// PdfDialog.tsx — PDF 选页弹窗（§5.5）+ 检查器内的会话入口
// 打开 PDF 自动弹出：左侧逐页缩略图（边渲染边出现），右侧所选页大预览，底部 DPI 与导入尺寸。
// 只选页、不裁剪：整页导入画布后，用图像编辑工具裁剪（裁剪唯一入口）。
// 单击选页，双击 / Enter 导入，↑↓ 换页，Esc 关闭；关闭后可从检查器「选择页面」重新打开。
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { setPdfDialogOpen } from '../state/commands'
import { importPdfPage } from '../io/fileAccess'
import { dpiAllowed, importSize, PDF_DEFAULT_DPI, PDF_IMPORT_DPIS, PDF_MAX_EDGE } from '../pdf/pdfImport'

export function PdfDialog() {
  const gallery = useStore((s) => s.ui.pdfGallery)
  const open = useStore((s) => s.ui.pdfDialogOpen)
  const [page, setPage] = useState(1)
  const [dpi, setDpi] = useState<number>(PDF_DEFAULT_DPI)
  const [preview, setPreview] = useState<{ key: string; url: string } | null>(null)
  const previewBox = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const fileName = gallery?.fileName ?? ''
  const pageCount = gallery?.pageCount ?? 0

  // 换 PDF 回到第 1 页
  useEffect(() => setPage(1), [fileName])

  // 所选页大预览：按需渲染，换页时丢弃过期结果
  const previewKey = `${fileName}#${page}`
  useEffect(() => {
    if (!open || !gallery) return
    const box = previewBox.current
    if (!box) return
    let alive = true
    void import('../pdf/pdfSession')
      .then(({ renderPreview }) => renderPreview(page, { width: box.clientWidth - 16, height: box.clientHeight - 16 }))
      .then((url) => {
        if (alive) setPreview({ key: previewKey, url })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [open, previewKey])

  const thumb = gallery?.thumbs.find((t) => t.page === page) ?? null
  const allowed = thumb ? dpiAllowed(thumb, dpi) : true
  const canImport = thumb !== null && allowed

  const doImport = () => {
    if (canImport) void importPdfPage(page, dpi)
  }

  // 弹窗打开期间独占键盘（App 的画布快捷键在 pdfDialogOpen 时让位）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (e.key === 'Escape') {
        setPdfDialogOpen(false)
      } else if (e.key === 'Enter' && tag !== 'SELECT' && tag !== 'BUTTON') {
        if (!e.repeat) doImport()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        setPage((p) => Math.min(pageCount, p + 1))
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        setPage((p) => Math.max(1, p - 1))
      } else {
        return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // 键盘换页时让所选缩略图滚入视野
  useEffect(() => {
    listRef.current?.querySelector('.pdf-page.selected')?.scrollIntoView({ block: 'nearest' })
  }, [page])

  if (!open || !gallery) return null
  const size = thumb ? importSize(thumb, dpi) : null
  const loading = gallery.thumbs.length < gallery.pageCount

  return (
    <div className="modal-backdrop">
      <div className="pdf-dialog" role="dialog" aria-modal="true" aria-label="从 PDF 选择页面" data-testid="pdf-dialog">
        <div className="pdf-dialog-head">
          <span className="pdf-dialog-title">从 PDF 选择页面</span>
          <span className="badge badge-gray">
            {gallery.fileName} · 共 {gallery.pageCount} 页
          </span>
          {loading && (
            <span className="pdf-dialog-progress">
              正在生成缩略图 {gallery.thumbs.length}/{gallery.pageCount}
            </span>
          )}
        </div>

        <div className="pdf-dialog-body">
          <div className="pdf-page-list" ref={listRef}>
            {gallery.thumbs.map((t) => (
              <button
                key={t.page}
                className={`pdf-page${t.page === page ? ' selected' : ''}`}
                data-testid={`pdf-page-${t.page}`}
                onClick={() => setPage(t.page)}
                onDoubleClick={() => {
                  setPage(t.page)
                  if (dpiAllowed(t, dpi)) void importPdfPage(t.page, dpi)
                }}
              >
                <img src={t.dataUrl} width={t.width} height={t.height} alt="" draggable={false} />
                <span>第 {t.page} 页</span>
              </button>
            ))}
          </div>

          <div className="pdf-page-preview" ref={previewBox} data-testid="pdf-preview">
            {preview?.key === previewKey ? (
              <img src={preview.url} alt={`第 ${page} 页预览`} draggable={false} />
            ) : thumb ? (
              <img className="pdf-preview-placeholder" src={thumb.dataUrl} alt="" draggable={false} />
            ) : null}
          </div>
        </div>

        <div className="pdf-dialog-foot">
          <label className="pdf-dpi">
            <span>分辨率</span>
            <select value={dpi} data-testid="pdf-dpi" onChange={(e) => setDpi(Number(e.target.value))}>
              {PDF_IMPORT_DPIS.map((d) => (
                <option key={d} value={d} disabled={thumb ? !dpiAllowed(thumb, d) : false}>
                  {d} DPI
                </option>
              ))}
            </select>
          </label>
          <span className="pdf-dialog-info" data-testid="pdf-import-size">
            {size
              ? allowed
                ? `第 ${page} 页 → ${size.width}×${size.height} px；导入后可用「图像编辑」工具裁剪`
                : `${dpi} DPI 下长边超过 ${PDF_MAX_EDGE}px，请选更低的分辨率`
              : '缩略图生成中…'}
          </span>
          <button className="btn-ghost" onClick={() => setPdfDialogOpen(false)} data-testid="pdf-cancel">
            取消（Esc）
          </button>
          <button
            className="btn-primary"
            disabled={!canImport}
            title="整页导入画布（已有校准与取点时会先提示）；双击缩略图同效"
            data-testid="pdf-import-page"
            onClick={doImport}
          >
            导入此页（Enter）
          </button>
        </div>
      </div>
    </div>
  )
}

/** 检查器内的 PDF 会话入口：弹窗关闭后可重新打开选下一页（会话缓存，无需重新解析） */
export function PdfSessionBlock() {
  const gallery = useStore((s) => s.ui.pdfGallery)
  if (!gallery) return null
  return (
    <>
      <div className="insp-section-title">PDF</div>
      <div className="axis-block" data-testid="pdf-session">
        <div className="axis-head">
          <span className="axis-title" title={gallery.fileName}>
            {gallery.fileName}
          </span>
          <span className="badge badge-gray">{gallery.pageCount} 页</span>
        </div>
        <button className="btn-ghost" data-testid="pdf-reopen" onClick={() => setPdfDialogOpen(true)}>
          选择页面…
        </button>
      </div>
    </>
  )
}
