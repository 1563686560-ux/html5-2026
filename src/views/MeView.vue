<script setup lang="ts">
/**
 * 我的（设置）
 * ------------------------------------------------------------------
 * 这里最重要的功能是大模型接口配置 —— 没有它整个应用跑不起来。
 * 设计原则：
 *   1. 密钥只写进本机 IndexedDB，不随代码提交、不经过中转服务器；
 *   2. 输入即自动保存（防抖），不需要用户找"保存"按钮；
 *   3. 提供"测试连接"，把"配错了"这件事在演示前就暴露出来。
 */
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import { PROVIDER_PRESETS } from '@/api/types'
import { testChatEndpoint, type TestResult } from '@/api/llm'
import { useTheme, VISUAL_THEMES } from '@/composables/useTheme'
import { useToast } from '@/composables/useToast'
import { usePrivacyStore } from '@/stores/privacy'
import { useSettingsStore } from '@/stores/settings'

const settings = useSettingsStore()
const privacy = usePrivacyStore()
const { visualStyle, setVisualStyle } = useTheme()
const { show } = useToast()

const showKey = ref(false)
const saved = ref(false)
const chatTest = ref<TestResult | null>(null)
const testing = ref<'' | 'chat'>('')
const pinDraft = ref('')
const pinBusy = ref(false)
const pinError = ref('')

/** 当前厂商的说明文字 */
const selectedPreset = computed(() => PROVIDER_PRESETS.find((p) => p.id === settings.api.providerId))

let persistTimer: number | undefined
let savedTimer: number | undefined

watch(
  () => settings.api,
  () => {
    if (persistTimer !== undefined) window.clearTimeout(persistTimer)
    persistTimer = window.setTimeout(async () => {
      try {
        await settings.persist()
        saved.value = true
        if (savedTimer !== undefined) window.clearTimeout(savedTimer)
        savedTimer = window.setTimeout(() => {
          saved.value = false
        }, 1600)
      } catch (error) {
        saved.value = false
        show(`保存失败：${(error as Error).message}`, 'error')
      }
    }, 500)
  },
  { deep: true }
)

watch(
  () => [settings.api.chat.baseUrl, settings.api.chat.model, settings.api.chat.apiKey],
  () => {
    chatTest.value = null
  }
)

function pickProvider(id: string): void {
  settings.applyPreset(id)
  chatTest.value = null
}

async function runChatTest(): Promise<void> {
  testing.value = 'chat'
  chatTest.value = null
  const endpoint = { ...settings.api.chat }
  try {
    const result = await testChatEndpoint(endpoint)
    if (
      Object.keys(endpoint).every(
        (key) => endpoint[key as keyof typeof endpoint] === settings.api.chat[key as keyof typeof endpoint]
      )
    )
      chatTest.value = result
  } finally {
    testing.value = ''
  }
}

async function savePin(): Promise<void> {
  if (!/^\d{4,8}$/.test(pinDraft.value)) {
    pinError.value = '请输入 4～8 位数字'
    return
  }
  pinBusy.value = true
  pinError.value = ''
  const ok = await privacy.setPin(pinDraft.value)
  pinBusy.value = false
  if (ok) {
    pinDraft.value = ''
    show('隐私锁已启用', 'success')
  } else {
    pinError.value = privacy.errorText ?? 'PIN 设置失败'
  }
}

async function disablePin(): Promise<void> {
  const value = pinDraft.value
  if (!value) {
    pinError.value = '请输入当前 PIN 后再关闭'
    return
  }
  pinBusy.value = true
  pinError.value = ''
  const ok = await privacy.disablePin(value)
  pinBusy.value = false
  if (ok) {
    pinDraft.value = ''
    show('隐私锁已关闭', 'success')
  } else {
    pinError.value = privacy.errorText ?? 'PIN 不正确'
  }
}
</script>

<template>
  <div class="page scroll-y settings-page">
    <header class="head safe-x">
      <div>
        <h1 class="title">我的</h1>
      </div>
      <Transition name="fade">
        <span v-if="saved" class="saved">已保存</span>
      </Transition>
    </header>

    <!-- 大模型接口 -->
    <section class="section safe-x">
      <h2 class="section-title">APIkey</h2>

      <div class="chips">
        <button
          v-for="preset in PROVIDER_PRESETS"
          :key="preset.id"
          class="chip"
          :class="{ on: settings.api.providerId === preset.id }"
          @click="pickProvider(preset.id)"
        >
          {{ preset.name }}
        </button>
      </div>

      <label class="field">
        <span class="field-label">API Key</span>
        <span class="field-with-btn">
          <input
            v-model="settings.api.chat.apiKey"
            class="input"
            :type="showKey ? 'text' : 'password'"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="sk-..."
          />
          <button class="ghost-btn" @click="showKey = !showKey">
            {{ showKey ? '隐藏' : '显示' }}
          </button>
        </span>
      </label>

      <details class="advanced-config" :open="settings.api.providerId === 'custom'">
        <summary>
          接口地址与模型 <span>{{ settings.api.chat.model || '待填写' }}</span>
        </summary>
        <p class="hint">常用服务商自动填写；自定义地址填到 /v1，不需要加 /chat/completions。</p>
        <label class="field">
          <span class="field-label">Base URL</span>
          <input
            v-model="settings.api.chat.baseUrl"
            class="input"
            type="url"
            inputmode="url"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="https://api.example.com/v1"
          />
        </label>

        <label class="field">
          <span class="field-label">模型名</span>
          <input
            v-model="settings.api.chat.model"
            class="input"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="deepseek-flash"
          />
        </label>
      </details>
      <a
        v-if="selectedPreset?.docsUrl"
        class="docs-link"
        :href="selectedPreset.docsUrl"
        target="_blank"
        rel="noopener noreferrer"
        >获取 {{ selectedPreset.name }} API Key ↗</a
      >
      <button class="primary-btn" :disabled="testing === 'chat' || !settings.chatConfigured" @click="runChatTest">
        {{ testing === 'chat' ? '测试中…' : '测试连接' }}
      </button>

      <Transition name="fade">
        <p v-if="chatTest" class="result" :class="chatTest.ok ? 'ok' : 'bad'">
          <AppIcon :name="chatTest.ok ? 'check' : 'alert'" />
          {{ chatTest.message }}
        </p>
      </Transition>
    </section>

    <!-- 外观 -->
    <section class="section safe-x">
      <h2 class="section-title">外观</h2>
      <div class="style-choice" role="group" aria-label="界面风格">
        <button
          v-for="item in VISUAL_THEMES"
          :key="item.id"
          class="style-option"
          :class="{ selected: visualStyle === item.id }"
          :aria-pressed="visualStyle === item.id"
          @click="setVisualStyle(item.id)"
        >
          <span
            class="style-swatch"
            :style="{ background: `linear-gradient(90deg, ${item.background} 60%, ${item.accent} 60%)` }"
            aria-hidden="true"
          />
          <strong>{{ item.name }}</strong>
        </button>
      </div>
    </section>

    <!-- 数据与记忆 -->
    <section class="section safe-x">
      <h2 class="section-title">我的管理</h2>
      <RouterLink to="/memories" class="row-btn">
        <span class="row-icon"><AppIcon name="sparkle" /></span>
        <span class="row-body">
          <span class="row-title">长期记忆</span>
        </span>
        <span class="row-action">管理</span>
      </RouterLink>
      <details class="privacy-box" :open="privacy.enabled">
        <summary>
          高级设置 <span>{{ privacy.enabled ? '已启用' : '可选' }}</span>
        </summary>
        <div class="privacy-box-head">
          <div>
            <p class="row-title">隐私锁</p>
          </div>
          <span class="lock-status" :class="{ on: privacy.enabled }">{{ privacy.enabled ? '已启用' : '未启用' }}</span>
        </div>
        <input
          v-model="pinDraft"
          class="input pin-input"
          type="password"
          inputmode="numeric"
          maxlength="8"
          autocomplete="off"
          placeholder="4～8 位数字 PIN"
        />
        <div class="privacy-actions">
          <button class="primary-small" :disabled="pinBusy" @click="savePin">启用 / 修改</button>
          <button v-if="privacy.enabled" class="ghost-small" :disabled="pinBusy" @click="disablePin">关闭隐私锁</button>
        </div>
        <p v-if="pinError" class="pin-error">{{ pinError }}</p>
        <p v-if="privacy.storageWarning" class="pin-error">{{ privacy.storageWarning }}</p>
      </details>
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
  align-items: flex-end;
  justify-content: space-between;
  padding: var(--sp-5) var(--sp-5) var(--sp-3);
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

.saved {
  font-size: var(--fs-xs);
  color: var(--success);
}

.section {
  padding: 0 var(--sp-5);
  margin-bottom: var(--sp-5);
}

.section-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.06em;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.chip {
  padding: 7px 13px;
  border-radius: var(--r-full);
  font-size: var(--fs-xs);
  color: var(--text-2);
  background: var(--surface-1);
  border: 1px solid var(--border);
  transition: all var(--dur) var(--ease);
}

.chip.on {
  color: var(--brand-on);
  background: var(--brand-action);
  border-color: transparent;
}

.hint {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-xs);
  line-height: 1.65;
  color: var(--text-3);
}

.docs-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 var(--sp-3);
  color: var(--brand-action);
  font-size: var(--fs-xs);
  text-decoration: none;
}

.docs-link:focus-visible {
  outline: 2px solid var(--brand-action);
  outline-offset: 3px;
  border-radius: 3px;
}

.field {
  display: block;
  margin-bottom: var(--sp-3);
}

.field-label {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

.input {
  width: 100%;
  padding: 11px 13px;
  border-radius: var(--r-sm);
  background: var(--surface-1);
  border: 1px solid var(--border);
  font-size: var(--fs-sm);
  outline: none;
  transition: border-color var(--dur) var(--ease);
}

.input:focus {
  border-color: var(--brand);
}

.field-with-btn {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
}

.ghost-btn {
  flex: none;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.primary-btn {
  width: 100%;
  padding: 12px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--brand-on);
  background: var(--brand-action);
  transition: transform var(--dur-fast) var(--ease);
}

.primary-btn:active {
  transform: scale(0.985);
}

.primary-btn:disabled {
  opacity: 0.55;
}

.result {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: var(--sp-3) 0 0;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  line-height: 1.6;
}

.result.ok {
  color: var(--success);
  background: rgba(79, 209, 165, 0.1);
  border: 1px solid rgba(79, 209, 165, 0.26);
}

.result.bad {
  color: var(--danger);
  background: rgba(255, 107, 129, 0.1);
  border: 1px solid rgba(255, 107, 129, 0.26);
}

.row-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  background: var(--surface-1);
  border: 1px solid var(--border);
  text-align: left;
  margin-bottom: var(--sp-2);
}

.row-btn.static {
  margin-bottom: var(--sp-3);
}

.row-btn:not(.static):active {
  background: var(--surface-2);
}

.row-icon {
  flex: none;
  font-size: 1.0625rem;
  color: var(--brand);
}

.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.row-title {
  font-size: var(--fs-sm);
  font-weight: 600;
}

.row-desc {
  font-size: var(--fs-xs);
  color: var(--text-2);
  margin-top: 2px;
}

.row-action {
  flex: none;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

.outline-btn,
.danger-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: 12px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
}

.outline-btn {
  margin-bottom: var(--sp-2);
  color: var(--brand);
  background: var(--brand-soft);
  border: 1px solid var(--border);
}

.danger-btn {
  color: var(--danger);
  background: rgba(255, 107, 129, 0.08);
  border: 1px solid rgba(255, 107, 129, 0.24);
}

.privacy-box {
  margin-bottom: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  background: var(--surface-1);
  border: 1px solid var(--border);
}

.privacy-box-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.lock-status {
  padding: 3px 8px;
  border-radius: var(--r-full);
  color: var(--text-3);
  background: var(--surface-2);
  font-size: 0.625rem;
}

/* 只有真正启用时才显示为绿色。
   之前用 :has(.lock-status) 判断，而那个元素一直都在，
   结果「未启用」也是绿的 —— 状态色反而误导用户。 */
.lock-status.on {
  color: var(--success);
  background: rgba(79, 209, 165, 0.14);
}

.pin-input {
  width: 100%;
}

.privacy-actions {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

.primary-small,
.ghost-small {
  flex: 1;
  padding: 9px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
}

.primary-small {
  color: var(--brand-on);
  background: var(--brand-action);
}

.ghost-small {
  color: var(--text-2);
  background: var(--surface-2);
}

.primary-small:disabled,
.ghost-small:disabled {
  opacity: 0.45;
}

.pin-error {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--danger);
}

.data-note {
  margin: var(--sp-3) 0 0;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-3);
}

.tail {
  height: var(--sp-6);
}

.style-choice {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.style-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
  padding: 14px;
  text-align: left;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}

.style-option.selected {
  border-color: var(--brand);
  box-shadow: 0 0 0 2px var(--brand-soft);
}

.style-option strong,
.style-option small {
  display: block;
}

.style-option strong {
  font-size: var(--fs-sm);
}
.style-option small {
  margin-top: 3px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  line-height: 1.4;
}
.style-swatch {
  width: 42px;
  height: 25px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}
.warm-swatch {
  background: linear-gradient(90deg, #081326 64%, #65e3df 64%);
}
.pro-swatch {
  background: linear-gradient(90deg, #f5f6fb 64%, #5264d9 64%);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--dur) var(--ease);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.settings-page .head {
  padding-bottom: 20px;
}
.eyebrow {
  margin: 8px 0 0;
  font-size: 10px;
  letter-spacing: 0.15em;
  color: var(--brand-action);
}
.profile-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 20px 20px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: linear-gradient(135deg, var(--brand-soft), var(--surface-1));
}
.profile-icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  flex: none;
  border-radius: 16px;
  background: var(--brand-soft);
  color: var(--brand-action);
  font-size: 24px;
}
.profile-card strong {
  font-size: 16px;
}
.profile-card p {
  margin: 5px 0 0;
  font-size: 11px;
  color: var(--text-2);
}
.config-state {
  margin-left: auto;
  flex: none;
  font-size: 10px;
  padding: 5px 8px;
  border-radius: 20px;
  color: var(--text-2);
  background: var(--surface-2);
}
.config-state.ready {
  color: var(--success);
}
.settings-page .section {
  margin: 0 20px 16px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: var(--surface-1);
}
.settings-page .section-title {
  color: var(--text-1);
  font-size: 15px;
  letter-spacing: 0;
}
.settings-page .input {
  background: var(--surface-2);
  min-width: 0;
}
.advanced-config {
  margin: 0 0 16px;
  padding: 12px;
  background: var(--surface-2);
  border-radius: 14px;
}
.advanced-config summary,
.privacy-box summary {
  min-height: 24px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
}
.advanced-config summary span,
.privacy-box summary span {
  float: right;
  max-width: 50%;
  overflow-wrap: anywhere;
  color: var(--text-3);
  font-size: 11px;
}
.advanced-config[open] summary,
.privacy-box[open] summary {
  margin-bottom: 16px;
}
.privacy-box {
  margin: 12px 0 0;
}
.settings-page .hint {
  color: var(--text-2);
}
.settings-page .style-option {
  padding: 12px;
  background: var(--surface-2);
}
@media (max-width: 350px) {
  .settings-page .section,
  .profile-card {
    margin-left: 14px;
    margin-right: 14px;
    padding: 14px;
  }
  .profile-card {
    gap: 8px;
  }
}

.settings-page .head {
  padding-bottom: 16px;
}
.settings-page .style-choice {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}
.settings-page .style-option {
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 4px;
  min-height: 68px;
  border-radius: 12px;
  text-align: center;
}
.settings-page .style-option strong {
  font-size: 11px;
  white-space: nowrap;
}
.settings-page .style-swatch {
  width: 30px;
  height: 16px;
  border-radius: 5px;
}
.settings-page .row-btn {
  padding: 12px;
  margin-bottom: 0;
}
.settings-page .privacy-box {
  padding: 12px;
  border-radius: 14px;
}
</style>
