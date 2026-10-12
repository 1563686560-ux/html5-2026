/**
 * 左右滑动切换
 * ------------------------------------------------------------------
 * 与下拉刷新共用同一片触摸区域，所以判定必须**严格**：
 * 只有「横向位移够大」且「横向明显大于纵向」才算滑动意图。
 * 判定不出来就返回 null —— 宁可什么都不做，
 * 也不要在用户只是想上下滚消息时把会话切走。
 */
import { ref } from 'vue'

/** 触发切换所需的最小横向位移（px）。太小会与「点按」和轻微抖动混淆 */
export const SWIPE_MIN_PX = 56

/**
 * 横向位移至少要达到纵向的这么多倍，才算「明确的横向意图」。
 * 取 1.8 是经验值：斜着划一下不会被判成滑动，但正常的横划很容易过线。
 */
export const SWIPE_DOMINANCE = 1.8

export type SwipeDirection = 'prev' | 'next'

/**
 * 纯函数：由位移判定方向，判不出来返回 null。
 * 单独抽出来是为了能直接测边界，不必去构造 TouchEvent。
 */
export function resolveSwipe(dx: number, dy: number, min = SWIPE_MIN_PX): SwipeDirection | null {
  if (Math.abs(dx) < min) return null
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_DOMINANCE) return null
  // 手指向右 → 回到上一条；向左 → 去看下一条。与轮播图的直觉一致
  return dx > 0 ? 'prev' : 'next'
}

export interface SwipeNavHandlers {
  onPrev: () => void
  onNext: () => void
}

export function useSwipeNav(handlers: SwipeNavHandlers) {
  /** 多指触摸（缩放等）不参与判定 */
  const tracking = ref(false)

  let startX = 0
  let startY = 0

  function onTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) {
      tracking.value = false
      return
    }
    const touch = event.touches[0]
    startX = touch.clientX
    startY = touch.clientY
    tracking.value = true
  }

  function onTouchEnd(event: TouchEvent): void {
    if (!tracking.value) return
    tracking.value = false

    const touch = event.changedTouches[0]
    if (!touch) return

    const direction = resolveSwipe(touch.clientX - startX, touch.clientY - startY)
    if (!direction) return

    if (direction === 'prev') handlers.onPrev()
    else handlers.onNext()
  }

  function onTouchCancel(): void {
    tracking.value = false
  }

  return { onTouchStart, onTouchEnd, onTouchCancel }
}
