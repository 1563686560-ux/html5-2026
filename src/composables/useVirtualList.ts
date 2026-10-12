/**
 * 定高虚拟滚动
 * ------------------------------------------------------------------
 * 只渲染视口内（外加少量 overscan）的行。手机上一个长列表如果一次渲染几百行，
 * 光是建 DOM 就要几十毫秒，滚动时还会不断触发重排 —— 虚拟滚动把这两件事都按住。
 *
 * 为什么要求**固定行高**：定高才能用「scrollTop ÷ 行高」直接算出可见区间，
 * 不需要测量每一行。代价是长文本要截断（列表里用行数截断 + 省略号），
 * 这恰好也是列表该有的展示方式；需要看全文的地方（如分块内容）另有展开入口。
 *
 * 为什么用 padTop/padBottom 而不是绝对定位：
 * 绝对定位对 `<table>` 不成立（会破坏表格布局），而本项目两处用它的地方
 * 一个是分块列表、一个是 CSV 预览表格。用上下两个占位把滚动高度撑起来，
 * 两种情况都能用。
 */
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

export interface VirtualWindow {
  /** 第一个可见行（含 overscan） */
  start: number
  /** 最后一个可见行的**下一个**下标（含 overscan） */
  end: number
  /** 列表顶部该留出的占位高度 */
  padTop: number
  /** 列表底部该留出的占位高度 */
  padBottom: number
}

/**
 * 纯函数：算出可见区间与上下占位。
 * 单独抽出来是为了能直接测边界（空列表、滚动到底、overscan 越界等），
 * 不用去搭 DOM。
 */
export function computeVirtualWindow(
  total: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 4
): VirtualWindow {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  }

  // 视口高度还没测出来时（首帧），至少渲染 overscan*2 行，避免白屏
  const height = viewportHeight > 0 ? viewportHeight : rowHeight * overscan * 2

  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const start = Math.max(0, Math.min(first, total - 1) - overscan)

  const lastVisible = Math.ceil((Math.max(0, scrollTop) + height) / rowHeight)
  const end = Math.min(total, Math.max(lastVisible + overscan, start + 1))

  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight)
  }
}

export interface UseVirtualListOptions<T> {
  /** 数据源。用 getter 而不是数组，保证响应式更新能被追踪 */
  items: () => T[]
  /** 固定行高（px）。必须与 CSS 里该行的高度一致，否则会错位 */
  rowHeight: number
  overscan?: number
}

export function useVirtualList<T>(options: UseVirtualListOptions<T>) {
  const scroller = ref<HTMLElement | null>(null) as Ref<HTMLElement | null>
  const scrollTop = ref(0)
  const viewportHeight = ref(0)

  let observer: ResizeObserver | null = null

  const total = computed(() => options.items().length)

  const window = computed(() =>
    computeVirtualWindow(total.value, options.rowHeight, scrollTop.value, viewportHeight.value, options.overscan ?? 4)
  )

  const visible = computed(() => options.items().slice(window.value.start, window.value.end))

  /** 滚动时只更新一个数字，实际的裁剪交给 computed */
  function onScroll(): void {
    const el = scroller.value
    if (!el) return
    scrollTop.value = el.scrollTop
  }

  function measure(): void {
    const el = scroller.value
    if (!el) return
    viewportHeight.value = el.clientHeight
  }

  /** 重新打开面板、切换数据源时把滚动位置拉回顶部 */
  function scrollToTop(): void {
    const el = scroller.value
    if (el) el.scrollTop = 0
    scrollTop.value = 0
  }

  /*
   * 监听 scroller 元素本身，而不是在 onMounted 里一次性绑定。
   * 虚拟列表常放在条件渲染的面板里（打开展示、关闭销毁），
   * onMounted 时它还是 null，量不到高度、也挂不上观察器。
   * flush: 'post' 保证在 DOM 更新之后再读尺寸。
   */
  watch(
    scroller,
    (el) => {
      observer?.disconnect()
      observer = null

      if (!el) {
        viewportHeight.value = 0
        return
      }

      measure()
      // 用 ResizeObserver 而不是 window resize：横竖屏、软键盘、容器自身尺寸变化都能覆盖
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure)
        observer.observe(el)
      }
    },
    { flush: 'post' }
  )

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return {
    /** 绑到滚动容器上（模板里 ref="scroller"） */
    scroller,
    visible,
    total,
    /** 绑定到滚动容器的 @scroll */
    onScroll,
    scrollToTop,
    padTop: computed(() => window.value.padTop),
    padBottom: computed(() => window.value.padBottom),
    start: computed(() => window.value.start),
    end: computed(() => window.value.end)
  }
}
