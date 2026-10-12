import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 设置页的厂商预设回填。
 *
 * 这块逻辑全靠"点一下 chip"触发，没有浏览器就验不了，
 * 但它又是纯状态变换 —— 所以用单测把行为钉死，尤其是那个
 * 「默认选中 DeepSeek，点它却什么都不填」的坑。
 */
const { kvStore, kvGetMock, kvSetMock } = vi.hoisted(() => {
  const kvStore = new Map<string, unknown>()
  return {
    kvStore,
    kvGetMock: vi.fn(async (key: string) => kvStore.get(key)),
    kvSetMock: vi.fn(async (key: string, value: unknown) => {
      kvStore.set(key, value)
    })
  }
})

vi.mock('@/db', () => ({ kvGet: kvGetMock, kvSet: kvSetMock }))

import { useSettingsStore } from './settings'
import { DEFAULT_PROVIDER_ID, EMPTY_API_SETTINGS, PROVIDER_PRESETS } from '@/api/types'

const KEY = 'api-settings'
const DEEPSEEK = PROVIDER_PRESETS.find((p) => p.id === 'deepseek')!
const SILICON = PROVIDER_PRESETS.find((p) => p.id === 'siliconflow')!

beforeEach(() => {
  setActivePinia(createPinia())
  kvStore.clear()
  kvGetMock.mockClear()
  kvSetMock.mockClear()
  kvGetMock.mockImplementation(async (key: string) => kvStore.get(key))
})

describe('默认配置', () => {
  it('对话端点预填默认厂商的地址与模型名，但绝不含密钥', () => {
    expect(EMPTY_API_SETTINGS.providerId).toBe(DEFAULT_PROVIDER_ID)
    expect(EMPTY_API_SETTINGS.chat.baseUrl).toBe(DEEPSEEK.baseUrl)
    expect(EMPTY_API_SETTINGS.chat.model).toBe(DEEPSEEK.chatModel)
    // 密钥必须留空：预填任何 key 都是不可接受的做法
    expect(EMPTY_API_SETTINGS.chat.apiKey).toBe('')
    expect(EMPTY_API_SETTINGS.embed.apiKey).toBe('')
  })

  it('Embedding 端点不预填 —— DeepSeek 没有这个接口，预填别家地址会误导', () => {
    expect(DEEPSEEK.embedBaseUrl).toBe('')
    expect(EMPTY_API_SETTINGS.embed.baseUrl).toBe('')
    expect(EMPTY_API_SETTINGS.embed.model).toBe('')
  })

  it('新装用户一打开就已经能只填 Key 就发起对话', () => {
    const settings = useSettingsStore()
    expect(settings.api.chat.baseUrl).toBe(DEEPSEEK.baseUrl)
    expect(settings.api.chat.model).toBe(DEEPSEEK.chatModel)
    expect(settings.chatConfigured).toBe(false) // 缺 Key，仍未配置
  })
})

describe('applyPreset 厂商预设', () => {
  it('默认厂商再点一次也要把空字段填上（这是原先的 bug）', () => {
    const settings = useSettingsStore()
    // 模拟旧版本的存档：providerId 已是 deepseek，但地址与模型是空的
    settings.api.chat.baseUrl = ''
    settings.api.chat.model = ''

    settings.applyPreset('deepseek')

    expect(settings.api.chat.baseUrl).toBe(DEEPSEEK.baseUrl)
    expect(settings.api.chat.model).toBe(DEEPSEEK.chatModel)
  })

  it('同一厂商时绝不覆盖用户手改过的值', () => {
    const settings = useSettingsStore()
    settings.api.chat.baseUrl = 'https://my-proxy.example.com/v1'
    settings.api.chat.model = 'my-finetune'
    settings.api.chat.apiKey = 'sk-keep-me'

    settings.applyPreset('deepseek')

    expect(settings.api.chat.baseUrl).toBe('https://my-proxy.example.com/v1')
    expect(settings.api.chat.model).toBe('my-finetune')
    expect(settings.api.chat.apiKey).toBe('sk-keep-me')
  })

  it('换厂商时整体套用预设，并清掉旧的 Embedding 密钥', () => {
    const settings = useSettingsStore()
    settings.api.embed.apiKey = 'sk-old-embed'
    const dashscope = PROVIDER_PRESETS.find((p) => p.id === 'dashscope')!

    settings.applyPreset('dashscope')

    expect(settings.api.providerId).toBe('dashscope')
    expect(settings.api.chat.baseUrl).toBe(dashscope.baseUrl)
    expect(settings.api.chat.model).toBe(dashscope.chatModel)
    expect(settings.api.embed.baseUrl).toBe(dashscope.embedBaseUrl)
    expect(settings.api.embed.model).toBe(dashscope.embedModel)
    // 旧 Key 在新厂商下几乎一定无效，清掉以免发出必定失败的请求
    expect(settings.api.embed.apiKey).toBe('')
  })
})

describe('applyEmbedPreset 只改 Embedding', () => {
  it('填好地址与模型，清掉旧 Key，且不动 providerId', () => {
    const settings = useSettingsStore()
    settings.api.embed.apiKey = 'sk-old'
    const providerBefore = settings.api.providerId
    const chatUrlBefore = settings.api.chat.baseUrl

    settings.applyEmbedPreset('siliconflow')

    expect(settings.api.embed.baseUrl).toBe(SILICON.embedBaseUrl)
    expect(settings.api.embed.model).toBe(SILICON.embedModel)
    expect(settings.api.embed.apiKey).toBe('')
    // 关键：不能顺手把「对话用哪家」也改了，那是另一件事
    expect(settings.api.providerId).toBe(providerBefore)
    expect(settings.api.chat.baseUrl).toBe(chatUrlBefore)
  })

  it('已经是这家时什么都不做，不清用户填好的 Key', () => {
    const settings = useSettingsStore()
    settings.applyEmbedPreset('siliconflow')
    settings.api.embed.apiKey = 'sk-embed-ok'

    settings.applyEmbedPreset('siliconflow')

    expect(settings.api.embed.apiKey).toBe('sk-embed-ok')
  })

  it('没有 Embedding 的厂商（DeepSeek）点不动', () => {
    const settings = useSettingsStore()
    settings.applyEmbedPreset('deepseek')
    expect(settings.api.embed.baseUrl).toBe('')
    expect(settings.api.embed.model).toBe('')
  })
})

describe('load 读档兼容', () => {
  it('旧存档里的空地址会被预设补回，用户不必重填', async () => {
    kvStore.set(KEY, {
      providerId: 'deepseek',
      chat: { baseUrl: '', apiKey: 'sk-user', model: '' },
      embed: { baseUrl: '', apiKey: '', model: '' }
    })

    const settings = useSettingsStore()
    await settings.load()

    expect(settings.api.chat.baseUrl).toBe(DEEPSEEK.baseUrl)
    expect(settings.api.chat.model).toBe(DEEPSEEK.chatModel)
    // 用户填的 Key 必须原样保留
    expect(settings.api.chat.apiKey).toBe('sk-user')
    expect(settings.chatConfigured).toBe(true)
  })

  it('用户自改的地址不会被读档覆盖', async () => {
    kvStore.set(KEY, {
      providerId: 'deepseek',
      chat: { baseUrl: 'https://my-proxy.example.com/v1', apiKey: 'sk-user', model: 'deepseek-chat' },
      embed: { baseUrl: 'https://embed.example.com/v1', apiKey: 'sk-e', model: 'bge-m3' }
    })

    const settings = useSettingsStore()
    await settings.load()

    expect(settings.api.chat.baseUrl).toBe('https://my-proxy.example.com/v1')
    // Embedding 指向别家也必须保留，不能被对话厂商的预设冲掉
    expect(settings.api.embed.baseUrl).toBe('https://embed.example.com/v1')
    expect(settings.api.embed.model).toBe('bge-m3')
    expect(settings.embedConfigured).toBe(true)
  })

  it('「自定义」厂商不做任何补空，用户填什么就是什么', async () => {
    kvStore.set(KEY, {
      providerId: 'custom',
      chat: { baseUrl: '', apiKey: '', model: '' },
      embed: { baseUrl: '', apiKey: '', model: '' }
    })

    const settings = useSettingsStore()
    await settings.load()

    expect(settings.api.chat.baseUrl).toBe('')
    expect(settings.api.chat.model).toBe('')
  })
})
