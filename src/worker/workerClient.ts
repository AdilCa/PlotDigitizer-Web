// workerClient.ts — 主线程侧 Worker 客户端（懒加载单例，id 配对请求/响应）
import type { AxisFitDiagnostics } from '../engine/axisFitter'
import type { TickFitDiagnostics } from '../engine/tickFitter'
import type { AxisId, PixelPoint } from '../state/model'
import type {
  AnnotatedMarker,
  CropRect,
  RefinedItem,
  RefineItem,
  TracedCurve,
  WorkerRequest,
  WorkerResponse,
} from './protocol'

/** 算法失败时 reject 的错误类型：携带 engine 诊断（扫描带/候选线），供调试叠加层可视化 */
export class WorkerRequestError extends Error {
  diagnostics?: unknown
  constructor(message: string, diagnostics?: unknown) {
    super(message)
    this.name = 'WorkerRequestError'
    this.diagnostics = diagnostics
  }
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>()

/** 分配式 Omit：对联合类型逐成员去掉 id（请求发送前不含 id） */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
export type WorkerRequestDraft = WithoutId<WorkerRequest>

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./imageWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const resp = e.data
      const entry = pending.get(resp.id)
      if (!entry) return
      pending.delete(resp.id)
      if (resp.ok) entry.resolve(resp)
      else entry.reject(new WorkerRequestError(resp.error, resp.diagnostics))
    }
    worker.onerror = (e) => {
      const err = new Error(e.message || 'imageWorker 异常')
      for (const entry of pending.values()) entry.reject(err)
      pending.clear()
    }
  }
  return worker
}

function request<T extends WorkerResponse>(
  req: WorkerRequestDraft,
  transfer: Transferable[] = [],
): Promise<T> {
  const w = ensureWorker()
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: WorkerResponse) => void, reject })
    w.postMessage({ ...req, id } as WorkerRequest, { transfer })
  })
}

/** 图像加载：Worker decode → gray 一次（§5.2）；返回处理轨尺寸 */
export async function workerLoadImage(file: Blob): Promise<{ width: number; height: number }> {
  const resp = await request<Extract<WorkerResponse, { reqType: 'loadImage'; ok: true }>>({
    type: 'loadImage',
    file,
  })
  return { width: resp.width, height: resp.height }
}

/** 裁剪：Worker 重建双轨并回传显示轨缩略图与累计区域（§5.3） */
export async function workerCrop(
  rect: CropRect,
  base: { width: number; height: number },
): Promise<{
  width: number
  height: number
  thumbnail: ImageBitmap
  region: CropRect
}> {
  const resp = await request<Extract<WorkerResponse, { reqType: 'crop'; ok: true }>>({
    type: 'crop',
    rect,
    base,
  })
  return { width: resp.width, height: resp.height, thumbnail: resp.thumbnail, region: resp.region }
}

export async function workerDispose(): Promise<void> {
  await request({ type: 'dispose' })
}

/** 当前处理轨图像 → PNG 字节（.pdproj 保存路径，§7.1；编辑烘焙后图像） */
export async function workerExportImagePng(): Promise<Uint8Array> {
  const resp = await request<Extract<WorkerResponse, { reqType: 'exportImagePng'; ok: true }>>({
    type: 'exportImagePng',
  })
  return new Uint8Array(resp.png)
}

/** 标注截图（§7.2）：Worker 离屏按处理轨分辨率重绘底图 + 标记叠加，与屏幕缩放无关 */
export async function workerRenderAnnotated(
  markers: AnnotatedMarker[],
): Promise<Uint8Array> {
  const resp = await request<Extract<WorkerResponse, { reqType: 'renderAnnotated'; ok: true }>>({
    type: 'renderAnnotated',
    markers,
  })
  return new Uint8Array(resp.png)
}

/** 轴线拟合（§4.2）：手绘线段 → Worker 内 gray 精确定位；失败 reject WorkerRequestError（带 diagnostics） */
export async function workerFitAxis(
  axis: AxisId,
  a: PixelPoint,
  b: PixelPoint,
  scanRadius?: number,
): Promise<{ position: number; diagnostics: AxisFitDiagnostics }> {
  const resp = await request<Extract<WorkerResponse, { reqType: 'fitAxis'; ok: true }>>({
    type: 'fitAxis',
    axis,
    a,
    b,
    scanRadius,
  })
  return { position: resp.position, diagnostics: resp.diagnostics as AxisFitDiagnostics }
}

/** 刻度拟合（§4.3）：点击位置 → 多行谷值中心；全部成功才 resolve，失败 reject（带 diagnostics） */
export async function workerFitTicks(
  axis: AxisId,
  ticks: { id: string; at: PixelPoint }[],
  scanHalf?: number,
): Promise<{ fitted: Record<string, number>; diagnostics: TickFitDiagnostics }> {
  const resp = await request<Extract<WorkerResponse, { reqType: 'fitTicks'; ok: true }>>({
    type: 'fitTicks',
    axis,
    ticks,
    scanHalf,
  })
  return { fitted: resp.fitted, diagnostics: resp.diagnostics as TickFitDiagnostics }
}

/** 批量 refine（Confirm 路径，manual 由调用方短路）（§5.2：无状态接口，输入点数组返回优化后点数组，等长同序） */
export async function workerRefinePoints(items: RefineItem[]): Promise<RefinedItem[]> {
  const resp = await request<Extract<WorkerResponse, { reqType: 'refinePoints'; ok: true }>>({
    type: 'refinePoints',
    items,
  })
  return resp.refined
}

/** 曲线提取（§4.6）：一笔涂抹 → 沿笔迹的曲线点；一个点都没找到时 points 为空、reason 说明原因 */
export async function workerTraceCurve(stroke: PixelPoint[], radius: number, step: number): Promise<TracedCurve> {
  const resp = await request<Extract<WorkerResponse, { reqType: 'traceCurve'; ok: true }>>({
    type: 'traceCurve',
    stroke,
    radius,
    step,
  })
  return { points: resp.points, misses: resp.misses, color: resp.color, reason: resp.reason }
}
