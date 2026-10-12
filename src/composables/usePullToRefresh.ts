/**
 * 下拉刷新
 * ------------------------------------------------------------------
 * 用原生 touch 事件实现，不引组件库。
 *
 * 两个关键处理：
 *   1. **阻尼**：手指下拉的距离不等于内容位移的距离，而是乘一个小于 1 的
 *      系数并封顶。否则一下拉到底，手感像在拽一张没有重量的纸。
 *   2. **只在顶部生效**：容器 scrollTop > 0 时完全不管，把滚动手势还给浏览器。
 *      这是下拉刷新最容易做错的地方 —— 处理不当会让列表在中段拉不动。
 */
import { ref, type Ref } from 'vue'

export interface PullToRefreshOptions {
  /** 触发刷新所需的拉动距离 */
  threshold?: number
  onRefresh: () => Promise<void> | void
}

export function usePullToRefresh(container: Ref<HTMLElement | null>, options: PullToRefreshOptions) {
  const threshold = options.threshold ?? 62

  /** 当前内容位移（用于 transform） */
  const distance = ref(0)
  /** 是否处于下拉手势中 */
  const pulling = ref(false)
  /** 是否正在执行刷新 */
  const refreshing = ref(false)

  let startY = 0
  let tracking = false

  function reset(): void {
    distance.value = 0
    pulling.value = false
    tracking = false
  }

  function onTouchStart(event: TouchEvent): void {
    const el = container.value
    if (!el || refreshing.value) return
    // 只有已经在顶部才接管手势
    if (el.scrollTop > 0) return
    startY = event.touches[0].clientY
    tracking = true
    pulling.value = true
  }

  function onTouchMove(event: TouchEvent): void {
    if (!tracking) return
    const el = container.value
    if (!el) return

    const delta = event.touches[0].clientY - startY

    // 向上滑或者已经离开顶部：交还给浏览器滚动
    if (delta <= 0 || el.scrollTop > 0) {
      distance.value = 0
      return
    }

    // 阻尼系数 0.45，并把位移封顶在阈值的 1.4 倍
    distance.value = Math.min(delta * 0.45, threshold * 1.4)

    // 进入了明确的下拉状态才阻止默认行为，避免影响正常滚动
    if (event.cancelable) event.preventDefault()
  }

  async function onTouchEnd(): Promise<void> {
    if (!tracking) return
    tracking = false
    pulling.value = false

    if (distance.value < threshold) {
      distance.value = 0
      return
    }

    refreshing.value = true
    // 保持在阈值位置，让"正在刷新"的指示器停在看得见的地方
    distance.value = threshold

    try {
      await options.onRefresh()
    } catch (error) {
      console.warn('[pull-to-refresh] 刷新失败', error)
    } finally {
      refreshing.value = false
      distance.value = 0
    }
  }

  return {
    distance,
    pulling,
    refreshing,
    threshold,
    reset,
    handlers: { onTouchStart, onTouchMove, onTouchEnd }
  }
}
