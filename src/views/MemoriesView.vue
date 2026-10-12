<script setup lang="ts">
/**
 * 记忆可视化
 * ------------------------------------------------------------------
 * 抽象的"AI 记住了你"必须变成用户看得见、删得掉、关得上的卡片。
 */
import { ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'
import { useMemoryStore } from '@/stores/memory'
import { useToast } from '@/composables/useToast'

const memory = useMemoryStore()
const { show } = useToast()
const draft = ref('')
const topic = ref('偏好')
const adding = ref(false)

const topics = ['身份', '偏好', '目标', '经历', '其他']

async function addMemory(): Promise<void> {
  if (!draft.value.trim()) return
  adding.value = true
  try {
    await memory.add(draft.value, topic.value)
    draft.value = ''
    show('已记住', 'success')
  } finally {
    adding.value = false
  }
}

async function remove(id: string): Promise<void> {
  await memory.remove(id)
  show('已删除这条记忆', 'success')
}
</script>

<template>
  <div class="page scroll-y">
    <header class="head safe-x">
      <RouterLink to="/me" class="back" aria-label="返回我的">
        <AppIcon name="close" />
      </RouterLink>
      <div>
        <h1 class="title">记忆</h1>
        <p class="subtitle">AI 记住了什么，由你决定</p>
      </div>
    </header>

    <section class="privacy safe-x">
      <div class="privacy-copy">
        <p class="privacy-title">启用长期记忆</p>
        <p class="privacy-desc">开启后，AI 会从对话中提取关于你的长期事实，只存本机。</p>
      </div>
      <button
        class="switch"
        :class="{ on: memory.enabled }"
        role="switch"
        :aria-checked="memory.enabled"
        @click="memory.setEnabled(!memory.enabled)"
      >
        <span />
      </button>
    </section>

    <section class="add-section safe-x">
      <h2 class="section-title">手动添加</h2>
      <div class="add-card">
        <textarea v-model="draft" class="input" rows="2" maxlength="120" placeholder="例如：我正在准备六级考试" />
        <div class="add-bottom">
          <div class="topic-list">
            <button
              v-for="item in topics"
              :key="item"
              class="topic"
              :class="{ selected: topic === item }"
              @click="topic = item"
            >
              {{ item }}
            </button>
          </div>
          <button class="add-btn" :disabled="adding || !draft.trim()" aria-label="添加记忆" @click="addMemory">
            <AppIcon name="plus" />
          </button>
        </div>
      </div>
    </section>

    <section class="list-section safe-x">
      <div class="section-head">
        <h2 class="section-title">
          已记住 <span>{{ memory.memories.length }}</span>
        </h2>
        <span v-if="memory.extracting" class="extracting">正在整理…</span>
      </div>

      <EmptyState
        v-if="memory.ready && memory.memories.length === 0"
        icon="sparkle"
        title="还没有记忆"
        description="聊得越多，AI 越了解你。也可以先手动添加一条。"
      />

      <div v-else class="memory-list">
        <article v-for="item in memory.sortedMemories" :key="item.id" class="memory-card">
          <div class="memory-top">
            <span class="memory-topic">{{ item.topic }}</span>
            <button class="delete-btn" aria-label="删除记忆" @click="remove(item.id)">
              <AppIcon name="trash" />
            </button>
          </div>
          <p class="memory-content">{{ item.content }}</p>
          <p class="memory-meta">
            重要度 {{ item.weight }} · {{ new Date(item.updatedAt).toLocaleDateString('zh-CN') }}
          </p>
        </article>
      </div>
    </section>

    <div class="tail" />
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  padding-top: var(--safe-top);
}
.head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-5) var(--sp-5) var(--sp-4);
}
.back {
  flex: none;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  color: var(--text-2);
  background: var(--surface-1);
  border: 1px solid var(--border);
  font-size: 1.125rem;
}
.title {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 700;
}
.subtitle {
  margin: 6px 0 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.privacy {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: 0 var(--sp-5) var(--sp-5);
  padding: var(--sp-4);
  border-radius: var(--r-lg);
  background: var(--brand-soft);
  border: 1px solid var(--border);
}
.privacy-copy {
  flex: 1;
  min-width: 0;
}
.privacy-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 650;
}
.privacy-desc {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-2);
}
.switch {
  flex: none;
  width: 46px;
  height: 27px;
  padding: 3px;
  border-radius: var(--r-full);
  background: var(--surface-3);
  transition: background var(--dur) var(--ease);
}
.switch span {
  display: block;
  width: 21px;
  height: 21px;
  border-radius: var(--r-full);
  background: var(--text-2);
  transition:
    transform var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.switch.on {
  background: var(--brand-action);
}
.switch.on span {
  transform: translateX(19px);
  background: #fff;
}
.add-section,
.list-section {
  margin-bottom: var(--sp-5);
}
.section-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.06em;
}
.add-card {
  padding: var(--sp-3);
  border-radius: var(--r-lg);
  background: var(--surface-1);
  border: 1px solid var(--border);
}
.input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  resize: none;
  outline: none;
  font-size: var(--fs-sm);
  line-height: 1.6;
}
.input:focus {
  border-color: var(--brand);
}
.add-bottom {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.topic-list {
  flex: 1;
  display: flex;
  gap: 5px;
  overflow-x: auto;
}
.topic {
  flex: none;
  padding: 5px 9px;
  border-radius: var(--r-full);
  font-size: 0.625rem;
  color: var(--text-3);
  background: var(--surface-2);
}
.topic.selected {
  color: var(--brand);
  background: var(--brand-soft);
}
.add-btn {
  flex: none;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  color: var(--brand-on);
  background: var(--brand-action);
  font-size: 1.0625rem;
}
.add-btn:disabled {
  opacity: 0.35;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-head .section-title span {
  color: var(--brand);
}
.extracting {
  font-size: var(--fs-xs);
  color: var(--brand);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.4;
  }
}
.memory-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.memory-card {
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  background: var(--surface-1);
  border: 1px solid var(--border);
}
.memory-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.memory-topic {
  padding: 3px 8px;
  border-radius: var(--r-full);
  font-size: 0.625rem;
  color: var(--brand);
  background: var(--brand-soft);
}
.delete-btn {
  padding: 5px;
  color: var(--text-3);
  font-size: 0.875rem;
  border-radius: var(--r-full);
}
.delete-btn:active {
  color: var(--danger);
  background: rgba(255, 107, 129, 0.12);
}
.memory-content {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-sm);
  line-height: 1.65;
}
.memory-meta {
  margin: 7px 0 0;
  font-size: 0.625rem;
  color: var(--text-3);
}
.tail {
  height: var(--sp-6);
}
</style>
