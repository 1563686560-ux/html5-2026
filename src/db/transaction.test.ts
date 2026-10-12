import { beforeEach, expect, it, vi } from 'vitest'

// 只模拟 IDB 的事件时序：验证 helper 不提前报告成功，以及同步异常会主动回滚。
beforeEach(() => {
  vi.resetModules()
})
async function setup() {
  const tx = {
    oncomplete: null as null | (() => void),
    onabort: null as null | (() => void),
    error: null as Error | null,
    abort: vi.fn(),
    objectStore: vi.fn()
  }
  const transaction = vi.fn(() => tx)
  const request = { result: { transaction }, onsuccess: null as null | (() => void) }
  vi.stubGlobal('window', { indexedDB: {} })
  vi.stubGlobal('indexedDB', {
    open: () => {
      queueMicrotask(() => request.onsuccess?.())
      return request
    }
  })
  return { tx, transaction, ...(await import('./index')) }
}
it('跨表操作等待事务提交才完成', async () => {
  const { tx, transaction, dbWriteTransaction } = await setup()
  let completed = false
  const writing = dbWriteTransaction(['documents', 'chunks'], () => {}).then(() => {
    completed = true
  })
  await vi.waitFor(() => expect(transaction).toHaveBeenCalledWith(['documents', 'chunks'], 'readwrite'))
  expect(completed).toBe(false)
  tx.oncomplete?.()
  await writing
  expect(completed).toBe(true)
})
it('安排第二项操作时抛异常也会回滚整个事务', async () => {
  const { tx, dbWriteTransaction } = await setup()
  await expect(
    dbWriteTransaction(['documents', 'chunks'], () => {
      throw new Error('无法克隆片段')
    })
  ).rejects.toThrow('无法克隆片段')
  expect(tx.abort).toHaveBeenCalledTimes(1)
})
it('事务中止不会报告成功', async () => {
  const { tx, transaction, dbWriteTransaction } = await setup()
  const writing = dbWriteTransaction(['documents', 'chunks'], () => {})
  const assertion = expect(writing).rejects.toThrow('容量不足')
  await vi.waitFor(() => expect(transaction).toHaveBeenCalled())
  tx.error = new Error('容量不足')
  tx.onabort?.()
  await assertion
})
