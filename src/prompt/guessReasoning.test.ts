import { describe, expect, it } from 'vitest'
import {
  buildEvidence,
  buildReplanningMessages,
  hasUniformCandidateAnswers,
  validateExplorationPlan,
  normalizeGuessName,
  parseCandidateReview,
  recoveryReason,
  validateQuestionPlan
} from './guessReasoning'
import { buildGuessMessages, validateReply } from './guess'

describe('用户事实与模型假设分离', () => {
  const turns = [
    { question: '它不是现实动物吗？', answer: 'yes' as const, candidates: ['皮卡丘'] },
    { question: '它来自日本吗？', answer: 'no' as const },
    { question: '它是哺乳类吗？', answer: 'unsure' as const },
    { question: '它是黄色的吗？', answer: '' as const }
  ]

  it('保留用户问句原义、编号与不确定回答，待回答问题不成为事实', () => {
    expect(buildEvidence(turns)).toEqual([
      { id: 1, question: '它不是现实动物吗？', answer: 'yes' },
      { id: 2, question: '它来自日本吗？', answer: 'no' },
      { id: 3, question: '它是哺乳类吗？', answer: 'unsure' }
    ])
    const evidence = buildEvidence(turns)
    expect(JSON.stringify(evidence)).not.toContain('皮卡丘')
  })

  it('提示词分别提供肯定、否定与未知事实，旧候选仅是假设', () => {
    const messages = buildGuessMessages(
      turns.filter((turn) => turn.answer !== ''),
      3,
      [],
      undefined,
      [],
      ['皮卡丘']
    )
    const content = messages.at(-1)!.content
    expect(content).toContain('"confirmed":[{"id":1')
    expect(content).toContain('"denied":[{"id":2')
    expect(content).toContain('"unknown":[{"id":3')
    expect(content).toContain('不是事实')
  })
})

describe('候选核对不能跳过事实', () => {
  const evidence = buildEvidence([
    { question: '它是虚构角色吗？', answer: 'yes' },
    { question: '它来自日本吗？', answer: 'no' },
    { question: '它有翅膀吗？', answer: 'unsure' }
  ])
  const valid = { verdict: 'compatible', checked: [1, 2], conflicts: [], aliases: ['别名'] }

  it('只有明确核对全部已知事实的结构化结果才通过', () => {
    expect(parseCandidateReview(valid, evidence)?.verdict).toBe('compatible')
    expect(parseCandidateReview({ ...valid, checked: [1] }, evidence)).toBeNull()
    expect(parseCandidateReview({ ...valid, checked: [1, 2, 99] }, evidence)).toBeNull()
    expect(parseCandidateReview({ ...valid, checked: [1, 2, 3] }, evidence)).toBeNull()
    expect(parseCandidateReview({ verdict: 'compatible' }, evidence)).toBeNull()
  })

  it('通过与冲突编号不能同时存在，不确定不能变成冲突', () => {
    expect(parseCandidateReview({ ...valid, conflicts: [1] }, evidence)).toBeNull()
    expect(parseCandidateReview({ ...valid, verdict: 'contradicted', conflicts: [3] }, evidence)).toBeNull()
    expect(parseCandidateReview({ ...valid, verdict: 'contradicted', conflicts: [2] }, evidence)?.conflicts).toEqual([
      2
    ])
  })
})

describe('自动重新规划', () => {
  it('用途命题换维度标签仍能发现连续否定，并建议问结构而非继续枚举', () => {
    const turns = [
      { question: '它主要用于清洁吗？', questionKey: '用途:清洁', action: 'ask' as const, answer: 'no' as const },
      { question: '它通常用来照明吗？', questionKey: '功能:照明', action: 'ask' as const, answer: 'no' as const },
      {
        question: '它通常用来播放声音吗？',
        questionKey: '作用:播放声音',
        action: 'ask' as const,
        answer: 'no' as const
      }
    ]
    const reply = { question: '它通常用来护理身体吗？', questionKey: '作用:护理', guess: '', confidence: 0, raw: '{}' }
    expect(recoveryReason(turns)).toContain('「用途」')
    expect(validateExplorationPlan(reply, turns)?.reason).toContain('停止逐项枚举')
    expect(
      validateExplorationPlan({ ...reply, question: '它有旋转的部件吗？', questionKey: '结构:旋转' }, turns)
    ).toBeNull()
    expect(validateExplorationPlan(reply, [{ ...turns[0], answer: 'yes' }, ...turns.slice(1)])).toBeNull()
    expect(validateExplorationPlan(reply, turns.slice(1))).toBeNull()
  })
  it('一次具体猜错立即重新扩展候选，但否定属性不当成猜错', () => {
    expect(recoveryReason([{ question: '它是月亮吗？', guess: '月亮', action: 'guess', answer: 'no' }])).toContain(
      '刚刚猜错'
    )
    expect(recoveryReason([{ question: '它是月亮吗？', guess: '月亮', answer: 'no' }])).toContain('刚刚猜错')
    expect(recoveryReason([{ question: '它是黄色的吗？', action: 'ask', answer: 'no' }])).toBe('')
  })

  it('独立发现收到恢复原因，但不收到旧候选锚点', () => {
    const evidence = buildEvidence([{ question: '它需要用电吗？', answer: 'yes' }])
    const messages = buildReplanningMessages(evidence, ['微波炉'], '刚刚猜错，换一个容易判断的属性')
    expect(JSON.parse(messages.at(-1)!.content)).toEqual({
      evidence,
      rejected: ['微波炉'],
      reason: '刚刚猜错，换一个容易判断的属性'
    })
  })
  it('同一维度连续被否定时停止枚举，要求换维度', () => {
    expect(
      recoveryReason([
        { question: '它来自甲作品吗？', answer: 'no', questionKey: '作品:甲' },
        { question: '它来自乙作品吗？', answer: 'no', questionKey: '作品:乙' },
        { question: '它来自丙作品吗？', answer: 'no', questionKey: '作品:丙' }
      ])
    ).toContain('停止逐项枚举')
  })
  it('多次不确定或具体猜错时换策略，不凭空补答案', () => {
    expect(
      recoveryReason([
        { question: '分类问题一？', answer: 'unsure' },
        { question: '分类问题二？', answer: 'unsure' }
      ])
    ).toContain('不确定')
    expect(
      recoveryReason([
        { question: '它是甲吗？', answer: 'no', action: 'guess' },
        { question: '它是乙吗？', answer: 'no', action: 'guess' }
      ])
    ).toContain('重新扩展候选')
  })

  it('三轮反复使用相同候选触发重新规划，候选顺序不影响判断', () => {
    expect(
      recoveryReason([
        { question: '问题一？', answer: 'yes', candidates: ['甲', '乙'] },
        { question: '问题二？', answer: 'no', candidates: ['乙', '甲'] },
        { question: '问题三？', answer: 'yes', candidates: ['甲', '乙'] }
      ])
    ).toContain('候选没有变化')
  })
})

describe('提问必须有模型提供的区分计划', () => {
  const plan = {
    action: 'ask' as const,
    question: '它需要用电吗？',
    questionKey: '能源:用电',
    candidates: ['耳机', '书桌'],
    split: { yes: ['耳机'], no: ['书桌'], unsure: [] },
    guess: '',
    confidence: 0,
    raw: '{}'
  }
  it('完整分组证明所有候选回答相同，缺失或错误元数据不能作为这个证明', () => {
    for (const key of ['yes', 'no', 'unsure'] as const) {
      const split = { yes: [] as string[], no: [] as string[], unsure: [] as string[] }
      split[key] = ['耳机', '书桌']
      expect(hasUniformCandidateAnswers({ ...plan, split })).toBe(true)
    }
    expect(hasUniformCandidateAnswers(plan)).toBe(false)
    expect(hasUniformCandidateAnswers({ ...plan, split: undefined })).toBe(false)
    expect(hasUniformCandidateAnswers({ ...plan, split: { yes: ['耳机', '洗衣机'], no: [], unsure: [] } })).toBe(false)
    expect(
      hasUniformCandidateAnswers({
        ...plan,
        candidates: ['耳机', '耳机'],
        split: { yes: ['耳机', '耳机'], no: [], unsure: [] }
      })
    ).toBe(false)
  })
  it('有两轮线索后必须说明候选与区分方式', () => {
    expect(validateQuestionPlan(plan, 2)).toBeNull()
    expect(validateQuestionPlan({ ...plan, questionKey: undefined }, 0)).not.toBeNull()
    expect(validateQuestionPlan({ ...plan, candidates: [] }, 2)).not.toBeNull()
    expect(validateQuestionPlan({ ...plan, split: undefined }, 2)).not.toBeNull()
  })
  it('所有候选回答相同、重复分组、漏项或虚构候选编号时要求改问', () => {
    for (const split of [
      { yes: ['耳机', '书桌'], no: [], unsure: [] },
      { yes: ['耳机'], no: ['耳机'], unsure: [] },
      { yes: ['耳机'], no: ['洗衣机'], unsure: [] }
    ])
      expect(validateQuestionPlan({ ...plan, split }, 2)).not.toBeNull()
  })
})

describe('命题与名称校验', () => {
  it('误标为属性的具体候选指认被纠正，但属性仍按属性处理', () => {
    const parsed = validateReply(
      JSON.stringify({
        action: 'ask',
        question: '它是大熊猫吗？',
        candidates: ['大熊猫', '棕熊'],
        questionKey: '具体:大熊猫'
      }),
      []
    )
    expect(parsed.ok && parsed.reply.action).toBe('guess')
    expect(parsed.ok && parsed.reply.guess).toBe('大熊猫')
    const attribute = validateReply(
      JSON.stringify({
        action: 'ask',
        question: '它是主角吗？',
        candidates: ['孙悟空', '哈利波特']
      }),
      []
    )
    expect(attribute.ok && attribute.reply.action).toBe('ask')
    expect(attribute.ok && attribute.reply.guess).toBe('')
  })
  it('同义问题共用命题键时被拦截，不同属性值保留', () => {
    const reply = (questionKey: string) =>
      JSON.stringify({ action: 'ask', question: '它是否属于幻想中的形象？', questionKey })
    expect(validateReply(reply('身份:虚构角色'), ['它是虚构角色吗？'], [], ['身份:虚构角色']).ok).toBe(false)
    expect(validateReply(reply('来源:日本'), [], [], ['来源:中国']).ok).toBe(true)
  })

  it('明确猜测允许真实作品名中的疑问词、连词和长名称', () => {
    for (const name of ['十万个为什么', '猫和老鼠', '你的名字', 'The Lord of the Rings', '老鼠']) {
      const reply = validateReply(JSON.stringify({ action: 'guess', guess: name }), [])
      expect(reply.ok, name).toBe(true)
      if (reply.ok) expect(reply.reply.guess).toBe(name)
    }
    expect(validateReply(JSON.stringify({ action: 'guess', guess: '动物' }), []).ok).toBe(false)
  })

  it('姓名归一化不删除名字中的语气字，显式属性不携带最终答案', () => {
    expect(normalizeGuessName('哆啦Ａ梦')).toBe('哆啦a梦')
    const reply = validateReply(
      JSON.stringify({ action: 'ask', question: '它是主角吗？', guess: '皮卡丘', confidence: 1 }),
      [],
      ['皮卡丘']
    )
    expect(reply.ok && reply.reply.guess).toBe('')
    expect(reply.ok && reply.reply.confidence).toBe(0)
  })
})
