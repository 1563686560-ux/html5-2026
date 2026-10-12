import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 猜心状态机的回归测试。
 *
 * 这个文件补的是两处真实翻车过的行为：
 *   1. 一轮请求失败时，旧实现会把阶段打回 idle —— 用户玩到第八轮，
 *      屏幕突然跳回「开始」那一屏，进度全丢；
 *   2. 旧实现会在两种情况下**自作主张**宣布猜中：模型自报 confidence ≥ 0.8，
 *      或者「模型随手填的 guess 非空 + 用户答了是」。用户根本没确认过那个答案，
 *      看到的却是一句「猜中了！<一个不相干的东西>」。
 *
 * 环境说明：store 依赖 IndexedDB（走 @/db）与流式接口（走 @/api/llm），
 * 这里把两者都换成可编排的假实现；requestAnimationFrame 在 node 里不存在，
 * 用一对「只排队、不自动触发」的替身顶上，flush 时才会真正写入。
 */
const {
  kvStore,
  kvGetMock,
  kvSetMock,
  sentMessages,
  sentReviews,
  sentReplans,
  sentOptions,
  script,
  reviewScript,
  replanReplies,
  searchReference,
  pending
} = vi.hoisted(() => {
  const kvStore = new Map<string, unknown>()
  type Step =
    { kind: 'text'; text: string; truncated?: boolean } | { kind: 'error'; message: string } | { kind: 'hold' }
  return {
    kvStore,
    kvGetMock: vi.fn(async (key: string) => kvStore.get(key)),
    kvSetMock: vi.fn(async (key: string, value: unknown) => {
      kvStore.set(key, value)
    }),
    /** 每次请求发给模型的消息，供断言提示词内容 */
    sentMessages: [] as Array<Array<{ role: string; content: string }>>,
    sentReviews: [] as Array<Array<{ role: string; content: string }>>,
    sentReplans: [] as Array<Array<{ role: string; content: string }>>,
    sentOptions: [] as Array<{ thinking?: { type: string }; signal?: AbortSignal; retries?: number }>,
    script: [] as Step[],
    reviewScript: [] as Step[],
    replanReplies: [] as string[],
    searchReference: vi.fn(),
    /** 'hold' 步骤挂起的 resolver，由测试决定什么时候放行 */
    pending: [] as Array<{ resolve: (text: string) => void }>
  }
})

vi.mock('@/db', () => ({ kvGet: kvGetMock, kvSet: kvSetMock }))
vi.mock('./rag', () => ({ useRagStore: () => ({ ready: true, searchKeyword: searchReference }) }))

vi.mock('@/api/llm', () => ({
  streamChat: vi.fn(
    async (
      _endpoint: unknown,
      messages: Array<{ role: string; content: string }>,
      options?: {
        thinking?: { type: string }
        signal?: AbortSignal
        retries?: number
        onDelta?: (chunk: string, full: string) => void
        onFinish?: (info: { truncated: boolean }) => void
      }
    ) => {
      if (messages[0]?.content.includes('你负责猜心游戏的独立候选发现')) {
        sentReplans.push(messages)
        return replanReplies.shift() ?? JSON.stringify({ candidates: ['书桌', '耳机', '杯子'] })
      }
      if (messages[0]?.content.includes('你负责猜心游戏的候选一致性核对')) {
        sentReviews.push(messages)
        const step = reviewScript.shift()
        if (step?.kind === 'hold') return await new Promise<string>((resolve) => pending.push({ resolve }))
        if (step?.kind === 'error') throw new Error(step.message)
        if (step?.kind === 'text') {
          options?.onFinish?.({ truncated: step.truncated ?? false })
          return step.text
        }
        const input = JSON.parse(messages.at(-1)!.content) as { evidence: Array<{ id: number; answer: string }> }
        return JSON.stringify({
          verdict: 'compatible',
          checked: input.evidence.filter((item) => item.answer !== 'unsure').map((item) => item.id),
          conflicts: [],
          aliases: []
        })
      }
      sentMessages.push(messages)
      sentOptions.push(options ?? {})
      const step = script.shift()
      if (!step) throw new Error('测试脚本已用尽：还有请求没编排')
      if (step.kind === 'error') throw new Error(step.message)
      if (step.kind === 'hold') {
        const text = await new Promise<string>((resolve) => pending.push({ resolve }))
        options?.onDelta?.(text, text)
        return text
      }
      // 旧回归场景补齐新版提问协议；分组只是可编排的模型输出，不参与本机推理。
      let replyText = step.text
      try {
        const reply = JSON.parse(replyText)
        if (typeof reply.question === 'string' && reply.action !== 'guess') {
          reply.questionKey ??= reply.question
          reply.candidates =
            reply.candidates?.length >= 2 ? reply.candidates : [`${reply.question}对象甲`, `${reply.question}对象乙`]
          reply.split ??= { yes: [reply.candidates[0]], no: reply.candidates.slice(1), unsure: [] }
          replyText = JSON.stringify(reply)
        }
      } catch {
        /* 保留违规文本，测试真实修正分支 */
      }
      options?.onDelta?.(replyText, replyText)
      options?.onFinish?.({ truncated: step.truncated ?? false })
      return replyText
    }
  )
}))

import { useGuessStore } from './guess'
import { useSettingsStore } from './settings'
import { FALLBACK_QUESTIONS, GUESS_ROUND_TIMEOUT_MS, MAX_ROUNDS } from '@/prompt/guess'
import { createGuessReference } from '@/rag/guessSeed'

/** 一个合法的模型输出 */
function question(text: string, guess = '', confidence = 0): string {
  return JSON.stringify({ question: text, guess, confidence })
}

beforeEach(() => {
  setActivePinia(createPinia())
  useSettingsStore().api.chat = { baseUrl: 'https://example.invalid/v1', model: 'unit-test', apiKey: 'unit-test-key' }
  kvStore.clear()
  script.length = 0
  pending.length = 0
  sentMessages.length = 0
  sentReviews.length = 0
  sentReplans.length = 0
  reviewScript.length = 0
  replanReplies.length = 0
  sentOptions.length = 0
  searchReference.mockReset().mockReturnValue([])
  kvGetMock.mockClear()
  kvSetMock.mockClear()
  kvGetMock.mockImplementation(async (key: string) => kvStore.get(key))

  // rAF 只排队不自动触发：与浏览器一致，真正的写入发生在 flush()
  const queued: Array<() => void> = []
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    queued.push(callback)
    return queued.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queued[id - 1] = () => undefined
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('开局与基本一轮', () => {
  it('未配置接口时给出设置提示，不发送请求', async () => {
    useSettingsStore().api.chat.apiKey = ''
    const game = useGuessStore()
    await game.start()
    expect(game.phase).toBe('error')
    expect(game.failureText).toContain('配置对话接口')
    expect(sentMessages).toHaveLength(0)
  })
  it('恢复旧存档时修正已否定候选残留的肯定答案', async () => {
    kvStore.set('guess-active', {
      version: 1,
      phase: 'error',
      turns: [{ question: '它是皮卡丘吗？', answer: 'yes', guess: '皮卡丘', confidence: 0.9 }],
      pendingAnswer: '',
      rejectedAnswers: ['皮卡丘'],
      startedAt: Date.now()
    })
    const guess = useGuessStore()
    await guess.restoreGame()
    expect(guess.turns[0].answer).toBe('no')
    script.push({ kind: 'text', text: question('它是圆胖的吗？') })
    await guess.retryRound()
    expect(
      sentMessages
        .at(-1)
        ?.map((m) => m.content)
        .join('')
    ).not.toContain('答：是')
  })

  it('重新加载后恢复待回答的问题和已回答的线索', async () => {
    script.push({ kind: 'text', text: question('它是人造的吗？') })
    script.push({ kind: 'text', text: question('它需要用电吗？') })
    const first = useGuessStore()
    await first.start()
    await first.submitAnswer('yes')
    await vi.waitFor(() => {
      expect(kvStore.get('guess-active')).toMatchObject({
        phase: 'waiting',
        turns: [{ answer: 'yes' }, { answer: '' }]
      })
    })
    setActivePinia(createPinia())
    const restored = useGuessStore()
    await restored.restoreGame()
    expect(restored.phase).toBe('waiting')
    expect(restored.round).toBe(2)
    expect(restored.currentTurn?.question).toBe('它需要用电吗？')
    script.push({ kind: 'text', text: question('它能拿在手里吗？') })
    await restored.submitAnswer('no')
    expect(restored.round).toBe(3)
    expect(
      sentMessages
        .at(-1)
        ?.map((m) => m.content)
        .join('')
    ).toContain('答：是')
  })

  it('刷新发生在请求中时恢复为可重试状态，不回到开始页', async () => {
    kvStore.set('guess-active', {
      version: 1,
      phase: 'asking',
      turns: [],
      pendingAnswer: '',
      rejectedAnswers: [],
      startedAt: Date.now()
    })
    const guess = useGuessStore()
    await guess.restoreGame()
    expect(guess.phase).toBe('error')
    expect(guess.restoring).toBe(false)
    script.push({ kind: 'text', text: question('它是人造的吗？') })
    await guess.retryRound()
    expect(guess.phase).toBe('waiting')
    expect(guess.round).toBe(1)
  })

  it('已结束的对局不会在刷新后复活', async () => {
    script.push({ kind: 'text', text: question('它是人造的吗？') })
    const guess = useGuessStore()
    await guess.start()
    guess.abandon()
    await vi.waitFor(() => expect(kvStore.get('guess-active')).toBeNull())
    setActivePinia(createPinia())
    const restored = useGuessStore()
    await restored.restoreGame()
    expect(restored.phase).toBe('idle')
  })

  it('start 之后进入等回答，并把问题显示出来', async () => {
    script.push({ kind: 'text', text: question('它是人造的吗？') })
    const guess = useGuessStore()

    await guess.start()

    expect(guess.phase).toBe('waiting')
    expect(guess.round).toBe(1)
    expect(guess.turns).toHaveLength(1)
    expect(guess.currentTurn?.question).toBe('它是人造的吗？')
    expect(sentOptions[0]?.thinking).toEqual({ type: 'disabled' })
    expect(guess.busy).toBe(false)
  })

  it('回答之后自动问下一轮', async () => {
    script.push({ kind: 'text', text: question('它是人造的吗？') })
    script.push({ kind: 'text', text: question('它需要用电吗？') })
    const guess = useGuessStore()

    await guess.start()
    await guess.submitAnswer('yes')

    expect(guess.turns).toHaveLength(2)
    // 第二个问题已经在手上，所以当前就是第 2 轮
    expect(guess.round).toBe(2)
    expect(guess.currentTurn?.question).toBe('它需要用电吗？')
    expect(guess.turns[0].answer).toBe('yes')
  })
})

describe('请求失败不再丢掉整局（回归）', () => {
  it('中途请求失败时保留进度，并停在待重试状态', async () => {
    script.push({ kind: 'text', text: question('它是人造的吗？') })
    script.push({ kind: 'text', text: question('它需要用电吗？') })
    script.push({ kind: 'error', message: '连接中断：network error' })
    const guess = useGuessStore()

    await guess.start()
    await guess.submitAnswer('yes')
    await guess.submitAnswer('no')

    // 关键：不是 idle（跳回开始屏），进度原样还在
    expect(guess.phase).toBe('error')
    expect(guess.turns).toHaveLength(2)
    expect(guess.round).toBe(3)
    expect(guess.failureText).toContain('连接中断')
    expect(guess.result).toBeNull()
  })

  it('重试这一轮接着往下走，不用从头开始', async () => {
    script.push({ kind: 'text', text: question('它是人造的吗？') })
    script.push({ kind: 'text', text: question('它比手机大吗？') })
    script.push({ kind: 'error', message: 'HTTP 429' })
    script.push({ kind: 'text', text: question('它能拿在手里吗？') })
    const guess = useGuessStore()

    await guess.start()
    await guess.submitAnswer('yes')
    await guess.submitAnswer('no')
    expect(guess.phase).toBe('error')
    expect(guess.turns).toHaveLength(2)

    await guess.retryRound()

    expect(guess.phase).toBe('waiting')
    // 重试沿用同一局：前两轮还在，这一轮补上
    expect(guess.turns).toHaveLength(3)
    expect(guess.currentTurn?.question).toBe('它能拿在手里吗？')
    expect(guess.round).toBe(3)
    expect(guess.failureText).toBeNull()
  })

  it('放弃之后迟到的请求不能把状态改回来', async () => {
    script.push({ kind: 'hold' })
    const guess = useGuessStore()

    const starting = guess.start()
    await Promise.resolve()

    guess.reset()
    expect(guess.phase).toBe('idle')
    // 迟到的响应现在才回来
    pending.shift()?.resolve(question('它是人造的吗？'))
    await starting

    expect(guess.phase).toBe('idle')
    expect(guess.turns).toHaveLength(0)
    expect(guess.question).toBe('')
  })

  it('上一局迟到的流式文本不会覆盖新一局的问题', async () => {
    script.push({ kind: 'hold' })
    const guess = useGuessStore()
    const oldRequest = guess.start()
    script.push({ kind: 'text', text: question('它需要用电吗？') })
    await guess.start()
    pending.shift()?.resolve(question('它是人造的吗？'))
    await oldRequest
    expect(guess.phase).toBe('waiting')
    expect(guess.question).toBe('它需要用电吗？')
    expect(guess.turns).toHaveLength(1)
  })
})

describe('猜中必须由用户确认', () => {
  it('模型自报高置信度也不会自动结算，只提出候选', async () => {
    script.push({ kind: 'text', text: question('它是厨房电器吗？', '微波炉', 0.95) })
    const guess = useGuessStore()

    await guess.start()

    expect(guess.result).toBeNull()
    expect(guess.phase).toBe('waiting')
    expect(guess.candidateAnswer).toBe('微波炉')

    await guess.confirmCandidate(true)
    expect(guess.result).toBe('guessed')
    expect(guess.guess).toBe('微波炉')
    expect(kvStore.get('guess-history')).toBeTruthy()
  })

  it('对「它是 X 吗？」答「是」时先请用户确认，不直接宣布猜中', async () => {
    script.push({ kind: 'text', text: question('它是微波炉吗？') })
    const guess = useGuessStore()

    await guess.start()
    await guess.submitAnswer('yes')

    expect(guess.phase).toBe('confirming')
    expect(guess.awaitingConfirm).toBe(true)
    expect(guess.pendingAnswer).toBe('微波炉')
    expect(guess.result).toBeNull()

    guess.confirmCandidate(true)
    expect(guess.result).toBe('guessed')
    expect(guess.guess).toBe('微波炉')
  })

  it('候选被否定后继续问，并把否定过的答案写进提示词', async () => {
    script.push({ kind: 'text', text: question('它是微波炉吗？') })
    script.push({ kind: 'text', text: question('它是白色的吗？') })
    const guess = useGuessStore()

    await guess.start()
    await guess.submitAnswer('yes')
    await guess.confirmCandidate(false)

    expect(guess.phase).toBe('waiting')
    expect(guess.result).toBeNull()
    expect(guess.rejectedAnswers).toEqual(['微波炉'])
    expect(guess.turns).toHaveLength(2)
    expect(guess.turns[0].answer).toBe('no')

    const last = sentMessages[sentMessages.length - 1].map((m) => m.content).join('\n')
    expect(last).toContain('"question":"它是微波炉吗？","answer":"no"')
    expect(last).toContain('刚刚猜错')
    expect(last).toContain('对方已经明确否定过这些答案')
  })

  it('答「是」时指认的是问题里的东西，不是模型随手填的 guess（旧实现在这里猜错）', async () => {
    script.push({ kind: 'text', text: question('它是厨房电器吗？', '微波炉', 0.5) })
    script.push({ kind: 'text', text: question('它能加热食物吗？') })
    const guess = useGuessStore()

    await guess.start()
    // 置信度不够，不弹确认卡，只当线索
    expect(guess.candidateAnswer).toBe('')

    // 用户只是在回答「它是厨房电器吗」，不是在确认「微波炉」
    await guess.submitAnswer('yes')

    expect(guess.result).toBeNull()
    expect(guess.pendingAnswer).toBe('')
    expect(guess.pendingAnswer).not.toBe('微波炉')

    // 分类回答直接成为线索，不应让用户否定自己刚确认的分类
    expect(guess.phase).toBe('waiting')
    expect(guess.result).toBeNull()
    expect(guess.turns).toHaveLength(2)
  })
})

describe('违规处理', () => {
  it('SSE 提前断开即使留下可解析 JSON，也会修正后再展示问题', async () => {
    script.push(
      { kind: 'text', text: question('它是动物吗？'), truncated: true },
      { kind: 'text', text: question('它是虚构角色吗？') }
    )
    const game = useGuessStore()
    await game.start()
    expect(game.question).toBe('它是虚构角色吗？')
    expect(game.turns).toHaveLength(1)
  })
  it('模型空正文自动修正，不必立刻让用户点重试', async () => {
    script.push({ kind: 'error', message: '模型没有返回任何内容，请检查模型名与接口地址是否正确' })
    script.push({ kind: 'text', text: question('它是虚构角色吗？') })
    const guess = useGuessStore()
    await guess.start()
    expect(guess.phase).toBe('waiting')
    expect(guess.failureText).toBeNull()
    expect(guess.turns).toHaveLength(1)
  })

  it('解析失败只重问一次，成功就继续', async () => {
    script.push({ kind: 'text', text: '我想想……你觉得呢？' })
    script.push({ kind: 'text', text: question('是活物吗？') })
    const guess = useGuessStore()

    await guess.start()

    expect(guess.phase).toBe('waiting')
    expect(guess.currentTurn?.question).toBe('是活物吗？')
    expect(guess.errorText).toContain('重新整理了线索')
  })

  it('连续违规最多修正两次，不用固定题伪装恢复', async () => {
    for (let i = 0; i < 3; i++) script.push({ kind: 'text', text: '不是 JSON' })
    const guess = useGuessStore()
    await guess.start()
    expect(sentMessages).toHaveLength(3)
    expect(guess.phase).toBe('error')
    expect(guess.turns).toHaveLength(0)
    expect(guess.result).toBeNull()
    script.push({ kind: 'text', text: question('它是白色的吗？') })
    await guess.retryRound()
    expect(guess.phase).toBe('waiting')
    expect(guess.round).toBe(1)
  })

  it('修正请求遇到断网时保留进度，不伪造问题', async () => {
    script.push({ kind: 'text', text: '不是 JSON' })
    script.push({ kind: 'error', message: '连接中断' })
    const guess = useGuessStore()
    await guess.start()
    expect(guess.phase).toBe('error')
    expect(guess.turns).toHaveLength(0)
    expect(guess.failureText).toContain('连接中断')
  })

  it('兜底问题全部耗尽后重置短期上下文恢复，不提前结束本局', async () => {
    kvStore.set('guess-active', {
      version: 1,
      phase: 'error',
      turns: FALLBACK_QUESTIONS.map((text) => ({ question: text, answer: 'no', guess: '', confidence: 0 })),
      pendingAnswer: '',
      rejectedAnswers: [],
      startedAt: Date.now()
    })
    script.push({ kind: 'text', text: '不是 JSON' })
    script.push({ kind: 'text', text: '还是不是 JSON' })
    script.push({ kind: 'text', text: question('它有固定的颜色吗？') })
    const guess = useGuessStore()
    await guess.restoreGame()

    await guess.retryRound()

    expect(guess.phase).toBe('waiting')
    expect(guess.turns).toHaveLength(FALLBACK_QUESTIONS.length + 1)
    expect(guess.result).toBeNull()
    expect(guess.currentTurn?.question).toBe('它有固定的颜色吗？')
    expect(guess.errorText).toContain('重新整理了线索')
  })
})

describe('结算', () => {
  it('第 60 轮仍未猜中时结束本局，并把具体猜测记入排除项', async () => {
    const previousTurns = Array.from({ length: MAX_ROUNDS - 1 }, (_, index) => ({
      question: `历史线索 ${index + 1} 符合吗？`,
      answer: 'no',
      guess: '',
      confidence: 0
    }))
    kvStore.set('guess-active', {
      version: 1,
      phase: 'error',
      turns: previousTurns,
      pendingAnswer: '',
      rejectedAnswers: [],
      startedAt: Date.now()
    })
    script.push({ kind: 'text', text: question('它是火星车吗？', '火星车', 0.8) })
    const guess = useGuessStore()
    await guess.restoreGame()

    await guess.retryRound()
    expect(guess.round).toBe(60)
    await guess.submitAnswer('no')

    expect(guess.turns).toHaveLength(60)
    expect(guess.result).toBe('failed')
    expect(guess.phase).toBe('finished')
    expect(guess.rejectedAnswers).toContain('火星车')
    expect(guess.atRoundLimit).toBe(true)
  })

  it('主动放弃也留下记录', async () => {
    script.push({ kind: 'text', text: question('它是人造的吗？') })
    const guess = useGuessStore()

    await guess.start()
    guess.abandon()

    expect(guess.result).toBe('gaveup')
    expect(guess.phase).toBe('finished')
    const saved = kvStore.get('guess-history') as Array<{ result: string }>
    expect(saved[0].result).toBe('gaveup')
  })

  it('再来一局清空运行时状态但保留历史', async () => {
    script.push({ kind: 'text', text: question('它是人造的吗？') })
    const guess = useGuessStore()

    await guess.start()
    await guess.submitAnswer('yes')
    guess.abandon()
    expect(guess.history).toHaveLength(1)

    guess.reset()

    expect(guess.phase).toBe('idle')
    expect(guess.turns).toHaveLength(0)
    expect(guess.history).toHaveLength(1)
  })
})

describe('明确区分属性与具体猜测', () => {
  it('全部问题与答案均由模型产生，三个线索不会触发本地预设答案', async () => {
    script.push({ kind: 'text', text: question('它是虚构角色吗？') })
    script.push({ kind: 'text', text: question('它来自中国动画吗？') })
    script.push({ kind: 'text', text: JSON.stringify({ action: 'ask', question: '它是龙吗？' }) })
    script.push({ kind: 'text', text: JSON.stringify({ action: 'ask', question: '它身体是黄色的吗？' }) })
    const game = useGuessStore()
    await game.start()
    await game.submitAnswer('yes')
    await game.submitAnswer('yes')
    await game.submitAnswer('yes')
    expect(game.phase).toBe('waiting')
    expect(game.candidateAnswer).toBe('')
    expect(game.result).toBeNull()
    expect(sentMessages).toHaveLength(4)
    expect(sentMessages.flatMap((messages) => messages.map((message) => message.content)).join('')).not.toContain(
      '本地参考库'
    )
    expect(game.turns[3].question).toBe('它身体是黄色的吗？')
  })

  it('低置信度的明确猜测也能确认，不用先回答是再确认一次', async () => {
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '奶龙', confidence: 0.6 }) })
    const guess = useGuessStore()
    await guess.start()
    expect(guess.phase).toBe('confirming')
    expect(guess.candidateAnswer).toBe('奶龙')
    expect(guess.result).toBeNull()
    await guess.confirmCandidate(true)
    expect(guess.result).toBe('guessed')
    expect(guess.turns[0].answer).toBe('yes')
  })

  it('明确的属性问题不按问句形状误判成答案', async () => {
    script.push({
      kind: 'text',
      text: JSON.stringify({
        action: 'ask',
        question: '它是主角吗？',
        guess: '奶龙',
        confidence: 0.99,
        candidates: ['奶龙', '皮卡丘']
      })
    })
    script.push({ kind: 'text', text: question('它的身体是黄色的吗？') })
    const guess = useGuessStore()
    await guess.start()
    expect(guess.candidateAnswer).toBe('')
    await guess.submitAnswer('yes')
    expect(guess.phase).toBe('waiting')
    expect(guess.turns).toHaveLength(2)
    expect(sentMessages.at(-1)?.at(-1)?.content).toContain('上一轮候选假设')
  })

  it('已否定的候选即使换问题携带也要修正', async () => {
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '皮卡丘' }) })
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '皮卡丘' }) })
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '奶龙' }) })
    const guess = useGuessStore()
    await guess.start()
    await guess.confirmCandidate(false)
    expect(guess.turns[0].answer).toBe('no')
    expect(guess.candidateAnswer).toBe('奶龙')
    expect(guess.turns).toHaveLength(2)
    expect(
      sentMessages
        .at(-1)
        ?.map((m) => m.content)
        .join('')
    ).toContain('答：否')
  })

  it('刷新后保持未确认的具体猜测', async () => {
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '奶龙' }) })
    const guess = useGuessStore()
    await guess.start()
    await vi.waitFor(() => expect(kvStore.get('guess-active')).toMatchObject({ phase: 'confirming' }))
    setActivePinia(createPinia())
    const restored = useGuessStore()
    await restored.restoreGame()
    expect(restored.candidateAnswer).toBe('奶龙')
    expect(restored.result).toBeNull()
  })
})

describe('撤回与并发保护', () => {
  it('撤回上个回答，并阻止旧请求覆盖重新回答的结果', async () => {
    script.push({ kind: 'text', text: question('它是人造的吗？') }, { kind: 'hold' })
    const guess = useGuessStore()
    await guess.start()
    const answering = guess.submitAnswer('yes')
    expect(guess.canUndo).toBe(true)
    guess.undoAnswer()
    expect(guess.phase).toBe('waiting')
    expect(guess.currentTurn?.answer).toBe('')
    script.push({ kind: 'text', text: question('它是活物吗？') })
    await guess.submitAnswer('no')
    pending.shift()?.resolve(question('它需要用电吗？'))
    await answering
    expect(guess.question).toBe('它是活物吗？')
    expect(guess.turns[0].answer).toBe('no')
    expect(guess.turns).toHaveLength(2)
  })

  it('撤回一次否定后允许重新确认该候选', async () => {
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '奶龙' }) })
    script.push({ kind: 'text', text: question('它的身体是黄色的吗？') })
    const guess = useGuessStore()
    await guess.start()
    await guess.confirmCandidate(false)
    expect(guess.rejectedAnswers).toContain('奶龙')
    guess.undoAnswer()
    expect(guess.rejectedAnswers).not.toContain('奶龙')
    expect(guess.candidateAnswer).toBe('奶龙')
    expect(guess.turns).toHaveLength(1)
    await guess.confirmCandidate(true)
    expect(guess.result).toBe('guessed')
  })
})

describe('纯模型候选核对与重新规划', () => {
  it('候选核对反复失败时沿用本轮模型给出的合法新属性题，不泄露失败候选或卡局', async () => {
    script.push({ kind: 'text', text: question('它是现实存在的吗？') })
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '台灯' }) })
    script.push({ kind: 'text', text: JSON.stringify({
      action: 'ask', question: '它通常有共鸣箱吗？', questionKey: '结构:共鸣箱',
      candidates: ['吉他', '竖琴'], split: { yes: ['吉他', '竖琴'], no: [], unsure: [] }
    }) })
    replanReplies.push(JSON.stringify({ candidates: ['台灯'], guess: '台灯', confidence: 0.8 }))
    const rejectedReview = JSON.stringify({ verdict: 'contradicted', checked: [1], conflicts: [1], aliases: [] })
    reviewScript.push({ kind: 'text', text: rejectedReview }, { kind: 'text', text: rejectedReview })
    const game = useGuessStore()
    await game.start()
    await game.submitAnswer('yes')
    expect(game.phase).toBe('waiting')
    expect(game.question).toBe('它通常有共鸣箱吗？')
    expect(game.turns).toHaveLength(2)
    expect(game.turns[0].answer).toBe('yes')
    expect(game.candidateAnswer).toBe('')
    expect(game.guess).toBe('')
    expect(game.result).toBeNull()
    expect(sentReviews).toHaveLength(2)
  })
  it('连续否定三个用途后先修正新的用途枚举，并继续展示有效结构问题', async () => {
    for (const [text, key] of [
      ['它主要用于清洁吗？', '用途:清洁'],
      ['它通常用来照明吗？', '功能:照明'],
      ['它通常用来播放声音吗？', '作用:播放声音'],
      ['它通常用来个人护理吗？', '功能:护理'],
      ['它有旋转部件吗？', '结构:旋转']
    ])
      script.push({ kind: 'text', text: JSON.stringify({ action: 'ask', question: text, questionKey: key }) })
    const game = useGuessStore()
    await game.start()
    await game.submitAnswer('no')
    await game.submitAnswer('no')
    await game.submitAnswer('no')
    expect(game.phase).toBe('waiting')
    expect(game.question).toBe('它有旋转部件吗？')
    expect(game.turns).toHaveLength(4)
    expect(game.turns.some((turn) => turn.question === '它通常用来个人护理吗？')).toBe(false)
    expect(sentReplans.at(-1)!.at(-1)!.content).toContain('停止逐项枚举')
    expect(
      sentMessages
        .at(-1)!
        .map((message) => message.content)
        .join('\n')
    ).toContain('停止逐项枚举')
  })
  it('两次无区分度问题后自动独立发现新候选，第三次有效问题继续对局', async () => {
    script.push({ kind: 'text', text: question('它是现实存在的吗？') })
    const uniform = JSON.stringify({
      action: 'ask',
      question: '它放在室内使用吗？',
      questionKey: '场景:室内',
      candidates: ['书桌', '台灯'],
      split: { yes: ['书桌', '台灯'], no: [], unsure: [] }
    })
    script.push(
      { kind: 'text', text: uniform },
      { kind: 'text', text: uniform },
      {
        kind: 'text',
        text: JSON.stringify({
          action: 'ask',
          question: '它是自然形成的吗？',
          questionKey: '来源:自然',
          candidates: ['月亮', '台灯'],
          split: { yes: ['月亮'], no: ['台灯'], unsure: [] }
        })
      }
    )
    replanReplies.push(JSON.stringify({ candidates: ['月亮', '台灯'] }))
    const game = useGuessStore()
    await game.start()
    await game.submitAnswer('yes')
    expect(game.phase).toBe('waiting')
    expect(game.question).toBe('它是自然形成的吗？')
    expect(game.turns).toHaveLength(2)
    expect(sentReplans).toHaveLength(1)
    const input = JSON.parse(sentReplans[0].at(-1)!.content)
    expect(input.reason).toContain('所有候选对本轮问题的回答相同')
    expect(input.evidence).toEqual([{ id: 1, question: '它是现实存在的吗？', answer: 'yes' }])
    expect(sentMessages.at(-1)!.at(-1)!.content).toContain('上一轮候选假设（不是事实，请结合最新回答更新）：月亮、台灯')
  })
  it('第一次猜错即独立规划，旧候选和别名不继续成为候选锚点', async () => {
    script.push(
      { kind: 'text', text: JSON.stringify({ action: 'guess', guess: '月亮', candidates: ['月亮', '月球', '太阳'] }) },
      {
        kind: 'text',
        text: JSON.stringify({
          action: 'ask',
          question: '它自己发光吗？',
          questionKey: '光:自发光',
          candidates: ['太阳', '金星'],
          split: { yes: ['太阳'], no: ['金星'], unsure: [] }
        })
      }
    )
    reviewScript.push({
      kind: 'text',
      text: JSON.stringify({ verdict: 'compatible', checked: [], conflicts: [], aliases: ['月球'] })
    })
    replanReplies.push(JSON.stringify({ candidates: ['月亮', '月球', '太阳', '金星'] }))
    const game = useGuessStore()
    await game.start()
    await game.confirmCandidate(false)
    expect(sentReplans).toHaveLength(1)
    const input = JSON.parse(sentReplans[0].at(-1)!.content)
    expect(input.reason).toContain('刚刚猜错')
    expect(input.rejected).toEqual(expect.arrayContaining(['月亮', '月球']))
    expect(input.evidence[0].answer).toBe('no')
    expect(sentMessages.at(-1)!.at(-1)!.content).toContain('上一轮候选假设（不是事实，请结合最新回答更新）：太阳、金星')
    expect(game.phase).toBe('waiting')
    expect(game.question).toBe('它自己发光吗？')
  })

  it('排除名单超过八个仍完整保留，归一化别名去重而不抹掉历史', async () => {
    script.push(
      { kind: 'text', text: JSON.stringify({ action: 'guess', guess: '超人' }) },
      { kind: 'text', text: question('它来自日本吗？') }
    )
    reviewScript.push({
      kind: 'text',
      text: JSON.stringify({
        verdict: 'compatible',
        checked: [],
        conflicts: [],
        aliases: ['Superman', 'Ｓｕｐｅｒｍａｎ']
      })
    })
    const game = useGuessStore()
    await game.start()
    game.rejectedAnswers = Array.from({ length: 12 }, (_, index) => `旧答案${index}`)
    await game.confirmCandidate(false)
    expect(game.rejectedAnswers).toHaveLength(14)
    expect(game.rejectedAnswers).toContain('旧答案0')
    expect(game.rejectedAnswers).toContain('旧答案11')
    expect(game.rejectedAnswers).toContain('超人')
  })

  it('候选分组不佳时先独立重建，仍允许合法新问题探索候选列表之外，不人为卡住', async () => {
    script.push({ kind: 'text', text: question('它是虚构角色吗？') })
    for (let index = 0; index < 3; index++)
      script.push({
        kind: 'text',
        text: JSON.stringify({
          action: 'ask',
          question: '它是黄色的吗？',
          questionKey: '颜色:黄色',
          candidates: ['奶龙', '皮卡丘'],
          split: { yes: ['奶龙', '皮卡丘'], no: [], unsure: [] }
        })
      })
    const game = useGuessStore()
    await game.start()
    await game.submitAnswer('yes')
    expect(game.phase).toBe('waiting')
    expect(game.turns).toHaveLength(2)
    expect(game.turns[0].answer).toBe('yes')
    expect(game.question).toBe('它是黄色的吗？')
    expect(game.failureText).toBeNull()
    expect(sentReplans).toHaveLength(1)
  })
  it('模型把具体候选误标成普通问题时仍核对并进入确认，不继续丢掉正确答案', async () => {
    script.push({
      kind: 'text',
      text: JSON.stringify({
        action: 'ask',
        question: '它是大熊猫吗？',
        candidates: ['大熊猫', '棕熊'],
        questionKey: '具体:大熊猫'
      })
    })
    const game = useGuessStore()
    await game.start()
    expect(sentReviews).toHaveLength(1)
    expect(game.phase).toBe('confirming')
    expect(game.candidateAnswer).toBe('大熊猫')
    expect(game.result).toBeNull()
    await game.confirmCandidate(true)
    expect(game.result).toBe('guessed')
    expect(game.currentTurn?.answer).toBe('yes')
  })
  it('知识库命中只补充参考，继续由模型猜测并核对，最后仍等用户确认', async () => {
    const reference = createGuessReference()
    searchReference.mockReturnValue([{ chunk: reference.chunks[0]!, score: 1, mode: 'keyword' }])
    script.push({ kind: 'text', text: question('它是虚构的吗？') })
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '奶龙', confidence: 0.9 }) })
    const game = useGuessStore()
    await game.start()
    expect(searchReference).not.toHaveBeenCalled()
    await game.submitAnswer('yes')
    expect(sentMessages.at(-1)?.some((message) => message.content.includes('知识库检索参考'))).toBe(true)
    expect(sentReviews.at(-1)?.some((message) => message.content.includes('知识库检索参考'))).toBe(true)
    expect(game.candidateAnswer).toBe('奶龙')
    expect(game.result).toBeNull()
    await game.confirmCandidate(true)
    expect(game.result).toBe('guessed')
  })
  it('辅助提问计划连续缺项时仍展示合法新问题，不把元数据故障变成卡局', async () => {
    for (let i = 0; i < 3; i++)
      script.push({
        kind: 'text',
        text: JSON.stringify({ action: 'ask', question: '它是虚构的吗？', questionKey: '' })
      })
    const game = useGuessStore()
    await game.start()
    expect(sentMessages).toHaveLength(3)
    expect(game.phase).toBe('waiting')
    expect(game.question).toBe('它是虚构的吗？')
    expect(game.result).toBeNull()
  })
  it('独立重新发现的明确候选仍须核对后由用户确认，不靠固定轮数宣布猜中', async () => {
    kvStore.set('guess-active', {
      version: 1,
      phase: 'error',
      turns: Array.from({ length: 6 }, (_, index) => ({
        question: `历史属性${index + 1}吗？`,
        answer: 'yes',
        guess: '',
        confidence: 0,
        action: 'ask'
      })),
      pendingAnswer: '',
      rejectedAnswers: [],
      startedAt: Date.now()
    })
    replanReplies.push(JSON.stringify({ candidates: ['微波炉', '烤箱'], guess: '微波炉', confidence: 0.8 }))
    const game = useGuessStore()
    await game.restoreGame()
    await game.retryRound()
    expect(sentMessages).toHaveLength(0)
    expect(sentReviews).toHaveLength(1)
    expect(game.candidateAnswer).toBe('微波炉')
    expect(game.result).toBeNull()
    await game.confirmCandidate(true)
    expect(game.result).toBe('guessed')
  })
  it('具体作品名包含疑问词仍能确认，并将用户确认保存为肯定回答', async () => {
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '十万个为什么' }) })
    const game = useGuessStore()
    await game.start()
    expect(game.candidateAnswer).toBe('十万个为什么')
    await game.confirmCandidate(true)
    expect(game.result).toBe('guessed')
    expect(game.turns[0].answer).toBe('yes')
  })

  it('候选核对流提前中断时不展示候选，保留对局供重试', async () => {
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '微波炉' }) })
    reviewScript.push({
      kind: 'text',
      truncated: true,
      text: JSON.stringify({ verdict: 'compatible', checked: [], conflicts: [], aliases: [] })
    })
    const game = useGuessStore()
    await game.start()
    expect(game.phase).toBe('error')
    expect(game.candidateAnswer).toBe('')
    expect(game.turns).toHaveLength(0)
    expect(game.failureText).toContain('未完整结束')
  })
  it('候选违反已有线索时自动纠正，不展示未经核对的答案', async () => {
    script.push(
      { kind: 'text', text: JSON.stringify({ action: 'ask', question: '它是虚构角色吗？', questionKey: '身份:虚构' }) },
      { kind: 'text', text: JSON.stringify({ action: 'guess', guess: '微波炉' }) },
      { kind: 'text', text: JSON.stringify({ action: 'ask', question: '它来自中国吗？', questionKey: '来源:中国' }) }
    )
    reviewScript.push({
      kind: 'text',
      text: JSON.stringify({ verdict: 'contradicted', checked: [1], conflicts: [1], aliases: [] })
    })
    const game = useGuessStore()
    await game.start()
    await game.submitAnswer('yes')
    expect(game.phase).toBe('waiting')
    expect(game.candidateAnswer).toBe('')
    expect(game.turns).toHaveLength(2)
    expect(game.question).toBe('它来自中国吗？')
    expect(
      sentMessages
        .at(-1)
        ?.map((message) => message.content)
        .join('')
    ).toContain('冲突线索编号：1')
    expect(game.rejectedAnswers).not.toContain('微波炉')
  })

  it('核对遗漏事实时不放行候选，可以改问一个有效问题', async () => {
    script.push(
      { kind: 'text', text: question('它需要用电吗？') },
      { kind: 'text', text: JSON.stringify({ action: 'guess', guess: '微波炉' }) },
      { kind: 'text', text: question('它能加热食物吗？') }
    )
    reviewScript.push({
      kind: 'text',
      text: JSON.stringify({ verdict: 'compatible', checked: [], conflicts: [], aliases: [] })
    })
    const game = useGuessStore()
    await game.start()
    await game.submitAnswer('yes')
    expect(game.candidateAnswer).toBe('')
    expect(game.question).toBe('它能加热食物吗？')
    expect(
      sentMessages
        .at(-1)
        ?.map((message) => message.content)
        .join('')
    ).toContain('核对结果不完整')
  })

  it('用户否定候选后同时排除模型核对的别名，禁止换名字再猜', async () => {
    script.push(
      { kind: 'text', text: JSON.stringify({ action: 'guess', guess: '超人' }) },
      { kind: 'text', text: JSON.stringify({ action: 'guess', guess: '克拉克·肯特' }) },
      { kind: 'text', text: question('它来自日本吗？') }
    )
    reviewScript.push({
      kind: 'text',
      text: JSON.stringify({ verdict: 'compatible', checked: [], conflicts: [], aliases: ['克拉克·肯特', 'Superman'] })
    })
    const game = useGuessStore()
    await game.start()
    await game.confirmCandidate(false)
    expect(game.rejectedAnswers).toEqual(expect.arrayContaining(['超人', '克拉克·肯特', 'Superman']))
    expect(sentReviews).toHaveLength(1)
    expect(game.question).toBe('它来自日本吗？')
    expect(game.turns).toHaveLength(2)
    game.undoAnswer()
    expect(game.rejectedAnswers).toEqual([])
    expect(game.candidateAnswer).toBe('超人')
  })

  it('连续不确定时以事实重新规划，保留未知状态和实际命题键', async () => {
    for (const [text, key] of [
      ['它是哺乳类吗？', '分类:哺乳类'],
      ['它属于灵长类吗？', '分类:灵长类'],
      ['它能飞吗？', '能力:飞行']
    ]) {
      script.push({ kind: 'text', text: JSON.stringify({ action: 'ask', question: text, questionKey: key }) })
    }
    const game = useGuessStore()
    await game.start()
    await game.submitAnswer('unsure')
    await game.submitAnswer('unsure')
    const last = sentMessages.at(-1)!
    expect(last).toHaveLength(2)
    expect(last.at(-1)?.content).toContain('本轮重新规划')
    expect(last.at(-1)?.content).toContain('"unknown":[{"id":1')
    expect(last.at(-1)?.content).toContain('分类:哺乳类')
  })

  it('刷新与撤回保留命题、模型候选及核对别名，不留下撤回后的事实', async () => {
    script.push(
      {
        kind: 'text',
        text: JSON.stringify({
          action: 'ask',
          question: '它是虚构角色吗？',
          questionKey: '身份:虚构',
          candidates: ['甲', '乙']
        })
      },
      { kind: 'text', text: JSON.stringify({ action: 'guess', guess: '超人' }) }
    )
    reviewScript.push({
      kind: 'text',
      text: JSON.stringify({ verdict: 'compatible', checked: [1], conflicts: [], aliases: ['Superman'] })
    })
    const game = useGuessStore()
    await game.start()
    await game.submitAnswer('yes')
    await vi.waitFor(() => expect(kvStore.get('guess-active')).toMatchObject({ phase: 'confirming' }))
    setActivePinia(createPinia())
    const restored = useGuessStore()
    await restored.restoreGame()
    expect(restored.turns[1].aliases).toContain('Superman')
    restored.undoAnswer()
    expect(restored.turns).toHaveLength(1)
    expect(restored.currentTurn).toMatchObject({ questionKey: '身份:虚构', candidates: ['甲', '乙'], answer: '' })
  })
})

describe('整轮等待预算', () => {
  it('生成修正共享 30 秒上限，挂起请求也能结束，迟到回复不能覆盖结果', async () => {
    vi.useFakeTimers()
    script.push({ kind: 'hold' }, { kind: 'hold' })
    const game = useGuessStore()
    const starting = game.start()
    await vi.advanceTimersByTimeAsync(20_000)
    pending.shift()!.resolve('不是 JSON')
    await vi.advanceTimersByTimeAsync(0)
    expect(sentMessages).toHaveLength(2)
    expect(sentOptions[0].signal).toBe(sentOptions[1].signal)
    expect(sentOptions.every((options) => options.retries === 0)).toBe(true)
    await vi.advanceTimersByTimeAsync(GUESS_ROUND_TIMEOUT_MS - 20_000)
    await starting
    expect(game.phase).toBe('error')
    expect(game.failureText).toContain('30 秒')
    expect(game.turns).toHaveLength(0)
    pending.shift()!.resolve(question('它需要用电吗？'))
    await vi.advanceTimersByTimeAsync(0)
    expect(game.phase).toBe('error')
    expect(game.turns).toHaveLength(0)
  })

  it('候选核对也占用同一预算，超时前不能泄露尚未核对的猜测', async () => {
    vi.useFakeTimers()
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '微波炉' }) })
    reviewScript.push({ kind: 'hold' })
    const game = useGuessStore()
    const starting = game.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(game.requestStage).toBe('checking')
    expect(game.candidateAnswer).toBe('')
    await vi.advanceTimersByTimeAsync(GUESS_ROUND_TIMEOUT_MS)
    await starting
    expect(game.phase).toBe('error')
    expect(game.turns).toHaveLength(0)
    pending.shift()!.resolve(JSON.stringify({ verdict: 'compatible', checked: [], conflicts: [], aliases: [] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(game.candidateAnswer).toBe('')
  })

  it('用户可暂停候选核对并重试，迟到核对不能覆盖新问题', async () => {
    script.push({ kind: 'text', text: JSON.stringify({ action: 'guess', guess: '微波炉' }) })
    reviewScript.push({ kind: 'hold' })
    const game = useGuessStore()
    const starting = game.start()
    await vi.waitFor(() => expect(game.requestStage).toBe('checking'))
    game.cancelRound()
    await starting
    expect(game.phase).toBe('error')
    expect(game.failureText).toContain('已暂停')
    script.push({ kind: 'text', text: question('它需要用电吗？') })
    await game.retryRound()
    pending.shift()!.resolve(JSON.stringify({ verdict: 'compatible', checked: [], conflicts: [], aliases: [] }))
    await Promise.resolve()
    expect(game.phase).toBe('waiting')
    expect(game.question).toBe('它需要用电吗？')
    expect(game.turns).toHaveLength(1)
  })
})
