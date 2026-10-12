import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
const { embed, complete, config, endpoint, transaction, readAll, readKv } = vi.hoisted(() => ({
  transaction: vi.fn(),
  embed: vi.fn(),
  complete: vi.fn(),
  config: { chatConfigured: false },
  readAll: vi.fn(),
  readKv: vi.fn(),
  endpoint: { baseUrl: 'https://example.invalid', model: 'current', apiKey: 'test' }
}))
vi.mock('@/api/llm', () => ({ embedTexts: embed, completeChat: complete }))
vi.mock('./settings', () => ({
  useSettingsStore: () => ({ ...config, embedConfigured: true, api: { embed: endpoint, chat: endpoint } })
}))
vi.mock('@/db', () => ({
  STORE: { documents: 'documents', chunks: 'chunks', kv: 'kv' },
  dbWriteTransaction: transaction,
  dbDelete: vi.fn(),
  dbDeleteByIndex: vi.fn(),
  dbGetAllByIndex: readAll,
  kvGet: readKv,
  dbPut: vi.fn(),
  dbPutMany: vi.fn()
}))
import { useRagStore } from './rag'
import type { RagChunk } from '@/rag/types'
import { createGuessReference, GUESS_REFERENCE_SEED_KEY } from '@/rag/guessSeed'
function chunk(id: string, model?: string): RagChunk {
  return {
    id,
    documentId: id,
    documentTitle: id,
    index: 0,
    start: 0,
    end: 10,
    createdAt: 0,
    content: id === 'keyword' ? 'Vue 用于构建用户界面。' : '无关段落',
    vector: model ? new Float32Array([1, 0]) : undefined,
    vectorModel: model
  }
}
beforeEach(() => {
  setActivePinia(createPinia())
  embed.mockReset()
  complete.mockReset()
  config.chatConfigured = false
  transaction.mockReset()
  readAll.mockReset().mockResolvedValue([])
  readKv.mockReset().mockResolvedValue(undefined)
})

it('首次初始化把奶龙资料和导入标记一起写入，并发初始化不重复导入', async () => {
  const written: Array<{ store: string; value: unknown }> = []
  transaction.mockImplementation(async (_stores, write) =>
    write({
      objectStore: (store: string) => ({ put: (value: unknown) => written.push({ store, value }) })
    })
  )
  const store = useRagStore()
  await Promise.all([store.init(), store.init()])
  expect(transaction).toHaveBeenCalledTimes(1)
  expect(transaction.mock.calls[0]?.[0]).toEqual(['documents', 'chunks', 'kv'])
  expect(written.find((row) => row.store === 'kv')?.value).toEqual({ key: GUESS_REFERENCE_SEED_KEY, value: true })
  expect(store.searchKeyword('黄色恐龙')[0]?.chunk.documentTitle).toContain('奶龙')
  expect(store.documents).toHaveLength(1)
})

it('用户已删除的种子资料不会因重新初始化被补回', async () => {
  readKv.mockResolvedValue(true)
  const store = useRagStore()
  await store.init()
  expect(store.documents).toHaveLength(0)
  expect(transaction).not.toHaveBeenCalled()
})

it('种子导入失败不展示半份资料，已有用户资料仍可使用', async () => {
  readAll.mockImplementation(async (name: string) => (name === 'chunks' ? [chunk('keyword')] : []))
  transaction.mockRejectedValue(new Error('存储已满'))
  const store = useRagStore()
  await store.init()
  expect(store.ready).toBe(true)
  expect(store.errorText).toBe('存储已满')
  expect(store.documents).toHaveLength(0)
  expect(store.chunks).toHaveLength(1)
  expect(store.searchKeyword('Vue')).toHaveLength(1)
})

it('已有同编号资料不会被初始化覆盖修改内容', async () => {
  const original = createGuessReference()
  original.chunks[0]!.content = '用户已编辑的奶龙资料'
  readAll.mockImplementation(async (name: string) => (name === 'documents' ? [original.document] : original.chunks))
  const written: string[] = []
  transaction.mockImplementation(async (_stores, write) =>
    write({
      objectStore: (store: string) => ({ put: () => written.push(store) })
    })
  )
  const store = useRagStore()
  await store.init()
  expect(written).toEqual(['kv'])
  expect(store.chunks[0]?.content).toBe('用户已编辑的奶龙资料')
})

it('限定资料在关键词和向量检索之前生效', async () => {
  const store = useRagStore()
  store.chunks = [chunk('vector', 'current'), chunk('keyword')]
  expect((await store.search('Vue', 4, 'keyword')).map((h) => h.chunk.id)).toEqual(['keyword'])
  expect(embed).not.toHaveBeenCalled()
  expect(await store.search('Vue', 4, 'deleted')).toEqual([])
})

it('导入事务失败后不会在内存显示半份资料', async () => {
  transaction.mockRejectedValue(new Error('存储已满'))
  const store = useRagStore()
  expect(await store.importText('标题', 'text', '正文')).toBeNull()
  expect(transaction.mock.calls[0][0]).toEqual(['documents', 'chunks'])
  expect(store.documents).toHaveLength(0)
  expect(store.chunks).toHaveLength(0)
  expect(store.importing).toBe(false)
})

it('删除事务失败时保留内存资料，并恢复操作入口', async () => {
  transaction.mockRejectedValue(new Error('事务中断'))
  const store = useRagStore()
  store.chunks = [chunk('keyword')]
  await expect(store.deleteDocument('keyword')).rejects.toThrow('事务中断')
  expect(store.chunks).toHaveLength(1)
  expect(store.importing).toBe(false)
})
it('相同维度的旧模型向量不会混入当前模型检索', async () => {
  const store = useRagStore()
  store.chunks = [chunk('old', 'old-model'), chunk('keyword')]
  expect((await store.search('Vue')).map((h) => h.chunk.id)).toEqual(['keyword'])
  expect(embed).not.toHaveBeenCalled()
})
it('即使保留旧向量和接口配置也只返回关键词命中且不调用接口', async () => {
  const store = useRagStore()
  store.chunks = [chunk('vector', 'current'), chunk('keyword')]
  embed.mockResolvedValue([[1, 0]])
  expect((await store.search('Vue')).map((h) => h.chunk.id)).toEqual(['keyword'])
  expect(embed).not.toHaveBeenCalled()
})
it('向量接口出错时仍用关键词查资料', async () => {
  const store = useRagStore()
  store.chunks = [chunk('vector', 'current'), chunk('keyword')]
  embed.mockRejectedValue(new Error('offline'))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect((await store.search('Vue')).map((h) => h.chunk.id)).toEqual(['keyword'])
  } finally {
    warn.mockRestore()
  }
})

it('已停止的资料检索不继续返回结果', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(useRagStore().search('Vue', 5, undefined, controller.signal)).rejects.toMatchObject({
    name: 'AbortError'
  })
})

it('弱匹配使用现有对话 API 提取同义词，只返回所选资料原文', async () => {
  config.chatConfigured = true
  complete.mockResolvedValue('["截止日期","交付期限"]')
  const store = useRagStore()
  store.chunks = [
    { ...chunk('selected'), content: '交付期限为星期五。' },
    { ...chunk('other'), content: '截止日期为星期一。' }
  ]
  const hits = await store.search('什么时候交完？', 4, 'selected')
  expect(hits.map((hit) => hit.chunk.id)).toEqual(['selected'])
  expect(hits[0]?.chunk.content).toBe('交付期限为星期五。')
  expect(complete.mock.calls[0]?.[0]).toEqual(endpoint)
  expect(embed).not.toHaveBeenCalled()
})
it('强匹配和空资料范围不产生额外模型调用', async () => {
  config.chatConfigured = true
  const store = useRagStore()
  store.chunks = [chunk('keyword')]
  expect(await store.search('Vue')).toHaveLength(1)
  expect(await store.search('Vue', 4, 'deleted')).toEqual([])
  expect(complete).not.toHaveBeenCalled()
})
it('检索词响应格式错误仍保留原问题命中', async () => {
  config.chatConfigured = true
  complete.mockResolvedValue('格式错误')
  const store = useRagStore()
  store.chunks = [chunk('keyword')]
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect((await store.search('Vue 数据库')).map((hit) => hit.chunk.id)).toEqual(['keyword'])
  } finally {
    warn.mockRestore()
  }
})
it('扩展期间停止检索不会继续返回引用', async () => {
  config.chatConfigured = true
  const controller = new AbortController()
  complete.mockImplementation(async () => {
    controller.abort()
    return '["交付期限"]'
  })
  const store = useRagStore()
  store.chunks = [{ ...chunk('selected'), content: '交付期限为星期五。' }]
  await expect(store.search('什么时候交完？', 4, undefined, controller.signal)).rejects.toMatchObject({
    name: 'AbortError'
  })
})
it('检索期间被删除的资料不会重新作为引用返回', async () => {
  config.chatConfigured = true
  const store = useRagStore()
  store.chunks = [{ ...chunk('selected'), content: '交付期限为星期五。' }]
  complete.mockImplementation(async () => {
    store.chunks = []
    return '["交付期限"]'
  })
  expect(await store.search('什么时候交完？')).toEqual([])
})

