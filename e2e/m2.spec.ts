// M2 验收：完整 X 轴校准流程（画轴拟合 → 标刻度 → 拟合刻度 → 录值 → 已校准）
// 夹具：tests/fixtures/large-4000x3000.png
//   X 轴线 y=2800（x∈[200,3800]，8px 黑）；刻度线 x=600..3400 步 400（y∈[2800,2830]，4px）
import { expect, test } from '@playwright/test'
import path from 'node:path'

const FIXTURE = path.resolve('tests/fixtures/large-4000x3000.png')

test.use({ viewport: { width: 1600, height: 900 } })

/** 图像坐标 → 页面鼠标坐标（canvas 铺满窗口左上角 (0,0)） */
async function toScreen(page: import('@playwright/test').Page, p: { x: number; y: number }) {
  return page.evaluate((pt) => {
    const vp = (window as any).__store.getState().ui.viewport
    return { x: pt.x * vp.scale + vp.offsetX, y: pt.y * vp.scale + vp.offsetY }
  }, p)
}

async function dragImage(page: import('@playwright/test').Page, a: { x: number; y: number }, b: { x: number; y: number }) {
  const sa = await toScreen(page, a)
  const sb = await toScreen(page, b)
  await page.mouse.move(sa.x, sa.y)
  await page.mouse.down()
  await page.mouse.move(sb.x, sb.y, { steps: 8 })
  await page.mouse.up()
}

async function clickImage(page: import('@playwright/test').Page, p: { x: number; y: number }) {
  const s = await toScreen(page, p)
  await page.mouse.click(s.x, s.y)
}

test('M2：X 轴校准主流程（拟合轴线 ±3px、刻度吸附、映射参数出现）', async ({ page }) => {
  await page.goto('/')
  // 加载图像
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(FIXTURE)
  await expect(page.locator('.empty-hint')).toHaveCount(0)

  // 状态栏引导：铁律 4 一句话（无 statusMessage 时回退到 nextActionHint）
  await expect(page.locator('.status-bar')).toContainText('X 轴')

  // ---- 画 X 轴（斜手绘线 400,2795 → 3600,2805，松开即 Worker 拟合）
  await page.getByRole('button', { name: '画 X 轴' }).click()
  await dragImage(page, { x: 400, y: 2795 }, { x: 3600, y: 2805 })
  await expect(page.locator('.status-bar')).toContainText('轴线已拟合', { timeout: 8000 })
  const axisLine = await page.evaluate(
    () => (window as any).__store.getState().model.calibration.x.axisLine as number,
  )
  console.log(`[M2] X 轴线拟合位置: ${axisLine}（期望 2800±3）`)
  expect(Math.abs(axisLine - 2800)).toBeLessThanOrEqual(3)

  // 检查清单徽标：X 轴进入「缺刻度」
  await expect(page.locator('[data-testid="axis-block-x"] .badge').first()).toHaveText('缺刻度')

  // ---- 标两个 X 刻度（点击刻度线本体，剖面行避开轴线）
  await page.getByRole('button', { name: '标 X 刻度' }).click()
  await clickImage(page, { x: 600, y: 2815 })
  await clickImage(page, { x: 3400, y: 2815 })
  const tickCount = await page.evaluate(
    () => (window as any).__store.getState().model.calibration.x.ticks.length,
  )
  expect(tickCount).toBe(2)

  // ---- 拟合 X 轴刻度（门控可用；点击后空心→实心吸附到 600/3400）
  const fitBtn = page.getByTestId('fit-x')
  await expect(fitBtn).toBeEnabled()
  await fitBtn.click()
  await expect(page.locator('.status-bar')).toContainText('刻度已拟合', { timeout: 8000 })
  const fitted = await page.evaluate(() =>
    (window as any).__store.getState().model.calibration.x.ticks.map((t: any) => ({
      pos: t.pos,
      fittedPos: t.fittedPos,
    })),
  )
  console.log(`[M2] 刻度拟合结果: ${JSON.stringify(fitted)}`)
  expect(Math.abs(fitted[0].fittedPos - 600)).toBeLessThanOrEqual(2)
  expect(Math.abs(fitted[1].fittedPos - 3400)).toBeLessThanOrEqual(2)
  expect(fitted[0].pos).toBe(fitted[0].fittedPos) // pos 吸附 = 派生「已拟合」
  // 空心 → 实心视觉态
  await expect(page.locator('[data-testid="tick-row-x-0"] .tick-dot')).toHaveClass(/dot-solid/)

  // ---- 录刻度值 → 已校准（徽标 + 映射参数 a/b 出现）
  await page.getByTestId('tick-value-x-0').fill('0')
  await page.getByTestId('tick-value-x-1').fill('100')
  await expect(page.locator('[data-testid="axis-block-x"] .badge').first()).toHaveText('已校准 ✓')
  await expect(page.locator('[data-testid="axis-block-x"] .mapping-info')).toBeVisible()
  const mappingText = await page.locator('[data-testid="axis-block-x"] .mapping-info').innerText()
  console.log(`[M2] X 轴映射参数: ${mappingText}`)
  // b = 100 / (3400-600) ≈ 0.0357
  expect(mappingText).toContain('b = 0.0357')

  // ---- 引导推进：X 校准完成后状态栏指向 Y 轴
  await expect(page.locator('.status-bar')).toContainText('Y 轴')

  // ---- 删除轴线：画轴工具下单击轴线选中 → Delete，连带清除刻度与刻度值
  await page.getByRole('button', { name: '画 X 轴' }).click()
  await clickImage(page, { x: 2000, y: 2802 })
  await expect(page.locator('.status-bar')).toContainText('已选中 X 轴线')
  await page.keyboard.press('Delete')
  const afterDelete = await page.evaluate(() => {
    const c = (window as any).__store.getState().model.calibration.x
    return { line: c.axisLine, n: c.ticks.length }
  })
  expect(afterDelete).toEqual({ line: null, n: 0 })
  await expect(page.locator('[data-testid="axis-block-x"] .badge').first()).toHaveText('未设置')
})

test('M2：拟合失败走内联反馈（铁律 5），状态不破坏', async ({ page }) => {
  page.on('console', (m) => console.log(`[browser:${m.type()}]`, m.text()))
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(FIXTURE)
  await expect(page.locator('.empty-hint')).toHaveCount(0)

  // 在空白区域画轴（y≈500：避开 y=400/600 水平网格线；垂直网格线整列同灰度、对比度为 0 被门控拒绝）
  await page.getByRole('button', { name: '画 X 轴' }).click()
  await dragImage(page, { x: 3000, y: 495 }, { x: 3700, y: 505 })
  await expect(page.locator('.status-bar')).toContainText('有效采样点不足', { timeout: 8000 })
  const axisLine = await page.evaluate(
    () => (window as any).__store.getState().model.calibration.x.axisLine,
  )
  expect(axisLine).toBeNull()
})
