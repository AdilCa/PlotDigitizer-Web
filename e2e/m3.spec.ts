// M3 验收：marker 取点主流程（scatter refine 吸附）+ 点编辑（选中/步进/拖动/删除）+ hover 读数
// 夹具：large-4000x3000.png —— Y 轴线 x=200（y∈[200,2800]，8px 黑），X 轴刻度 x=600..3400。
// refine 验证策略：在 Y 轴线旁点击，scatter 暗度质心应把点吸附到 x≈200 的轴线上（确定性特征）。
import { expect, test } from '@playwright/test'
import path from 'node:path'

const FIXTURE = path.resolve('tests/fixtures/large-4000x3000.png')

test.use({ viewport: { width: 1600, height: 900 } })

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

/** 加载夹具并完成 X 轴校准（复用 M2 流程） */
async function loadAndCalibrateX(page: import('@playwright/test').Page) {
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
  await expect(page.locator('[data-testid="axis-block-x"] .badge').first()).toHaveText('已校准 ✓')
}

test('M3：取点主流程——scatter refine 吸附 + Confirm + 已确认计数', async ({ page }) => {
  await loadAndCalibrateX(page)

  // 门控：X 已校准但还没有序列 → 取点工具不可用，tooltip 说明原因
  const tool = page.getByRole('button', { name: '取点', exact: true })
  await expect(tool).toBeDisabled()
  await expect(tool).toHaveAttribute('title', /新建序列/)

  // 新建序列时必须选择图表类型；之后取点工具可用
  await page.getByTestId('add-series').click()
  await page.getByTestId('new-series-scatter').click()
  await expect(tool).toBeEnabled()
  await tool.click()

  // scatter refine 吸附到 Y 轴线 x≈200
  await clickImage(page, { x: 207, y: 1500 })
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('point-count')).toHaveText('已确认 1 个')
  const pt = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return s.model.series[0].points[0]
  })
  console.log(`[M3] refine 后点位置: (${pt.pixel.x.toFixed(2)}, ${pt.pixel.y.toFixed(2)})，点名 ${pt.name}`)
  expect(Math.abs(pt.pixel.x - 200)).toBeLessThanOrEqual(3) // 吸附到轴线
  expect(Math.abs(pt.pixel.y - 1500)).toBeLessThanOrEqual(8) // 垂直方向不动
  // 新点自动选中（confirmMarkerAt 置 selectedPointId）
  const sel = await page.evaluate(() => (window as any).__store.getState().ui.selectedPointId)
  expect(sel).toBe(pt.id)
})

test('M3：点编辑——选中 / 方向键步进 / 拖动移动 / Delete', async ({ page }) => {
  await loadAndCalibrateX(page)
  // 手动模式：不 refine，按原位置提交（§6.3 manual 语义）
  await page.getByTestId('add-series').click()
  await page.getByTestId('new-series-manual').click()
  await page.getByRole('button', { name: '取点', exact: true }).click()
  await clickImage(page, { x: 1000, y: 1000 })
  await page.keyboard.press('Enter')
  const getPixel = () =>
    page.evaluate(() => {
      const s = (window as any).__store.getState()
      return { ...s.model.series[0].points[0].pixel }
    })
  const p0 = await getPixel()
  expect(Math.abs(p0.x - 1000)).toBeLessThanOrEqual(2)
  expect(Math.abs(p0.y - 1000)).toBeLessThanOrEqual(2)

  // 方向键步进：→ ×3（默认 1px/步）
  await clickImage(page, { x: 1000, y: 1000 }) // 单击选中
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  const p1 = await getPixel()
  expect(Math.abs(p1.x - (p0.x + 3))).toBeLessThanOrEqual(0.5)

  // Shift ×10：↓ 一步 = 10px
  await page.keyboard.press('Shift+ArrowDown')
  const p2 = await getPixel()
  expect(Math.abs(p2.y - (p1.y + 10))).toBeLessThanOrEqual(0.5)

  // 按下时手抖（< 3 屏幕像素）：只选中，不改坐标
  const before = await getPixel()
  const scr = await toScreen(page, { x: before.x, y: before.y })
  await page.mouse.move(scr.x, scr.y)
  await page.mouse.down()
  await page.mouse.move(scr.x + 2, scr.y + 1)
  await page.mouse.up()
  expect(await getPixel()).toEqual(before)

  // 按住拖动：点保持按下时的相对偏移跟随指针
  await dragImage(page, before, { x: before.x + 80, y: before.y + 60 })
  const p3 = await getPixel()
  expect(Math.abs(p3.x - (before.x + 80))).toBeLessThanOrEqual(2)
  expect(Math.abs(p3.y - (before.y + 60))).toBeLessThanOrEqual(2)
  // 拖动只编辑，不新增点、不留下待确认标记
  const { count, pending } = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return { count: s.model.series[0].points.length, pending: s.ui.pendingMarkers.length }
  })
  expect(count).toBe(1)
  expect(pending).toBe(0)

  // Delete 删除选中点
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('point-count')).toHaveText('已确认 0 个')
})

test('M3：hover 读数（铁律 2 级联：像素 + 已校准轴数据坐标）', async ({ page }) => {
  await loadAndCalibrateX(page)
  // 光标移到图像点 (1000, 1000)：读数含像素与 X 数据坐标
  const s = await toScreen(page, { x: 1000, y: 1000 })
  await page.mouse.move(s.x, s.y)
  const readout = page.locator('.hover-readout')
  await expect(readout).toContainText('px (1000, 1000)')
  await expect(readout).toContainText('X:')
  // X 映射：刻度中心 601→0，3401→100 → x=1000 处 X = (1000-601)×100/2800 ≈ 14.25
  const text = await readout.innerText()
  const m = text.match(/X: (-?[\d.]+)/)!
  expect(Math.abs(parseFloat(m[1]) - 14.25)).toBeLessThan(0.5)
  console.log(`[M3] hover 读数: ${text}`)
})
