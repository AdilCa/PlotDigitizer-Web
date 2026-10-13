// refine 端到端：Confirm 走 Worker 吸附，状态栏给出结果；透明底 PNG 铺白后同样能吸附
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { encodePngRgba } from '../tests/helpers/png'

test.use({ viewport: { width: 1600, height: 900 } })

async function openImage(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(file)
  await expect(page.locator('.empty-hint')).toHaveCount(0)
}

/** 直接写入一条已校准 X 轴（本文件只关心取点，不重复走 M2 校准流程） */
async function injectXCalibration(page: Page, axisLine: number, p1: number, p2: number) {
  await page.evaluate(
    ([line, a, b]) => {
      ;(window as any).__store.setState((s: any) => {
        const c = s.model.calibration.x
        c.axisLine = line
        c.ticks = [
          { id: 't1', pos: a, at: { x: a, y: line }, fittedPos: a, value: 0 },
          { id: 't2', pos: b, at: { x: b, y: line }, fittedPos: b, value: 1 },
        ]
      })
    },
    [axisLine, p1, p2],
  )
}

async function clickImage(page: Page, p: { x: number; y: number }) {
  const vp = await page.evaluate(() => (window as any).__store.getState().ui.viewport)
  await page.mouse.click(p.x * vp.scale + vp.offsetX, p.y * vp.scale + vp.offsetY)
}

const points = (page: Page) =>
  page.evaluate(() => (window as any).__store.getState().model.series[0].points.map((q: any) => q.pixel))

test('散点：偏离标记点击 → Confirm 吸附到标记重心，状态栏显示移动距离，画布记下吸附轮廓（test2.png）', async ({ page }) => {
  await openImage(page, path.resolve('tests/fixtures/test2.png'))
  await injectXCalibration(page, 333, 80, 520)
  await page.getByTestId('add-series').click()
  await page.getByTestId('new-series-scatter').click()
  await page.getByRole('button', { name: '取点', exact: true }).click()

  await clickImage(page, { x: 247.5, y: 147.5 }) // 标记 ≈ (243, 144.5) 右下 4–5px
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('point-count')).toHaveText('已确认 1 个')
  const [p] = await points(page)
  expect(Math.abs(p.x - 243)).toBeLessThan(1.5)
  expect(Math.abs(p.y - 144.5)).toBeLessThan(1.5)
  await expect(page.locator('.status-bar')).toContainText(/已确认 序列 11：已吸附到标记重心（移动 \d+\.\dpx）/)
  const outlines = await page.evaluate(() => (window as any).__store.getState().ui.refineOutlines)
  expect(outlines).toHaveLength(1)
  expect(outlines[0].outline.length).toBeGreaterThanOrEqual(4)

  await page.evaluate(() => {
    const s = (window as any).__store
    s.setState((st: any) => {
      st.ui.viewport = { ...st.ui.viewport, scale: 8, offsetX: 600 - 243 * 8, offsetY: 400 - 144 * 8 }
    })
  })
  await page.screenshot({ path: test.info().outputPath('outline.png'), clip: { x: 450, y: 250, width: 300, height: 300 } })
})

test('透明底 PNG：铺白后吸附正常（不铺白时透明像素被当成纯黑，点原地不动）', async ({ page }) => {
  const W = 300
  const H = 200
  const rgba = new Uint8ClampedArray(W * H * 4) // 全透明
  const dot = { x: 150, y: 100 }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((x + 0.5 - dot.x) ** 2 + (y + 0.5 - dot.y) ** 2 <= 16) {
        rgba.set([0, 0, 0, 255], (y * W + x) * 4)
      }
    }
  }
  await openImage(page, { name: 'transparent.png', mimeType: 'image/png', buffer: encodePngRgba(rgba, W, H) })
  await injectXCalibration(page, 190, 20, 280)
  await page.getByTestId('add-series').click()
  await page.getByTestId('new-series-scatter').click()
  await page.getByRole('button', { name: '取点', exact: true }).click()

  await clickImage(page, { x: 155.5, y: 104.5 })
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('point-count')).toHaveText('已确认 1 个')
  const [p] = await points(page)
  expect(Math.abs(p.x - dot.x)).toBeLessThan(0.5)
  expect(Math.abs(p.y - dot.y)).toBeLessThan(0.5)
})
