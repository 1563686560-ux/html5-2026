/**
 * 角色注册表
 * ------------------------------------------------------------------
 * 内置角色是代码常量，自定义角色是运行时的本地数据，但对话页、辩论页、
 * 卡片渲染都只认「一个 Persona」。所以这里做一层注册表把它们合起来：
 *
 *   all      = 内置 + 自定义 + 临时
 *   resolve  = 按 id 解析，找不到才退回默认助手
 *
 * 为什么必须放在 store 而不是 data/personas.ts：
 *   data 里的 getPersona() 是同步纯函数，读不到异步加载的 IndexedDB 数据。
 *   放进 store 后 custom 是 ref，角色广场和对话页才能跟着一起更新 ——
 *   否则用户新建完角色，对话页仍会把他解析成默认助手。
 *
 * 持久化键沿用需求文档 §2.4 的约定，落在 kv 存储里。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { kvGet, kvSet } from '@/db'
import { PERSONAS, buildCustomPersona, buildTempPersona, type CustomPersonaInput, type Persona } from '@/data/personas'
import { createId } from '@/utils/id'

const KEY = 'custom-personas'

/** 临时人设最多留几个：它只活在内存里，攒太多会把角色广场撑乱 */
const TEMP_LIMIT = 20

export const usePersonasStore = defineStore('personas', () => {
  const custom = ref<Persona[]>([])
  /** 由「想和谁聊」一句话生成的临时人设，刷新即消失 —— 这就是「临时」的定义 */
  const temp = ref<Persona[]>([])
  const ready = ref(false)
  const busy = ref(false)
  const errorText = ref<string | null>(null)
  /** 读取失败时的提示：自定义角色静默消失，用户会以为是自己没保存成功 */
  const storageWarning = ref<string | null>(null)

  /** 内置 + 自定义 + 临时。顺序即角色广场里的组内顺序 */
  const all = computed<Persona[]>(() => [...PERSONAS, ...custom.value, ...temp.value])

  const customCount = computed(() => custom.value.length)

  /** 按 id 精确查找，找不到返回 null。编辑页用它判断「这个角色还在不在」 */
  function find(id: string | undefined): Persona | null {
    if (!id) return null
    return all.value.find((p) => p.id === id) ?? null
  }

  function resolve(id: string | undefined): Persona {
    return find(id) ?? PERSONAS[0]
  }

  /** 用户自建、可以编辑和删除的角色（临时人设也能编辑后保存） */
  function isCustom(persona: Persona): boolean {
    return persona.origin === 'custom'
  }

  function isTemp(persona: Persona): boolean {
    return persona.origin === 'temp'
  }

  /**
   * 把角色摊平成普通对象再写库。
   * 放进 ref 之后就是响应式代理了，而结构化克隆算法无法克隆 Proxy，
   * 直接写会抛 DataCloneError —— 这是本项目里踩过的坑，必须逐字段展开。
   */
  function toStorable(persona: Persona): Persona {
    return {
      id: persona.id,
      name: persona.name,
      avatar: persona.avatar,
      tagline: persona.tagline,
      category: 'custom',
      origin: 'custom',
      era: persona.era,
      accent: persona.accent,
      identity: persona.identity,
      traits: [...persona.traits],
      speechStyle: [...persona.speechStyle],
      knowledgeScope: persona.knowledgeScope,
      taboos: [...persona.taboos],
      greeting: persona.greeting,
      suggestions: [...persona.suggestions]
    }
  }

  async function init(): Promise<void> {
    try {
      const saved = await kvGet<Persona[]>(KEY)
      // 存量数据可能来自旧版本或被手改过，交给 buildCustomPersona 逐字段兜底重建，
      // 而不是直接把库里的对象塞进内存 —— 那样缺字段会在渲染时炸掉
      custom.value = Array.isArray(saved) ? saved.map(restore).filter((p): p is Persona => p !== null) : []
      storageWarning.value = null
    } catch (error) {
      // 读不出来不能假装「用户没建过角色」
      storageWarning.value = `自定义角色读取失败，本次未加载：${(error as Error).message}`
      console.warn('[personas] 读取自定义角色失败', error)
      custom.value = []
    } finally {
      ready.value = true
    }
  }

  /** 从库里的一条记录重建角色；结构不可用就返回 null 并丢弃 */
  function restore(raw: Partial<Persona> | null | undefined): Persona | null {
    if (!raw || typeof raw !== 'object') return null
    const id = String(raw.id ?? '').trim()
    const name = String(raw.name ?? '').trim()
    if (!id || !name) return null

    const persona = buildCustomPersona(
      {
        name,
        avatar: String(raw.avatar ?? ''),
        tagline: String(raw.tagline ?? ''),
        identity: String(raw.identity ?? ''),
        speechStyle: Array.isArray(raw.speechStyle) ? raw.speechStyle.join('\n') : '',
        taboos: Array.isArray(raw.taboos) ? raw.taboos.join('\n') : ''
      },
      id,
      'custom'
    )

    // 主色是用户可改的，存过就沿用，没存过用按名字算出来的默认色
    const accent = String(raw.accent ?? '').trim()
    return accent ? { ...persona, accent } : persona
  }

  /**
   * 新建（不传 id）或更新（传 id）一个自定义角色。
   * 先落盘、成功后再改内存：反过来的话，写库失败时界面会显示一个
   * 刷新后就消失的角色，用户完全无从察觉。
   */
  async function saveCustom(input: CustomPersonaInput, id?: string): Promise<Persona | null> {
    if (!input.name.trim()) {
      errorText.value = '请先给角色起个名字'
      return null
    }
    if (!input.identity.trim()) {
      errorText.value = '写一句身份设定，角色才知道自己是谁'
      return null
    }

    busy.value = true
    errorText.value = null
    try {
      const existing = id ? custom.value.find((p) => p.id === id) : undefined
      const persona = buildCustomPersona(input, existing?.id ?? createId('persona'), 'custom')
      const next = existing ? custom.value.map((p) => (p.id === existing.id ? persona : p)) : [...custom.value, persona]

      await kvSet(KEY, next.map(toStorable))
      custom.value = next
      return persona
    } catch (error) {
      errorText.value = `保存失败：${(error as Error).message}`
      return null
    } finally {
      busy.value = false
    }
  }

  async function removeCustom(id: string): Promise<boolean> {
    const target = custom.value.find((p) => p.id === id)
    if (!target) return false

    busy.value = true
    errorText.value = null
    try {
      const next = custom.value.filter((p) => p.id !== id)
      await kvSet(KEY, next.map(toStorable))
      custom.value = next
      return true
    } catch (error) {
      errorText.value = `删除失败：${(error as Error).message}`
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * 由「想和谁聊」的一句话造临时人设。
   * 刻意不走模型生成：多一次网络调用就多一次等待和失败，
   * 而用户要的只是「立刻以这个身份开口」。
   */
  function addTemp(description: string): Persona {
    const persona = buildTempPersona(description, createId('temp'))
    temp.value = [...temp.value, persona].slice(-TEMP_LIMIT)
    return persona
  }

  /** 把临时人设转为正式的自定义角色 */
  async function promoteTemp(id: string): Promise<Persona | null> {
    const source = temp.value.find((p) => p.id === id)
    if (!source) return null
    return saveCustom(
      {
        name: source.name,
        avatar: source.avatar,
        tagline: source.tagline,
        identity: source.identity,
        speechStyle: source.speechStyle.join('\n'),
        taboos: source.taboos.join('\n')
      },
      undefined
    )
  }

  function removeTemp(id: string): void {
    temp.value = temp.value.filter((p) => p.id !== id)
  }

  function clearError(): void {
    errorText.value = null
  }

  return {
    custom,
    temp,
    all,
    customCount,
    ready,
    busy,
    errorText,
    storageWarning,
    init,
    resolve,
    find,
    isCustom,
    isTemp,
    saveCustom,
    removeCustom,
    addTemp,
    promoteTemp,
    removeTemp,
    clearError
  }
})
