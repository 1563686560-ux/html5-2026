/**
 * 视口状态：软键盘遮挡高度 + 横竖屏方向
 * ------------------------------------------------------------------
 * 这两件事都必须走 JS，纯 CSS 做不到：
 *
 *   1. **软键盘没有对应的 CSS 单位**。`dvh` 跟随的是地址栏伸缩，不含键盘；
 *      iOS Safari 弹出键盘时布局视口高度**不变**，内容被直接盖住，
 *      只有 `visualViewport` 会缩小 —— 所以键盘高度只能从它读。
 *   2. **旋转屏幕**之后需要把聊天重新滚到底、重量一次贴底状态，这是命令式动作。
 *
 * 键盘高度同时写进 `html` 的 `--kb-inset`，样式层按需消费；
 * 组件也可以直接用导出的响应式 `keyboardInset` / `isLandscape`。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 小于这个高度一律当噪声。
 * iOS 键盘最矮也在 200px 以上，而地址栏伸缩只有几十像素；
 * 取 80px 是为了既不会误判地址栏，也不会把矮键盘漏掉。
 */
const KEYBOARD_MIN_PX = 80

/** 键盘再高也不过屏高的一半多一点，超过就说明读数异常，宁可不动 */
const KEYBOARD_MAX_RATIO = 0.6

export function useViewport() {
  const keyboardInset = ref(0)
  const isLandscape = ref(false)

  function readKeyboard(): void {
    const vv = window.visualViewport
    if (!vv) {
      keyboardInset.value = 0
      return
    }

    /*
     * innerHeight 与可视视口底部的差值，就是被键盘盖住的高度。
     * 这个算法在两端都成立：
     *   Android Chrome 弹键盘时 innerHeight 会一起缩小 → 差值≈0 → 不重复补偿；
     *   iOS Safari 不缩 innerHeight，差值就是键盘高度 → 正好补上。
     */
    const covered = window.innerHeight - (vv.height + vv.offsetTop)
    const max = window.innerHeight * KEYBOARD_MAX_RATIO
    const next = covered > KEYBOARD_MIN_PX && covered < max ? Math.round(covered) : 0

    if (next !== keyboardInset.value) {
      keyboardInset.value = next
      document.documentElement.style.setProperty('--kb-inset', `${next}px`)
    }
  }

  function readOrientation(): void {
    isLandscape.value = window.matchMedia('(orientation: landscape)').matches
  }

  function onWindowResize(): void {
    readKeyboard()
    readOrientation()
  }

  onMounted(() => {
    readKeyboard()
    readOrientation()
    // visualViewport 的 resize/scroll 是键盘收放的唯一可靠信号
    window.visualViewport?.addEventListener('resize', readKeyboard)
    window.visualViewport?.addEventListener('scroll', readKeyboard)
    window.addEventListener('resize', onWindowResize)
    window.addEventListener('orientationchange', onWindowResize)
  })

  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener('resize', readKeyboard)
    window.visualViewport?.removeEventListener('scroll', readKeyboard)
    window.removeEventListener('resize', onWindowResize)
    window.removeEventListener('orientationchange', onWindowResize)
    document.documentElement.style.removeProperty('--kb-inset')
  })

  return { keyboardInset, isLandscape }
}
