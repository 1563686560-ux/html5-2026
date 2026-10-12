import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
const { put, putMany, readPage, remove, search, stream, extraction } = vi.hoisted(() => ({
  put: vi.fn(),
  putMany: vi.fn(),
  readPage: vi.fn(),
  remove: vi.fn(),
  search: vi.fn(),
  stream: vi.fn(),
  extraction: vi.fn()
}))
vi.mock('@/db', () => ({
  STORE: { sessions: 'sessions', messages: 'messages' },
  dbPut: put,
  dbPutMany: putMany,
  dbDelete: remove,
  dbDeleteByIndex: vi.fn(),
  dbGetAllByIndex: vi.fn(),
  dbGetPageByIndex: readPage,
  dbScanByIndex: vi.fn()
}))
vi.mock('@/api/llm', () => ({ streamChat: stream }))
vi.mock('./settings', () => ({ useSettingsStore: () => ({ api: { chat: {} } }) }))
vi.mock('./memory', () => ({
  useMemoryStore: () => ({ top: () => ['其他资料中的旧记忆'], scheduleExtraction: extraction })
}))
vi.mock('./rag', () => ({ useRagStore: () => ({ search }) }))
vi.mock('./personas', () => ({
  usePersonasStore: () => ({
    resolve: () => ({
      id: 'test',
      name: '助手',
      identity: '助手',
      traits: [],
      speechStyle: [],
      taboos: [],
      category: 'assistant'
    })
  })
}))
import { useChatStore } from './chat'
beforeEach(() => {
  setActivePinia(createPinia())
  put.mockReset().mockResolvedValue('ok')
  putMany.mockReset().mockResolvedValue(undefined)
  readPage.mockReset().mockResolvedValue([])
  remove.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('IDBKeyRange', { bound: (...args: unknown[]) => args })
  search.mockReset().mockResolvedValue([])
  extraction.mockReset()
  stream.mockReset().mockImplementation(async (_endpoint, _messages, options) => {
    options.onDelta('回答[1]', '回答[1]')
    options.onFinish({ truncated: false })
    return '回答[1]'
  })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
it('创建会话落盘期间连续发送只有一个请求，结束后解除锁定', async () => {
  let release!: () => void
  put.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const chat = useChatStore()
  const first = chat.sendMessage('第一条')
  expect(chat.streaming).toBe(true)
  await chat.sendMessage('第二条')
  release()
  await first
  expect(stream).toHaveBeenCalledTimes(1)
  expect(chat.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['第一条'])
  expect(chat.streaming).toBe(false)
})
it('创建会话失败释放发送锁，下一次可以重试', async () => {
  put.mockRejectedValueOnce(new Error('存储不可用'))
  const chat = useChatStore()
  await chat.sendMessage('问题')
  expect(chat.errorText).toBe('存储不可用')
  expect(chat.streaming).toBe(false)
  await chat.sendMessage('重试')
  expect(stream).toHaveBeenCalledTimes(1)
})
it('检索期间停止后不会发起模型请求', async () => {
  let release!: (value: []) => void
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const chat = useChatStore()
  const sending = chat.sendMessage('问题')
  await vi.waitFor(() => expect(search).toHaveBeenCalled())
  chat.stop()
  release([])
  await sending
  expect(stream).not.toHaveBeenCalled()
  expect(chat.streaming).toBe(false)
})
it('指定资料无命中时调用模型补充，并在末尾追加核实提示', async () => {
  const chat = useChatStore()
  chat.selectedDocumentId = 'doc-a'
  await chat.sendMessage('未记载的问题')
  expect(search.mock.calls[0][2]).toBe('doc-a')
  expect(stream).toHaveBeenCalledTimes(1)
  const prompt = stream.mock.calls[0][1].map((m: { content: string }) => m.content).join('\n')
  expect(prompt).toContain('可以根据自身知识生成合理答案')
  expect(chat.messages.at(-1)?.content).toBe('回答[1]\n\nAI生成可能有误，注意核实。')
})
it('指定资料的省略式追问会带上上一条用户问题检索', async () => {
  const chat = useChatStore()
  await chat.createSession()
  chat.selectedDocumentId = 'doc-a'
  chat.messages.push(
    {
      id: 'prior-user',
      sessionId: chat.currentSessionId!,
      role: 'user',
      content: '云镜展示屏的押金是多少？',
      createdAt: 1,
      documentId: 'doc-a'
    },
    {
      id: 'prior-assistant',
      sessionId: chat.currentSessionId!,
      role: 'assistant',
      content: '押金为 500 元。',
      createdAt: 2,
      documentId: 'doc-a'
    }
  )
  search.mockResolvedValue([
    {
      score: 1,
      mode: 'keyword',
      chunk: {
        id: 'chunk-a',
        documentId: 'doc-a',
        documentTitle: '测试资料',
        index: 0,
        content: '完成关机、断电、线缆归位和负责人验收后退回押金。',
        start: 0,
        end: 26
      }
    }
  ])

  await chat.sendMessage('什么时候退回？')

  expect(search.mock.calls[0][0]).toBe('云镜展示屏的押金是多少？\n什么时候退回？')
  expect(search.mock.calls[0][2]).toBe('doc-a')
})
it('引用随回复落盘，指定资料不混入记忆和其他范围的历史', async () => {
  const chat = useChatStore()
  await chat.createSession()
  chat.messages.push({
    id: 'old',
    sessionId: chat.currentSessionId!,
    role: 'assistant',
    content: '别的文件秘密内容',
    createdAt: 0
  })
  chat.selectedDocumentId = 'doc-a'
  search.mockResolvedValue([
    {
      score: 1,
      mode: 'keyword',
      chunk: {
        id: 'chunk-a',
        documentId: 'doc-a',
        documentTitle: '测试资料',
        index: 0,
        content: '项目采用 Vue。',
        start: 0,
        end: 10
      }
    }
  ])
  await chat.sendMessage('项目采用什么？')
  const prompt = stream.mock.calls[0][1].map((m: { content: string }) => m.content).join('\n')
  expect(prompt).toContain('优先依据本轮所选资料回答')
  expect(prompt).not.toContain('别的文件秘密内容')
  expect(prompt).not.toContain('其他资料中的旧记忆')
  expect(
    put.mock.calls.find(([store, message]) => store === 'messages' && message.role === 'assistant')?.[1].references
  ).toEqual([{ title: '测试资料', content: '项目采用 Vue。', documentId: 'doc-a', chunkIds: ['chunk-a'] }])
  expect(extraction).not.toHaveBeenCalled()
})

it('快速切换会话时较慢的旧读取不覆盖新会话', async () => {
  const chat = useChatStore()
  const a = await chat.createSession()
  const b = await chat.createSession()
  let release!: (value: unknown[]) => void
  readPage
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    .mockResolvedValueOnce([{ id: 'b-message', sessionId: b.id, role: 'user', content: 'B内容', createdAt: 1 }])
  const old = chat.selectSession(a.id)
  await chat.selectSession(b.id)
  release([{ id: 'a-message', sessionId: a.id, role: 'user', content: 'A内容', createdAt: 1 }])
  await old
  expect(chat.currentSessionId).toBe(b.id)
  expect(chat.messages.map((message) => message.content)).toEqual(['B内容'])
})
it('每个会话恢复各自资料范围，新会话不继承旧范围', async () => {
  const chat = useChatStore()
  const a = await chat.createSession()
  chat.selectedDocumentId = 'doc-a'
  const b = await chat.createSession()
  expect(chat.selectedDocumentId).toBe('')
  chat.selectedDocumentId = 'doc-b'
  await chat.selectSession(a.id)
  expect(chat.selectedDocumentId).toBe('doc-a')
  await chat.selectSession(b.id)
  expect(chat.selectedDocumentId).toBe('doc-b')
})
it('失败重试保持原问题资料范围，不使用后来选中的资料', async () => {
  const chat = useChatStore()
  await chat.createSession()
  chat.selectedDocumentId = 'doc-a'
  stream.mockRejectedValueOnce(new Error('接口失败'))
  await chat.sendMessage('原问题')
  chat.selectedDocumentId = 'doc-b'
  await chat.retryLastMessage()
  expect(search.mock.calls[1]?.[2]).toBe('doc-a')
  expect(chat.messages.filter((message) => message.role === 'user')).toHaveLength(1)
})
it('回复中途报错不抽取记忆，半截内容不进入下一次模型上下文', async () => {
  const chat = useChatStore()
  stream.mockImplementationOnce(async (_endpoint, _messages, options) => {
    options.onDelta('半截', '失败的半截回复')
    throw new Error('连接异常')
  })
  await chat.sendMessage('第一问')
  expect(extraction).not.toHaveBeenCalled()
  await chat.sendMessage('第二问')
  expect(
    stream.mock.calls[1]?.[1].some((message: { content: string }) => message.content.includes('失败的半截回复'))
  ).toBe(false)
})
it('停止的回复和空回复都不抽取记忆', async () => {
  const chat = useChatStore()
  stream.mockImplementationOnce(async (_endpoint, _messages, options) => {
    options.onDelta('半截', '半截')
    chat.stop()
    options.signal.throwIfAborted()
  })
  await chat.sendMessage('第一问')
  expect(extraction).not.toHaveBeenCalled()
  stream.mockImplementationOnce(async (_endpoint, _messages, options) => options.onFinish({ truncated: false }))
  await chat.sendMessage('第二问')
  expect(extraction).not.toHaveBeenCalled()
})
it('切换会话后旧检索结束不覆盖新会话，也不阻塞新发送', async () => {
  const chat = useChatStore()
  const a = await chat.createSession()
  let release!: (value: []) => void
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const old = chat.sendMessage('旧问题')
  await vi.waitFor(() => expect(search).toHaveBeenCalled())
  const b = await chat.createSession()
  expect(b.id).not.toBe(a.id)
  await chat.sendMessage('新问题')
  release([])
  await old
  expect(chat.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
    '新问题'
  ])
  expect(stream).toHaveBeenCalledTimes(1)
})
it('重试删除消息期间切换会话不裁掉新会话消息', async () => {
  const chat = useChatStore()
  const a = await chat.createSession()
  await chat.sendMessage('A问题')
  let release!: () => void
  remove.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const retrying = chat.retryLastMessage()
  await vi.waitFor(() => expect(remove).toHaveBeenCalled())
  await chat.createSession()
  await chat.sendMessage('B问题')
  release()
  await retrying
  expect(chat.currentSessionId).not.toBe(a.id)
  expect(chat.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
    'B问题'
  ])
})
it('上一会话的加载更多结果不追加到新会话', async () => {
  const chat = useChatStore()
  const a = await chat.createSession()
  chat.messages = [{ id: 'latest', sessionId: a.id, role: 'user', content: 'A最新', createdAt: 10 }]
  chat.hasMoreHistory = true
  let release!: (value: unknown[]) => void
  readPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const loading = chat.loadOlderMessages()
  await chat.createSession()
  await chat.sendMessage('B问题')
  release([{ id: 'older', sessionId: a.id, role: 'user', content: 'A旧消息', createdAt: 1 }])
  await loading
  expect(chat.messages.some((message) => message.sessionId === a.id)).toBe(false)
})

it('旧版会话从最后一条用户消息恢复资料范围并保存', async () => {
  const chat = useChatStore()
  const a = await chat.createSession()
  delete chat.sessions[0]!.documentId
  await chat.createSession()
  chat.selectedDocumentId = 'doc-b'
  readPage.mockResolvedValueOnce([
    { id: 'legacy', sessionId: a.id, role: 'user', content: '旧资料问题', documentId: 'doc-a', createdAt: 1 }
  ])
  await chat.selectSession(a.id)
  expect(chat.selectedDocumentId).toBe('doc-a')
  expect(chat.currentSession?.documentId).toBe('doc-a')
})
it('当前会话读取期间禁止发送，读取完成后恢复', async () => {
  const chat = useChatStore()
  const a = await chat.createSession()
  let release!: (value: []) => void
  readPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const selecting = chat.selectSession(a.id)
  await chat.sendMessage('不应发送')
  expect(stream).not.toHaveBeenCalled()
  release([])
  await selecting
  await chat.sendMessage('可以发送')
  expect(stream).toHaveBeenCalledTimes(1)
})
it('连续三问检索始终保留主题，不借用助手编造的内容', async () => {
  const chat = useChatStore()
  await chat.createSession()
  chat.selectedDocumentId = 'doc-a'
  await chat.sendMessage('云镜展示屏的押金是多少？')
  await chat.sendMessage('什么时候退回？')
  await chat.sendMessage('谁负责？')
  expect(search.mock.calls[2]?.[0]).toBe('云镜展示屏的押金是多少？\n什么时候退回？\n谁负责？')
  expect(search.mock.calls[2]?.[0]).not.toContain('回答[1]')
})
