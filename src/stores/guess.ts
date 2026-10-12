/**
 * 猜心对局状态机
 * ------------------------------------------------------------------
 * 玩法：用户心里想好一个东西不说，App 每轮只问一个「是 / 否 / 不确定」问题，
 * 直到猜出来（需求文档 §2.2-D，FR-G1~G5）。
 *
 * 四个必须守住的点：
 *   1. 走的是「问人」同一套流式通道（streamChat），只是每轮要求结构化 JSON；
 *   2. 模型违规最多修正两次，始终保留真实线索，不使用脱离上下文的固定题；
 *   3. **宣布猜中之前必须由用户点头**。模型自报的 confidence 只是它自己的
 *      感觉，直接据此结算会得到一个用户根本没确认过的「答案」——
 *      所以它只能提出候选，由用户点「猜对了 / 不是」；
 *   4. **请求失败不能把对局丢掉**。早先的实现里，一轮请求失败会直接把
 *      阶段打回 idle，用户看到的是「玩了八轮，屏幕突然跳回开始屏」。
 *      现在只把这一轮标成失败，进度原地保留，给一个「重试这一轮」。
 *   5. 对局内容不写入记忆层 —— 猜心的问答是游戏过程，不是关于用户的事实。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { kvGet, kvSet } from '@/db'
import { streamChat } from '@/api/llm'
import type { ChatMessage } from '@/api/types'
import {
  GUESS_CONFIDENCE_THRESHOLD,
  GUESS_ROUND_TIMEOUT_MS,
  MAX_ROUNDS,
  buildGuessMessages,
  extractGuessCandidate,
  parseJsonLoose,
  turnToMessages,
  validateReply,
  type GuessAnswer,
  type GuessReply,
  type ViolationHint
} from '@/prompt/guess'
import {
  buildCandidateReviewMessages,
  buildReplanningMessages,
  buildEvidence,
  normalizeGuessName,
  parseCandidateReview,
  parseNames,
  recoveryReason,
  hasUniformCandidateAnswers,
  validateExplorationPlan,
  validateQuestionPlan
} from '@/prompt/guessReasoning'
import { createId } from '@/utils/id'
import { useSettingsStore } from './settings'
import { useRagStore } from './rag'
import { buildGuessReferenceQueries, withGuessReferences } from '@/rag/guessReferences'
import type { SearchHit } from '@/rag/types'

/**
 * 对局阶段：
 * 开局 → 请求中 → 等用户回答 → 等用户确认候选答案 → 请求失败待重试 → 已结算
 */
export type GuessPhase = 'idle' | 'asking' | 'waiting' | 'confirming' | 'error' | 'guessed' | 'finished'

/** 结算口径：猜中 / 到最大轮数仍未猜中 / 用户主动放弃 */
export type GuessResult = 'guessed' | 'failed' | 'gaveup'

export interface GuessTurn {
  action?: 'ask' | 'guess'
  questionKey?: string
  candidates?: string[]
  aliases?: string[]
  /** 用于撤回时恢复本轮开始前的排除项。 */
  rejectedBefore?: string[]
  /** 未回答时为空串 */
  answer: GuessAnswer | ''
  question: string
  /** 模型本轮给出的猜测（它自己有把握时才填） */
  guess: string
  /** 模型自报的置信度，用于界面提示与提出候选 */
  confidence: number
}

export interface GuessRecord {
  id: string
  startedAt: number
  /** 对局用时（毫秒） */
  durationMs: number
  /** 实际进行的轮数 */
  rounds: number
  result: GuessResult
  /** 最终猜的答案，没有则为空串 */
  answer: string
  turns: GuessTurn[]
}

const HISTORY_KEY = 'guess-history'
/** 最多留 20 局，避免这套「纯记录」的历史无限增长 */
const HISTORY_LIMIT = 20

const PHASE_IDLE: GuessPhase = 'idle'

function cloneTurns(turns: GuessTurn[]): GuessTurn[] {
  return turns.map((turn) => ({
    ...turn,
    ...(turn.rejectedBefore ? { rejectedBefore: [...turn.rejectedBefore] } : {}),
    ...(turn.candidates ? { candidates: [...turn.candidates] } : {}),
    ...(turn.aliases ? { aliases: [...turn.aliases] } : {})
  }))
}

export const useGuessStore = defineStore('guess', () => {
  const phase = ref<GuessPhase>(PHASE_IDLE)
  const turns = ref<GuessTurn[]>([])
  /** 本轮问题：仅写入校验通过的文本。 */
  const question = ref('')
  const guess = ref('')
  const confidence = ref(0)
  /** 等用户确认的候选答案（点「猜对了」才结算） */
  const pendingAnswer = ref('')
  /** 用户已经否定过的答案，交给提示词阻止模型换个说法再猜一次 */
  const rejectedAnswers = ref<string[]>([])
  const candidates = ref<string[]>([])
  const result = ref<GuessResult | null>(null)
  const startedAt = ref(0)
  const durationMs = ref(0)
  /** 模型违规之类的软提示（不阻断对局） */
  const errorText = ref<string | null>(null)
  /** 请求失败之类的硬错误（这一轮没拿到问题，等用户点重试） */
  const failureText = ref<string | null>(null)
  const history = ref<GuessRecord[]>([])
  /** 本地读取失败时的提示：和 privacy store 的约定一致，静默失败比报错更糟 */
  const storageWarning = ref<string | null>(null)
  const requestStage = ref<'planning' | 'checking' | 'replanning'>('planning')

  let controller: AbortController | null = null
  /** 发给模型的对话上下文（system 由 buildGuessMessages 负责，这里只存问答） */
  let transcript: ChatMessage[] = []
  let historyLoaded = false
  /**
   * 对局代号。
   * 「放弃这一局」和「再来一局」都会中断正在飞的请求，而那个请求的
   * catch 分支还会继续往下走。没有这个代号的话，一局结束之后
   * 迟到的旧请求会把状态改回 asking / error，把新一局搅乱。
   */
  let generation = 0

  // 每次状态变动按顺序写入，避免较早的存档覆盖新的进度。
  const restoring = ref(true)
  let saveQueue: Promise<void> = Promise.resolve()
  const snapshot = () => ({
    version: 1,
    phase: phase.value,
    turns: cloneTurns(turns.value),
    pendingAnswer: pendingAnswer.value,
    rejectedAnswers: [...rejectedAnswers.value],
    startedAt: startedAt.value,
    candidates: [...candidates.value]
  })
  watch(
    snapshot,
    (saved) => {
      if (restoring.value) return
      const active = ['asking', 'waiting', 'confirming', 'error'].includes(saved.phase)
      saveQueue = saveQueue
        .then(() => kvSet('guess-active', active ? saved : null))
        .catch(() => {
          storageWarning.value = '当前进度保存失败，请暂时不要刷新页面。'
        })
    },
    { deep: true, flush: 'sync' }
  )

  async function restoreGame(): Promise<void> {
    if (!restoring.value) return
    const token = generation
    try {
      const saved = await kvGet<ReturnType<typeof snapshot>>('guess-active')
      if (token !== generation || phase.value !== 'idle' || !saved) return
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.turns) ||
        !['asking', 'waiting', 'confirming', 'error'].includes(saved.phase) ||
        !Array.isArray(saved.rejectedAnswers) ||
        !saved.rejectedAnswers.every((x) => typeof x === 'string') ||
        typeof saved.pendingAnswer !== 'string' ||
        !Number.isFinite(saved.startedAt) ||
        !saved.turns.every(
          (t) =>
            t &&
            typeof t.question === 'string' &&
            typeof t.guess === 'string' &&
            Number.isFinite(t.confidence) &&
            ['', 'yes', 'no', 'unsure'].includes(t.answer) &&
            (t.action === undefined || t.action === 'ask' || t.action === 'guess') &&
            (t.questionKey === undefined || typeof t.questionKey === 'string') &&
            (t.candidates === undefined ||
              (Array.isArray(t.candidates) && t.candidates.every((x) => typeof x === 'string'))) &&
            (t.aliases === undefined || (Array.isArray(t.aliases) && t.aliases.every((x) => typeof x === 'string'))) &&
            (t.rejectedBefore === undefined ||
              (Array.isArray(t.rejectedBefore) && t.rejectedBefore.every((x) => typeof x === 'string')))
        )
      ) {
        storageWarning.value = '上次对局存档无法读取，可以开始新一局。'
        return
      }
      turns.value = cloneTurns(saved.turns)
      rejectedAnswers.value = saved.rejectedAnswers
      candidates.value = Array.isArray(saved.candidates)
        ? saved.candidates.filter((x) => typeof x === 'string').slice(0, 5)
        : []
      pendingAnswer.value = saved.pendingAnswer
      // 兼容旧存档：已否定的具体答案不能仍然保留肯定记录。
      for (const turn of turns.value) {
        if (
          turn.action !== 'ask' &&
          turn.answer === 'yes' &&
          rejectedAnswers.value.includes(turn.action === 'guess' ? turn.guess : extractGuessCandidate(turn.question))
        ) {
          turn.answer = 'no'
        }
      }
      if (rejectedAnswers.value.includes(pendingAnswer.value)) pendingAnswer.value = ''
      startedAt.value = saved.startedAt
      rebuildTranscript()
      const last = turns.value.at(-1)
      question.value = last?.question ?? ''
      guess.value = last?.guess ?? ''
      confidence.value = last?.confidence ?? 0
      if (rejectedAnswers.value.includes(guess.value)) guess.value = ''
      phase.value =
        saved.phase === 'confirming' && pendingAnswer.value ? 'confirming' : last && !last.answer ? 'waiting' : 'error'
      if (phase.value === 'error') failureText.value = '已恢复上次进度，点击重试继续这一轮。'
      errorText.value = '已恢复上次未完成的对局'
    } catch {
      storageWarning.value = '无法读取上次进度，请检查浏览器存储。'
    } finally {
      restoring.value = false
    }
  }

  /**
   * 当前是第几轮。
   * 正在问（或上一轮请求失败待重试）时，这一轮的问题还没进 turns，要 +1；
   * 问题已经在手上时，turns.length 本身就是当前轮数。
   * 早先这里恒等于 turns.length + 1，于是第一个问题就显示「第 2 轮」。
   */
  const round = computed(() => {
    if (phase.value === 'asking' || phase.value === 'error') return turns.value.length + 1
    return Math.max(1, turns.value.length)
  })
  const currentTurn = computed(() => turns.value[turns.value.length - 1] ?? null)
  /** 已问过的问题，供单问约束与重复检测使用 */
  const askedQuestions = computed(() => turns.value.map((turn) => turn.question))
  const busy = computed(() => phase.value === 'asking')
  /** 当前是否已经达到整局轮数上限。 */
  const atRoundLimit = computed(() => turns.value.length >= MAX_ROUNDS)
  const elapsedSeconds = computed(() => Math.max(0, Math.round(durationMs.value / 1000)))
  const hasHistory = computed(() => history.value.length > 0)
  /** 正在等用户确认一个候选答案 */
  const awaitingConfirm = computed(() => phase.value === 'confirming' && pendingAnswer.value !== '')
  /**
   * 界面上要展示的候选答案。
   * 两种情况：模型自报高置信度（可以边答题边确认），
   * 或者用户刚对一个「它是 X 吗？」答了「是」。
   */
  const candidateAnswer = computed(() => {
    if (phase.value === 'confirming') return pendingAnswer.value
    if (phase.value === 'waiting' && guess.value && confidence.value >= GUESS_CONFIDENCE_THRESHOLD) return guess.value
    return ''
  })

  const canUndo = computed(
    () => ['asking', 'waiting', 'confirming', 'error'].includes(phase.value) && turns.value.some((t) => t.answer)
  )

  function rebuildTranscript(): void {
    transcript = turns.value.flatMap((t) => (t.answer ? turnToMessages({ ...t, answer: t.answer }) : []))
  }

  /** 撤回会取消正在生成的新题；旧请求即使稍后返回也不能污染这局。 */
  function undoAnswer(): void {
    if (!canUndo.value) return
    stop()
    generation += 1
    let index = turns.value.length - 1
    while (index >= 0 && !turns.value[index].answer) index -= 1
    const turn = turns.value[index]
    rejectedAnswers.value = turn.rejectedBefore
      ? [...turn.rejectedBefore]
      : turns.value
          .slice(0, index)
          .filter((t) => t.answer === 'no' && t.action !== 'ask')
          .flatMap((t) => [t.action === 'guess' ? t.guess : extractGuessCandidate(t.question), ...(t.aliases ?? [])])
          .filter(Boolean)
    turns.value = turns.value.slice(0, index + 1)
    turn.answer = ''
    candidates.value = [...(turn.candidates ?? [])]
    rebuildTranscript()
    question.value = turn.question
    guess.value = turn.guess
    confidence.value = turn.confidence
    pendingAnswer.value = turn.action === 'guess' ? turn.guess : ''
    phase.value = pendingAnswer.value ? 'confirming' : 'waiting'
    failureText.value = null
    errorText.value = '已撤回上个回答，请重新选择。'
  }

  function clearError(): void {
    errorText.value = null
  }

  function stop(): void {
    controller?.abort()
  }

  /** 已经结算 / 已放弃 / 已重置：迟到的异步分支不该再改状态 */
  function isSettled(token: number): boolean {
    return token !== generation || phase.value === 'finished' || phase.value === 'guessed' || phase.value === PHASE_IDLE
  }

  async function loadHistory(): Promise<void> {
    if (historyLoaded) return
    historyLoaded = true
    try {
      const saved = await kvGet<GuessRecord[]>(HISTORY_KEY)
      history.value = Array.isArray(saved) ? saved : []
      storageWarning.value = null
    } catch (error) {
      history.value = []
      storageWarning.value = `历史对局读取失败，本次不会显示旧记录：${(error as Error).message}`
      console.warn('[guess] 读取历史失败', error)
    }
  }

  /** 结算时落盘。写失败只提示、不回滚：这一局的成绩还在屏幕上，不该因此消失 */
  async function persistRecord(record: GuessRecord): Promise<void> {
    history.value = [record, ...history.value].slice(0, HISTORY_LIMIT)
    try {
      await kvSet(
        HISTORY_KEY,
        history.value.map((item) => ({ ...item, turns: cloneTurns(item.turns) }))
      )
      storageWarning.value = null
    } catch (error) {
      storageWarning.value = `这一局没能存进本地，刷新后会丢失：${(error as Error).message}`
      console.warn('[guess] 保存对局失败', error)
    }
  }

  /** 重置运行时状态（不动历史记录） */
  function resetRuntime(): void {
    // 代号一加，任何还在飞的旧请求回来都会被 isSettled 挡掉
    generation += 1
    phase.value = PHASE_IDLE
    turns.value = []
    question.value = ''
    guess.value = ''
    confidence.value = 0
    pendingAnswer.value = ''
    rejectedAnswers.value = []
    candidates.value = []
    result.value = null
    durationMs.value = 0
    startedAt.value = 0
    errorText.value = null
    failureText.value = null
    transcript = []
  }

  /** 开始新的一局（FR-G1：点「开始」即进入对局，无需用户再输入任何东西） */
  async function start(): Promise<void> {
    restoring.value = false
    stop()
    resetRuntime()
    const settings = useSettingsStore()
    if (!settings.chatConfigured) {
      failureText.value = '请先在「我的」里配置对话接口。'
      phase.value = 'error'
      return
    }
    startedAt.value = Date.now()
    await askRound(generation)
  }

  /** 生成和核对共用整轮中断信号；禁用 API 内层重试，避免重试层层叠加。 */
  async function requestModel(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    const settings = useSettingsStore()
    let onAbort: (() => void) | undefined
    let truncated = false
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DOMException('本轮请求已中断', 'AbortError'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      if (signal.aborted) return await interrupted
      const text = await Promise.race([
        streamChat(settings.api.chat, messages, {
          signal,
          temperature: 0.3,
          thinking: { type: 'disabled' },
          timeoutMs: 20_000,
          retries: 0,
          onFinish: (info) => {
            truncated = info.truncated
          }
        }),
        interrupted
      ])
      if (truncated) throw new Error('模型回复未完整结束，请重试这一轮')
      return text
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  function referenceHits(candidate = ''): SearchHit[] {
    const rag = useRagStore()
    const hits = new Map<string, SearchHit>()
    for (const query of buildGuessReferenceQueries(turns.value, candidate)) {
      for (const hit of rag.searchKeyword(query, 3)) {
        const previous = hits.get(hit.chunk.id)
        if (!previous || previous.score < hit.score) hits.set(hit.chunk.id, hit)
      }
    }
    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 3)
  }

  /** 候选先由独立模型核对用户事实和别名，核对失败不会展示给用户。 */
  async function reviewCandidate(reply: GuessReply, signal: AbortSignal): Promise<ViolationHint | null> {
    if (
      !reply.guess ||
      (reply.action !== 'guess' &&
        !extractGuessCandidate(reply.question) &&
        reply.confidence < GUESS_CONFIDENCE_THRESHOLD)
    )
      return null
    requestStage.value = 'checking'
    const evidence = buildEvidence(turns.value)
    const text = await requestModel(
      withGuessReferences(
        buildCandidateReviewMessages(evidence, reply.guess, rejectedAnswers.value),
        referenceHits(reply.guess)
      ),
      signal
    )
    const review = parseCandidateReview(parseJsonLoose(text), evidence)
    if (!review)
      return { raw: reply.raw, reason: '候选核对结果不完整，请重新核对全部用户事实后选择问题或答案', kind: 'conflict' }
    const aliases = parseNames([reply.guess, ...review.aliases])
    const rejectedAlias = aliases.find((alias) =>
      rejectedAnswers.value.some((name) => normalizeGuessName(name) === normalizeGuessName(alias))
    )
    if (review.verdict === 'contradicted' || rejectedAlias) {
      return {
        raw: reply.raw,
        kind: 'conflict',
        reason: rejectedAlias
          ? `候选「${reply.guess}」与已否定答案「${rejectedAlias}」是同一个对象，换别名也不能再猜`
          : `候选「${reply.guess}」未通过一致性核对，冲突线索编号：${review.conflicts.join('、') || '已否定答案'}。请保留全部用户事实，换一个候选或有效问题`
      }
    }
    reply.aliases = aliases
    return null
  }

  /** 最多三次生成；整轮含核对共享 30 秒，最后一次用事实清单重新规划。 */
  async function askRound(token: number): Promise<void> {
    if (turns.value.length >= MAX_ROUNDS) {
      finishGame(token)
      return
    }
    phase.value = 'asking'
    failureText.value = null
    errorText.value = null
    question.value = ''
    guess.value = ''
    confidence.value = 0
    pendingAnswer.value = ''
    const answered = turns.value.filter((turn): turn is GuessTurn & { answer: GuessAnswer } => turn.answer !== '')
    const recovery = recoveryReason(answered)
    requestStage.value = recovery ? 'replanning' : 'planning'
    const roundController = new AbortController()
    controller = roundController
    const deadline = setTimeout(() => roundController.abort(), GUESS_ROUND_TIMEOUT_MS)
    let hint: ViolationHint | undefined
    let explorationQuestion: GuessReply | undefined
    try {
      const rag = useRagStore()
      // 应用启动时已初始化；若直接进入页面，则后台加载，不能拖住本轮超时。
      if (!rag.ready) void rag.init()
      if (isSettled(token)) return
      if (roundController.signal.aborted) throw new DOMException('本轮请求已中断', 'AbortError')
      const references = referenceHits()
      let plannedCandidates = remainingCandidates(candidates.value)
      let replannedGuess = ''
      const discoverCandidates = async (reason: string): Promise<void> => {
        requestStage.value = 'replanning'
        const plan = await requestModel(
          withGuessReferences(
            buildReplanningMessages(buildEvidence(turns.value), rejectedAnswers.value, reason),
            references
          ),
          roundController.signal
        )
        if (isSettled(token)) return
        const parsedPlan = parseJsonLoose(plan)
        replannedGuess = ''
        plannedCandidates = parseNames(parsedPlan?.candidates).filter(
          (name) => !rejectedAnswers.value.some((rejected) => normalizeGuessName(rejected) === normalizeGuessName(name))
        )
        if (
          typeof parsedPlan?.guess === 'string' &&
          plannedCandidates.some((name) => normalizeGuessName(name) === normalizeGuessName(parsedPlan.guess as string))
        ) {
          replannedGuess = JSON.stringify({
            action: 'guess',
            guess: parsedPlan.guess,
            confidence: typeof parsedPlan.confidence === 'number' ? parsedPlan.confidence : 0,
            candidates: plannedCandidates
          })
        }
      }
      if (recovery) await discoverCandidates(recovery)
      for (let attempt = 0; attempt < 3; attempt++) {
        const rediscover = attempt === 2 && (hint?.kind === 'duplicate' || hint?.kind === 'conflict')
        if (rediscover) {
          await discoverCandidates(`前两次回复无效：${hint!.reason}。丢弃旧候选锚点，按全部原始用户事实重新发现候选。`)
          if (isSettled(token)) return
        }
        const freshContext = !!recovery || attempt === 2
        requestStage.value = attempt > 0 || freshContext ? 'replanning' : 'planning'
        let text: string
        try {
          text =
            (attempt === 0 || rediscover) && replannedGuess
              ? replannedGuess
              : await requestModel(
                  withGuessReferences(
                    buildGuessMessages(
                      answered,
                      turns.value.length,
                      freshContext ? [] : transcript,
                      hint,
                      rejectedAnswers.value,
                      plannedCandidates,
                      recovery || (attempt === 2 ? '前两次回复无效，根据用户事实清单重新规划，不重复无效问题。' : '')
                    ),
                    references
                  ),
                  roundController.signal
                )
        } catch (error) {
          if (
            roundController.signal.aborted ||
            !/模型没有返回任何内容|模型回复未完整结束/.test((error as Error).message ?? '')
          )
            throw error
          text = ''
        }
        if (isSettled(token)) return
        const validated = validateReply(
          text,
          askedQuestions.value,
          rejectedAnswers.value,
          answered.flatMap((turn) => (turn.questionKey ? [turn.questionKey] : []))
        )
        if (!validated.ok) {
          hint = validated.hint
          continue
        }
        const directGuess =
          validated.reply.action === 'guess' ||
          (validated.reply.guess && extractGuessCandidate(validated.reply.question) === validated.reply.guess)
        const uniform = !directGuess && hasUniformCandidateAnswers(validated.reply)
        const exploration = directGuess ? null : validateExplorationPlan(validated.reply, answered)
        const invalidPlan = directGuess
          ? null
          : (exploration ??
            (uniform
              ? {
                  raw: validated.reply.raw,
                  kind: 'conflict' as const,
                  reason: '所有候选对本轮问题的回答相同，不能区分它们。请换一个容易回答且能区分候选的新属性。'
                }
              : validateQuestionPlan(validated.reply, answered.length)))
        // 候选只是开放世界的少量假设；重建后仍可通过一个合法新问题探查列表外对象。
        // 分组不佳促使修正，不能被当作事实而让有效问题永远无法通过。
        if (invalidPlan && attempt < 2) {
          // 保存模型已经给出的合法新属性题。候选分组只是辅助假设，
          // 后续猜测核对失败时仍可继续探查，不能被元数据拖成卡局。
          if (validated.reply.action === 'ask' && !validated.reply.guess) explorationQuestion = validated.reply
          hint = invalidPlan
          continue
        }
        const conflict = await reviewCandidate(validated.reply, roundController.signal)
        if (isSettled(token)) return
        if (conflict) {
          hint = conflict
          continue
        }
        acceptReply(validated.reply)
        if (attempt > 0 || recovery) errorText.value = '我重新整理了线索，换个方向继续。'
        return
      }
      if (explorationQuestion) {
        acceptReply(explorationQuestion)
        errorText.value = '我重新整理了线索，先确认一个新属性。'
        return
      }
      failureText.value = `这一轮没能生成有效的新问题：${hint?.reason ?? '模型回复无效'}。线索已保留，可以重新生成。`
      phase.value = 'error'
    } catch (error) {
      if (!isSettled(token)) {
        failureText.value = roundController.signal.aborted
          ? '本轮等待已超过 30 秒，线索已保留，可以重试。'
          : `暂时没能完成这一轮：${(error as Error).message}`
        phase.value = 'error'
      }
    } finally {
      clearTimeout(deadline)
      if (controller === roundController) controller = null
    }
  }

  function acceptReply(reply: GuessReply): void {
    turns.value.push({
      question: reply.question,
      answer: '',
      guess: reply.guess,
      confidence: reply.confidence,
      action: reply.action,
      questionKey: reply.questionKey,
      candidates: [...(reply.candidates ?? [])],
      aliases: [...(reply.aliases ?? [])],
      rejectedBefore: [...rejectedAnswers.value]
    })
    candidates.value = remainingCandidates(reply.candidates ?? [])
    question.value = reply.question
    guess.value = reply.guess
    confidence.value = reply.confidence
    pendingAnswer.value = reply.action === 'guess' ? reply.guess : ''
    phase.value = pendingAnswer.value ? 'confirming' : 'waiting'
  }

  /** 仅排除用户明确否定的名称与已核对别名，不在本地推断属性或答案。 */
  function remainingCandidates(names: string[]): string[] {
    const rejected = new Set(rejectedAnswers.value.map(normalizeGuessName))
    return names.filter((name) => !rejected.has(normalizeGuessName(name)))
  }

  function rejectCandidate(name: string, aliases: string[] = []): void {
    const rejected = new Map(rejectedAnswers.value.map((item) => [normalizeGuessName(item), item]))
    for (const item of [name, ...aliases]) {
      if (normalizeGuessName(item)) rejected.set(normalizeGuessName(item), item.trim())
    }
    rejectedAnswers.value = [...rejected.values()]
    candidates.value = remainingCandidates(candidates.value)
  }

  /** 用完这一轮就进下一轮，或者到顶结算 */
  async function nextRound(token: number): Promise<void> {
    pendingAnswer.value = ''
    await askRound(token)
  }

  /** 用户回答（是 / 否 / 不确定） */
  async function submitAnswer(answer: GuessAnswer): Promise<void> {
    const turn = currentTurn.value
    if (phase.value !== 'waiting' || !turn || turn.answer !== '') return

    const token = generation
    turn.answer = answer
    transcript.push(...turnToMessages({ ...turn, answer }))
    errorText.value = null

    /**
     * 答「是」的指认式问句（「它是微波炉吗？」）本身就是一次猜测。
     * 但绝不据此直接宣布猜中 —— 先把 X 作为候选交给用户点一下，
     * 这也是「猜对了 / 不是」这套确认机制存在的原因。
     */
    if (answer === 'yes') {
      const candidate = turn.action === 'ask' ? '' : extractGuessCandidate(turn.question)
      if (candidate) {
        pendingAnswer.value = candidate
        phase.value = 'confirming'
        return
      }
    }

    const rejectedCandidate = answer === 'no' && turn.action !== 'ask' ? extractGuessCandidate(turn.question) : ''
    if (rejectedCandidate) rejectCandidate(rejectedCandidate, turn.aliases)

    if (turns.value.length >= MAX_ROUNDS) {
      finishGame(token)
      return
    }

    await nextRound(token)
  }

  /**
   * 用户对候选答案表态。
   *
   * 两个阶段都能确认：
   *   - `confirming`：用户刚对「它是 X 吗？」答了「是」，这一轮已经答完；
   *   - `waiting`：模型自报高置信度，用户可以先点「猜对了」，也可以不理它继续答题。
   *
   * 说「不是」时要把这个答案记下来交给提示词 —— 只靠对话里那一句「不是」，
   * 模型下一轮经常会把同一个东西换个说法再猜一次。
   */
  async function confirmCandidate(correct: boolean): Promise<void> {
    const candidate = candidateAnswer.value
    if (!candidate) return

    const token = generation

    if (correct) {
      if (
        currentTurn.value &&
        (currentTurn.value.action === 'guess' || extractGuessCandidate(currentTurn.value.question) === candidate)
      )
        currentTurn.value.answer = 'yes'
      finishGame(token, 'guessed', candidate)
      return
    }

    rejectCandidate(candidate, currentTurn.value?.aliases)

    if (phase.value === 'confirming') {
      // 修正原来对该候选的肯定，不能同时保留「是」和「不是」。
      if (currentTurn.value) currentTurn.value.answer = 'no'
      rebuildTranscript()
      transcript.push({
        role: 'user',
        content: `不是，答案不是「${candidate}」。请把它排除，继续问一个能区分剩余候选的问题。`
      })
      pendingAnswer.value = ''
      if (turns.value.length >= MAX_ROUNDS) {
        finishGame(token)
        return
      }
      await nextRound(token)
      return
    }

    // 还在等用户回答问题：只否掉这个候选，题目照答，候选卡随之收起
    transcript.push({ role: 'user', content: `不是，答案不是「${candidate}」。` })
    guess.value = ''
    confidence.value = 0
  }

  /** 请求失败后的重试：沿用同一局、同一轮数，只把这一轮重新问一次 */
  async function retryRound(): Promise<void> {
    if (phase.value !== 'error') return
    await askRound(generation)
  }

  /** 暂停等待保留本局；旧请求即使不响应 abort，也不能覆盖用户的新操作。 */
  function cancelRound(): void {
    if (!busy.value) return
    generation += 1
    stop()
    failureText.value = '已暂停等待，已有线索都保留了，可以重试这一轮。'
    phase.value = 'error'
  }

  /** 用户主动放弃：照样留下记录，只是结果记成「未猜中（放弃）」 */
  function abandon(): void {
    if (phase.value === PHASE_IDLE || phase.value === 'finished' || phase.value === 'guessed') return
    const token = generation
    stop()
    finishGame(token, 'gaveup', pendingAnswer.value || guess.value)
  }

  /**
   * 结算（FR-G4 / FR-G5）。
   * 轮数取 turns.length，用时取真实墙钟时间 —— 中途切到后台的时间也算在内，
   * 那本来就是用户花在这局上的时间。
   */
  function finishGame(token: number, forced?: GuessResult, answer = ''): void {
    if (token !== generation) return
    if (phase.value === 'finished' || phase.value === 'guessed') return

    const finalTurns = cloneTurns(turns.value)
    const finalAnswer = answer || finalTurns[finalTurns.length - 1]?.guess || ''
    // 没有指定结果就是「轮数用尽仍未猜中」
    const outcome: GuessResult = forced ?? 'failed'
    const record: GuessRecord = {
      id: createId('guess'),
      startedAt: startedAt.value || Date.now(),
      durationMs: Date.now() - (startedAt.value || Date.now()),
      rounds: finalTurns.length,
      result: outcome,
      answer: finalAnswer,
      turns: finalTurns
    }

    result.value = outcome
    guess.value = finalAnswer
    durationMs.value = record.durationMs
    phase.value = outcome === 'guessed' ? 'guessed' : 'finished'
    void persistRecord(record)
  }

  /** 再来一局：清空运行时状态回到开局屏，历史记录保留 */
  function reset(): void {
    stop()
    resetRuntime()
  }

  /** 回看某一局：只读克隆，不改变当前对局 */
  function replay(record: GuessRecord): GuessTurn[] {
    return cloneTurns(record.turns)
  }

  /** 清空全部历史（用户主动清理本地数据） */
  async function clearHistory(): Promise<void> {
    history.value = []
    try {
      await kvSet(HISTORY_KEY, [])
      storageWarning.value = null
    } catch (error) {
      storageWarning.value = `清空历史失败：${(error as Error).message}`
      console.warn('[guess] 清空历史失败', error)
    }
  }

  return {
    restoring,
    restoreGame,
    phase,
    turns,
    question,
    guess,
    confidence,
    pendingAnswer,
    rejectedAnswers,
    result,
    startedAt,
    durationMs,
    elapsedSeconds,
    errorText,
    failureText,
    history,
    storageWarning,
    requestStage,
    round,
    currentTurn,
    askedQuestions,
    busy,
    atRoundLimit,
    hasHistory,
    awaitingConfirm,
    candidateAnswer,
    loadHistory,
    start,
    submitAnswer,
    confirmCandidate,
    retryRound,
    cancelRound,
    canUndo,
    undoAnswer,
    abandon,
    reset,
    replay,
    clearHistory,
    clearError,
    stop
  }
})
