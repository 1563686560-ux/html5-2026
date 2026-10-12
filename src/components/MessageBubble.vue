<script setup lang="ts">
/**
 * 消息气泡
 * ------------------------------------------------------------------
 * 用户消息靠右、纯文本；助手消息靠左、Markdown 渲染。
 * 支持长按复制（自带触觉反馈），并用 -webkit-touch-callout 屏蔽
 * 系统原生的长按菜单，保持统一的应用内手感。
 */
import { computed } from 'vue'
import type { Persona } from '@/data/personas'
import type { StoredMessage } from '@/stores/chat'
import { useToast } from '@/composables/useToast'
import MarkdownView from './MarkdownView.vue'

const props = defineProps<{
  message: StoredMessage
  persona: Persona
  /** 是否是正在生成中的那一条（用于显示光标） */
  live?: boolean
}>()

const { show } = useToast()

const isUser = computed(() => props.message.role === 'user')
const isEmpty = computed(() => props.message.content.length === 0)

let pressTimer: number | undefined

function clearPress(): void {
  if (pressTimer !== undefined) {
    window.clearTimeout(pressTimer)
    pressTimer = undefined
  }
}

function onPressStart(): void {
  if (isEmpty.value) return
  clearPress()
  pressTimer = window.setTimeout(() => {
    pressTimer = undefined
    void copyMessage()
  }, 520)
}

async function copyMessage(): Promise<void> {
  const text = props.message.content
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    // 轻微震动反馈，让"复制成功"这件事可感知
    navigator.vibrate?.(12)
    show('已复制全文', 'success')
  } catch {
    show('复制失败，请手动选择文本', 'error')
  }
}
</script>

<template>
  <div
    class="row"
    :class="isUser ? 'from-user' : 'from-assistant'"
    @touchstart.passive="onPressStart"
    @touchend="clearPress"
    @touchmove="clearPress"
    @touchcancel="clearPress"
    @mousedown="onPressStart"
    @mouseup="clearPress"
    @mouseleave="clearPress"
    @contextmenu.prevent
  >
    <div v-if="!isUser" class="avatar" aria-hidden="true">
      {{ persona.name.slice(0, 1) }}
    </div>

    <div class="bubble" :class="{ live }">
      <template v-if="isUser">
        <p class="plain selectable">{{ message.content }}</p>
      </template>

      <template v-else>
        <MarkdownView v-if="message.content" :content="message.content" :streaming="live" />
        <div v-if="message.references?.length && message.content" class="references" @mousedown.stop @touchstart.stop>
          <p class="references-label">本轮参考资料 · 点击编号查看原文</p>
          <details v-for="(source, index) in message.references" :key="index">
            <summary>[{{ index + 1 }}] {{ source.title || '未命名资料' }}</summary>
            <p class="source-note">回答时保存的原文片段；资料删除后仍可核对。</p>
            <p class="source-content">{{ source.content }}</p>
          </details>
        </div>
        <span v-if="live && !message.content" class="thinking" role="status" aria-label="正在思考">
          <i class="dot" />
          <i class="dot" />
          <i class="dot" />
        </span>
        <span v-else-if="live" class="caret" aria-hidden="true" />
        <p v-else-if="message.status === 'incomplete'" class="incomplete-note">{{ message.content ? '回复未完成' : '未生成回复' }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.incomplete-note {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: var(--fs-xs);
}
.references {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.references-label,
.source-note {
  color: var(--text-2);
  font-size: var(--fs-xs);
  margin: 6px 0;
}
.references summary {
  color: var(--brand);
  cursor: pointer;
  padding: 8px 0;
  overflow-wrap: anywhere;
}
.source-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 260px;
  overflow-y: auto;
  line-height: 1.7;
  font-size: var(--fs-sm);
}
.row {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
  -webkit-touch-callout: none;
}

.row.from-user {
  justify-content: flex-end;
}

.avatar {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--brand);
  background: var(--brand-soft);
  border: 1px solid var(--border);
  margin-top: 2px;
}

.bubble {
  max-width: 82%;
  padding: 10px 14px;
  border-radius: var(--r-md);
  background: var(--surface-1);
  border: 1px solid var(--border);
  animation: bubble-in var(--dur) var(--ease);
}

.from-user .bubble {
  background: var(--brand-soft);
  border-color: color-mix(in srgb, var(--brand) 20%, var(--border));
  color: var(--text-1);
  border-bottom-right-radius: 6px;
}

.from-assistant .bubble {
  border-bottom-left-radius: 6px;
}

@keyframes bubble-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.plain {
  margin: 0;
  font-size: var(--fs-md);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 流式光标：跟随在文字末尾闪烁 */
.caret {
  display: inline-block;
  width: 7px;
  height: 1.05em;
  margin-left: 2px;
  vertical-align: text-bottom;
  border-radius: 2px;
  background: var(--brand);
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

/* 还没有任何内容时的三点等待动画 */
.thinking {
  display: inline-flex;
  gap: 5px;
  padding: 3px 0;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: var(--r-full);
  background: var(--text-3);
  animation: bounce 1.3s var(--ease) infinite;
}

.dot:nth-child(2) {
  animation-delay: 0.16s;
}

.dot:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}
</style>
