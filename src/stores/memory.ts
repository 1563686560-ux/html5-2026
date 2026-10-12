/**
 * 统一记忆层（P2）
 * ------------------------------------------------------------------
 * 记忆只存浏览器 IndexedDB；模型只负责从最近一轮对话中提取候选事实，
 * 最终是否保存由本地去重与上限策略决定。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { completeChat } from '@/api/llm'
import { STORE, dbDelete, dbGetAllByIndex, dbPut, kvGet, kvSet } from '@/db'
import { buildMemoryExtractionMessages, parseExtractedMemories } from '@/prompt/memory'
import type { StoredMessage } from './chat'
import { useSettingsStore } from './settings'

export interface MemoryItem {
  id: string
  content: string
  topic: string
  weight: number
  sessionId: string
  createdAt: number
  updatedAt: number
}

const ENABLED_KEY = 'memory-enabled'
const MAX_MEMORIES = 60

function normalize(value: string): string {
  return value.replace(/[\s，。！？、,.!?：:；;]/g, '').toLowerCase()
}

/** 字符集合相似度：不依赖额外 NLP 包，足够做候选记忆去重 */
function similarity(a: string, b: string): number {
  const left = new Set(Array.from(normalize(a)))
  const right = new Set(Array.from(normalize(b)))
  if (!left.size || !right.size) return 0
  let common = 0
  left.forEach((char) => {
    if (right.has(char)) common += 1
  })
  return common / (left.size + right.size - common)
}

export const useMemoryStore = defineStore('memory', () => {
  const memories = ref<MemoryItem[]>([])
  const enabled = ref(true)
  const ready = ref(false)
  const extracting = ref(false)
  const lastError = ref<string | null>(null)
  let timer: number | undefined

  const sortedMemories = computed(() =>
    [...memories.value].sort((a, b) => {
      const scoreA = a.weight * Math.exp(-(Date.now() - a.updatedAt) / (1000 * 60 * 60 * 24 * 120))
      const scoreB = b.weight * Math.exp(-(Date.now() - b.updatedAt) / (1000 * 60 * 60 * 24 * 120))
      return scoreB - scoreA
    })
  )

  async function init(): Promise<void> {
    try {
      const [rows, setting] = await Promise.all([
        dbGetAllByIndex<MemoryItem>(STORE.memories, 'updatedAt'),
        kvGet<boolean>(ENABLED_KEY)
      ])
      memories.value = rows.sort((a, b) => b.updatedAt - a.updatedAt)
      if (typeof setting === 'boolean') enabled.value = setting
    } catch (error) {
      console.warn('[memory] 初始化失败', error)
      memories.value = []
    } finally {
      ready.value = true
    }
  }

  async function setEnabled(value: boolean): Promise<void> {
    enabled.value = value
    await kvSet(ENABLED_KEY, value)
  }

  function top(limit = 8): string[] {
    if (!enabled.value) return []
    return sortedMemories.value.slice(0, limit).map((item) => item.content)
  }

  async function add(content: string, topic = '其他', sessionId = 'manual'): Promise<MemoryItem | null> {
    const text = content.trim()
    if (text.length < 2) return null
    const now = Date.now()
    const old = memories.value.find((item) => similarity(item.content, text) >= 0.7)
    if (old) {
      old.weight += 1
      old.updatedAt = now
      await dbPut(STORE.memories, { ...old })
      return old
    }

    const item: MemoryItem = {
      id: `mem-${crypto.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`}`,
      content: text.slice(0, 120),
      topic: topic || '其他',
      weight: 1,
      sessionId,
      createdAt: now,
      updatedAt: now
    }
    memories.value.unshift(item)
    await dbPut(STORE.memories, item)

    if (memories.value.length > MAX_MEMORIES) {
      const tail = [...memories.value]
        .sort((a, b) => a.weight - b.weight || a.updatedAt - b.updatedAt)
        .slice(0, memories.value.length - MAX_MEMORIES)
      for (const removed of tail) {
        memories.value = memories.value.filter((entry) => entry.id !== removed.id)
        await dbDelete(STORE.memories, removed.id)
      }
    }
    return item
  }

  async function remove(id: string): Promise<void> {
    memories.value = memories.value.filter((item) => item.id !== id)
    await dbDelete(STORE.memories, id)
  }

  async function clear(): Promise<void> {
    const current = [...memories.value]
    memories.value = []
    for (const item of current) await dbDelete(STORE.memories, item.id)
  }

  /** 对话结束后延迟抽取，避免用户刚收到回复时又被第二个请求抢网络 */
  function scheduleExtraction(sessionId: string, messages: StoredMessage[]): void {
    if (!enabled.value || extracting.value || messages.length < 2) return
    if (timer !== undefined) window.clearTimeout(timer)
    const recent = messages.slice(-2).map((message) => ({ role: message.role, content: message.content }))
    timer = window.setTimeout(() => {
      void extractFrom(sessionId, recent)
    }, 1800)
  }

  async function extractFrom(
    sessionId: string,
    recent: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<void> {
    const settings = useSettingsStore()
    if (!enabled.value || !settings.chatConfigured || extracting.value) return
    extracting.value = true
    lastError.value = null
    try {
      const reply = await completeChat(settings.api.chat, buildMemoryExtractionMessages(recent), {
        temperature: 0.15,
        maxTokens: 300,
        timeoutMs: 30_000
      })
      const candidates = parseExtractedMemories(reply)
      for (const candidate of candidates) await add(candidate.content, candidate.topic, sessionId)
    } catch (error) {
      // 记忆是加分项，抽取失败不能影响主对话
      lastError.value = (error as Error).message
      console.warn('[memory] 抽取失败', error)
    } finally {
      extracting.value = false
      timer = undefined
    }
  }

  return {
    memories,
    sortedMemories,
    enabled,
    ready,
    extracting,
    lastError,
    init,
    setEnabled,
    top,
    add,
    remove,
    clear,
    scheduleExtraction
  }
})
