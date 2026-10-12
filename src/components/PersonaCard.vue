<script setup lang="ts">
/**
 * 先贤卡片
 * ------------------------------------------------------------------
 * 主色通过 CSS 自定义属性 --accent 注入，卡片内部所有强调色都读它。
 * 这样新增一位先贤只要在数据里给个颜色，不用再写一份样式。
 */
import type { Persona } from '@/data/personas'

defineProps<{
  persona: Persona
  /** 是否是当前对话正在使用的角色 */
  active?: boolean
  /**
   * 细分身份标签（如「各科老师」「律师」）。
   * 角色广场把若干细分分类并成了展示分组，靠这个标签把合并掉的信息补回来，
   * 否则「学习与学术」一组里分不清谁是任课老师、谁是论文导师。
   */
  subLabel?: string
}>()
</script>

<template>
  <button
    class="card"
    :class="{ active }"
    :style="{ '--accent': persona.accent }"
    :aria-pressed="active ? 'true' : 'false'"
  >
    <span class="avatar" aria-hidden="true">{{ persona.name.slice(0, 1) }}</span>
    <span class="name">{{ persona.name }}</span>
    <span class="meta">
      <span class="era">{{ persona.era }}</span>
      <span v-if="subLabel" class="sub">{{ subLabel }}</span>
    </span>
    <span class="tagline">{{ persona.tagline }}</span>

    <span v-if="active" class="badge">当前</span>
  </button>
</template>

<style scoped>
.card {
  position: relative;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  column-gap: 13px;
  align-items: center;
  padding: 13px 14px;
  border-radius: var(--r-md);
  text-align: left;
  background: var(--surface-1);
  border: 1px solid var(--border);
  overflow: hidden;
  transition:
    transform var(--dur-fast) var(--ease),
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}

.card:active {
  transform: scale(0.972);
  background: var(--surface-2);
}

.card.active {
  border-color: var(--brand);
}

.avatar {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  grid-column: 1;
  grid-row: 1 / 4;
  border-radius: 14px;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 1.2rem;
  font-weight: 700;
  font-family: Georgia, 'Songti SC', serif;
}

.name {
  grid-column: 2;
  font-size: var(--fs-sm);
  font-weight: 700;
}

.era {
  font-size: 0.625rem;
  letter-spacing: 0.06em;
  color: var(--brand);
}

/* 细分身份标签：和 era 同一行，太长时换行而不是把卡片撑破 */
.meta {
  grid-column: 2;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.sub {
  font-size: 0.625rem;
  padding: 1px 6px;
  border-radius: var(--r-full);
  color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.tagline {
  grid-column: 2;
  margin-top: 1px;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-2);
}

.badge {
  position: absolute;
  top: 10px;
  right: 10px;
  font-size: 0.625rem;
  padding: 2px 7px;
  border-radius: var(--r-full);
  color: var(--brand);
  background: var(--brand-soft);
}
</style>
