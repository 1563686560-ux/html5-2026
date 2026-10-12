<script setup lang="ts">
/**
 * 底部导航
 * ------------------------------------------------------------------
 * 用 router-link 的 active class 做高亮；底部留出安全区内边距，
 * 避免被 iPhone 的手势条压住。
 */
import { useRoute } from 'vue-router'
import AppIcon from './AppIcon.vue'
import type { IconName } from './icons'

interface TabItem {
  to: string
  label: string
  icon: IconName
}

const tabs: TabItem[] = [
  { to: '/', label: '广场', icon: 'plaza' },
  { to: '/guess', label: '猜心', icon: 'sparkle' },
  { to: '/predict', label: '预测', icon: 'sliders' },
  { to: '/library', label: '问知', icon: 'library' },
  { to: '/me', label: '我的', icon: 'me' }
]

const route = useRoute()
</script>

<template>
  <nav class="tabbar safe-x" aria-label="主导航">
    <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="tab" :class="{ active: route.path === tab.to }">
      <AppIcon :name="tab.icon" class="tab-icon" />
      <span class="tab-label">{{ tab.label }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.tabbar {
  position: relative;
  z-index: 2;
  flex: none;
  display: flex;
  align-items: stretch;
  min-height: calc(var(--tabbar-h) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  padding-inline: max(8px, var(--safe-left)) max(8px, var(--safe-right));
  background: var(--surface-1);
  border-top: 1px solid var(--border);
}

.tab {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  color: var(--text-2);
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease),
    transform var(--dur-fast) var(--ease);
}

.tab:active {
  transform: scale(0.94);
}

.tab.active {
  color: var(--brand);
  font-weight: 600;
}

.tab-icon {
  font-size: 1.3125rem;
}
.tab.active .tab-icon {
  filter: drop-shadow(0 0 8px color-mix(in srgb, var(--brand) 25%, transparent));
}

.tab-label {
  font-size: var(--fs-xs);
  letter-spacing: 0;
}
.tab.active .tab-label {
  font-weight: 600;
}
</style>
