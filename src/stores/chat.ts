/**
 * 会话状态
 * ------------------------------------------------------------------
 * 负责：会话与消息的加载、发送、流式接收、中断、持久化。
 *
 * 两个关键细节：
 *   1. 流式增量走「帧批量提交」（见 utils/frameBatcher），
 *      否则每个 token 一次响应式写入，手机上必掉帧；
 *   2. 写入 IndexedDB 前必须把响应式代理展开成普通对象，
 *      因为结构化克隆算法无法克隆 Proxy，会直接抛 DataCloneError。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import {
  STORE,
  dbDelete,
  dbDeleteByIndex,
  dbGetAllByIndex,
  dbGetPageByIndex,
  dbPut,
  dbPutMany,
  dbScanByIndex
} from '@/db'
import { streamChat } from '@/api/llm'
import { DEFAULT_PERSONA_ID } from '@/data/personas'
import { usePersonasStore } from './personas'
import { assembleMessages, type Reference } from '@/prompt/assembler'
import { buildReferences } from '@/rag/references'
import { buildRetrievalQuery } from '@/rag/queryContext'
import { createFrameBatcher } from '@/utils/frameBatcher'
import { useMemoryStore } from './memory'
import { useRagStore } from './rag'
import { createId } from '@/utils/id'
import { useSettingsStore } from './settings'
import {
  DEFAULT_SEARCH_LIMITS,
  createHistorySearch,
  isTruncated,
  matchSessionTitles,
  normalizeKeyword,
  type HistorySearchResult,
  type SearchLimits
} from '@/utils/search'

export interface ChatSession {
  id: string
  title: string
  personaId: string
  documentId?: string
  createdAt: number
  updatedAt: number
}

export interface StoredMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  status?: 'complete' | 'incomplete'
  references?: Reference[]
  documentId?: string
}

/** 送进模型的历史消息上限，防止上下文无限增长 */
const HISTORY_LIMIT = 20
/** 每次从数据库读入的消息条数（上滑加载更多时也用它） */
export const PAGE_SIZE = 30
const NEW_SESSION_TITLE = '新对话'

function messageRange(sessionId: string): IDBKeyRange {
  // 复合索引 [sessionId, createdAt]，用上下界圈出该会话的全部消息（天然按时间有序）
  return IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>([])
  const messages = ref<StoredMessage[]>([])
  const currentSessionId = ref<string | null>(null)
  const streaming = ref(false)
  const ready = ref(false)
  const errorText = ref<string | null>(null)
  /** 正在向上加载更早的消息 */
  const loadingOlder = ref(false)
  /** 当前会话是否还有更早的消息没读进来 */
  const hasMoreHistory = ref(false)
  /** 空串检索全部资料；具体 ID 只检索该文档。 */
  const selectedDocumentId = ref('')

  let controller: AbortController | null = null
  let sessionVersion = 0
  let retryVersion: number | null = null
  const loadingSession = ref(false)

  function beginNavigation(): number {
    stop()
    controller = null
    streaming.value = false
    loadingOlder.value = false
    loadingSession.value = false
    retryVersion = null
    return ++sessionVersion
  }

  function isCurrent(id: string, version: number): boolean {
    return currentSessionId.value === id && sessionVersion === version
  }

  const currentSession = computed(() => sessions.value.find((s) => s.id === currentSessionId.value) ?? null)

  watch(
    selectedDocumentId,
    (documentId) => {
      const session = currentSession.value
      if (!session) return
      session.documentId = documentId
      void dbPut(STORE.sessions, { ...session }).catch((error) => console.warn('[chat] 保存资料范围失败', error))
    },
    { flush: 'sync' }
  )

  // 走角色注册表而不是 data 里的 getPersona()：用户自建和临时人设
  // 只存在于运行时，纯函数查不到它们，会被静默解析成默认助手
  const personas = usePersonasStore()
  const currentPersona = computed(() => personas.resolve(currentSession.value?.personaId ?? DEFAULT_PERSONA_ID))

  /** 流式过程中最后一条助手消息的内容，供界面显示光标 */
  const streamingMessageId = computed(() =>
    streaming.value ? (messages.value[messages.value.length - 1]?.id ?? null) : null
  )

  async function loadSessions(): Promise<void> {
    try {
      const list = await dbGetAllByIndex<ChatSession>(STORE.sessions, 'updatedAt')
      sessions.value = list.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (error) {
      console.warn('[chat] 读取会话失败', error)
      sessions.value = []
    }
  }

  async function init(): Promise<void> {
    await loadSessions()
    ready.value = true
    if (sessions.value.length > 0) {
      await selectSession(sessions.value[0].id)
    }
  }

  /**
   * 重新从数据库读会话列表（下拉刷新用）。
   * 特意不复用 init()：init 会顺带切到第一个会话，
   * 而"下拉刷新把用户正在看的会话换掉"是明显的错误行为。
   */
  async function reloadSessions(): Promise<void> {
    await loadSessions()
  }

  async function selectSession(id: string): Promise<void> {
    const version = beginNavigation()
    currentSessionId.value = id
    const savedRange = currentSession.value?.documentId
    errorText.value = null
    messages.value = []
    hasMoreHistory.value = false
    loadingSession.value = true
    selectedDocumentId.value = savedRange ?? ''
    try {
      const page = await dbGetPageByIndex<StoredMessage>(STORE.messages, 'sessionId_createdAt', messageRange(id), {
        limit: PAGE_SIZE,
        direction: 'prev'
      })
      if (!isCurrent(id, version)) return
      messages.value = page.filter((message) => message.sessionId === id).reverse()
      hasMoreHistory.value = page.length === PAGE_SIZE
      // Older saved sessions did not have a per-session range. Recover it from their latest user turn.
      if (savedRange === undefined) {
        selectedDocumentId.value =
          [...messages.value].reverse().find((message) => message.role === 'user')?.documentId ?? ''
        const session = currentSession.value
        if (session) {
          session.documentId = selectedDocumentId.value
          await dbPut(STORE.sessions, { ...session })
        }
      }
    } catch (error) {
      if (!isCurrent(id, version)) return
      console.warn('[chat] 读取消息失败', error)
      errorText.value = '会话读取失败，请重新打开此会话'
    } finally {
      if (isCurrent(id, version)) loadingSession.value = false
    }
  }

  /**
   * 向上加载更早的一页消息（配合上滑手势）。
   * 上界取到当前最旧那一条本身（闭区间）而不是减一毫秒 ——
   * 同一毫秒内可能有多条消息，用开区间会把它们整批漏掉。
   * 代价是可能读回已加载的那条，所以读回后按 id 去重。
   */
  async function loadOlderMessages(): Promise<void> {
    const sessionId = currentSessionId.value
    const version = sessionVersion
    const oldest = messages.value[0]
    if (!sessionId || !oldest || loadingSession.value || loadingOlder.value || !hasMoreHistory.value) return

    loadingOlder.value = true
    try {
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, oldest.createdAt])
      const page = await dbGetPageByIndex<StoredMessage>(STORE.messages, 'sessionId_createdAt', range, {
        limit: PAGE_SIZE,
        direction: 'prev'
      })

      if (!isCurrent(sessionId, version)) return
      const known = new Set(messages.value.map((m) => m.id))
      const older = page.filter((m) => m.sessionId === sessionId && !known.has(m.id)).reverse()

      if (older.length === 0) {
        // 一整页都是已加载的，说明真的到底了。同时也是死循环的保险丝
        hasMoreHistory.value = false
        return
      }

      messages.value = [...older, ...messages.value]
      // 读满了一页就还有下一页。上面已保证 older 非空，不会出现"永远有更多"
      hasMoreHistory.value = page.length === PAGE_SIZE
    } catch (error) {
      console.warn('[chat] 加载历史失败', error)
      if (isCurrent(sessionId, version)) hasMoreHistory.value = false
    } finally {
      if (isCurrent(sessionId, version)) loadingOlder.value = false
    }
  }

  /** 为搜索跳转补载命中消息附近的一页，并与当前已加载消息合并。 */
  async function revealMessage(messageId: string, createdAt: number): Promise<boolean> {
    const sessionId = currentSessionId.value
    const version = sessionVersion
    if (!sessionId) return false
    if (messages.value.some((message) => message.id === messageId)) return true

    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, createdAt])
    const page = await dbGetPageByIndex<StoredMessage>(STORE.messages, 'sessionId_createdAt', range, {
      limit: PAGE_SIZE,
      direction: 'prev'
    })
    if (!isCurrent(sessionId, version)) return false
    const merged = new Map(messages.value.map((message) => [message.id, message]))
    for (const message of page) if (message.sessionId === sessionId) merged.set(message.id, message)
    messages.value = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
    hasMoreHistory.value = page.length === PAGE_SIZE
    return messages.value.some((message) => message.id === messageId)
  }

  /**
   * 跨会话搜索：标题命中 + 历史消息正文命中。
   *
   * 为什么放在 store 而不是视图里：它同时要用会话列表（标题匹配）和 messages 表
   * （正文匹配），而这两份数据的读取约定 —— STORE 常量、游标方向、扫描上限 ——
   * 都归数据层管，散到视图里迟早会和别处的读法不一致。
   *
   * 性能上只有一条硬要求：**不把 messages 表整个读进内存**。
   * 所以正文匹配走 dbScanByIndex 游标逐条看，命中数或扫描数到上限就立刻刹车，
   * 返回结果里的 truncated 用来说明"这不是全部"。
   */
  async function searchHistory(
    rawKeyword: string,
    limits: SearchLimits = DEFAULT_SEARCH_LIMITS
  ): Promise<HistorySearchResult> {
    const keyword = normalizeKeyword(rawKeyword)
    if (!keyword) return { hits: [], scanned: 0, truncated: false, reason: 'exhausted' }

    // 标题命中不扫表：会话列表本来就在内存里（几十条），再开一次游标纯属浪费
    const titleHits = matchSessionTitles(sessions.value, keyword, limits.maxHits)
    // 标题命中先占掉名额，保证两类结果加起来不超过 maxHits —— 上限是给用户的承诺，不是给某一类的
    const messageBudget = Math.max(0, limits.maxHits - titleHits.length)
    const scanner = createHistorySearch(keyword, { maxScan: limits.maxScan, maxHits: messageBudget })

    // 先按 updatedAt 倒序遍历会话，再在会话内倒序扫描消息。这样达到扫描上限时，
    // 被保留下来的是近期会话与近期消息，而不是复合索引中 id 靠前的旧记录。
    let remainingScan = limits.maxScan
    let indexExhausted = true
    for (const session of sessions.value) {
      if (remainingScan <= 0) {
        indexExhausted = false
        break
      }
      const outcome = await dbScanByIndex<StoredMessage>(
        STORE.messages,
        'sessionId_createdAt',
        (message) => scanner.feed(message),
        { query: messageRange(session.id), direction: 'prev', maxScan: remainingScan }
      )
      remainingScan -= outcome.scanned
      if (!outcome.exhausted) {
        indexExhausted = false
        break
      }
    }

    const summary = scanner.finish()
    return {
      hits: [...titleHits, ...summary.hits],
      scanned: summary.scanned,
      truncated: isTruncated(summary.reason, indexExhausted),
      reason: summary.reason
    }
  }

  async function createSession(personaId: string = DEFAULT_PERSONA_ID): Promise<ChatSession> {
    const version = beginNavigation()
    loadingSession.value = true
    try {
      return await insertSession(personaId, '', version)
    } finally {
      if (sessionVersion === version) loadingSession.value = false
    }
  }

  async function insertSession(
    personaId: string = DEFAULT_PERSONA_ID,
    documentId = '',
    version = sessionVersion
  ): Promise<ChatSession> {
    const now = Date.now()
    const session: ChatSession = {
      id: createId('sess'),
      title: NEW_SESSION_TITLE,
      personaId,
      documentId,
      createdAt: now,
      updatedAt: now
    }
    await dbPut(STORE.sessions, { ...session })
    sessions.value.unshift(session)
    if (version !== sessionVersion) return session
    currentSessionId.value = session.id
    messages.value = []
    hasMoreHistory.value = false
    selectedDocumentId.value = documentId
    errorText.value = null
    return session
  }

  /** 没有当前会话时按需创建，避免一进应用就留下空会话 */
  async function ensureSession(): Promise<ChatSession> {
    return currentSession.value ?? (await insertSession(DEFAULT_PERSONA_ID, selectedDocumentId.value))
  }

  async function deleteSession(id: string): Promise<void> {
    const wasCurrent = currentSessionId.value === id
    const version = wasCurrent ? beginNavigation() : sessionVersion
    try {
      await dbDelete(STORE.sessions, id)
      await dbDeleteByIndex(STORE.messages, 'sessionId_createdAt', messageRange(id))
    } catch (error) {
      console.warn('[chat] 删除会话失败', error)
    }
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (wasCurrent && isCurrent(id, version)) {
      currentSessionId.value = null
      messages.value = []
      if (sessions.value.length > 0) await selectSession(sessions.value[0].id)
    }
  }

  async function renameSession(id: string, title: string): Promise<void> {
    const session = sessions.value.find((s) => s.id === id)
    const next = title.trim()
    if (!session || !next) return
    session.title = next.slice(0, 30)
    session.updatedAt = Date.now()
    await dbPut(STORE.sessions, { ...session })
  }

  /**
   * 换一位先贤。
   * 已有对话不会被清空 —— 换个人接着聊是合理的用法（"这事庄子怎么看"），
   * 历史消息照旧带进上下文，由新的 system prompt 决定回应的口吻。
   */
  async function switchPersona(personaId: string): Promise<void> {
    stop()
    const session = currentSession.value
    if (!session) {
      await createSession(personaId)
      return
    }
    session.personaId = personaId
    session.updatedAt = Date.now()
    await dbPut(STORE.sessions, { ...session })
  }

  function stop(): void {
    controller?.abort()
  }

  function clearError(): void {
    errorText.value = null
  }

  async function sendMessage(rawText: string): Promise<void> {
    const text = rawText.trim()
    if (!text || streaming.value || loadingSession.value || retryVersion !== null) return
    streaming.value = true
    const requestController = new AbortController()
    controller = requestController
    const documentId = selectedDocumentId.value
    const version = sessionVersion
    try {
      await sendLocked(text, requestController.signal, documentId, version)
    } catch (error) {
      if (!requestController.signal.aborted && version === sessionVersion) errorText.value = (error as Error).message
    } finally {
      if (controller === requestController) {
        controller = null
        streaming.value = false
      }
    }
  }

  /** 删除上一次失败轮次后重新发送，避免聊天里出现重复提问。 */
  async function retryLastMessage(): Promise<void> {
    if (streaming.value || loadingSession.value || retryVersion !== null) return
    const id = currentSessionId.value
    if (!id) return
    const version = sessionVersion
    let userIndex = -1
    for (let index = messages.value.length - 1; index >= 0; index--) {
      if (messages.value[index]!.role === 'user') {
        userIndex = index
        break
      }
    }
    if (userIndex < 0) return
    const retrying = messages.value[userIndex]!
    const trailing = messages.value.slice(userIndex)
    retryVersion = version
    try {
      for (const message of trailing) {
        if (!isCurrent(id, version)) return
        await dbDelete(STORE.messages, message.id)
      }
      if (!isCurrent(id, version)) return
      messages.value = messages.value.slice(0, userIndex)
      selectedDocumentId.value = retrying.documentId ?? ''
      errorText.value = null
      retryVersion = null
      await sendMessage(retrying.content)
    } catch (error) {
      if (isCurrent(id, version)) errorText.value = `重试准备失败：${(error as Error).message}`
    } finally {
      if (retryVersion === version) retryVersion = null
    }
  }

  async function sendLocked(text: string, signal: AbortSignal, documentId: string, version: number): Promise<void> {
    const settings = useSettingsStore()
    const memory = useMemoryStore()
    const rag = useRagStore()
    errorText.value = null

    const session = await ensureSession()
    signal.throwIfAborted()
    if (!isCurrent(session.id, version)) throw new DOMException('会话已切换', 'AbortError')
    const persona = currentPersona.value
    const now = Date.now()

    // 1. 先落用户消息
    const userMessage: StoredMessage = {
      id: createId('msg'),
      sessionId: session.id,
      role: 'user',
      content: text,
      createdAt: now,
      documentId: documentId || undefined
    }
    messages.value.push(userMessage)

    // 首条消息顺便当作会话标题，省掉一次额外的模型调用
    if (session.title === NEW_SESSION_TITLE) {
      session.title = text.length > 16 ? `${text.slice(0, 16)}…` : text
    }
    session.updatedAt = now

    try {
      await dbPutMany(STORE.messages, [userMessage])
      await dbPut(STORE.sessions, { ...session })
    } catch (error) {
      console.warn('[chat] 保存用户消息失败', error)
    }
    signal.throwIfAborted()

    // 2. 插入助手占位消息（重新读一次拿到响应式代理，直接改它才能触发更新）
    messages.value.push({
      id: createId('msg'),
      sessionId: session.id,
      role: 'assistant',
      status: 'incomplete',
      documentId: documentId || undefined,
      content: '',
      createdAt: now + 1
    })
    const assistant = messages.value[messages.value.length - 1]

    // 发送锁已在入口取得，这里只准备当前回复的流式缓冲。
    const batcher = createFrameBatcher((value) => {
      assistant.content = value
    })
    const contextMessages = messages.value.filter((message) => message.sessionId === session.id)
    let replyCompleted = false
    let userAborted = false
    /** 服务端没发 [DONE] 就断开：内容可能是半截的 */
    let truncated = false

    try {
      // 4. 先检索资料，再组装上下文：人设 + 记忆 + 资料 + 历史
      const scopedHistory = contextMessages.filter(
        (message) =>
          message.id !== userMessage.id &&
          message.id !== assistant.id &&
          message.status !== 'incomplete' &&
          (!documentId || message.documentId === documentId)
      )
      const retrievalQuery = documentId
        ? buildRetrievalQuery(
            text,
            scopedHistory.map((message) => ({ role: message.role, content: message.content }))
          )
        : text
      const hits = await rag.search(retrievalQuery, 4, documentId || undefined, signal)
      signal.throwIfAborted()
      assistant.references = buildReferences(hits)
      assistant.documentId = documentId || undefined
      const history = assembleMessages(
        persona,
        contextMessages
          .filter(
            (m) => m.id !== assistant.id && m.status !== 'incomplete' && (!documentId || m.documentId === documentId)
          )
          .map((m) => ({ role: m.role, content: m.content })),
        {
          historyLimit: HISTORY_LIMIT,
          memories: documentId ? [] : memory.top(8),
          references: assistant.references,
          strictReferences: Boolean(documentId)
        }
      )

      await streamChat({ ...settings.api.chat }, history, {
        temperature: hits.length ? 0.3 : documentId ? 0.5 : 0.8,
        signal,
        onDelta: (_chunk, full) => batcher.push(full),
        onFinish: (info) => {
          truncated = info.truncated
        }
      })
      batcher.flush()
      signal.throwIfAborted()
      replyCompleted = !truncated && Boolean(assistant.content.trim())
      assistant.status = replyCompleted ? 'complete' : 'incomplete'
      if (replyCompleted && documentId && !hits.length) {
        const warning = 'AI生成可能有误，注意核实。'
        if (!assistant.content.trimEnd().endsWith(warning)) {
          assistant.content = `${assistant.content.trimEnd()}\n\n${warning}`.trim()
        }
      }
    } catch (error) {
      batcher.flush()
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      userAborted = aborted
      if (aborted) {
        if (!assistant.content.trim()) assistant.content = '（已停止生成）'
      } else {
        if (isCurrent(session.id, version)) errorText.value = (error as Error).message
      }
    } finally {
      const content = assistant.content

      if (content.trim()) {
        try {
          await dbPut(STORE.messages, {
            id: assistant.id,
            sessionId: assistant.sessionId,
            role: assistant.role,
            content,
            status: assistant.status,
            createdAt: assistant.createdAt,
            references: assistant.references,
            documentId: assistant.documentId
          })
        } catch (error) {
          console.warn('[chat] 保存回复失败', error)
        }
      } else {
        // 一个字都没生成（例如直接报错），不留下空气泡
        if (isCurrent(session.id, version)) messages.value = messages.value.filter((m) => m.id !== assistant.id)
      }

      session.updatedAt = Date.now()
      try {
        await dbPut(STORE.sessions, { ...session })
      } catch (error) {
        console.warn('[chat] 更新会话失败', error)
      }
      sessions.value = [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt)

      if (truncated && content.trim() && isCurrent(session.id, version)) {
        // 半截回答照样展示、照样保存，但要告诉用户，
        // 并且下面不能拿它去抽取记忆，否则记忆层会被不完整的结论污染
        errorText.value = '回复可能不完整：连接在生成结束前就断开了'
      }

      // 抽取是旁路任务：失败不能影响刚刚完成的主回复。
      // 用户主动停止、或服务端没发 [DONE] 时都不抽取，只让完整回复进入候选记忆。
      if (!userAborted && replyCompleted && !signal.aborted && !documentId) {
        memory.scheduleExtraction(session.id, [
          userMessage,
          {
            id: assistant.id,
            sessionId: assistant.sessionId,
            role: assistant.role,
            content,
            createdAt: assistant.createdAt
          }
        ])
      }
    }
  }

  /** 清空全部会话与消息 */
  async function clearAll(): Promise<void> {
    const version = beginNavigation()
    const removedIds = new Set(sessions.value.map((session) => session.id))
    for (const session of [...sessions.value]) {
      await dbDeleteByIndex(STORE.messages, 'sessionId_createdAt', messageRange(session.id)).catch(() => undefined)
      await dbDelete(STORE.sessions, session.id).catch(() => undefined)
    }
    sessions.value = sessions.value.filter((session) => !removedIds.has(session.id))
    if (sessionVersion !== version) return
    messages.value = []
    currentSessionId.value = null
    selectedDocumentId.value = ''
  }

  return {
    selectedDocumentId,
    sessions,
    messages,
    currentSessionId,
    currentSession,
    currentPersona,
    streaming,
    streamingMessageId,
    ready,
    errorText,
    loadingOlder,
    loadingSession,
    hasMoreHistory,
    init,
    selectSession,
    loadOlderMessages,
    revealMessage,
    searchHistory,
    reloadSessions,
    createSession,
    deleteSession,
    renameSession,
    switchPersona,
    sendMessage,
    retryLastMessage,
    stop,
    clearError,
    clearAll
  }
})
