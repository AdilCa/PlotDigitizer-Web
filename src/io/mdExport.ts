// mdExport.ts — Markdown 导出内容生成（§7.2，纯函数，可单测）
// 表格数据由 selector 即时计算（铁律 2，导出永不自相矛盾，F3.5）；
// 跳过轴整列不出现（F1.1）；未校准轴同样无映射、整列不出现。
import type { ImageRef, ProjectModel } from '../state/model'
import { axisMapping, dataPointsOf } from '../state/selectors'

export interface ExportMeta {
  /** 表标题（导出表单可编辑） */
  title: string
  /** 标注截图文件名（MD 中的相对链接） */
  annotatedPngName: string
  /** 各已校准轴数值名（跳过轴无此项） */
  axisNames: { x?: string; y?: string }
}

/** 数字格式化：整数直出，否则 6 位有效数字 */
export function formatValue(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v)
  return v.toPrecision(6).replace(/\.?0+e/, 'e').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

/** 建议文件名主体（§7.3）：图片 `{名}-digitized`；PDF `{名}-p{页}-img{序}-digitized` */
export function suggestedBaseName(image: ImageRef | null): string {
  if (!image) return 'digitized'
  const stem = image.name.replace(/\.[^.]+$/, '')
  if (image.sourceType === 'pdf' && image.pdf) {
    return `${stem}-p${image.pdf.page}-img${image.pdf.imageIndex}-digitized`
  }
  return `${stem}-digitized`
}

/** 生成 MD 全文（§7.2 结构：标题 / 截图 / 校准信息 / 按序列分节表格） */
export function buildMarkdown(model: ProjectModel, meta: ExportMeta): string {
  const lines: string[] = []
  lines.push(`# ${meta.title}`, '')
  lines.push(`![标注截图](${meta.annotatedPngName})`, '')
  lines.push('## 校准信息', '')

  for (const axis of ['x', 'y'] as const) {
    const label = axis.toUpperCase()
    const cal = model.calibration[axis]
    if (cal.skipped) {
      lines.push(`- ${label} 轴：已跳过`)
      continue
    }
    const m = axisMapping(cal)
    if (m) {
      lines.push(`- ${label} 轴：a=${formatValue(m.a)}, b=${formatValue(m.b)}, scaleType=${m.scaleType}`)
    } else {
      lines.push(`- ${label} 轴：未校准`)
    }
  }
  lines.push('')

  // 列布局：仅已校准（有映射）轴出现；跳过轴整列不出现（F1.1）
  const hasX = axisMapping(model.calibration.x) !== null
  const hasY = axisMapping(model.calibration.y) !== null

  for (const series of model.series) {
    lines.push(`## ${series.name}`, '')
    const headers = ['点名']
    if (hasX) headers.push(meta.axisNames.x ?? 'X')
    if (hasY) headers.push(meta.axisNames.y ?? 'Y')
    lines.push(`| ${headers.join(' | ')} |`)
    lines.push(`|${headers.map(() => '---').join('|')}|`)
    for (const p of dataPointsOf(model, series.id)) {
      const cells = [p.name]
      if (hasX) cells.push(p.x !== undefined ? formatValue(p.x) : '')
      if (hasY) cells.push(p.y !== undefined ? formatValue(p.y) : '')
      lines.push(`| ${cells.join(' | ')} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
