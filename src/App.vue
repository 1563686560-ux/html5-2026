<script setup lang="ts">
/**
 * 应用外壳
 * ------------------------------------------------------------------
 * 结构：内容区（可滚动） + 底部导航 + 全局提示层。
 * 启动时按顺序恢复本地数据：设置（决定能否发起对话）→ 会话与消息。
 */
import { nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppTabBar from '@/components/AppTabBar.vue'
import LockView from '@/components/LockView.vue'
import ToastHost from '@/components/ToastHost.vue'
import { useViewport } from '@/composables/useViewport'
import { useChatStore } from '@/stores/chat'
import { useMemoryStore } from '@/stores/memory'
import { usePersonasStore } from '@/stores/personas'
import { usePrivacyStore } from '@/stores/privacy'
import { useRagStore } from '@/stores/rag'
import { useSettingsStore } from '@/stores/settings'

// 不叫 route：模板里 <RouterView v-slot="{ route }"> 已经有同名插槽变量，
// 重名会触发 vue/no-template-shadow
const currentRoute = useRoute()
const settings = useSettingsStore()
const chat = useChatStore()
const memory = useMemoryStore()
const personas = usePersonasStore()
const privacy = usePrivacyStore()
const rag = useRagStore()

// 软键盘遮挡高度与横竖屏方向：写进 --kb-inset，供 .main 消费
useViewport()

const mainEl = ref<HTMLElement | null>(null)

/**
 * 路由切换后把焦点移到主内容区。
 * 单页应用换页时浏览器**不会**自动移动焦点：键盘与屏幕阅读器用户按 Tab
 * 仍会从上一页留下的位置开始，或者压根不知道页面已经换了。
 *
 * `preventScroll: true` 是关键 —— 不阻止的话浏览器会把刚获得焦点的容器
 * 滚动到视口内，移动端表现为切页时莫名其妙地跳一下。
 */
watch(
  () => currentRoute.path,
  async () => {
    await nextTick()
    mainEl.value?.focus({ preventScroll: true })
  }
)

onMounted(async () => {
  await settings.load()
  await Promise.all([memory.init(), chat.init(), privacy.init(), rag.init(), personas.init()])
})
</script>

<template>
  <div class="shell">
    <!-- 隐私配置确认前不渲染业务内容，避免锁屏首帧闪现已保存页面 -->
    <template v-if="privacy.ready">
      <main v-if="!privacy.locked" ref="mainEl" class="main" tabindex="-1">
        <RouterView v-slot="{ Component, route }">
          <Transition name="page" mode="out-in">
            <component :is="Component" :key="route.path" />
          </Transition>
        </RouterView>
      </main>

      <AppTabBar v-if="!privacy.locked" />
      <ToastHost v-if="!privacy.locked" />
      <LockView v-if="privacy.locked" />
    </template>
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  /* 先写 vh 兜底，再用 dvh 覆盖：老浏览器忽略后者 */
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

.main {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  /*
   * 软键盘弹出时把内容顶起来。--kb-inset 由 useViewport 从 visualViewport 读出后
   * 写到 html 上，这里只负责消费（纯 CSS 拿不到键盘高度，dvh 不含键盘）。
   * 加在 .main 而不是 .shell：底部导航会被挤出可视区，让出的纵向空间全给输入区，
   * 键盘弹起时不会出现「导航条 + 输入框」两层底栏。
   */
  padding-bottom: var(--kb-inset, 0px);
}

/*
 * 主内容区是路由切换后的程序化焦点落点（tabindex="-1"）。
 * 给它去掉轮廓：这不是用户点出来的焦点，画一圈框只会让人困惑。
 */
.main:focus {
  outline: none;
}

/* 每个页面自己撑满内容区并内部滚动 */
.main > * {
  height: 100%;
}

.page-enter-active,
.page-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}

.page-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
