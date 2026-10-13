// projectFile.ts — .pdproj 读写（§7.1）
// store-only zip 容器：`project.json`（model 全量，v1 schema，含 version 字段）
// + `image.png`（编辑烘焙后的当前图像，恢复时无需重放编辑历史）。
// 与 C++ 版脱钩，不兼容旧文件、无迁移路径。
import {
  createEmptyModel,
  DEFAULT_BAR_SPAN,
  DEFAULT_CURVE_RADIUS,
  DEFAULT_CURVE_STEP,
  DEFAULT_SCATTER_RADIUS,
  type ProjectModel,
} from '../state/model'
import { readZip, writeZip } from './zipStore'

export const PROJECT_JSON_ENTRY = 'project.json'
export const PROJECT_IMAGE_ENTRY = 'image.png'

/** 序列化：model → project.json 字节（纯函数，可单测） */
export function serializeProject(model: ProjectModel): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(model))
}

/**
 * 解析 project.json → model（纯函数，可单测）。
 * 结构校验：version 必须为 1；缺关键字段即拒绝（宁缺毋滥，铁律 5 内联报错由调用方负责）。
 */
export function parseProjectJson(bytes: Uint8Array): ProjectModel {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('project.json 不是合法 JSON')
  }
  const m = raw as Partial<ProjectModel>
  if (m?.version !== 1) throw new Error('不支持的工程文件版本（仅支持 v1）')
  if (typeof m.calibration?.x !== 'object' || typeof m.calibration?.y !== 'object') {
    throw new Error('project.json 缺少校准数据')
  }
  if (!Array.isArray(m.series)) throw new Error('project.json 缺少序列数据')
  if (typeof m.image !== 'object' || m.image === null) throw new Error('project.json 缺少图像信息')
  // 与空模型做深合并式兜底：缺失的可选字段用默认值补齐（向前兼容空间）
  const base = createEmptyModel()
  return {
    ...base,
    ...m,
    version: 1,
    calibration: {
      x: { ...base.calibration.x, ...m.calibration.x },
      y: { ...base.calibration.y, ...m.calibration.y },
    },
    series: m.series.map((s) => ({
      ...s,
      barSpan: s.barSpan ?? DEFAULT_BAR_SPAN,
      scatterRadius: s.scatterRadius ?? DEFAULT_SCATTER_RADIUS,
      curveRadius: s.curveRadius ?? DEFAULT_CURVE_RADIUS,
      curveStep: s.curveStep ?? DEFAULT_CURVE_STEP,
    })),
  } as ProjectModel
}

/** 打包 .pdproj（project.json + image.png） */
export function buildProjectBlob(model: ProjectModel, imagePng: Uint8Array): Blob {
  const zip = writeZip([
    { name: PROJECT_JSON_ENTRY, data: serializeProject(model) },
    { name: PROJECT_IMAGE_ENTRY, data: imagePng },
  ])
  return new Blob([zip.buffer as ArrayBuffer], { type: 'application/vnd.plotdigitizer.project' })
}

/** 解包 .pdproj；结构/版本错误抛带原因的 Error */
export function parseProject(bytes: Uint8Array): { model: ProjectModel; imagePng: Uint8Array } {
  const entries = readZip(bytes)
  const json = entries.find((e) => e.name === PROJECT_JSON_ENTRY)
  const img = entries.find((e) => e.name === PROJECT_IMAGE_ENTRY)
  if (!json) throw new Error('.pdproj 中缺少 project.json')
  if (!img) throw new Error('.pdproj 中缺少 image.png')
  return { model: parseProjectJson(json.data), imagePng: img.data }
}
