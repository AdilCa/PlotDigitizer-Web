// mdExport.test.ts — MD 导出内容生成（§7.2）
import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../src/state/store'
import { createEmptyModel, createSeries } from '../src/state/model'
import { buildMarkdown, formatValue, suggestedBaseName } from '../src/io/mdExport'
import { annotatedName, defaultExportForm } from '../src/io/exporter'
import { createFreshUi } from '../src/state/store'

const IMG = { name: 'chart.png', sourceType: 'file' as const, width: 800, height: 600 }

beforeEach(() => {
  useStore.setState({ model: createEmptyModel(), ui: createFreshUi() }, true)
})

function calibratedModel(withY = true) {
  const model = createEmptyModel()
  model.image = IMG
  for (const axis of ['x', 'y'] as const) {
    if (axis === 'y' && !withY) break
    model.calibration[axis].axisLine = 500
    model.calibration[axis].ticks.push(
      { id: `${axis}1`, pos: 100, at: { x: 100, y: 100 }, fittedPos: 100, value: 0 },
      { id: `${axis}2`, pos: 700, at: { x: 700, y: 700 }, fittedPos: 700, value: 60 },
    )
  }
  const s = createSeries('A')
  s.points.push(
    { id: 'p1', pixel: { x: 400, y: 250 }, name: 'A1' },
    { id: 'p2', pixel: { x: 100, y: 100 }, name: 'A2' },
  )
  model.series.push(s)
  model.activeSeriesId = s.id
  return model
}

const META = { title: '我的图表', annotatedPngName: 'chart-annotated.png', axisNames: { x: '时间/s', y: '电压/V' } }

describe('mdExport（§7.2）', () => {
  it('结构：标题 / 截图链接 / 校准信息 / 序列表格；数据由 selector 即时计算', () => {
    const md = buildMarkdown(calibratedModel(), META)
    expect(md).toContain('# 我的图表')
    expect(md).toContain('![标注截图](chart-annotated.png)')
    expect(md).toContain('X 轴：a=-10, b=0.1, scaleType=linear')
    expect(md).toContain('## A')
    expect(md).toContain('| 点名 | 时间/s | 电压/V |')
    // p1: x=400 → 30；y=250 → 15
    expect(md).toContain('| A1 | 30 | 15 |')
    expect(md).toContain('| A2 | 0 | 0 |')
  })

  it('跳过轴整列不出现（F1.1，含表头）', () => {
    const model = calibratedModel()
    model.calibration.y.skipped = true
    const md = buildMarkdown(model, META)
    expect(md).toContain('- Y 轴：已跳过')
    expect(md).toContain('| 点名 | 时间/s |')
    expect(md).not.toContain('电压/V')
    expect(md).toContain('| A1 | 30 |')
  })

  it('未校准轴同样不出现（无映射）', () => {
    const model = calibratedModel(false)
    model.calibration.y.axisLine = 500 // 有线但未校准
    const md = buildMarkdown(model, META)
    expect(md).toContain('- Y 轴：未校准')
    expect(md).not.toContain('电压/V')
  })

  it('suggestedBaseName：图片去扩展 + -digitized；PDF 带定位（§7.3）', () => {
    expect(suggestedBaseName(IMG)).toBe('chart-digitized')
    expect(
      suggestedBaseName({
        name: 'p3',
        sourceType: 'pdf',
        width: 1,
        height: 1,
        pdf: { fileName: 'paper.pdf', page: 3, imageIndex: 2 },
      }),
    ).toBe('p3-p3-img2-digitized')
  })

  it('annotatedName 与 MD 共用主体', () => {
    expect(annotatedName('chart-digitized')).toBe('chart-annotated')
  })

  it('formatValue：整数直出，小数去尾零', () => {
    expect(formatValue(30)).toBe('30')
    expect(formatValue(0.1)).toBe('0.1')
    expect(formatValue(1.5e-7)).toBe('1.5e-7')
  })

  it('defaultExportForm 从当前 model 预填', () => {
    useStore.setState({ model: calibratedModel(), ui: createFreshUi() }, true)
    const f = defaultExportForm()
    expect(f.fileName).toBe('chart-digitized')
    expect(f.title).toBe('chart')
  })
})
