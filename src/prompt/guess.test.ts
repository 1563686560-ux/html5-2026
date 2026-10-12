import { describe, expect, it } from 'vitest'
import {
  FALLBACK_QUESTIONS,
  MAX_CONTEXT_TURNS,
  MAX_ROUNDS,
  answerLabel,
  buildGuessMessages,
  buildGuessSystemPrompt,
  extractGuessCandidate,
  extractJsonText,
  isDuplicateQuestion,
  normalizeQuestion,
  parseGuessReply,
  pickFallbackQuestion,
  similarity,
  validateReply,
  validateSingleQuestion,
  type GuessAnswer
} from './guess'

describe('buildGuessSystemPrompt 系统提示词', () => {
  const prompt = buildGuessSystemPrompt()

  it('讲清玩法与「只用是 / 否回答」的前提', () => {
    expect(prompt).toContain('猜心')
    expect(prompt).toContain('「是」「否」或「不确定」')
  })

  it('写明单问约束与 60 轮上限', () => {
    expect(MAX_ROUNDS).toBe(60)
    expect(prompt).toContain('每轮只能输出一个问题')
    expect(prompt).toContain('禁止重复提问')
    expect(prompt).toContain(`最多 ${MAX_ROUNDS} 轮`)
  })

  it('要求只返回一个 JSON 对象并给出字段说明', () => {
    expect(prompt).toContain('"action":"ask"')
    expect(prompt).toContain('"split":{"yes":')
    expect(prompt).toContain('confidence')
  })

  it('给出先大类后细节的收敛策略', () => {
    expect(prompt).toContain('先大类后细节')
    expect(prompt).toContain('二分')
  })
})

describe('parseGuessReply 结构化回复解析', () => {
  it('解析正常 JSON', () => {
    const out = parseGuessReply('{"question":"是活物吗？","guess":"","confidence":0}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.reply.question).toBe('是活物吗？')
    expect(out.reply.guess).toBe('')
    expect(out.reply.confidence).toBe(0)
  })

  it('解析被 ```json 代码块围栏包裹的回复', () => {
    const out = parseGuessReply('```json\n{"question":"是人造的吗？","guess":"","confidence":0.2}\n```')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.reply.question).toBe('是人造的吗？')
    expect(out.reply.confidence).toBe(0.2)
  })

  it('解析前后带说明文字的回复', () => {
    const out = parseGuessReply(
      '好的，我的下一个问题是：\n{"question":"能拿在手里吗？","guess":"","confidence":0}\n请回答。'
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.reply.question).toBe('能拿在手里吗？')
  })

  it('问题里含转义引号与花括号也能解析', () => {
    const out = parseGuessReply('{"question":"它是不是叫「{小王子}」？","guess":"","confidence":0}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.reply.question).toContain('小王子')
  })

  it('字段缺失时返回失败而不是抛异常', () => {
    const out = parseGuessReply('{"guess":"猫","confidence":0.9}')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.kind).toBe('parse')
    expect(out.reason).toContain('question')
  })

  it('question 字段类型不对时视为缺失', () => {
    const out = parseGuessReply('{"question":123,"guess":"","confidence":0}')
    expect(out.ok).toBe(false)
  })

  it('confidence 是字符串时归一化成数字', () => {
    const out = parseGuessReply('{"question":"是动物吗？","guess":"猫","confidence":"0.75"}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.reply.confidence).toBe(0.75)
  })

  it('confidence 是百分数时按百分比理解', () => {
    const out = parseGuessReply('{"question":"是动物吗？","guess":"猫","confidence":"70%"}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.reply.confidence).toBeCloseTo(0.7)
  })

  it('confidence 超出范围时夹到 0~1', () => {
    const out = parseGuessReply('{"question":"是动物吗？","guess":"猫","confidence":95}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.reply.confidence).toBeCloseTo(0.95)

    const weird = parseGuessReply('{"question":"是动物吗？","guess":"猫","confidence":"说不清"}')
    expect(weird.ok).toBe(true)
    if (!weird.ok) return
    expect(weird.reply.confidence).toBe(0)
  })

  it('空回复返回 empty 失败', () => {
    expect(parseGuessReply('').ok).toBe(false)
    expect(parseGuessReply('   \n  ').ok).toBe(false)
  })

  it('完全不是 JSON 时返回失败', () => {
    const out = parseGuessReply('我想想……你觉得呢？')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.kind).toBe('parse')
  })

  it('保留原始输出，供重问时引用', () => {
    const out = parseGuessReply('{"question":"是动物吗？","guess":"","confidence":0}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.reply.raw).toContain('是动物吗')
  })
})

describe('extractJsonText 抽取 JSON 片段', () => {
  it('剥掉围栏并截到第一个完整对象', () => {
    expect(extractJsonText('```json\n{"question":"a？"} 额外说明\n```')).toBe('{"question":"a？"}')
  })

  it('没有 JSON 时返回 null', () => {
    expect(extractJsonText('没有任何对象')).toBeNull()
  })

  it('括号不配对时返回 null', () => {
    expect(extractJsonText('{"question":"a？"')).toBeNull()
  })
})

describe('validateSingleQuestion 单问约束', () => {
  it('合法的封闭式问题通过', () => {
    expect(validateSingleQuestion('是活物吗？').ok).toBe(true)
    expect(validateSingleQuestion('比手机大吗？').ok).toBe(true)
  })

  it('出现多个问号判为违规', () => {
    const out = validateSingleQuestion('是活的吗？还是人造的？')
    expect(out.ok).toBe(false)
    expect(out.kind).toBe('multi')
    expect(out.reason).toContain('问号')
  })

  it('「是 A 还是 B」这类一次问多件事判为违规', () => {
    const out = validateSingleQuestion('它是动物还是植物？')
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('多个选项')
  })

  it('逗号前后两个小问句判为违规', () => {
    const out = validateSingleQuestion('它会动吗，是活物么？')
    expect(out.ok).toBe(false)
  })

  it('用「并且 / 以及」附加第二个问题判为违规', () => {
    expect(validateSingleQuestion('它是人造的，而且能发光吗？').ok).toBe(false)
    expect(validateSingleQuestion('它比人小，以及是金属做的吗？').ok).toBe(false)
  })

  it('开放式提问判为违规', () => {
    const out = validateSingleQuestion('它是什么颜色的？')
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('开放式')
  })

  it('「为什么 / 怎么 / 多少」这类问句同样算违规', () => {
    expect(validateSingleQuestion('它为什么会发光？').ok).toBe(false)
    expect(validateSingleQuestion('它有几种颜色？').ok).toBe(false)
  })

  it('要求描述或列举判为违规', () => {
    expect(validateSingleQuestion('能描述一下它的样子吗？').ok).toBe(false)
  })

  it('没有问号或不是问句判为违规', () => {
    expect(validateSingleQuestion('它是动物。').ok).toBe(false)
    expect(validateSingleQuestion('').ok).toBe(false)
  })

  it('明确返回结果而不抛异常', () => {
    expect(() => validateSingleQuestion('???')).not.toThrow()
    expect(validateSingleQuestion('???').ok).toBe(false)
  })
})

describe('重复提问检测', () => {
  it('归一化去掉空白、标点、大小写与语气词', () => {
    expect(normalizeQuestion('是 动物 吗？')).toBe(normalizeQuestion('是动物吗'))
    expect(normalizeQuestion('Is It Alive?')).toBe('isitalive')
  })

  it('完全相同的问题判为重复', () => {
    expect(isDuplicateQuestion('是活物吗？', ['是活物吗？'])).toBe(true)
    expect(isDuplicateQuestion('是活物吗', ['是活物吗？'])).toBe(true)
  })

  it('去掉标点与语气词后相同也判为重复', () => {
    expect(isDuplicateQuestion('它是活的么？', ['它是活的吗？'])).toBe(true)
  })

  it('换个说法（加语气词、改标点）判为重复', () => {
    expect(isDuplicateQuestion('它是活物么', ['它是活物吗？'])).toBe(true)
    expect(isDuplicateQuestion('比手机大吗？', ['它比手机大么？'])).toBe(true)
  })

  it('同一属性加上某种仍然是重复问题', () => {
    expect(isDuplicateQuestion('它是某种动物吗？', ['它是动物吗？'])).toBe(true)
  })

  it('真正不同的问题不判重复', () => {
    expect(isDuplicateQuestion('是动物吗？', ['比手机大吗？', '能拿在手里吗？'])).toBe(false)
  })

  it('圆形与圆柱形、不同材料是不同属性，不因相似句式拦截新问题', () => {
    expect(isDuplicateQuestion('它通常是圆形的吗？', ['它通常是圆柱形的吗？'])).toBe(false)
    expect(isDuplicateQuestion('它通常是长方形的吗？', ['它通常是正方形的吗？'])).toBe(false)
    expect(isDuplicateQuestion('它主要是塑料材质的吗？', ['它主要是金属材质的吗？'])).toBe(false)
    expect(isDuplicateQuestion('它通常是圆柱形的吗？', ['它通常是圆柱形的么？'])).toBe(true)
  })

  it('典型用途只换主要用于和通常用来，不成为一道新题', () => {
    expect(isDuplicateQuestion('它通常用来辅助个人护理或美容吗？', ['它主要用于个人护理或美容吗？'])).toBe(true)
    expect(isDuplicateQuestion('它主要用于提供网络或通信吗？', ['它通常用来提供网络或通信吗？'])).toBe(true)
    expect(isDuplicateQuestion('它通常用来清洁吗？', ['它主要用于照明吗？'])).toBe(false)
  })

  it('用途与能力、不同用途及否定仍分开判断', () => {
    expect(isDuplicateQuestion('它能用于加热食物吗？', ['它通常用于加热食物吗？'])).toBe(false)
    expect(isDuplicateQuestion('它可以用来加热食物吗？', ['它主要用于加热食物吗？'])).toBe(false)
    expect(isDuplicateQuestion('它不是主要用于照明的吗？', ['它通常用来照明吗？'])).toBe(false)
  })

  it('没有任何历史时不算重复', () => {
    expect(isDuplicateQuestion('是动物吗？', [])).toBe(false)
  })

  it('空问题不判重复', () => {
    expect(isDuplicateQuestion('', ['是动物吗？'])).toBe(false)
  })

  it('相似度对相同文本返回 1', () => {
    expect(similarity('是动物吗', '是动物吗')).toBe(1)
    expect(similarity('是动物吗', '是完全无关的问题')).toBeLessThan(0.3)
  })
})

describe('validateReply 收口校验', () => {
  it('显式属性不暴露随手填写的候选，分类也不能作为最终猜测', () => {
    const ask = validateReply(JSON.stringify({ action: 'ask', question: '它是主角吗？', guess: '奶龙' }), [])
    expect(ask.ok && ask.reply.guess).toBe('')
    expect(validateReply(JSON.stringify({ action: 'guess', guess: '厨房电器' }), []).ok).toBe(false)
    expect(validateReply(JSON.stringify({ action: 'guess', guess: '动画角色' }), []).ok).toBe(false)
    const legacy = validateReply(
      JSON.stringify({ question: '它需要用电吗？', guess: '厨房电器', confidence: 0.99 }),
      []
    )
    expect(legacy.ok && legacy.reply.guess).toBe('')
  })

  it('具体名字、颜色和否定不同，不因句式相似而误拦截', () => {
    expect(isDuplicateQuestion('它是超级马里奥吗？', ['它是超级瓦里奥吗？'])).toBe(false)
    expect(isDuplicateQuestion('这个角色的身体主要是黄色的吗？', ['这个角色的身体主要是红色的吗？'])).toBe(false)
    expect(isDuplicateQuestion('它不是人造的吗？', ['它是人造的吗？'])).toBe(false)
  })

  it('带上完整旧线索并保持实际轮次编号，候选只作为假设', () => {
    const turns = Array.from({ length: 20 }, (_, index) => ({
      question: `线索${index + 1}吗？`,
      answer: 'no' as const
    }))
    const content = buildGuessMessages(turns, 20, [], undefined, ['皮卡丘'], ['奶龙']).at(-1)!.content
    expect(content).toContain('9. 问：线索9吗？')
    expect(content).toContain('1. 问：线索1吗？')
    expect(content).toContain('不是事实')
  })

  it('常见换说法也拦截，开放问题不能当成候选绕过校验', () => {
    expect(isDuplicateQuestion('它是不是某种动物呢？', ['它是动物吗？'])).toBe(true)
    expect(validateReply(JSON.stringify({ question: '它是什么吗？' }), []).ok).toBe(false)
    expect(validateReply(JSON.stringify({ action: 'guess', guess: '奶龙' }), [], ['奶龙']).ok).toBe(false)
  })

  it('合法回复直接通过', () => {
    const out = validateReply('{"question":"是活物吗？","guess":"","confidence":0}', [])
    expect(out.ok).toBe(true)
  })

  it('解析失败时给出重问提示', () => {
    const out = validateReply('我不太确定该怎么问', [])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.hint.kind).toBe('parse')
    expect(out.hint.raw).toContain('不太确定')
  })

  it('一次问多件事时给出 multi 违规提示', () => {
    const out = validateReply('{"question":"是动物还是植物？","guess":"","confidence":0}', [])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.hint.kind).toBe('multi')
  })

  it('重复提问时给出 duplicate 违规提示', () => {
    const out = validateReply('{"question":"是动物吗？","guess":"","confidence":0}', ['是动物吗？'])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.hint.kind).toBe('duplicate')
  })

  it('指认式问题漏填 guess 时自动提取具体答案', () => {
    const direct = validateReply('{"question":"它是微波炉吗？","guess":"","confidence":0.7}', [])
    expect(direct.ok).toBe(true)
    if (direct.ok) expect(direct.reply.guess).toBe('微波炉')
  })
})

describe('buildGuessMessages 消息组装', () => {
  const turns: Array<{ question: string; answer: GuessAnswer }> = [
    { question: '是活物吗？', answer: 'yes' },
    { question: '比手机大吗？', answer: 'no' }
  ]

  it('第一条永远是 system', () => {
    const messages = buildGuessMessages([])
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('猜心')
  })

  it('开局时给出「先切大类」的指令', () => {
    const messages = buildGuessMessages([])
    expect(messages[messages.length - 1].content).toContain('第一个问题')
  })

  it('把历史问答带进上下文', () => {
    const messages = buildGuessMessages(turns)
    const flat = messages.map((m) => m.content).join('\n')
    expect(flat).toContain('是活物吗？')
    expect(flat).toContain('比手机大吗？')
    expect(flat).toContain('已经问了 2 轮')
  })

  it('重问时附带上一轮的原文与违规原因', () => {
    const messages = buildGuessMessages(turns, turns.length, [], {
      raw: '{"question":"是动物还是植物？"}',
      reason: '一次问了多个选项',
      kind: 'multi'
    })
    const flat = messages.map((m) => m.content).join('\n')
    expect(flat).toContain('一次问了多个选项')
    expect(flat).toContain('是动物还是植物')
  })

  it('总轮数可以把「尚未回答的那一轮」算进去', () => {
    const flat = buildGuessMessages(turns, 18)
      .map((m) => m.content)
      .join('\n')
    expect(flat).toContain(`已经问了 18 轮，本局最多 ${MAX_ROUNDS} 轮`)
  })

  it('所有轮次都由模型自主决定提问还是猜测', () => {
    const round21 = buildGuessMessages(turns, 20).at(-1)?.content ?? ''
    const round60 = buildGuessMessages(turns, 59).at(-1)?.content ?? ''
    expect(round21).not.toContain('本轮必须猜一个具体答案')
    expect(round60).not.toContain('本轮必须猜一个具体答案')
  })

  it('带上前端 transcript 里的历史消息', () => {
    const messages = buildGuessMessages(turns, turns.length, [
      { role: 'assistant', content: '{"question":"是活物吗？","guess":"","confidence":0}' },
      { role: 'user', content: '是' }
    ])
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('是活物吗'))).toBe(true)
    expect(messages[0].role).toBe('system')
  })

  it('轮数超过上下文上限时，把更早的问题单列出来防重复', () => {
    const many = Array.from({ length: MAX_CONTEXT_TURNS + 3 }, (_, i) => ({
      question: `第 ${i} 个问题？`,
      answer: 'no' as GuessAnswer
    }))
    const flat = buildGuessMessages(many)
      .map((m) => m.content)
      .join('\n')
    expect(flat).toContain('更早的问答')
    expect(flat).toContain('第 0 个问题？')
  })

  it('轮数没超出上下文上限时不做多余罗列', () => {
    const few = Array.from({ length: 4 }, (_, i) => ({ question: `第 ${i} 个问题？`, answer: 'no' as GuessAnswer }))
    const flat = buildGuessMessages(few)
      .map((m) => m.content)
      .join('\n')
    expect(flat).not.toContain('更早问过的问题')
  })

  it('把用户否定过的答案单独列出来，防止模型换个说法再猜一次', () => {
    const flat = buildGuessMessages(turns, turns.length, [], undefined, ['微波炉', '电饭煲'])
      .map((m) => m.content)
      .join('\n')
    expect(flat).toContain('对方已经明确否定过这些答案')
    expect(flat).toContain('微波炉')
    expect(flat).toContain('电饭煲')
  })

  it('没有被否定的答案时不多说一句', () => {
    const flat = buildGuessMessages(turns)
      .map((m) => m.content)
      .join('\n')
    expect(flat).not.toContain('对方已经明确否定过这些答案')
  })
})

describe('extractGuessCandidate 从「它是 X 吗？」里抽候选', () => {
  it('抽出指认式问句里的答案', () => {
    expect(extractGuessCandidate('它是微波炉吗？')).toBe('微波炉')
    expect(extractGuessCandidate('它是苹果吗？')).toBe('苹果')
    expect(extractGuessCandidate('它叫周杰伦吗？')).toBe('周杰伦')
  })

  it('去掉量词', () => {
    expect(extractGuessCandidate('它是一只猫吗？')).toBe('猫')
    expect(extractGuessCandidate('它是一台洗衣机吗？')).toBe('洗衣机')
  })

  it('上位分类不算答案：答「是」只说明范围缩小了', () => {
    expect(extractGuessCandidate('它是动物吗？')).toBe('')
    expect(extractGuessCandidate('它是生物吗？')).toBe('')
    expect(extractGuessCandidate('它是猫科动物吗？')).toBe('')
    expect(extractGuessCandidate('它是抽象概念吗？')).toBe('')
    expect(extractGuessCandidate('它是文化作品吗？')).toBe('')
    // 「它是固体吗？」在真机跑的时候被当成了答案，用户只能白点一次「不是」
    expect(extractGuessCandidate('它是固体吗？')).toBe('')
    expect(extractGuessCandidate('它是有机物吗？')).toBe('')
  })

  it('具体的东西照旧能抽出来（别把规则收得太狠）', () => {
    expect(extractGuessCandidate('它是礼物吗？')).toBe('礼物')
    expect(extractGuessCandidate('它是金属吗？')).toBe('金属')
  })

  it('属性问句不算答案', () => {
    expect(extractGuessCandidate('它是人造的吗？')).toBe('')
    expect(extractGuessCandidate('它能显示图像吗？')).toBe('')
    expect(extractGuessCandidate('它需要用电吗？')).toBe('')
    expect(extractGuessCandidate('它是白色的吗？')).toBe('')
    expect(extractGuessCandidate('它是猫的品种之一吗？')).toBe('')
  })

  it('不是指认式问句就返回空串', () => {
    expect(extractGuessCandidate('它通常放在室内使用吗？')).toBe('')
    expect(extractGuessCandidate('它比手机大吗？')).toBe('')
    expect(extractGuessCandidate('是活物吗？')).toBe('')
    expect(extractGuessCandidate('')).toBe('')
    expect(extractGuessCandidate('它是猫还是狗？')).toBe('')
  })

  it('过长的候选不当成答案', () => {
    expect(extractGuessCandidate('它是一台可以自动清洗并且带烘干功能的家用电器吗？')).toBe('')
  })
})

describe('pickFallbackQuestion 兜底问题', () => {
  it('没有历史时给第一个', () => {
    expect(pickFallbackQuestion([])).toBe(FALLBACK_QUESTIONS[0])
  })

  it('问过的跳过，不会连着端上同一个问题', () => {
    const picked = pickFallbackQuestion([FALLBACK_QUESTIONS[0], FALLBACK_QUESTIONS[1]])
    expect(picked).toBe(FALLBACK_QUESTIONS[2])
  })

  it('全都问过时返回 null，不重复最后一个', () => {
    expect(pickFallbackQuestion([...FALLBACK_QUESTIONS])).toBeNull()
  })
})

describe('answerLabel 回答文案', () => {
  it('三种回答都有中文说法', () => {
    expect(answerLabel('yes')).toBe('是')
    expect(answerLabel('no')).toBe('否')
    expect(answerLabel('unsure')).toBe('不确定')
  })
})
