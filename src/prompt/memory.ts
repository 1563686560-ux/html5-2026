/** 记忆抽取提示词与防御式 JSON 解析 */
import type { ChatMessage } from '@/api/types'

export interface ExtractedMemory {
  content: string
  topic: string
}

export function buildMemoryExtractionMessages(messages: ChatMessage[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是一个用户记忆抽取器。只提取关于用户本人、未来对话有长期价值的事实，例如身份、偏好、目标、正在做的事。忽略闲聊、临时问题和模型自身信息。只输出 JSON 数组，不要 Markdown，不要解释。每项格式为 {"content":"简短事实","topic":"身份/偏好/目标/经历/其他"}。没有值得记住的内容就输出 []。'
    },
    {
      role: 'user',
      content: `请从下面这轮对话中提取值得长期记住的用户事实：\n\n${messages
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
        .join('\n')}`
    }
  ]
}

export function parseExtractedMemories(raw: string): ExtractedMemory[] {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []

  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(value)) return []
    return value
      .filter((item): item is { content?: unknown; topic?: unknown } => typeof item === 'object' && item !== null)
      .map((item) => ({
        content: typeof item.content === 'string' ? item.content.trim() : '',
        topic: typeof item.topic === 'string' ? item.topic.trim() || '其他' : '其他'
      }))
      .filter((item) => item.content.length >= 2 && item.content.length <= 120)
      .slice(0, 5)
  } catch {
    return []
  }
}
