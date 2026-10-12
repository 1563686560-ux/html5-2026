<script setup lang="ts">
/**
 * Markdown 正文（分块渲染）
 * ------------------------------------------------------------------
 * 按顶层块逐个绑定 v-html，而不是整篇一次性注入。
 * 这样流式输出时 Vue 只需 patch 变化的那一块 DOM —— 见 utils/markdown.ts。
 */
import { computed } from 'vue'
import { renderMarkdownBlocks } from '@/utils/markdown'

const props = defineProps<{
  content: string
  /** 流式进行中：末块不写缓存，避免每帧的中间态把历史块的缓存挤掉 */
  streaming?: boolean
}>()

const blocks = computed(() => renderMarkdownBlocks(props.content, props.streaming === true))
</script>

<template>
  <div class="markdown selectable">
    <!-- 渲染内容已由 DOMPurify 消毒，v-html 是 Markdown 渲染的既定用法 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-for="block in blocks" :key="block.index" class="md-block" v-html="block.html" />
  </div>
</template>

<style scoped>
.markdown {
  font-size: var(--fs-md);
  line-height: 1.72;
  word-break: break-word;
}

.markdown :deep(p) {
  margin: 0 0 0.7em;
}

/* 分块渲染之后，块之间的间距由各元素自身的外边距提供，
   所以不能再把每个 p 的 margin-bottom 抹掉；
   只去掉整篇回答最开头与最末尾的外边距，避免气泡上下留白过多 */
.markdown :deep(.md-block:first-child > :first-child) {
  margin-top: 0;
}

.markdown :deep(.md-block:last-child > :last-child) {
  margin-bottom: 0;
}

.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) {
  margin: 1.1em 0 0.5em;
  line-height: 1.35;
  font-weight: 650;
}

.markdown :deep(h1) {
  font-size: 1.35em;
}

.markdown :deep(h2) {
  font-size: 1.2em;
}

.markdown :deep(h3) {
  font-size: 1.08em;
}

.markdown :deep(ul),
.markdown :deep(ol) {
  margin: 0 0 0.7em;
  padding-left: 1.3em;
}

.markdown :deep(li) {
  margin-bottom: 0.28em;
}

.markdown :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
  padding: 0.14em 0.42em;
  border-radius: 6px;
  background: var(--surface-3);
}

.markdown :deep(pre) {
  margin: 0 0 0.8em;
  padding: var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.markdown :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 0.84em;
  line-height: 1.6;
}

.markdown :deep(blockquote) {
  margin: 0 0 0.8em;
  padding: 0.2em 0 0.2em 0.9em;
  border-left: 3px solid var(--brand);
  color: var(--text-2);
}

.markdown :deep(a) {
  color: var(--brand);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.markdown :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 0.8em;
  font-size: 0.92em;
}

.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 8px;
  text-align: left;
}

.markdown :deep(th) {
  background: var(--surface-2);
}

.markdown :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}
</style>
