<script setup lang="ts">
import { useToast } from '@/composables/useToast'
import AppIcon from './AppIcon.vue'

const { items } = useToast()
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="item in items" :key="item.id" class="toast" :class="item.tone">
        <AppIcon :name="item.tone === 'error' ? 'alert' : 'check'" class="toast-icon" />
        <span>{{ item.text }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 0;
  right: 0;
  /* 浮在底部导航之上 */
  bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 14px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  pointer-events: none;
  z-index: 90;
  padding: 0 var(--sp-4);
}

.toast {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  max-width: 100%;
  padding: 9px 15px;
  border-radius: var(--r-full);
  font-size: var(--fs-sm);
  color: var(--text-1);
  background: color-mix(in srgb, var(--bg) 70%, transparent);
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  border: 1px solid var(--border-strong);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.34);
}

.toast-icon {
  font-size: 0.9375rem;
}

.toast.success .toast-icon {
  color: var(--success);
}

.toast.error .toast-icon {
  color: var(--danger);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px) scale(0.94);
}
</style>
