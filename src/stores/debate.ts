/**
 * 多智能体辩论（P5）
 * ------------------------------------------------------------------
 * 两位先贤轮流用流式接口发言，逐轮回应对方。复用 assembler 的人物设定，
 * 只在 system 里追加一条「辩论立场」约束，避免重写整段人设。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { streamChat } from '@/api/llm'
import type { ChatMessage } from '@/api/types'
import { getPersona, type Persona } from '@/data/personas'
import { assembleSystemPrompt } from '@/prompt/assembler'
import { createFrameBatcher } from '@/utils/frameBatcher'
import { createId } from '@/utils/id'
import { useSettingsStore } from './settings'

export interface DebateTurn {
  id: string
  personaId: string
  personaName: string
  avatar: string
  round: number
  role: 'opening' | 'rebuttal'
  content: string
  side: 'positive' | 'negative'
  completed: boolean
}

export const useDebateStore = defineStore('debate', () => {
  const topic = ref('')
  const aId = ref('kongzi')
  const bId = ref('zhuangzi')
  const rounds = ref(2)
  const turns = ref<DebateTurn[]>([])
  const running = ref(false)
  const finished = ref(false)
  const currentSpeakerId = ref<string | null>(null)
  const errorText = ref<string | null>(null)
  let controller: AbortController | null = null
  let activeConfig: { topic: string; aId: string; bId: string; rounds: number } | null = null
  const canResume = computed(() => !running.value && !finished.value && activeConfig !== null)
  const completedCount = computed(() => turns.value.filter((turn) => turn.completed).length)

  const speakers = computed<Persona[]>(() => [getPersona(aId.value), getPersona(bId.value)])

  function buildSystem(persona: Persona, side: 'positive' | 'negative'): string {
    return assembleSystemPrompt(persona, {
      stanceHint: `你正在参加一场正式的辩论，辩题：「${activeConfig!.topic}」。你是${side === 'positive' ? '正方，必须支持题目中的主张或前一种选择' : '反方，必须反对题目中的主张或支持后一种选择'}。无论角色原本倾向如何，都必须守住分配立场，不得与对方同边。请完全以「${persona.name}」的身份和思想体系坚定地论证你的立场，并针对对方的最新观点作出回应。每次发言只用120～180个汉字，最多220字。只保留一个核心论点、一个简短理由；回应时针对对方一个关键论点即可，不重复开场，不写长篇引文或多段论述。保持角色特点，直接给出本轮发言。`
    })
  }

  function buildUser(round: number): string {
    const prior = turns.value
      .filter((turn) => turn.completed && turn.content.trim())
      .map((turn) => `${turn.personaName}：${turn.content}`)
      .join('\n\n')
    const instruction =
      round === 0 ? '请发表你的开场陈词' : '轮到你发言，请直接回应并反驳对方最新观点，不要重复自己的开场'
    return `辩题：「${activeConfig!.topic}」\n\n${prior ? `已有发言：\n${prior}\n\n` : ''}${instruction}。`
  }

  function stop(): void {
    controller?.abort()
  }

  async function run(resume = false): Promise<void> {
    if (running.value || (!resume && !topic.value.trim())) return
    const settings = useSettingsStore()
    if (!settings.chatConfigured) {
      errorText.value = '请先在「我的」里配置 APIkey'
      return
    }
    if (resume) {
      if (!canResume.value || !activeConfig) return
    } else {
      if (aId.value === bId.value) {
        errorText.value = '请选择两位不同的辩手'
        return
      }
      activeConfig = { topic: topic.value.trim(), aId: aId.value, bId: bId.value, rounds: rounds.value }
      turns.value = []
    }
    running.value = true
    finished.value = false
    errorText.value = null
    const requestController = new AbortController()
    controller = requestController
    const config = activeConfig!
    try {
      for (let index = completedCount.value; index < config.rounds * 2; index++) {
        requestController.signal.throwIfAborted()
        const round = Math.floor(index / 2)
        const side = index % 2 === 0 ? 'positive' : 'negative'
        const persona = getPersona(side === 'positive' ? config.aId : config.bId)
        currentSpeakerId.value = persona.id
        // Replace only the interrupted turn; completed speeches remain intact.
        if (turns.value[index]) turns.value.splice(index)
        turns.value.push({
          id: createId('turn'),
          personaId: persona.id,
          personaName: persona.name,
          avatar: persona.avatar,
          round,
          role: round === 0 ? 'opening' : 'rebuttal',
          content: '',
          side,
          completed: false
        })
        const turn = turns.value[index]!
        const batcher = createFrameBatcher((value) => {
          turn.content = value
        })
        let truncated = false
        const messages: ChatMessage[] = [
          { role: 'system', content: buildSystem(persona, side) },
          { role: 'user', content: buildUser(round) }
        ]
        try {
          await streamChat({ ...settings.api.chat }, messages, {
            signal: requestController.signal,
            onDelta: (_chunk, full) => batcher.push(full),
            onFinish: (info) => {
              truncated = info.truncated
            }
          })
          batcher.flush()
          requestController.signal.throwIfAborted()
          if (truncated || !turn.content.trim()) throw new Error('本轮发言未完整生成，可继续当前轮')
          turn.completed = true
        } finally {
          batcher.flush()
        }
      }
      finished.value = true
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) errorText.value = (error as Error).message
    } finally {
      running.value = false
      currentSpeakerId.value = null
      controller = null
    }
  }

  function reset(): void {
    if (running.value) return
    activeConfig = null
    turns.value = []
    finished.value = false
    errorText.value = null
  }

  return {
    topic,
    aId,
    bId,
    rounds,
    turns,
    running,
    finished,
    currentSpeakerId,
    errorText,
    speakers,
    canResume,
    completedCount,
    run,
    stop,
    reset
  }
})
