// protocol.ts — 主线程 ↔ imageWorker 消息协议（§3 决策 4：Worker 无状态协议）
// 所有请求自带全参数；Worker 唯一持有的可变状态是处理轨像素（gray / bitmap / File 句柄），
// 业务 model 只存主线程，不存在主/Worker 数据分叉。

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface FitPixelPoint {
  x: number
  y: number
}

export interface FitTickInput {
  id: string
  at: FitPixelPoint
}

/** 批量 refine 输入（§5.2）：mode='manual' 不应出现（不调用 refine，§6.3） */
export interface RefineItem {
  refId: string
  x: number
  y: number
  mode: 'scatter' | 'bar'
  barDirection?: 'up' | 'down' | 'left' | 'right'
  barSpan?: number
  scatterRadius?: number
}

/** refine 结果：snapped = false 表示未找到特征，按原位置返回 */
export interface RefinedItem {
  refId: string
  x: number
  y: number
  snapped: boolean
  /** 未吸附原因（scatter） */
  reason?: string
  /** 吸附所用像素的凸包（scatter，图像坐标） */
  outline?: FitPixelPoint[]
}

/** 曲线提取结果（§4.6）：points 按笔迹方向排序；misses 为笔迹上未找到曲线的采样点 */
export interface TracedCurve {
  points: FitPixelPoint[]
  misses: FitPixelPoint[]
  color: { r: number; g: number; b: number } | null
  reason?: string
}

/** 标注截图的标记点（§7.2：按序列着色，颜色由主线程色盘决定） */
export interface AnnotatedMarker {
  x: number
  y: number
  color: string
  /** 点名，标在标记旁 */
  name: string
}

export type WorkerRequest =
  | { id: number; type: 'loadImage'; file: Blob }
  | {
      id: number
      type: 'crop'
      /** 整数像素矩形，已钳制在当前图像内 */
      rect: CropRect
      /** 发起请求时主线程的图像尺寸；与 Worker 当前尺寸不符即拒绝（图像已变化） */
      base: { width: number; height: number }
    }
  | {
      id: number
      type: 'fitAxis'
      axis: 'x' | 'y'
      a: FitPixelPoint
      b: FitPixelPoint
      scanRadius?: number
    }
  | {
      id: number
      type: 'fitTicks'
      axis: 'x' | 'y'
      ticks: FitTickInput[]
      /** 沿轴方向扫描半宽（px），缺省用 engine 默认值 */
      scanHalf?: number
    }
  | { id: number; type: 'refinePoints'; items: RefineItem[] }
  | { id: number; type: 'traceCurve'; stroke: FitPixelPoint[]; radius: number; step: number }
  | { id: number; type: 'exportImagePng' }
  | { id: number; type: 'renderAnnotated'; markers: AnnotatedMarker[] }
  | { id: number; type: 'dispose' }

export type WorkerResponse =
  | { id: number; reqType: 'loadImage'; ok: true; width: number; height: number }
  | {
      id: number
      reqType: 'crop'
      ok: true
      width: number
      height: number
      /** 新显示轨缩略图（长边 ≤2048，transferable；§5.3 步骤 3） */
      thumbnail: ImageBitmap
      /** 裁剪后图像在原始源图中的区域（累计；主线程显示轨直接采用，不再自行累加） */
      region: CropRect
    }
  | {
      id: number
      reqType: 'fitAxis'
      ok: true
      /** 拟合出的轴线位置（X 轴 = y 常量；Y 轴 = x 常量） */
      position: number
      diagnostics: unknown
    }
  | {
      id: number
      reqType: 'fitTicks'
      ok: true
      /** tickId → 拟合后沿轴位置 */
      fitted: Record<string, number>
      diagnostics: unknown
    }
  | { id: number; reqType: 'dispose'; ok: true }
  | {
      id: number
      reqType: 'exportImagePng'
      ok: true
      /** 当前处理轨图像的 PNG 字节（transferable；.pdproj 的 image.png 条目，§7.1） */
      png: ArrayBuffer
    }
  | {
      id: number
      reqType: 'renderAnnotated'
      ok: true
      /** 处理轨分辨率底图 + 标记叠加的 PNG 字节（§7.2，与屏幕缩放无关） */
      png: ArrayBuffer
    }
  | {
      id: number
      reqType: 'refinePoints'
      ok: true
      /** 与请求 items 等长同序（refId 原样回带） */
      refined: RefinedItem[]
    }
  | ({ id: number; reqType: 'traceCurve'; ok: true } & TracedCurve)
  /** 失败响应带算法诊断（扫描带/候选线等，纯 JSON），供内联可视化（铁律 5） */
  | { id: number; reqType: string; ok: false; error: string; diagnostics?: unknown }

/** 处理轨释放阈值（§5.4）：长边超过即灰度化后释放原图 RGBA bitmap */
export const PROCESS_TRACK_RELEASE_EDGE = 4096

/** 显示轨缩略图长边上限（§5.1） */
export const DISPLAY_THUMB_EDGE = 2048

/** 处理轨释放分支判定（纯函数，可单测） */
export function shouldReleaseOriginal(width: number, height: number): boolean {
  return Math.max(width, height) > PROCESS_TRACK_RELEASE_EDGE
}

/** 缩略图目标尺寸（保持比例，长边 ≤ DISPLAY_THUMB_EDGE；原图更小则不放大） */
export function thumbSize(width: number, height: number): { width: number; height: number } {
  const edge = Math.max(width, height)
  if (edge <= DISPLAY_THUMB_EDGE) return { width, height }
  const k = DISPLAY_THUMB_EDGE / edge
  return { width: Math.round(width * k), height: Math.round(height * k) }
}
