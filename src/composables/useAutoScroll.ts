/**
 * 自动滚动到底部
 * ------------------------------------------------------------------
 * 聊天界面的经典问题：流式输出时内容不断变高，但如果用户已经手动往上
 * 翻了（在回看历史），就不该把他强行拽回底部。
 * 所以这里维护一个「是否贴底」的状态，只有贴底时才自动跟随。
 */
import { nextTick, onMounted, ref, watch, type Ref } from 'vue'

/** 距离底部多少像素以内算「贴底」 */
const NEAR_BOTTOM_PX = 90

export function useAutoScroll(container: Ref<HTMLElement | null>, signature: () => string) {
  const pinned = ref(true)

  function updatePinned(): void {
    const el = container.value
    if (!el) return
    pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
  }

  function scrollToBottom(behavior: ScrollBehavior = 'auto'): void {
    const el = container.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }

  onMounted(() => {
    void nextTick(() => scrollToBottom())
  })

  // signature 变化即代表内容有更新（新消息或流式增量）
  watch(signature, () => {
    if (!pinned.value) return
    void nextTick(() => scrollToBottom())
  })

  return { pinned, updatePinned, scrollToBottom }
}
