// store.ts — Zustand 单一 store（铁律 1：单一数据源）
// model：业务数据，唯一持久化切片（.pdproj 序列化对象）
// ui：临时界面状态，不持久化；渲染层从这里读一切，自身不持有业务数据
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  createEmptyModel,
  type AxisId,
  type PixelPoint,
  type ProjectModel,
  type ToolId,
} from './model'
import { identityViewport, type Viewport } from '../render/viewport'

export type { Viewport }

/**
 * 调试可视化叠加（铁律 5：Fit 失败的扫描带/候选线/内外点是默认行为，非开发者开关）。
 * 由 engine 诊断结果填充（M2-1/M2-5），渲染层原样绘制。
 */
export interface DebugOverlay {
  /** 扫描带（图像坐标矩形），ink 10% 填充 */
  scanBands?: { x: number; y: number; w: number; h: number }[]
  /** 候选线（拟合失败时），warning 色 */
  candidateLines?: { axis: AxisId; pos: number }[]
  /** AxisFitter 全部采样点位置（中位数不剔点，无内外点之分），ink 色 */
  samplePoints?: PixelPoint[]
  inliers?: PixelPoint[]
  outliers?: PixelPoint[]
}

/** 裁剪选框（图像坐标，§5.3：显示轨矢量叠加层，零像素运算） */
export interface CropBox {
  x: number
  y: number
  w: number
  h: number
}

/** 临时 UI 状态：不写入 .pdproj */
export interface UiState {
  activeTool: ToolId
  viewport: Viewport
  /** 未确认的当前标记（Confirm 后转为 SeriesPoint 进入 model） */
  pendingMarker: PixelPoint | null
  selectedPointId: string | null
  selectedTickId: string | null
  /** 状态栏一句话提示 / 内联错误（铁律 4/5） */
  statusMessage: string | null
  /** Fit 诊断叠加（engine 产出，渲染层原样绘制；铁律 5） */
  debugOverlay: DebugOverlay | null
  /** 裁剪选框（imageEdit 工具；§6.6 执行前全程预览） */
  cropBox: CropBox | null
  /** 画轴工具的手绘草稿线（图像坐标，拖动全程预览；松开即拟合） */
  draftLine: { a: PixelPoint; b: PixelPoint } | null
  /** 方向键步进（图像像素，面板可调，默认 1，Shift ×10；§6.3） */
  nudgeStep: number
  /** 光标处图像坐标（hover 读数数据源，§6.3 铁律 2 级联） */
  hoverImage: PixelPoint | null
  /** 待确认的新文件导入名（§6.6 加载重置预告；File 本体在 io/fileAccess 模块态） */
  pendingImportName: string | null
  /** PDF 会话图库（§5.5；文档句柄在 pdf/pdfSession 模块态保活，store 只放缩略图元信息） */
  pdfGallery: {
    fileName: string
    pageCount: number
    thumbs: {
      page: number
      dataUrl: string
      width: number
      height: number
      pageWidth: number
      pageHeight: number
    }[]
  } | null
  /** 已有校准时裁剪需二次确认（铁律 3 预告；首次确认后置位） */
  cropArmed: boolean
}

export interface AppState {
  model: ProjectModel
  ui: UiState
}

export function createFreshUi(): UiState {
  return {
    activeTool: 'drawXAxis',
    viewport: identityViewport(),
    pendingMarker: null,
    selectedPointId: null,
    selectedTickId: null,
    statusMessage: null,
    debugOverlay: null,
    cropBox: null,
    draftLine: null,
    nudgeStep: 1,
    hoverImage: null,
    pendingImportName: null,
    pdfGallery: null,
    cropArmed: false,
  }
}

export const useStore = create<AppState>()(
  immer(() => ({
    model: createEmptyModel(),
    ui: createFreshUi(),
  })),
)
