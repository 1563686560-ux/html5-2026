<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import { DEFAULT_PERSONA_ID } from '@/data/personas'
import { useToast } from '@/composables/useToast'
import { useTheme, VISUAL_THEMES, type VisualStyle } from '@/composables/useTheme'
import { useChatStore } from '@/stores/chat'
import { usePersonasStore } from '@/stores/personas'
import { useSettingsStore } from '@/stores/settings'

const router = useRouter()
const chat = useChatStore()
const personas = usePersonasStore()
const settings = useSettingsStore()
const { show } = useToast()
const { theme, visualStyle, setVisualStyle } = useTheme()
const showThemes = ref(false)
const wish = ref('')
const entering = ref(false)
const recent = computed(() => chat.sessions.slice(0, 3))

function pickTheme(style: VisualStyle): void {
  setVisualStyle(style)
  showThemes.value = false
}

async function quickChat(): Promise<void> {
  if (entering.value) return
  entering.value = true
  try {
    await chat.createSession(DEFAULT_PERSONA_ID)
    chat.selectedDocumentId = ''
    await router.push('/chat')
  } finally {
    entering.value = false
  }
}

async function startWish(): Promise<void> {
  const text = wish.value.trim()
  if (!text || entering.value) return
  entering.value = true
  try {
    const persona = personas.addTemp(text)
    await chat.createSession(persona.id)
    chat.selectedDocumentId = ''
    wish.value = ''
    show(`已以「${persona.name}」的身份开场`, 'success')
    await router.push('/chat')
  } finally {
    entering.value = false
  }
}

async function openSession(id: string): Promise<void> {
  await chat.selectSession(id)
  await router.push('/chat')
}
</script>

<template>
  <div class="page scroll-y" :class="{ 'light-theme': theme === 'light' }">
    <div class="content">
      <header class="hero">
        <div class="hero-copy">
          <p class="eyebrow">AI 智囊团</p>
          <h1>灵感广场</h1>
        </div>
        <button
          class="theme-toggle"
          aria-label="选择主题"
          :aria-expanded="showThemes"
          @click="showThemes = !showThemes"
        >
          <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" />
        </button>
      </header>

      <div v-if="showThemes" class="theme-picker" role="group" aria-label="主题选择">
        <button
          v-for="item in VISUAL_THEMES"
          :key="item.id"
          :aria-pressed="visualStyle === item.id"
          :class="{ selected: visualStyle === item.id }"
          @click="pickTheme(item.id)"
        >
          <i :style="{ background: item.accent }" />{{ item.name }}
        </button>
      </div>
      <div v-if="settings.ready && !settings.chatConfigured" class="notice">
        <AppIcon name="alert" />
        <span>配置大模型接口后即可开始对话。</span>
        <RouterLink to="/me">去配置</RouterLink>
      </div>

      <section class="ask-panel" aria-label="开始对话">
        <div class="hero-orbit" aria-hidden="true" />

        <div class="ask-top">
          <div>
            <h2>今天想聊些什么？</h2>
          </div>
        </div>
        <button class="ask-button" :disabled="entering" @click="quickChat">
          开启新的对话 <span aria-hidden="true">↗</span>
        </button>
        <div class="wish">
          <label class="sr-only" for="wish-input">描述想聊的角色</label>
          <input
            id="wish-input"
            v-model="wish"
            maxlength="40"
            placeholder="描述一个角色，如：数学老师"
            @keyup.enter="startWish"
          />
          <button :disabled="!wish.trim() || entering" aria-label="开始角色对话" @click="startWish">
            <AppIcon name="send" />
          </button>
        </div>
      </section>

      <section class="section" aria-labelledby="explore-title">
        <div class="section-heading">
          <div>
            <h2 id="explore-title">探索功能</h2>
          </div>
        </div>
        <div class="features">
          <RouterLink to="/guess" class="feature">
            <span class="feature-icon"><AppIcon name="sparkle" /></span>
            <span class="feature-copy"><strong>猜心空间</strong><small>心中想一个事物，让 AI 来猜</small></span>
            <span class="arrow" aria-hidden="true">↗</span>
          </RouterLink>
          <RouterLink to="/predict" class="feature">
            <span class="feature-icon"><AppIcon name="sliders" /></span>
            <span class="feature-copy"><strong>趋势预测</strong><small>让数据中的趋势清晰可见</small></span>
            <span class="arrow" aria-hidden="true">↗</span>
          </RouterLink>
          <RouterLink to="/personas" class="feature feature-persona">
            <span class="feature-icon"><AppIcon name="chat" /></span>
            <span class="feature-copy"><strong>角色对话</strong><small>换个视角，展开新的交流</small></span>
            <span class="arrow" aria-hidden="true">↗</span>
          </RouterLink>
          <RouterLink to="/library" class="feature">
            <span class="feature-icon"><AppIcon name="library" /></span>
            <span class="feature-copy"><strong>问知知识库</strong><small>根据资料提问，回答附出处</small></span>
            <span class="arrow" aria-hidden="true">↗</span>
          </RouterLink>
        </div>
      </section>

      <section v-if="recent.length" class="section" aria-labelledby="recent-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">接着上次的话题</p>
            <h2 id="recent-title">最近对话</h2>
          </div>
        </div>
        <button v-for="session in recent" :key="session.id" class="recent-row" @click="openSession(session.id)">
          <span class="recent-initial" aria-hidden="true">{{ session.title.slice(0, 1) || '聊' }}</span>
          <span class="recent-title">{{ session.title }}</span>
          <span class="arrow" aria-hidden="true">→</span>
        </button>
      </section>

      <section class="section extras" aria-labelledby="extras-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">换一种思路</p>
            <h2 id="extras-title">灵感与探索</h2>
          </div>
        </div>
        <div class="extra-grid">
          <RouterLink to="/debate" class="extra-card">
            <span class="extra-symbol" aria-hidden="true">↔</span>
            <strong>观点对辩</strong>
            <small>听见两种不同的声音</small>
          </RouterLink>
          <RouterLink to="/memories" class="extra-card">
            <span class="extra-symbol" aria-hidden="true"><AppIcon name="history" /></span>
            <strong>长期记忆</strong>
            <small>管理对话中记住的内容</small>
          </RouterLink>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  padding-top: var(--safe-top);
}
.content {
  max-width: 520px;
  margin: auto;
  padding: 30px max(20px, var(--safe-right)) 40px max(20px, var(--safe-left));
}
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 26px;
}
.brand-mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 48px;
  height: 48px;
  border-radius: 16px;
  background: var(--brand);
  color: var(--bg);
  font-size: 1.35rem;
  font-weight: 700;
  font-family: Georgia, 'Songti SC', serif;
}
.hero-copy {
  min-width: 0;
}
.eyebrow {
  margin: 0 0 5px;
  color: var(--brand);
  font-size: 0.73rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.hero h1 {
  margin: 0;
  color: var(--text-1);
  font-size: clamp(1.65rem, 6vw, 2.25rem);
  font-weight: 750;
  letter-spacing: -0.025em;
  line-height: 1.25;
}
.intro {
  margin: 8px 0 0;
  color: var(--text-2);
  font-size: var(--fs-sm);
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-1);
  color: var(--text-2);
  font-size: var(--fs-xs);
}
.notice span {
  flex: 1;
}
.notice a {
  flex: none;
  font-weight: 700;
}
.ask-panel {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: linear-gradient(135deg, var(--bg-glow), var(--surface-1));
  box-shadow: var(--tech-shadow);
}
.ask-top {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ask-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: var(--r-sm);
  color: var(--brand);
  background: var(--brand-soft);
  font-size: 1.2rem;
}
.ask-top h2 {
  margin: 0;
  font-size: 1.8rem;
  line-height: 1.3;
}
.ask-top p {
  margin: 2px 0 0;
  color: var(--text-2);
  font-size: var(--fs-xs);
}
.ask-button {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  min-height: 48px;
  margin-top: 20px;
  padding: 0 16px;
  border-radius: var(--r-sm);
  color: var(--brand-on);
  background: var(--brand-action);
  font-size: var(--fs-sm);
  font-weight: 700;
}
.ask-button:disabled {
  opacity: 0.6;
}
.ask-button span {
  font-size: 1.2rem;
}
.wish {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 4px 5px 4px 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-1);
}
.wish:focus-within {
  border-color: var(--brand);
}
.wish input {
  min-width: 0;
  flex: 1;
  padding: 8px 0;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: var(--fs-xs);
}
.wish input::placeholder {
  color: var(--text-3);
}
.wish button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: var(--brand-soft);
  color: var(--brand);
}
.wish button:disabled {
  opacity: 0.35;
}
.section {
  margin-top: 32px;
}
.section-heading {
  margin-bottom: 14px;
}
.section h2 {
  margin: 0;
  font-size: 1.25rem;
  letter-spacing: -0.015em;
}
.features {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.feature {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  position: relative;
  min-height: 82px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-1);
  color: var(--text-1);
}
.feature-persona {
  border-color: color-mix(in srgb, var(--brand) 30%, var(--border));
}
.feature-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--r-sm);
  color: var(--brand);
  background: var(--brand-soft);
  font-size: 1.15rem;
}
.feature-copy {
  display: grid;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.feature-copy strong {
  font-size: var(--fs-sm);
}
.feature-copy small {
  color: var(--text-2);
  font-size: var(--fs-xs);
  line-height: 1.4;
}
.arrow {
  flex: none;
  color: var(--brand);
  font-size: 1.1rem;
}
.feature .arrow {
  position: absolute;
  right: 14px;
  top: 16px;
}
.feature-copy {
  gap: 6px;
}
.theme-toggle {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 14px;
  color: var(--brand);
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.hero-orbit {
  position: absolute;
  z-index: -1;
  right: -35px;
  top: 14px;
  width: 170px;
  height: 170px;
  border: 1px solid var(--brand);
  border-radius: 50%;
  opacity: 0.15;
}
.hero-orbit::before,
.hero-orbit::after {
  content: '';
  position: absolute;
  inset: 24px;
  border: 1px solid var(--brand);
  border-radius: 50%;
}
.hero-orbit::after {
  inset: 49px;
  background: var(--brand);
  opacity: 0.35;
}
.light-theme .ask-panel {
  background: var(--surface-1);
  border-top: 3px solid var(--brand);
}
.recent-row {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  min-height: 58px;
  padding: 7px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.recent-initial {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--brand);
  font-weight: 700;
}
.recent-title {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-sm);
}
.extra-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.extra-card {
  display: flex;
  flex-direction: column;
  min-height: 130px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-1);
  color: var(--text-1);
}
.extra-symbol {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-bottom: auto;
  border-radius: 9px;
  color: var(--brand);
  background: var(--brand-soft);
  font-weight: 700;
}
.extra-card strong {
  margin-top: 10px;
  font-size: var(--fs-sm);
}
.extra-card small {
  margin-top: 3px;
  color: var(--text-2);
  font-size: var(--fs-xs);
  line-height: 1.4;
}
@media (max-width: 350px) {
  .content {
    padding-inline: 14px;
  }
  .hero {
    gap: 11px;
  }
  .brand-mark {
    width: 42px;
    height: 42px;
  }
  .ask-panel {
    padding: 16px;
  }
}

.content {
  padding-top: 20px;
}
.hero {
  margin-bottom: 18px;
}
.ask-panel {
  padding: 18px;
}
.ask-top h2 {
  font-size: 1.2rem;
}
.ask-button {
  margin-top: 14px;
}
.section {
  margin-top: 24px;
}
.features {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.feature {
  min-height: 124px;
  padding: 14px;
  gap: 10px;
}
.feature-copy small {
  font-size: 11px;
}
.feature-icon {
  width: 32px;
  height: 32px;
  font-size: 1rem;
}
.section h2 {
  font-size: var(--fs-md);
}
.theme-picker {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-1);
}
.theme-picker button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: 11px;
  color: var(--text-2);
}
.theme-picker button.selected {
  border-color: var(--brand);
  color: var(--brand);
  background: var(--brand-soft);
}
.theme-picker i {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
</style>
