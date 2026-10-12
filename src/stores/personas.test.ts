import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isReactive } from 'vue'

/**
 * 角色注册表的持久化行为。
 *
 * 为什么要把 @/db mock 掉：真正的实现走 IndexedDB，而测试环境里没有它。
 * 这里替换成内存 Map，就能在 node 下验证「存进去的是什么、读出来变成什么」
 * 这条最容易出错、又最不容易在浏览器里手动复现的路径。
 */
const { kvStore, kvGetMock, kvSetMock, rest } = vi.hoisted(() => {
  const kvStore = new Map<string, unknown>()
  const kvGetMock = vi.fn(async (key: string) => kvStore.get(key))
  const kvSetMock = vi.fn(async (key: string, value: unknown) => {
    kvStore.set(key, value)
  })
  // 对话 store 会连带用到这些接口（它要把会话写库）。本文件虽然只关心角色解析，
  // 但 import 这些模块时名字必须存在，否则整个测试文件都加载不起来。
  const rest = {
    STORE: {
      sessions: 'sessions',
      messages: 'messages',
      memories: 'memories',
      documents: 'documents',
      chunks: 'chunks',
      kv: 'kv'
    },
    dbGet: vi.fn(async () => undefined),
    dbGetAll: vi.fn(async () => []),
    dbGetAllByIndex: vi.fn(async () => []),
    dbGetPageByIndex: vi.fn(async () => []),
    dbPut: vi.fn(async () => 1),
    dbPutMany: vi.fn(async () => undefined),
    dbDelete: vi.fn(async () => undefined),
    dbDeleteByIndex: vi.fn(async () => undefined),
    dbClear: vi.fn(async () => undefined),
    dbClearAll: vi.fn(async () => undefined)
  }
  return { kvStore, kvGetMock, kvSetMock, rest }
})

vi.mock('@/db', () => ({ kvGet: kvGetMock, kvSet: kvSetMock, ...rest }))

import { usePersonasStore } from './personas'
import { useChatStore } from './chat'
import { PERSONAS } from '@/data/personas'

const KEY = 'custom-personas'

function sampleInput(name = '健身教练') {
  return {
    name,
    avatar: '🏋️',
    tagline: '帮我把训练计划排明白',
    identity: '你是一位有十年经验的健身教练。',
    speechStyle: '先问清我的目标\n说人话',
    taboos: '不要编造医学结论'
  }
}

/** 取出最后一次写库的负载 */
function lastPersisted(): Record<string, unknown>[] {
  const calls = kvSetMock.mock.calls
  const payload = calls[calls.length - 1]?.[1]
  return payload as Record<string, unknown>[]
}

beforeEach(() => {
  setActivePinia(createPinia())
  kvStore.clear()
  kvGetMock.mockClear()
  kvSetMock.mockClear()
  kvGetMock.mockImplementation(async (key: string) => kvStore.get(key))
})

describe('自定义角色持久化', () => {
  it('保存后进入注册表，并能被 resolve 解析到', async () => {
    const personas = usePersonasStore()
    const saved = await personas.saveCustom(sampleInput(), undefined)

    expect(saved).toBeTruthy()
    expect(saved?.origin).toBe('custom')
    expect(saved?.category).toBe('custom')
    expect(personas.resolve(saved!.id).name).toBe('健身教练')
    expect(personas.customCount).toBe(1)
  })

  it('缺名称或缺身份时拒绝保存并给出提示', async () => {
    const personas = usePersonasStore()

    expect(await personas.saveCustom(sampleInput('   '), undefined)).toBeNull()
    expect(personas.errorText).toContain('名字')
    expect(personas.customCount).toBe(0)

    expect(await personas.saveCustom({ ...sampleInput(), identity: '  ' }, undefined)).toBeNull()
    expect(personas.errorText).toContain('身份')
    expect(personas.customCount).toBe(0)
  })

  it('写库的必须是普通对象：响应式代理会抛 DataCloneError', async () => {
    const personas = usePersonasStore()
    await personas.saveCustom(sampleInput('第一个'), undefined)
    // 第二次保存时，第一个角色已经躺在 ref 里、是被代理过的对象了。
    // toStorable 必须把它展开成普通对象，否则真实环境里这一步直接抛错。
    await personas.saveCustom(sampleInput('第二个'), undefined)

    const persisted = lastPersisted()
    expect(persisted).toHaveLength(2)
    for (const row of persisted) {
      expect(isReactive(row)).toBe(false)
      expect(isReactive(row.speechStyle)).toBe(false)
      expect(isReactive(row.taboos)).toBe(false)
      expect(Array.isArray(row.speechStyle)).toBe(true)
    }
  })

  it('更新已有角色是就地替换，不会多出一条', async () => {
    const personas = usePersonasStore()
    const first = await personas.saveCustom(sampleInput(), undefined)
    const updated = await personas.saveCustom({ ...sampleInput('健身教练（改）') }, first!.id)

    expect(updated?.id).toBe(first?.id)
    expect(personas.customCount).toBe(1)
    expect(personas.resolve(first!.id).name).toBe('健身教练（改）')
  })

  it('删除会同时清掉内存与库里的记录', async () => {
    const personas = usePersonasStore()
    const saved = await personas.saveCustom(sampleInput(), undefined)

    expect(await personas.removeCustom(saved!.id)).toBe(true)
    expect(personas.customCount).toBe(0)
    expect(lastPersisted()).toHaveLength(0)
    // 删掉之后解析要退回默认助手，而不是报错
    expect(personas.resolve(saved!.id).id).toBe('assistant')
    expect(personas.find(saved!.id)).toBeNull()
  })
})

describe('init 从本地恢复', () => {
  it('恢复已保存的角色', async () => {
    kvStore.set(KEY, [
      {
        id: 'persona_x',
        name: '营养师',
        avatar: '🥗',
        tagline: '帮我看一日三餐',
        identity: '你是一位注册营养师。',
        speechStyle: ['先了解我的作息'],
        taboos: ['不要编造膳食指南'],
        suggestions: []
      }
    ])

    const personas = usePersonasStore()
    await personas.init()

    expect(personas.ready).toBe(true)
    expect(personas.customCount).toBe(1)
    const restored = personas.resolve('persona_x')
    expect(restored.name).toBe('营养师')
    expect(restored.traits).toEqual([])
    // 恢复出来的角色必须仍是可编辑的自建角色，而不是被当成内置角色
    expect(personas.isCustom(restored)).toBe(true)
  })

  it('丢弃结构残缺的记录，而不是让它在渲染时炸掉', async () => {
    kvStore.set(KEY, [
      { id: 'ok', name: '正常的', identity: '你是正常的。' },
      { id: '', name: '缺 id' },
      { name: '缺 id 字段' },
      null,
      'not-an-object'
    ])

    const personas = usePersonasStore()
    await personas.init()

    expect(personas.customCount).toBe(1)
    expect(personas.resolve('ok').name).toBe('正常的')
  })

  it('读库失败时给出警告，不假装「用户没建过角色」', async () => {
    kvGetMock.mockRejectedValueOnce(new Error('数据库打不开'))

    const personas = usePersonasStore()
    await personas.init()

    expect(personas.storageWarning).toContain('数据库打不开')
    expect(personas.ready).toBe(true)
  })
})

describe('临时人设', () => {
  it('「想和谁聊」生成的临时人设可立即使用', () => {
    const personas = usePersonasStore()
    const temp = personas.addTemp('一个毒舌的健身教练')

    expect(personas.isTemp(temp)).toBe(true)
    expect(personas.resolve(temp.id).name).toBe('一个毒舌的健身教练')
    // 临时人设不落盘
    expect(kvSetMock).not.toHaveBeenCalled()
  })

  it('临时人设能转正成正式的自定义角色', async () => {
    const personas = usePersonasStore()
    const temp = personas.addTemp('一个毒舌的健身教练')

    const promoted = await personas.promoteTemp(temp.id)

    expect(promoted?.origin).toBe('custom')
    expect(personas.isTemp(promoted!)).toBe(false)
    expect(personas.customCount).toBe(1)
    expect(kvStore.get(KEY)).toHaveLength(1)
  })
})

describe('对话页解析角色（store 间联动）', () => {
  it('会话绑定的自定义角色能被解析出来，而不是退回默认助手', async () => {
    const personas = usePersonasStore()
    const chat = useChatStore()

    const custom = await personas.saveCustom(sampleInput('健身教练'), undefined)
    await chat.createSession(custom!.id)

    expect(chat.currentPersona.id).toBe(custom!.id)
    expect(chat.currentPersona.name).toBe('健身教练')
  })

  it('临时人设同样能被解析', async () => {
    const personas = usePersonasStore()
    const chat = useChatStore()

    const temp = personas.addTemp('一个毒舌的健身教练')
    await chat.createSession(temp.id)

    expect(chat.currentPersona.id).toBe(temp.id)
  })

  it('角色被删除后，绑在旧会话上的 id 安全退回默认助手', async () => {
    const personas = usePersonasStore()
    const chat = useChatStore()

    const custom = await personas.saveCustom(sampleInput(), undefined)
    await chat.createSession(custom!.id)
    await personas.removeCustom(custom!.id)

    expect(chat.currentPersona.id).toBe('assistant')
  })
})

describe('内置角色不受影响', () => {
  it('没有自定义角色时，注册表就是内置角色本身', () => {
    const personas = usePersonasStore()
    expect(personas.all.length).toBe(PERSONAS.length)
    expect(personas.resolve('kongzi').name).toBe('孔子')
    expect(personas.resolve('不存在的 id').id).toBe('assistant')
  })

  it('内置角色不可编辑也不可删除', () => {
    const personas = usePersonasStore()
    const sage = personas.resolve('kongzi')
    expect(personas.isCustom(sage)).toBe(false)
    expect(personas.isTemp(sage)).toBe(false)
  })
})
