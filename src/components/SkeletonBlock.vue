<script setup lang="ts">
/**
 * 骨架屏
 * ------------------------------------------------------------------
 * 加载态用「内容形状的灰块 + 流光动画」代替转圈，
 * 视觉上更接近最终内容，能减少等待的突兀感。
 */
const props = withDefaults(defineProps<{ lines?: number; compact?: boolean }>(), {
  lines: 3,
  compact: false
})

/** 让每行宽度有变化，看起来更像真实文本段落 */
const widths = ['100%', '88%', '94%', '72%', '96%', '80%']
</script>

<template>
  <div class="skeleton" :class="{ compact }" aria-hidden="true">
    <span v-for="i in props.lines" :key="i" class="line" :style="{ width: widths[(i - 1) % widths.length] }" />
  </div>
</template>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--sp-4);
}

.skeleton.compact {
  padding: var(--sp-2) 0;
  gap: 8px;
}

.line {
  height: 13px;
  border-radius: var(--r-full);
  background: linear-gradient(90deg, var(--surface-2) 0%, var(--surface-3) 45%, var(--surface-2) 90%);
  background-size: 220% 100%;
  animation: shimmer 1.35s var(--ease) infinite;
}

@keyframes shimmer {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}
</style>
