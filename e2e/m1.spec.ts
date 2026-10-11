// M1 门禁 E2E 冒烟：图像加载（文件选择器路径）→ 画布渲染 → 缩放平移 → 裁剪执行与重置
// 注意：headless 软件渲染下的 fps 仅供参考；>40fps 门禁需真实浏览器人工复核（plan.md M1 门禁）。
import { expect, test } from '@playwright/test'
import path from 'node:path'

const FIXTURE = path.resolve('tests/fixtures/test1.png')

test('M1 冒烟：加载 → 渲染 → 缩放平移 → 裁剪', async ({ page }) => {
  await page.goto('/')

  // 空状态可见
  await expect(page.locator('.empty-hint')).toBeVisible()

  // 经文件选择器加载夹具图片
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开' }).click()
  await (await chooser).setFiles(FIXTURE)

  // 加载完成：空状态消失
  await expect(page.locator('.empty-hint')).toHaveCount(0)

  // 画布非空白（显示轨缩放级为异步解码，轮询等待渐进清晰完成）
  const sampleNonBlank = () =>
    page.evaluate(() => {
      const c = document.querySelector('canvas')!
      const ctx = c.getContext('2d')!
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let diff = 0
      for (let i = 0; i + 2 < d.length; i += 4 * 997) {
        if (Math.abs(d[i] - 233) > 8 || Math.abs(d[i + 1] - 233) > 8 || Math.abs(d[i + 2] - 230) > 8) diff++
      }
      return diff
    })
  await expect.poll(sampleNonBlank, { timeout: 5000 }).toBeGreaterThan(10)

  const box = (await page.locator('canvas').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  // 滚轮缩放（常驻，无需切换工具）
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, -400)
  await page.mouse.wheel(0, 200)

  // 中键平移 + 帧率采样（软件渲染下仅作 sanity）
  await page.mouse.down({ button: 'middle' })
  const fpsPromise = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0
        const t0 = performance.now()
        const loop = () => {
          frames++
          if (performance.now() - t0 < 1500) requestAnimationFrame(loop)
          else resolve(frames / ((performance.now() - t0) / 1000))
        }
        requestAnimationFrame(loop)
      }),
  )
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(cx + i * 5, cy + i * 3)
    await page.waitForTimeout(70)
  }
  const fps = await fpsPromise
  await page.mouse.up({ button: 'middle' }) // 必须显式释放中键，否则影响后续左键交互
  console.log(`[M1 冒烟] 平移期间 rAF 帧率（headless 软件渲染）: ${fps.toFixed(1)} fps`)
  expect(fps).toBeGreaterThan(24) //  sanity：防止病理性卡顿；40fps 门禁以真实浏览器为准

  // 裁剪：切工具 → 拖框 → 确认条出现 → Enter 执行 → 状态栏提示（无校准数据，无需二次确认）
  await page.getByRole('button', { name: '编辑图像' }).click()
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 5 })
  await page.mouse.up()
  await expect(page.locator('.crop-bar')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.status-bar')).toContainText('裁剪完成')
})
