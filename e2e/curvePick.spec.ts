// 曲线涂抹端到端：沿红线拖一笔 → Enter → Worker 提取一串点，点都落在红线上（tests/fixtures/curves.png）
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { compositeOnWhite, decodePngRgba } from '../tests/helpers/png'

test.use({ viewport: { width: 1600, height: 900 } })

const FIXTURE = path.resolve('tests/fixtures/curves.png')

async function toScreen(page: Page, p: { x: number; y: number }) {
  const vp = await page.evaluate(() => (window as any).__store.getState().ui.viewport)
  return { x: p.x * vp.scale + vp.offsetX, y: p.y * vp.scale + vp.offsetY }
}

const shot = (name: string) => (process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, name) : test.info().outputPath(name))

test('沿红线涂抹一笔 → Enter 提取，点全部落在红线上，画布画出连线（curves.png）', async ({ page }) => {
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(FIXTURE)
  await expect(page.locator('.empty-hint')).toHaveCount(0)
  await page.evaluate(() => {
    ;(window as any).__store.setState((s: any) => {
      const c = s.model.calibration.x
      c.axisLine = 231
      c.ticks = [
        { id: 't1', pos: 63, at: { x: 63, y: 231 }, fittedPos: 63, value: -3000 },
        { id: 't2', pos: 339, at: { x: 339, y: 231 }, fittedPos: 339, value: 0 },
      ]
    })
  })
  await page.getByTestId('add-series').click()
  await page.getByTestId('new-series-curve').click()
  await page.getByRole('button', { name: '取点', exact: true }).click()
  await page.getByTestId('curve-radius').fill('8')

  // 手涂：沿红线大致走向，整体偏 (+2, −2)
  const path0 = [[154, 28], [220, 57], [268, 79], [292, 98], [298, 112], [304, 138], [310, 167], [322, 203], [328, 213]]
  const pts = await Promise.all(path0.map(([x, y]) => toScreen(page, { x: x + 2, y: y - 2 })))
  await page.mouse.move(pts[0].x, pts[0].y)
  await page.mouse.down()
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByTestId('confirm-curve')).toBeEnabled()
  await page.screenshot({ path: shot('stroke.png') })

  await page.keyboard.press('Enter')
  await expect(page.locator('.status-bar')).toContainText(/已提取 \d+ 个点（序列 11–序列 1\d+），曲线色 #/)
  const got: { x: number; y: number }[] = await page.evaluate(() =>
    (window as any).__store.getState().model.series[0].points.map((q: any) => q.pixel),
  )
  expect(got.length).toBeGreaterThan(50)

  const { rgba: raw, width } = decodePngRgba(FIXTURE)
  const rgba = compositeOnWhite(raw)
  const isRed = (x: number, y: number) => {
    const j = (y * width + x) * 4
    return rgba[j] > 150 && rgba[j + 1] < 140 && rgba[j + 2] < 140
  }
  for (const p of got) {
    let d = Infinity
    for (let y = Math.floor(p.y) - 3; y <= Math.floor(p.y) + 3; y++) {
      for (let x = Math.floor(p.x) - 3; x <= Math.floor(p.x) + 3; x++) {
        if (isRed(x, y)) d = Math.min(d, Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y))
      }
    }
    expect(d).toBeLessThanOrEqual(1)
  }
  await page.screenshot({ path: shot('extracted.png') })
})
