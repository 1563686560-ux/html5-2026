/** P3 文档与分块状态：关键词检索、分步进度 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { STORE, dbGetAllByIndex, dbWriteTransaction, kvGet } from '@/db'
import { chunkText } from '@/rag/chunker'
import { keywordSearch, mergeSearchHits } from '@/rag/search'
import { expandQuery } from '@/rag/expandQuery'
import { useSettingsStore } from './settings'
import type { RagChunk, RagDocument, SearchHit } from '@/rag/types'
import { createGuessReference, GUESS_REFERENCE_ID, GUESS_REFERENCE_SEED_KEY } from '@/rag/guessSeed'

export const useRagStore = defineStore('rag', () => {
  const documents = ref<RagDocument[]>([])
  const chunks = ref<RagChunk[]>([])
  const ready = ref(false)
  const importing = ref(false)
  const progress = ref(0)
  const progressText = ref('')
  const errorText = ref<string | null>(null)

  let initializing: Promise<void> | null = null
  async function init(): Promise<void> {
    if (ready.value) return
    if (!initializing) initializing = load()
    return initializing
  }

  async function load(): Promise<void> {
    try {
      documents.value = (await dbGetAllByIndex<RagDocument>(STORE.documents, 'createdAt')).sort(
        (a, b) => b.updatedAt - a.updatedAt
      )
      chunks.value = await dbGetAllByIndex<RagChunk>(STORE.chunks, 'documentId')
      chunks.value = chunks.value.map((chunk) => {
        if (Array.isArray(chunk.vector)) chunk.vector = new Float32Array(chunk.vector)
        return chunk
      })
      // 只导入一次；用户删除这份资料后不会在下次启动时自动补回。
      if (!(await kvGet<boolean>(GUESS_REFERENCE_SEED_KEY))) {
        const reference = createGuessReference()
        const exists = documents.value.some((doc) => doc.id === GUESS_REFERENCE_ID)
        await dbWriteTransaction([STORE.documents, STORE.chunks, STORE.kv], (tx) => {
          if (!exists) {
            tx.objectStore(STORE.documents).put(reference.document)
            for (const chunk of reference.chunks) tx.objectStore(STORE.chunks).put(chunk)
          }
          tx.objectStore(STORE.kv).put({ key: GUESS_REFERENCE_SEED_KEY, value: true })
        })
        if (!exists) {
          documents.value.unshift(reference.document)
          chunks.value.push(...reference.chunks)
        }
      }
    } catch (error) {
      errorText.value = (error as Error).message
    } finally {
      ready.value = true
    }
  }

  async function importText(title: string, source: 'text' | 'txt', text: string): Promise<RagDocument | null> {
    if (importing.value) return null
    const content = text.trim()
    if (!content) {
      errorText.value = '文本内容为空'
      return null
    }
    importing.value = true
    errorText.value = null
    progress.value = 5
    progressText.value = '正在分析文本…'
    try {
      const now = Date.now()
      const doc: RagDocument = {
        id: `doc-${now}-${Math.random().toString(36).slice(2, 8)}`,
        title: title.trim() || '未命名资料',
        source,
        charCount: content.length,
        chunkCount: 0,
        createdAt: now,
        updatedAt: now
      }
      const rawChunks = chunkText(content)
      doc.chunkCount = rawChunks.length
      progress.value = 38
      progressText.value = `已分成 ${rawChunks.length} 个中文片段`
      const stored: RagChunk[] = rawChunks.map((item) => ({
        id: `${doc.id}-${item.index}`,
        documentId: doc.id,
        documentTitle: doc.title,
        index: item.index,
        content: item.content,
        start: item.start,
        end: item.end,
        createdAt: now
      }))
      await dbWriteTransaction([STORE.documents, STORE.chunks], (tx) => {
        tx.objectStore(STORE.documents).put(doc)
        for (const chunk of stored) tx.objectStore(STORE.chunks).put(chunk)
      })
      progress.value = 100
      progressText.value = '导入完成'
      documents.value.unshift(doc)
      chunks.value.push(...stored)
      return doc
    } catch (error) {
      errorText.value = (error as Error).message
      return null
    } finally {
      importing.value = false
    }
  }

  async function deleteDocument(id: string): Promise<void> {
    if (importing.value) throw new Error('资料正在处理中，请完成后再删除')
    importing.value = true
    try {
      await dbWriteTransaction([STORE.documents, STORE.chunks], (tx) => {
        tx.objectStore(STORE.documents).delete(id)
        const store = tx.objectStore(STORE.chunks)
        const request = store.index('documentId').openKeyCursor(id)
        request.onsuccess = () => {
          const cursor = request.result
          if (cursor) {
            store.delete(cursor.primaryKey)
            cursor.continue()
          }
        }
      })
      documents.value = documents.value.filter((doc) => doc.id !== id)
      chunks.value = chunks.value.filter((chunk) => chunk.documentId !== id)
    } finally {
      importing.value = false
    }
  }

  function searchKeyword(query: string, topK = 5): SearchHit[] {
    return keywordSearch(chunks.value, query, topK)
  }

  async function search(query: string, topK = 5, documentId?: string, signal?: AbortSignal): Promise<SearchHit[]> {
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError')
    if (!query.trim() || topK <= 0) return []
    const scope = chunks.value.filter((chunk) => !documentId || chunk.documentId === documentId)
    const original = keywordSearch(scope, query, topK)
    if (!scope.length) return []
    const settings = useSettingsStore()
    // Direct strong matches return immediately; only weak searches need another model request.
    if (!settings.chatConfigured || (original[0]?.score ?? 0) >= 0.55) return original
    try {
      const phrases = await expandQuery({ ...settings.api.chat }, query, signal)
      if (signal?.aborted) throw new DOMException('已停止', 'AbortError')
      let hits = original
      for (const phrase of phrases) hits = mergeSearchHits(hits, keywordSearch(scope, phrase, topK), topK)
      return hits.filter((hit) => chunks.value.some((chunk) => chunk.id === hit.chunk.id))
    } catch (error) {
      if (signal?.aborted) throw new DOMException('已停止', 'AbortError')
      // An optional query rewrite must not prevent existing keyword results from being used.
      console.warn('检索词提取未完成，使用原问题检索', error)
      return original.filter((hit) => chunks.value.some((chunk) => chunk.id === hit.chunk.id))
    }
  }

  function clearError(): void {
    errorText.value = null
  }

  return {
    documents,
    chunks,
    ready,
    importing,
    progress,
    progressText,
    errorText,
    init,
    importText,
    deleteDocument,
    searchKeyword,
    search,
    clearError
  }
})
