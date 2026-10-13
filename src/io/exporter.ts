// exporter.ts — 导出流程（§7.2/§7.3）
// 产物：{主体}.md + {主体}-annotated.png（同目录同主体名）。
// 数据由 selector 即时计算（铁律 2）；标注截图由 Worker 按处理轨分辨率离屏重绘（与缩放无关）。
// 保存：默认 showSaveFilePicker（浏览器记住目录，第二次起一键确认）；
// API 不可用（或用户环境不支持）时回退 <a download>。
import { useStore } from '../state/store'
import { setStatus } from '../state/commands'
import { SERIES_COLORS } from '../render/canvasRenderer'
import { workerRenderAnnotated } from '../worker/workerClient'
import { buildMarkdown, suggestedBaseName, type ExportMeta } from './mdExport'

export interface ExportForm {
  /** MD 主体名（含 -digitized 后缀；§7.3 预填规则） */
  fileName: string
  title: string
  axisNames: { x?: string; y?: string }
}

export function defaultExportForm(): ExportForm {
  const { model } = useStore.getState()
  return {
    fileName: suggestedBaseName(model.image),
    title: model.image?.name.replace(/\.[^.]+$/, '') ?? '提取数据',
    axisNames: { x: 'X', y: 'Y' },
  }
}

/** 由 MD 主体名推导 PNG 主体名（-digitized → -annotated，共用主体） */
export function annotatedName(mdBase: string): string {
  return mdBase.replace(/-digitized$/, '') + '-annotated'
}

/** 生成导出物（纯数据组装 + Worker 渲染；无副作用，可测性由 buildMarkdown 承担） */
export async function produceExport(form: ExportForm): Promise<{ md: Blob; png: Blob; pngName: string }> {
  const { model } = useStore.getState()
  const markers = model.series.flatMap((s, i) =>
    s.points.map((p) => ({ x: p.pixel.x, y: p.pixel.y, color: SERIES_COLORS[i % SERIES_COLORS.length], name: p.name })),
  )
  const pngBytes = await workerRenderAnnotated(markers)
  const pngName = `${annotatedName(form.fileName)}.png`
  const meta: ExportMeta = { title: form.title, annotatedPngName: pngName, axisNames: form.axisNames }
  const md = new Blob([buildMarkdown(model, meta)], { type: 'text/markdown' })
  const png = new Blob([pngBytes as unknown as BlobPart], { type: 'image/png' })
  return { md, png, pngName }
}

interface SaveFilePickerOptions {
  suggestedName: string
  types?: { description: string; accept: Record<string, string[]> }[]
}

declare global {
  interface Window {
    showSaveFilePicker?: (opts?: SaveFilePickerOptions) => Promise<{
      createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>
    }>
  }
}

/** 单个文件保存：优先 File System Access API；回退 anchor 下载。返回 false = 用户取消 */
async function saveBlob(blob: Blob, suggestedName: string, mime: string, ext: string): Promise<boolean> {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: suggestedName, accept: { [mime]: [ext] } }],
      })
      const w = await handle.createWritable()
      await w.write(blob)
      await w.close()
      return true
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return false // 用户取消，静默
      throw err
    }
  }
  // 回退：anchor 下载（浏览器默认下载目录）
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

/** 导出主流程：MD 与 PNG 同目录同主体（两个保存对话框，浏览器记住目录） */
export async function runExport(form: ExportForm): Promise<void> {
  setStatus('正在生成导出…')
  try {
    const { md, png, pngName } = await produceExport(form)
    const mdName = `${form.fileName}.md`
    if (!(await saveBlob(md, mdName, 'text/markdown', '.md'))) return
    if (!(await saveBlob(png, pngName, 'image/png', '.png'))) return
    setStatus(`已导出 ${mdName} 与 ${pngName}`)
  } catch (err) {
    setStatus(`导出失败：${err instanceof Error ? err.message : String(err)}`) // 内联反馈，铁律 5
  }
}

/** 保存工程 .pdproj（§7.1：store-only zip = project.json + image.png） */
export async function runSaveProject(): Promise<void> {
  setStatus('正在打包工程…')
  try {
    const { buildProjectFile } = await import('./fileAccess')
    const { model } = useStore.getState()
    const blob = await buildProjectFile()
    const stem = model.image?.name.replace(/\.[^.]+$/, '') ?? 'project'
    if (await saveBlob(blob, `${stem}.pdproj`, 'application/vnd.plotdigitizer.project', '.pdproj')) {
      setStatus(`工程已保存为 ${stem}.pdproj`)
    }
  } catch (err) {
    setStatus(`保存失败：${err instanceof Error ? err.message : String(err)}`)
  }
}
