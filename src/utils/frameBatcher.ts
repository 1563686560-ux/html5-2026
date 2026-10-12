/**
 * 帧批量提交器
 * ------------------------------------------------------------------
 * 流式输出时模型每秒可能吐几十上百个 token。如果每个 token 都直接写
 * 响应式状态，就会触发同样多次组件重渲染 —— 手机上必然掉帧。
 *
 * 这里把一帧内的所有增量合并成一次写入：无论这一帧来了多少 token，
 * 都只在下一帧统一更新一次 DOM，这是流式聊天不掉帧的关键。
 */
export interface FrameBatcher {
  /** 提交一个新值，实际写入会推迟到下一帧 */
  push: (value: string) => void
  /** 立即写入并取消待执行的帧回调（流结束时调用，保证最后一帧不丢） */
  flush: () => void
  /** 丢弃待写入的值 */
  cancel: () => void
}

export function createFrameBatcher(apply: (value: string) => void): FrameBatcher {
  let pending: string | null = null
  let frame = 0

  const commit = () => {
    frame = 0
    if (pending !== null) {
      const value = pending
      pending = null
      apply(value)
    }
  }

  return {
    push(value: string) {
      pending = value
      if (!frame) frame = requestAnimationFrame(commit)
    },
    flush() {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      commit()
    },
    cancel() {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      pending = null
    }
  }
}
