// M5 验收：主流程端到端冒烟（plan M5-5）
// 拖入图片 → 画双轴 → 标刻度 → 拟合 → 多序列取点（M5-1 分组工作流）→ 编辑点 → 导出 → 拖入 .pdproj 恢复
// 夹具：large-4000x3000.png —— X 轴 y=2800 x∈[200,3800]，X 刻度 x=600..3400 步 400；
//       Y 轴 x=200，Y 刻度（轴内侧）y=401/801/.../2801 步 400。
import { expect, test } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'

const FIXTURE = path.resolve('tests/fixtures/large-4000x3000.png')

test.use({ viewport: { width: 1600, height: 900 } })

// 导出/保存走 <a download> 回退（headless 无法操作原生保存对话框）
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as any).showSaveFilePicker
  })
})

async function toScreen(page: import('@playwright/test').Page, p: { x: number; y: number }) {
  return page.evaluate((pt) => {
    const vp = (window as any).__store.getState().ui.viewport
    return { x: pt.x * vp.scale + vp.offsetX, y: pt.y * vp.scale + vp.offsetY }
  }, p)
}

async function clickImage(page: import('@playwright/test').Page, p: { x: number; y: number }) {
  const s = await toScreen(page, p)
  await page.mouse.click(s.x, s.y)
}

async function dragImage(page: import('@playwright/test').Page, a: { x: number; y: number }, b: { x: number; y: number }) {
  const sa = await toScreen(page, a)
  const sb = await toScreen(page, b)
  await page.mouse.move(sa.x, sa.y)
  await page.mouse.down()
  await page.mouse.move(sb.x, sb.y, { steps: 8 })
  await page.mouse.up()
}

/** 拖放加载文件（验证拖放路径，而非 filechooser） */
async function dropFile(page: import('@playwright/test').Page, filePath: string, name: string, type: string) {
  const bytes = Array.from(fs.readFileSync(filePath))
  await page.evaluate(
    async ([data, fileName, mime]) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(data as number[])], fileName as string, { type: mime as string }))
      const el = document.querySelector('.app-shell')!
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    },
    [bytes, name, type] as const,
  )
}

test('M5 冒烟：完整主流程 + .pdproj 恢复', async ({ page }) => {
  await page.goto('/')
  // 空状态引导（M5-3）
  await expect(page.locator('.empty-hint')).toBeVisible()
  await expect(page.locator('.status-bar')).toContainText('拖入图片开始')

  // ---- 拖入图片
  await dropFile(page, FIXTURE, 'large-4000x3000.png', 'image/png')
  await expect(page.locator('.empty-hint')).toHaveCount(0)

  // ---- 画 X 轴 → 标 X 刻度 → 拟合 → 输值
  await page.getByRole('button', { name: '画 X 轴' }).click()
  await dragImage(page, { x: 400, y: 2795 }, { x: 3600, y: 2805 })
  await expect(page.locator('.status-bar')).toContainText('轴线已拟合', { timeout: 8000 })
  await page.getByRole('button', { name: '标 X 刻度' }).click()
  await clickImage(page, { x: 600, y: 2815 })
  await clickImage(page, { x: 3400, y: 2815 })
  await page.getByTestId('fit-x').click()
  await expect(page.locator('.status-bar')).toContainText('刻度已拟合', { timeout: 8000 })
  await page.getByTestId('tick-value-x-0').fill('0')
  await page.getByTestId('tick-value-x-1').fill('100')

  // ---- 画 Y 轴 → 标 Y 刻度 → 拟合 → 输值（y 小 = 值大）
  await page.getByRole('button', { name: '画 Y 轴' }).click()
  await dragImage(page, { x: 195, y: 400 }, { x: 205, y: 2600 })
  await expect(page.locator('.status-bar')).toContainText('轴线已拟合', { timeout: 8000 })
  await page.getByRole('button', { name: '标 Y 刻度' }).click()
  await clickImage(page, { x: 220, y: 401 })
  await clickImage(page, { x: 220, y: 2401 })
  await page.getByTestId('fit-y').click()
  await expect(page.locator('.status-bar')).toContainText('刻度已拟合', { timeout: 8000 })
  await page.getByTestId('tick-value-y-0').fill('100')
  await page.getByTestId('tick-value-y-1').fill('0')

  // 检查清单双轴已校准（M5-2 清单）
  const checklist = page.locator('.insp-checklist')
  await expect(checklist).toContainText('已校准 ✓')

  // ---- 多序列取点（M5-1 分组工作流：组 A 柱状 → 切组 B）
  await page.getByRole('button', { name: '取点' }).click()
  await page.getByTestId('add-series').click()
  await page.getByTestId('series-name-0').fill('组A')
  await page.getByTestId('chart-type').selectOption('bar')
  await expect(page.getByTestId('bar-direction')).toBeVisible()
  await clickImage(page, { x: 1000, y: 1000 })
  await page.keyboard.press('Enter')
  await clickImage(page, { x: 2000, y: 1500 })
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('point-count')).toHaveText('已确认 2 个')

  await page.getByTestId('add-series').click()
  await page.getByTestId('series-name-1').fill('组B')
  // 点行 = 切换当前序列（M5-1）
  await page.getByTestId('series-row-0').click()
  await expect(page.getByTestId('point-count')).toHaveText('已确认 2 个')
  await page.getByTestId('series-row-1').click()
  await expect(page.getByTestId('point-count')).toHaveText('已确认 0 个')
  await clickImage(page, { x: 1200, y: 1200 })
  await page.keyboard.press('Enter')
  await clickImage(page, { x: 2200, y: 1800 })
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('point-count')).toHaveText('已确认 2 个')
  // 序列列表 badge 显示各自点数（ui-style §4）
  await expect(page.getByTestId('series-row-0')).toContainText('2 点')
  await expect(page.getByTestId('series-row-1')).toContainText('2 点')

  // 删除第三个序列：活动序列回退，不残留
  await page.getByTestId('add-series').click()
  await page.getByTestId('series-delete-2').click()
  await expect(page.getByTestId('series-row-2')).toHaveCount(0)

  // ---- 编辑点：行内改名（决策 #20）+ 方向键微调 + Delete 删最后一个标记（M5-3）
  await page.getByTestId('point-name-0').fill('B1')
  // 点坐标区选中（避开 name 输入框，防止方向键被文本编辑吃掉——快捷键让位规则）
  await page.getByTestId('point-row-0').locator('.point-pos').click()
  const readB0 = () =>
    page.evaluate(() => {
      const st = (window as any).__store.getState()
      const b = st.model.series.find((x: any) => x.name === '组B')
      return { name: b.points[0].name, x: b.points[0].pixel.x, y: b.points[0].pixel.y }
    })
  const before = await readB0()
  await page.keyboard.press('ArrowRight')
  const after = await readB0()
  expect(after.name).toBe('B1')
  expect(after.x - before.x).toBeCloseTo(1, 5) // 方向键步进 1px
  expect(after.y - before.y).toBeCloseTo(0, 5)
  // Esc 取消选中（M5-3）
  await page.keyboard.press('Escape')
  // 无选中时 Delete = 删除当前序列最后一个已确认标记（interaction-spec §3）
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('point-count')).toHaveText('已确认 1 个')
  // 补回一个点，保持导出两序列各 2 点
  await clickImage(page, { x: 2200, y: 1800 })
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('point-count')).toHaveText('已确认 2 个')

  // ---- 导出 MD + PNG
  await page.getByTestId('export-toggle').click()
  await expect(page.getByTestId('export-filename')).toHaveValue('large-4000x3000-digitized')
  const mdDownload = page.waitForEvent('download')
  await page.getByTestId('export-run').click()
  const md = await mdDownload
  const png = await page.waitForEvent('download')
  expect(md.suggestedFilename()).toBe('large-4000x3000-digitized.md')
  expect(png.suggestedFilename()).toBe('large-4000x3000-annotated.png')
  const content = await fs.promises.readFile(await md.path(), 'utf-8')
  expect(content).toMatch(/\| 点名 \| X \| Y \|/) // 双轴均已校准
  expect(content).toContain('组A')
  expect(content).toContain('B1') // 改名后的点出现在导出里
  console.log('[M5] MD 导出预览:\n' + content.split('\n').slice(0, 14).join('\n'))

  // ---- 保存工程 → 全新页面拖入 .pdproj 恢复
  const projDownload = page.waitForEvent('download')
  await page.getByTestId('save-project').click()
  const proj = await projDownload
  const projPath = await proj.path()

  await page.goto('/')
  await dropFile(page, projPath!, 'large-4000x3000.pdproj', 'application/octet-stream')
  await expect(page.locator('.status-bar')).toContainText('工程已恢复', { timeout: 10000 })

  const restored = await page.evaluate(() => {
    const st = (window as any).__store.getState()
    return {
      w: st.model.image?.width,
      xCal: st.model.calibration.x.axisLine,
      yCal: st.model.calibration.y.axisLine,
      series: st.model.series.map((x: any) => ({ name: x.name, type: x.chartType, n: x.points.length })),
      b0: st.model.series.find((x: any) => x.name === '组B')?.points[0]?.name,
    }
  })
  console.log('[M5] .pdproj 恢复:', JSON.stringify(restored))
  expect(restored.w).toBe(4000)
  expect(Math.abs(restored.xCal - 2800)).toBeLessThanOrEqual(3)
  expect(Math.abs(restored.yCal - 200)).toBeLessThanOrEqual(3)
  expect(restored.series).toEqual([
    { name: '组A', type: 'bar', n: 2 },
    { name: '组B', type: 'scatter', n: 2 },
  ])
  expect(restored.b0).toBe('B1')
})
