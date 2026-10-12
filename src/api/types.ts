/** 对话角色 */
export type ChatRole = 'system' | 'user' | 'assistant'

/** 发给大模型的单条消息 */
export interface ChatMessage {
  role: ChatRole
  content: string
}

/**
 * 一个接口端点配置。
 * 对话和 Embedding 各自独立配置 —— 因为很多厂商只提供其中一种，
 * 或者两者的地址、密钥、模型名并不相同。
 */
export interface EndpointConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface ApiSettings {
  /** 当前选中的厂商预设 id，仅用于回填表单，不参与请求 */
  providerId: string
  chat: EndpointConfig
  embed: EndpointConfig
}

/** 厂商预设 */
export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  chatModel: string
  /** 不提供 Embedding 的厂商留空，需要用户另行配置 */
  embedBaseUrl: string
  embedModel: string
  note: string
  docsUrl: string
}

/**
 * 均为 OpenAI 兼容协议的厂商，切换时只需换地址与模型名。
 * 各家的模型、价格与额度会变动；预设仅作快捷起点，具体以官方文档和「测试连接」为准。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    chatModel: 'deepseek-flash',
    embedBaseUrl: '',
    embedModel: '',
    note: '提供对话接口，不提供 Embedding；模型与计费以官网为准',
    docsUrl: 'https://api-docs.deepseek.com/'
  },
  {
    id: 'dashscope',
    name: '阿里通义（兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModel: 'qwen-plus',
    embedBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embedModel: 'text-embedding-v3',
    note: '对话与 Embedding 均可配置；API Key 和地域/业务空间需与接口地址匹配',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key'
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatModel: 'glm-4-flash',
    embedBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    embedModel: 'embedding-3',
    note: '提供对话与 Embedding 接口；模型与计费以官网为准',
    docsUrl: 'https://docs.bigmodel.cn/'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    chatModel: 'Qwen/Qwen2.5-7B-Instruct',
    embedBaseUrl: 'https://api.siliconflow.cn/v1',
    embedModel: 'BAAI/bge-large-zh-v1.5',
    note: '提供对话与 Embedding 接口；模型可用性与计费以模型广场为准',
    docsUrl: 'https://docs.siliconflow.cn/docs/userguide/quickstart'
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: '',
    chatModel: '',
    embedBaseUrl: '',
    embedModel: '',
    note: '任何兼容 OpenAI 协议的服务都可以填在这里',
    docsUrl: ''
  }
]

/** 默认厂商：新用户第一次打开就能直接填 Key 用起来 */
export const DEFAULT_PROVIDER_ID = 'deepseek'

const DEFAULT_PRESET = PROVIDER_PRESETS.find((p) => p.id === DEFAULT_PROVIDER_ID) ?? PROVIDER_PRESETS[0]

/**
 * 空配置。
 *
 * 对话端点**预填默认厂商的地址与模型名** —— 用户只需要填自己的 Key。
 * 让用户手抄 URL 是最高频的失败来源：抄错域名、漏了 `/v1`、
 * 或者把 `/chat/completions` 也一起抄进 baseUrl（本应用会自己拼这一段）。
 *
 * Embedding 端点**刻意不预填**：DeepSeek 没有这个接口，
 * 预填一个别家的地址只会让人以为「填个 Key 就能用」，反而更困惑。
 * 这一区的用法在「我的」页面里说明，并给了可一键填充的厂商。
 */
export const EMPTY_API_SETTINGS: ApiSettings = {
  providerId: DEFAULT_PRESET.id,
  chat: { baseUrl: DEFAULT_PRESET.baseUrl, apiKey: '', model: DEFAULT_PRESET.chatModel },
  embed: { baseUrl: '', apiKey: '', model: '' }
}

/** 提供 Embedding 接口的预设，供「Embedding 接口」一节做快捷填充 */
export const EMBED_PRESETS: ProviderPreset[] = PROVIDER_PRESETS.filter((p) => p.embedBaseUrl.trim() !== '')
