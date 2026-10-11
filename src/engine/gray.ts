// gray.ts — 灰度化（§4.1：一次性，Rec.601，与 cv::COLOR_BGR2GRAY / Qt Grayscale8 一致）
// 纯函数，零 DOM 依赖；整张图只做一次，所有后续算法共享该 buffer（在 Worker 中执行）。
// 修复 C++ 版性能 bug 的契约保证：refine 等算法接收本 buffer 作为参数，绝不自行转换图像。

/**
 * RGBA → 灰度。gray[i] = round(0.299R + 0.587G + 0.114B)
 * 输入长度必须 = width × height × 4；输出长度 = width × height。
 */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height
  if (rgba.length !== n * 4) {
    throw new Error(`toGray: 输入长度 ${rgba.length} 与 ${width}×${height} RGBA 不符`)
  }
  const out = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Rec.601；四舍五入以贴合 cv::COLOR_BGR2GRAY 的整数结果（误差 ≤1）
    out[i] = Math.round(0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2])
  }
  return out
}
