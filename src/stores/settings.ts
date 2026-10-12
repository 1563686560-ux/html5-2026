/**
 * 设置状态：大模型接口配置
 * ------------------------------------------------------------------
 * API Key 只存在用户自己的设备上（IndexedDB），不会随代码提交，
 * 也不经过任何第三方服务器 —— 这也是后续「隐私模式」的基础。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { kvGet, kvSet } from '@/db'
import { DEFAULT_PROVIDER_ID, EMPTY_API_SETTINGS, PROVIDER_PRESETS, type ApiSettings } from '@/api/types'

const KV_KEY = 'api-settings'

function cloneEmpty(): ApiSettings {
  return {
    providerId: EMPTY_API_SETTINGS.providerId,
    chat: { ...EMPTY_API_SETTINGS.chat },
    embed: { ...EMPTY_API_SETTINGS.embed }
  }
}

/**
 * 按当前厂商预设补上**空着的**字段。
 * 只补空位、绝不覆盖：用户手改过的地址或模型名是他的意图，
 * 补空的目的是「不让人手抄 URL」，不是「把配置重置成预设」。
 */
function backfillFromPreset(target: ApiSettings): void {
  const preset = PROVIDER_PRESETS.find((p) => p.id === target.providerId)
  // 「自定义」没有预设值可补；其余厂商按自己的地址与模型名补空
  if (!preset || preset.id === 'custom') return

  if (!target.chat.baseUrl.trim()) target.chat.baseUrl = preset.baseUrl
  if (!target.chat.model.trim()) target.chat.model = preset.chatModel
  if (!target.embed.baseUrl.trim()) target.embed.baseUrl = preset.embedBaseUrl
  if (!target.embed.model.trim()) target.embed.model = preset.embedModel
}

export const useSettingsStore = defineStore('settings', () => {
  const api = ref<ApiSettings>(cloneEmpty())
  const ready = ref(false)

  const chatConfigured = computed(() => {
    const c = api.value.chat
    return Boolean(c.baseUrl.trim() && c.apiKey.trim() && c.model.trim())
  })

  const embedConfigured = computed(() => {
    const e = api.value.embed
    return Boolean(e.baseUrl.trim() && e.apiKey.trim() && e.model.trim())
  })

  async function load(): Promise<void> {
    try {
      const saved = await kvGet<ApiSettings>(KV_KEY)
      if (saved) {
        // 逐层合并，保证旧版本数据缺字段时也能安全补齐
        const merged: ApiSettings = {
          providerId: saved.providerId || DEFAULT_PROVIDER_ID,
          chat: { ...EMPTY_API_SETTINGS.chat, ...saved.chat },
          embed: { ...EMPTY_API_SETTINGS.embed, ...saved.embed }
        }
        // 旧版本的默认配置里地址与模型名就是空字符串，存档会把这层空值带进来，
        // 于是升级上来的用户依然面对一张空表单。这里按预设补回来。
        backfillFromPreset(merged)
        api.value = merged
      }
    } catch (error) {
      console.warn('[settings] 读取本地配置失败', error)
    } finally {
      ready.value = true
    }
  }

  async function persist(): Promise<void> {
    // 让调用方能区分“真的保存成功”和“写库失败”。设置页只有在此 Promise
    // 成功后才显示“已保存”，避免现场配置看似成功、刷新后却丢失。
    await kvSet(KV_KEY, JSON.parse(JSON.stringify(api.value)) as ApiSettings)
  }

  /**
   * 套用厂商预设。
   *
   * 分两种情况处理，这是这段逻辑最容易做错的地方：
   *   1. **同一个厂商**：只补空位，绝不整体套用。
   *      整体套用会把用户手改过的地址、模型名一起冲掉，还会顺带清空
   *      Embedding 的 Key —— 用户什么都没做，配置却没了。
   *      但也**不能直接 return**：默认配置本来就是预设里的第一项，
   *      用户点它却什么都不填的话，地址栏会永远是空的（这正是让人手抄 URL 的根源）。
   *   2. **换厂商**：整体套用新预设，并按下面的规则处理 Embedding 的 Key。
   */
  function applyPreset(providerId: string): void {
    const preset = PROVIDER_PRESETS.find((p) => p.id === providerId)
    if (!preset) return

    if (api.value.providerId === preset.id) {
      backfillFromPreset(api.value)
      return
    }

    api.value.providerId = preset.id
    api.value.chat.baseUrl = preset.baseUrl
    api.value.chat.model = preset.chatModel
    api.value.embed.baseUrl = preset.embedBaseUrl
    api.value.embed.model = preset.embedModel
    // 切到另一家具名厂商时旧的 Embedding 密钥几乎一定无效，清掉以免误用；
    // 切到「自定义」则保留，用户多半只是想在这份配置上改地址
    if (preset.id !== 'custom') {
      api.value.embed.apiKey = ''
    }
  }

  /**
   * Embedding 区单独选厂商：只动 embed 的三个字段，**不碰**对话配置。
   * 也不改 providerId —— 那个字段代表「对话用哪家」，改它会连带把对话区的
   * chip 高亮换掉，等于偷偷改了另一件事。
   */
  function applyEmbedPreset(providerId: string): void {
    const preset = PROVIDER_PRESETS.find((p) => p.id === providerId)
    if (!preset || !preset.embedBaseUrl.trim()) return

    const already = api.value.embed.baseUrl.trim() === preset.embedBaseUrl
    const modelAlready = api.value.embed.model.trim() === preset.embedModel
    // 已经是这家且模型名没被改过：什么都不做，别把用户填好的 Key 清掉
    if (already && modelAlready) return

    api.value.embed.baseUrl = preset.embedBaseUrl
    api.value.embed.model = preset.embedModel
    // 换了服务，旧 Key 一定无效，清掉避免发出必定失败的请求
    api.value.embed.apiKey = ''
  }

  async function reset(): Promise<void> {
    api.value = cloneEmpty()
    await persist()
  }

  return {
    api,
    ready,
    chatConfigured,
    embedConfigured,
    load,
    persist,
    applyPreset,
    applyEmbedPreset,
    reset
  }
})
