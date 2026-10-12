<script setup lang="ts">
import AppIcon from './AppIcon.vue'
import type { IconName } from './icons'

withDefaults(
  defineProps<{
    icon?: IconName
    title: string
    description?: string
  }>(),
  { icon: 'sparkle', description: '' }
)
</script>

<template>
  <div class="empty">
    <div class="empty-icon">
      <AppIcon :name="icon" />
    </div>
    <p class="empty-title">{{ title }}</p>
    <p v-if="description" class="empty-desc">{{ description }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: var(--sp-6) var(--sp-5);
  gap: var(--sp-2);
}

.empty-icon {
  width: 62px;
  height: 62px;
  border-radius: var(--r-full);
  display: grid;
  place-items: center;
  font-size: 1.625rem;
  color: var(--brand);
  background: var(--brand-soft);
  margin-bottom: var(--sp-2);
  animation: pop var(--dur-slow) var(--ease);
}

@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.8);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.empty-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 600;
}

.empty-desc {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  max-width: 30ch;
  line-height: 1.7;
}
</style>
