/**
 * IndexedDB 封装
 * ------------------------------------------------------------------
 * 为什么不用 localStorage？
 *   会话与消息是结构化数据，且会持续增长；localStorage 只能存字符串、
 *   容量约 5MB 且同步阻塞主线程。IndexedDB 支持结构化存储、索引查询、
 *   大容量与异步读写，后续 P3 的文档分块与向量也要落在同一套表里。
 *
 * 表结构一次性规划好（含后续阶段要用的表），避免反复做数据迁移。
 */

import { toPlain } from './plain'

const DB_NAME = 'ai-brain-trust'
/**
 * 版本历史：
 *   1 → 会话、消息、文档、分块、kv
 *   2 → 新增 memories（统一记忆层）
 *
 * 升级是增量的：装过 v1 的浏览器只会补建缺少的表，已有会话数据不受影响。
 */
const DB_VERSION = 2

export const STORE = {
  sessions: 'sessions',
  messages: 'messages',
  memories: 'memories',
  documents: 'documents',
  chunks: 'chunks',
  kv: 'kv'
} as const

export type StoreName = (typeof STORE)[keyof typeof STORE]

let dbPromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持 IndexedDB'))
      return
    }

    /**
     * 打开失败时必须把缓存的 Promise 清掉。
     * 否则 dbPromise 会一直是一个「已 reject」的 Promise，
     * 之后所有读写都直接失败，数据层在刷新页面前彻底不可用。
     * 典型触发场景：另一个标签页占着库导致 onblocked。
     */
    const fail = (error: Error): void => {
      if (dbPromise === opening) dbPromise = null
      reject(error)
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(STORE.sessions)) {
        const store = db.createObjectStore(STORE.sessions, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
      }

      if (!db.objectStoreNames.contains(STORE.messages)) {
        const store = db.createObjectStore(STORE.messages, { keyPath: 'id' })
        // 复合索引：按会话取消息时天然按时间有序，省掉一次内存排序
        store.createIndex('sessionId_createdAt', ['sessionId', 'createdAt'])
      }

      if (!db.objectStoreNames.contains(STORE.memories)) {
        const store = db.createObjectStore(STORE.memories, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
      }

      if (!db.objectStoreNames.contains(STORE.documents)) {
        const store = db.createObjectStore(STORE.documents, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }

      if (!db.objectStoreNames.contains(STORE.chunks)) {
        const store = db.createObjectStore(STORE.chunks, { keyPath: 'id' })
        store.createIndex('documentId', 'documentId')
      }

      if (!db.objectStoreNames.contains(STORE.kv)) {
        db.createObjectStore(STORE.kv, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // 另一个标签页要升级数据库时，主动让路，避免卡死
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => fail(request.error ?? new Error('IndexedDB 打开失败'))
    request.onblocked = () => fail(new Error('数据库被其他标签页占用，请关闭其他页面后重试'))
  })

  dbPromise = opening
  return dbPromise
}

/** 把一次请求包成 Promise，并在事务层面兜住异常 */
function run<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  build: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction
        try {
          tx = db.transaction(storeName, mode)
        } catch (error) {
          reject(error as Error)
          return
        }

        let request: IDBRequest<T>
        try {
          request = build(tx.objectStore(storeName))
        } catch (error) {
          tx.abort()
          reject(error)
          return
        }
        tx.oncomplete = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB 读写失败'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被中断'))
      })
  )
}

export function dbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
}

export function dbGetAll<T>(store: StoreName): Promise<T[]> {
  return run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)
}

/** 按索引查询；query 省略时取该索引下全部记录 */
export function dbGetAllByIndex<T>(
  store: StoreName,
  indexName: string,
  query?: IDBValidKey | IDBKeyRange
): Promise<T[]> {
  return run<T[]>(store, 'readonly', (s) => {
    const index = s.index(indexName)
    return (query === undefined ? index.getAll() : index.getAll(query)) as IDBRequest<T[]>
  })
}

export interface PageOptions {
  /** 最多取多少条 */
  limit: number
  /**
   * 游标方向。
   * 'next' 按索引升序，'prev' 按索引降序 —— 取"最近 N 条消息"要用 'prev'，
   * 否则会退化成把整个会话全读出来再截断，长会话直接卡住。
   */
  direction?: IDBCursorDirection
}

/**
 * 按索引分页取数据（游标实现）。
 * 这是聊天记录「上滑加载历史」的基础：只读需要的那一页，不把整个会话读进内存。
 */
export function dbGetPageByIndex<T>(
  store: StoreName,
  indexName: string,
  query: IDBValidKey | IDBKeyRange | undefined,
  options: PageOptions
): Promise<T[]> {
  return openDatabase().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        let tx: IDBTransaction
        try {
          tx = db.transaction(store, 'readonly')
        } catch (error) {
          reject(error as Error)
          return
        }

        const index = tx.objectStore(store).index(indexName)
        const request = index.openCursor(query, options.direction ?? 'next')
        const rows: T[] = []

        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor || rows.length >= options.limit) {
            resolve(rows)
            return
          }
          rows.push(cursor.value as T)
          cursor.continue()
        }
        request.onerror = () => reject(request.error ?? new Error('分页查询失败'))
        tx.onabort = () => reject(tx.error ?? new Error('分页查询被中断'))
      })
  )
}

export interface ScanOptions {
  /** 索引上的查询范围；省略时扫整个索引 */
  query?: IDBValidKey | IDBKeyRange
  /** 游标方向，默认 'next'（按索引升序） */
  direction?: IDBCursorDirection
  /**
   * 扫描上限：累计看过这么多条就停下。
   * 这是「不能把整表读进内存」的最后一道保险 —— 即使调用方的 visit 忘了叫停，
   * 游标也不会无限往前走。
   */
  maxScan?: number
}

export interface ScanOutcome {
  /** 实际交给 visit 的记录条数 */
  scanned: number
  /** visit 主动返回 false 叫停的 */
  stoppedByVisit: boolean
  /** 因为到达 maxScan 叫停的（说明索引里还有没看的记录） */
  reachedScanLimit: boolean
  /** 游标一路走到了索引末尾：这次扫描看到了该范围内的全部记录 */
  exhausted: boolean
}

/**
 * 按索引游标扫描，边扫边交给 visit 判断，**支持提前退出**。
 * 这是「跨会话搜索历史消息」的底座：messages 表没有全文索引，
 * 只能逐条看正文，但绝不能先 dbGetAll 到内存里再 filter ——
 * 几十个会话累计上万条消息时，那一次 getAll 就会把主线程和内存一起拖垮。
 *
 * visit 返回 false 即停止扫描（例如命中数已经够了），
 * 于是「扫描上限」和「命中上限」都表现为游标提前刹车，而不是事后截断结果。
 */
export function dbScanByIndex<T>(
  store: StoreName,
  indexName: string,
  visit: (value: T) => boolean | void,
  options: ScanOptions = {}
): Promise<ScanOutcome> {
  const maxScan = options.maxScan ?? Number.POSITIVE_INFINITY

  return openDatabase().then(
    (db) =>
      new Promise<ScanOutcome>((resolve, reject) => {
        let tx: IDBTransaction
        try {
          tx = db.transaction(store, 'readonly')
        } catch (error) {
          reject(error as Error)
          return
        }

        const request = tx
          .objectStore(store)
          .index(indexName)
          .openCursor(options.query, options.direction ?? 'next')
        let scanned = 0

        request.onsuccess = () => {
          const cursor = request.result

          // 游标为空 = 这个范围已经走完了，看到的就是全部
          if (!cursor) {
            resolve({ scanned, stoppedByVisit: false, reachedScanLimit: false, exhausted: true })
            return
          }

          // 还有记录没看，但已经到上限：如实报告"没扫完"
          if (scanned >= maxScan) {
            resolve({ scanned, stoppedByVisit: false, reachedScanLimit: true, exhausted: false })
            return
          }

          scanned += 1
          let keepGoing: boolean | void
          try {
            keepGoing = visit(cursor.value as T)
          } catch (error) {
            // visit 里抛异常必须转成 reject：onsuccess 回调里逃出去的异常
            // 不会有人接，Promise 会永远挂住，界面就一直停在"搜索中"
            reject(error as Error)
            return
          }

          if (keepGoing === false) {
            resolve({ scanned, stoppedByVisit: true, reachedScanLimit: false, exhausted: false })
            return
          }

          cursor.continue()
        }
        request.onerror = () => reject(request.error ?? new Error('游标扫描失败'))
        tx.onabort = () => reject(tx.error ?? new Error('游标扫描被中断'))
      })
  )
}

export function dbPut<T>(store: StoreName, value: T): Promise<IDBValidKey> {
  // toPlain 兜住 Vue 响应式 Proxy，否则结构化克隆会抛 DataCloneError
  return run<IDBValidKey>(store, 'readwrite', (s) => s.put(toPlain(value) as unknown as never))
}

/** 同步安排跨表操作，仅在整个事务提交后报告成功。 */
export async function dbWriteTransaction(stores: StoreName[], build: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('数据保存已回滚，请重试'))
    // 请求错误由 IndexedDB 默认中止事务；等 onabort 确认回滚后再拒绝。
    try {
      build(tx)
    } catch (error) {
      tx.abort()
      reject(error)
    }
  })
}

/** 批量写入：共用同一个事务，比逐条 put 快一个数量级 */
export function dbPutMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (values.length === 0) return Promise.resolve()
  return openDatabase().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        const objectStore = tx.objectStore(store)
        for (const value of values) objectStore.put(toPlain(value) as unknown as never)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('批量写入失败'))
        tx.onabort = () => reject(tx.error ?? new Error('批量写入被中断'))
      })
  )
}

export function dbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  return run<undefined>(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>).then(() => undefined)
}

/** 按索引删除（例如删会话时连带删掉它的所有消息） */
export function dbDeleteByIndex(store: StoreName, indexName: string, query: IDBValidKey | IDBKeyRange): Promise<void> {
  return openDatabase().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        const index = tx.objectStore(store).index(indexName)
        const cursorRequest = index.openKeyCursor(query)
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (cursor) {
            tx.objectStore(store).delete(cursor.primaryKey)
            cursor.continue()
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('按索引删除失败'))
        tx.onabort = () => reject(tx.error ?? new Error('按索引删除被中断'))
      })
  )
}

export function dbClear(store: StoreName): Promise<void> {
  return run<undefined>(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>).then(() => undefined)
}

/** 清空全部业务数据（保留表结构） */
export async function dbClearAll(): Promise<void> {
  for (const name of Object.values(STORE)) {
    await dbClear(name)
  }
}

/** 简单的键值读写，用于存放偏好设置之类的零散数据 */
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await dbGet<{ key: string; value: T }>(STORE.kv, key)
  return row?.value
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await dbPut(STORE.kv, { key, value })
}
