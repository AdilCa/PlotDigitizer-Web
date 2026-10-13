// M4 验收：.pdproj 往返、MD+PNG 导出、PDF 图库区域导入、加载重置预告
import { expect, test } from '@playwright/test'
import path from 'node:path'

const FIXTURE = path.resolve('tests/fixtures/large-4000x3000.png')
const PDF_FIXTURE = path.resolve('tests/fixtures/sample.pdf')

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

/** 加载夹具 + X 轴校准 + 1 个序列 2 个点（manual 原位提交） */
async function setupProject(page: import('@playwright/test').Page) {
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(FIXTURE)
  await expect(page.locator('.empty-hint')).toHaveCount(0)
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
  await page.getByTestId('add-series').click()
  await page.getByTestId('new-series-manual').click()
  await page.getByRole('button', { name: '取点', exact: true }).click()
  await clickImage(page, { x: 1000, y: 1000 })
  await page.keyboard.press('Enter')
  await clickImage(page, { x: 2000, y: 1500 })
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('point-count')).toHaveText('已确认 2 个')
}

test('M4：MD + 标注 PNG 导出（跳过轴整列不出现；数据与屏幕一致）', async ({ page }) => {
  await setupProject(page)
  await page.getByTestId('export-toggle').click()
  await expect(page.getByTestId('export-filename')).toHaveValue('large-4000x3000-digitized')
  await page.getByTestId('export-title').fill('E2E 图表')
  await page.locator('[data-testid^="export-prefix-"]').fill('P')

  const mdDownload = page.waitForEvent('download')
  await page.getByTestId('export-run').click()
  const md = await mdDownload
  expect(md.suggestedFilename()).toBe('large-4000x3000-digitized.md')
  const png = await page.waitForEvent('download')
  expect(png.suggestedFilename()).toBe('large-4000x3000-annotated.png')

  const mdPath = await md.path()
  const fs = await import('node:fs/promises')
  const content = await fs.readFile(mdPath, 'utf-8')
  console.log('[M4] MD 导出预览:\n' + content.split('\n').slice(0, 16).join('\n'))
  expect(content).toContain('# E2E 图表')
  expect(content).toContain('![标注截图](large-4000x3000-annotated.png)')
  expect(content).toContain('X 轴：a=-21.4643,') // 刻度中心 601→0, 3401→100：a = -601×100/2800
  expect(content).toContain('Y 轴：未校准')
  expect(content).toMatch(/\| 点名 \| X \|/) // 跳过/未校准轴整列不出现
  expect(content).toMatch(/\| P1 \| 14\.\d+ \|/) // p1 x=1000 → X≈14.23；导出前改的前缀作用于已有点
  expect(content).toMatch(/\| P2 \| /)

  const pngPath = await png.path()
  await png.saveAs(test.info().outputPath('annotated.png')) // 留档供人工查看
  const pngHead = await fs.readFile(pngPath)
  expect(pngHead[0]).toBe(0x89) // PNG 魔数
  expect(pngHead.length).toBeGreaterThan(10000)
  await expect(page.locator('.status-bar')).toContainText('已导出')
})

test('M4：.pdproj 保存→恢复完整工程（图像 + 校准 + 取点）', async ({ page }) => {
  await setupProject(page)
  await page.getByTestId('export-toggle').click()

  const download = page.waitForEvent('download')
  await page.getByTestId('save-project').click()
  const dl = await download
  expect(dl.suggestedFilename()).toBe('large-4000x3000.pdproj')
  const projPath = await dl.path()

  // 全新页面恢复
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(projPath!)
  await expect(page.locator('.status-bar')).toContainText('工程已恢复', { timeout: 10000 })

  const s = await page.evaluate(() => {
    const st = (window as any).__store.getState()
    return {
      w: st.model.image?.width,
      xCal: st.model.calibration.x.axisLine,
      ticks: st.model.calibration.x.ticks.length,
      points: st.model.series[0]?.points.length,
      name: st.model.series[0]?.points[0]?.name,
    }
  })
  console.log('[M4] .pdproj 恢复:', JSON.stringify(s))
  expect(s.w).toBe(4000)
  expect(Math.abs(s.xCal - 2800)).toBeLessThanOrEqual(3)
  expect(s.ticks).toBe(2)
  expect(s.points).toBe(2)
  expect(s.name).toBe('序列 11')
})

test('M4：加载重置预告（铁律 3）——已有工作时新文件需确认', async ({ page }) => {
  await setupProject(page)
  // 拖入/选择新文件 → 预告条，不直接替换
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(FIXTURE)
  await expect(page.getByTestId('import-bar')).toBeVisible()
  await expect(page.getByTestId('import-bar')).toContainText('将清除当前校准与已取点')
  // 取消：状态不变
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByTestId('point-count')).toHaveText('已确认 2 个')
  // 再次触发并确认 → 全量重置
  const chooser2 = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser2).setFiles(FIXTURE)
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('point-count')).toHaveText('已确认 0 个')
  const xCal = await page.evaluate(
    () => (window as any).__store.getState().model.calibration.x.axisLine,
  )
  expect(xCal).toBeNull() // 无旧校准残留（F3.4）
})

test('M4：PDF 选页弹窗 → 整页按 DPI 导入，会话可重新打开（§5.5）', async ({ page }) => {
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(PDF_FIXTURE)
  // 打开即弹窗，两页缩略图逐页出现
  const dialog = page.getByTestId('pdf-dialog')
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('pdf-page-1')).toBeVisible()
  await expect(page.getByTestId('pdf-page-2')).toBeVisible()
  await expect(dialog.locator('.pdf-dialog-progress')).toHaveCount(0)

  const pageSize = (p: number) =>
    page.evaluate((n) => {
      const t = (window as any).__store.getState().ui.pdfGallery.thumbs.find((x: any) => x.page === n)
      return { wPt: t.widthPt, hPt: t.heightPt }
    }, p)
  const px = (pt: number, dpi: number) => Math.ceil((pt / 72) * dpi)

  // 选第 2 页：大预览 + 导入尺寸提示；↑ 回到第 1 页
  await page.getByTestId('pdf-page-2').click()
  await expect(page.getByRole('img', { name: '第 2 页预览' })).toBeVisible()
  const s2 = await pageSize(2)
  await expect(page.getByTestId('pdf-import-size')).toContainText(`${px(s2.wPt, 300)}×${px(s2.hPt, 300)} px`)
  await page.screenshot({ path: test.info().outputPath('pdf-dialog.png') }) // 留档供人工查看
  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('pdf-page-1')).toHaveClass(/selected/)

  // 预览区只看不裁：拖动不产生任何选框
  const box = (await page.getByTestId('pdf-preview').boundingBox())!
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 5 })
  await page.mouse.up()
  await expect(dialog.locator('.pdf-region')).toHaveCount(0)

  // Enter 导入第 1 页（整页 300 DPI）
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.empty-hint')).toHaveCount(0, { timeout: 15000 })
  const s1 = await pageSize(1)
  const img1 = await page.evaluate(() => ({ ...(window as any).__store.getState().model.image }))
  console.log('[M4] PDF 整页导入:', JSON.stringify(img1))
  expect(img1.sourceType).toBe('pdf')
  expect(img1.pdf).toEqual({ fileName: 'sample.pdf', page: 1, imageIndex: 1 })
  expect(img1.width).toBe(px(s1.wPt, 300))
  expect(img1.height).toBe(px(s1.hPt, 300))
  await expect(page.locator('.status-bar')).toContainText('图像编辑')

  // 换图后会话仍在：检查器重新打开弹窗，150 DPI 双击导入第 2 页
  await page.getByTestId('pdf-reopen').click()
  await expect(dialog).toBeVisible()
  await page.getByTestId('pdf-dpi').selectOption('150')
  await page.getByTestId('pdf-page-2').dblclick()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => (window as any).__store.getState().model.image?.pdf?.page))
    .toBe(2)
  const img2 = await page.evaluate(() => ({ ...(window as any).__store.getState().model.image }))
  expect(img2.pdf).toEqual({ fileName: 'sample.pdf', page: 2, imageIndex: 2 })
  expect(img2.width).toBe(px(s2.wPt, 150))

  // Esc 关闭弹窗，不导入
  await page.getByTestId('pdf-reopen').click()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__store.getState().model.image.pdf.page)).toBe(2)
})
