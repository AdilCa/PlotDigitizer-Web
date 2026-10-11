// M1 门禁大图实测：4000×3000 合成图的加载、缩放平移帧率与裁剪重置
// headless 软件渲染数字仅作参考下限；门禁结论以真实浏览器人工复核为准。
import { expect, test } from '@playwright/test'
import path from 'node:path'

const FIXTURE = path.resolve('tests/fixtures/large-4000x3000.png')

test('M1 门禁：4000×3000 大图性能与裁剪重置', async ({ page }) => {
  await page.goto('/')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(FIXTURE)
  await expect(page.locator('.empty-hint')).toHaveCount(0)

  // 等待显示轨首级解码完成（画布出现非底色像素）
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = document.querySelector('canvas')!
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
          let diff = 0
          for (let i = 0; i + 2 < d.length; i += 4 * 997) {
            if (Math.abs(d[i] - 233) > 8 || Math.abs(d[i + 1] - 233) > 8 || Math.abs(d[i + 2] - 230) > 8) diff++
          }
          return diff
        }),
      { timeout: 8000 },
    )
    .toBeGreaterThan(10)

  const box = (await page.locator('canvas').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // 连续缩放 + 平移期间采样帧率
  const fpsPromise = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0
        const t0 = performance.now()
        const loop = () => {
          frames++
          if (performance.now() - t0 < 2000) requestAnimationFrame(loop)
          else resolve(frames / ((performance.now() - t0) / 1000))
        }
        requestAnimationFrame(loop)
      }),
  )
  await page.mouse.move(cx, cy)
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(40)
  }
  await page.mouse.down({ button: 'middle' })
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(cx + i * 8, cy + i * 5)
    await page.waitForTimeout(40)
  }
  await page.mouse.up({ button: 'middle' })
  const fps = await fpsPromise
  console.log(`[M1 门禁] 4000×3000 缩放平移 rAF 帧率（headless 软件渲染）: ${fps.toFixed(1)} fps`)
  expect(fps).toBeGreaterThan(24) // sanity 下限；>40fps 以真实浏览器复核

  // 裁剪执行 → 全量重置（§6.6），新图像尺寸生效
  await page.getByRole('button', { name: '编辑图像' }).click()
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.75, { steps: 5 })
  await page.mouse.up()
  await expect(page.locator('.crop-bar')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.status-bar')).toContainText('裁剪完成')
  const dims = await page.evaluate(() => {
    const s = (window as any).__store.getState()
    return { w: s.model.image?.width, h: s.model.image?.height }
  })
  expect(dims.w).toBeGreaterThan(100)
  expect(dims.w).toBeLessThan(4000) // 裁剪后小于原图
  console.log(`[M1 门禁] 裁剪后图像尺寸: ${dims.w}×${dims.h}`)
})
