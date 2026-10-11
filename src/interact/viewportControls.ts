// viewportControls.ts — 常驻视口控制（§6.1）
// 滚轮缩放、空格+拖动 / 中键拖动平移在所有工具下全程常驻，不打断当前操作。
// 冲突规则：裸左键拖动永远归当前工具；平移必须带修饰（空格 / 中键）。
// 文本输入框聚焦时，空格等全局快捷键让位文本编辑（§6.3 焦点规则）。
import { useEffect, useRef, type RefObject } from 'react'
import type { PixelPoint } from '../state/model'
import { useStore } from '../state/store'
import { setViewport } from '../state/commands'
import { panBy, wheelZoomFactor, zoomAt } from '../render/viewport'

export type DragRole = 'pan' | 'tool'

/** 手势分类（纯函数，可单测）：中键 → 平移；左键+空格 → 平移；裸左键 → 当前工具；其他 → 忽略 */
export function classifyDragStart(input: { button: number; spaceHeld: boolean }): DragRole | null {
  if (input.button === 1) return 'pan'
  if (input.button === 0) return input.spaceHeld ? 'pan' : 'tool'
  return null
}

function isTextInputFocused(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/** 当前工具的裸拖动回调（由 interact/tools 层在 M1-8 / M2 / M3 提供） */
export interface ToolDragHandlers {
  onToolDragStart?(screenPos: PixelPoint, e: PointerEvent): void
  onToolDragMove?(screenPos: PixelPoint, e: PointerEvent): void
  onToolDragEnd?(screenPos: PixelPoint, e: PointerEvent): void
  /** 无拖动时的指针移动（hover 读数、抓起跟随） */
  onHover?(screenPos: PixelPoint, e: PointerEvent): void
  /** 指针离开画布 */
  onHoverEnd?(): void
  /** 原生双击（pointerdown 的 detail 恒为 0，双击必须用 dblclick 事件检测） */
  onToolDoubleClick?(screenPos: PixelPoint, e: MouseEvent): void
}

/**
 * 挂到画布元素上（M1-3 接线）。平移/缩放直接改 ui.viewport；
 * 裸拖动分类后透传给当前工具处理器，视口控制与工具操作互不阻塞。
 */
export function useViewportControls(
  ref: RefObject<HTMLElement | null>,
  toolHandlers: ToolDragHandlers = {},
): void {
  const spaceHeld = useRef(false)
  const drag = useRef<{
    role: DragRole
    pointerId: number
    lastX: number
    lastY: number
  } | null>(null)
  const handlersRef = useRef(toolHandlers)
  handlersRef.current = toolHandlers

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const localPos = (e: MouseEvent): PixelPoint => {
      const rect = el.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const vp = useStore.getState().ui.viewport
      setViewport(zoomAt(vp, localPos(e), wheelZoomFactor(e.deltaY)))
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTextInputFocused(e.target)) return
      if (!spaceHeld.current) {
        spaceHeld.current = true
        e.preventDefault() // 阻止页面滚动
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false
    }
    // 窗口失焦时复位，避免空格状态卡住
    const onBlur = () => {
      spaceHeld.current = false
    }

    const onPointerDown = (e: PointerEvent) => {
      const role = classifyDragStart({ button: e.button, spaceHeld: spaceHeld.current })
      if (!role) return
      el.setPointerCapture(e.pointerId)
      drag.current = { role, pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
      if (role === 'tool') handlersRef.current.onToolDragStart?.(localPos(e), e)
    }

    const onPointerMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.pointerId) {
        if (!d) handlersRef.current.onHover?.(localPos(e), e)
        return
      }
      if (d.role === 'pan') {
        const vp = useStore.getState().ui.viewport
        setViewport(panBy(vp, e.clientX - d.lastX, e.clientY - d.lastY))
      } else {
        handlersRef.current.onToolDragMove?.(localPos(e), e)
      }
      d.lastX = e.clientX
      d.lastY = e.clientY
    }

    const onPointerLeave = () => {
      handlersRef.current.onHoverEnd?.()
    }

    const onDblClick = (e: MouseEvent) => {
      handlersRef.current.onToolDoubleClick?.(localPos(e), e)
    }

    const onPointerEnd = (e: PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.pointerId) return
      if (d.role === 'tool') handlersRef.current.onToolDragEnd?.(localPos(e), e)
      drag.current = null
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerleave', onPointerLeave)
    el.addEventListener('dblclick', onDblClick)
    el.addEventListener('pointerup', onPointerEnd)
    el.addEventListener('pointercancel', onPointerEnd)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerleave', onPointerLeave)
      el.removeEventListener('dblclick', onDblClick)
      el.removeEventListener('pointerup', onPointerEnd)
      el.removeEventListener('pointercancel', onPointerEnd)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [ref])
}
