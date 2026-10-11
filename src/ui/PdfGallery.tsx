// PdfGallery.tsx — PDF 会话图库面板（§5.5，M4-3）
// 检查器内联：各页 96 DPI 缩略图可回看；选中页放大预览并框选区域；
// 「导入区域」按 300 DPI 只渲染该区域（M4-2），走加载新图路径（§6.6 预告由 fileAccess 落实）。
import { useRef, useState } from 'react'
import { useStore } from '../state/store'
import { importPdfRegion } from '../io/fileAccess'

const PREVIEW_WIDTH = 220

interface RegionRect {
  x: number
  y: number
  w: number
  h: number
}

export default function PdfGallery() {
  const gallery = useStore((s) => s.ui.pdfGallery)
  const [selectedPage, setSelectedPage] = useState<number | null>(null)
  const [rect, setRect] = useState<RegionRect | null>(null)
  const dragFrom = useRef<{ x: number; y: number } | null>(null)

  if (!gallery) return null
  const thumb = gallery.thumbs.find((t) => t.page === selectedPage) ?? null
  // 放大预览的显示比例：显示像素 / 96dpi 页像素
  const previewScale = thumb ? PREVIEW_WIDTH / thumb.pageWidth : 1

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    dragFrom.current = { x: e.clientX - box.left, y: e.clientY - box.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current
    if (!from) return
    const box = e.currentTarget.getBoundingClientRect()
    const cur = { x: e.clientX - box.left, y: e.clientY - box.top }
    // 显示坐标 → 96dpi 页坐标
    const x = Math.min(from.x, cur.x) / previewScale
    const y = Math.min(from.y, cur.y) / previewScale
    setRect({
      x,
      y,
      w: Math.abs(cur.x - from.x) / previewScale,
      h: Math.abs(cur.y - from.y) / previewScale,
    })
  }
  const onPointerUp = () => {
    dragFrom.current = null
    if (rect && (rect.w < 5 || rect.h < 5)) setRect(null) // 误触丢弃
  }

  return (
    <div className="axis-block" data-testid="pdf-gallery">
      <div className="axis-head">
        <span className="axis-title">PDF 图库</span>
        <span className="badge badge-gray">{gallery.fileName}（{gallery.pageCount} 页）</span>
      </div>

      <div className="pdf-thumbs">
        {gallery.thumbs.map((t) => (
          <button
            key={t.page}
            className={`pdf-thumb${selectedPage === t.page ? ' selected' : ''}`}
            title={`第 ${t.page} 页`}
            data-testid={`pdf-page-${t.page}`}
            onClick={() => {
              setSelectedPage(t.page)
              setRect(null)
            }}
          >
            <img src={t.dataUrl} width={t.width} height={t.height} alt={`p${t.page}`} />
          </button>
        ))}
      </div>

      {thumb && (
        <>
          <div
            className="pdf-preview"
            style={{ width: PREVIEW_WIDTH, height: thumb.pageHeight * previewScale }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            data-testid="pdf-preview"
          >
            <img
              src={thumb.dataUrl}
              width={thumb.pageWidth * previewScale}
              height={thumb.pageHeight * previewScale}
              alt={`第 ${thumb.page} 页`}
              draggable={false}
            />
            {rect && (
              <div
                className="pdf-region"
                style={{
                  left: rect.x * previewScale,
                  top: rect.y * previewScale,
                  width: rect.w * previewScale,
                  height: rect.h * previewScale,
                }}
              />
            )}
          </div>
          <button
            className="btn-primary"
            disabled={!rect}
            title={rect ? '按 300 DPI 渲染所选区域并导入（将清除当前校准与已取点）' : '先在预览上框选区域'}
            data-testid="pdf-import-region"
            onClick={() => {
              if (rect && thumb) void importPdfRegion(thumb.page, rect)
            }}
          >
            导入区域（300 DPI）
          </button>
        </>
      )}
    </div>
  )
}
