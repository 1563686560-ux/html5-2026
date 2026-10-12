/**
 * 猜心玩法的提示词与回复校验（纯函数）
 * ------------------------------------------------------------------
 * 玩法要求「每轮只问一个封闭式问题」，这是模型最容易违反的一条约束：
 * 它天生倾向于一次抛出好几个问题、或者把已经问过的问题换个说法再问一遍。
 * 所以这里把「解析 + 校验」写成不依赖任何 UI / 状态的纯函数，
 * store 只负责调用与重试，规则本身可以被单测覆盖。
 *
 * 另一个刻意的取舍：所有校验函数都**返回结果而不是抛异常**。
 * 违规是这条链路的常态（每局都可能遇到），用异常表达会让 store 的
 * 控制流变成 try/catch 套娃，也很难区分「模型违规」和「网络失败」。
 */

import type { ChatMessage } from '@/api/types'
import { buildEvidence, normalizeGuessName, parseNames, type ReasoningTurn } from './guessReasoning'

/** 模型每轮应当返回的结构化结果 */
export interface GuessReply {
  action?: 'ask' | 'guess'
  candidates?: string[]
  /** 模型对各候选回答本轮问题的预测，仅用于检查问题是否有区分度。 */
  split?: { yes: string[]; no: string[]; unsure: string[] }
  /** 同一个属性命题始终使用同一个键，包含属性值及否定关系。 */
  questionKey?: string
  /** 由独立模型核对返回，不能从本地知识库补答案。 */
  aliases?: string[]
  /** 本轮的问题，必然以问号结尾 */
  question: string
  /** 敢下结论时给出的答案，否则为空串 */
  guess: string
  /** 对 guess 的置信度，0~1；没给 guess 时为 0 */
  confidence: number
  /** 模型原始输出，违规重问时用它保留上下文 */
  raw: string
}

/** 违规重问时告诉模型「上一轮错在哪」 */
export interface ViolationHint {
  /** 上一轮的原始输出 */
  raw: string
  /** 人话描述的问题，同时会写进提示词让模型自查 */
  reason: string
  kind: 'empty' | 'parse' | 'multi' | 'duplicate' | 'conflict'
}

/** 违规判定结果：ok=false 时 reason 一定有值 */
export interface Violation {
  ok: boolean
  reason: string
  kind: 'multi' | 'duplicate'
}

export type GuessAnswer = 'yes' | 'no' | 'unsure'

/** 最长对局轮数；到顶仍未猜中就如实结算为失败。 */
export const MAX_ROUNDS = 60
/** 兼容旧格式：达到阈值只能提出候选，仍须核对并由用户确认。 */
export const GUESS_CONFIDENCE_THRESHOLD = 0.8
/** 整轮的生成、候选核对与修正共享预算，禁止逐次重置计时。 */
export const GUESS_ROUND_TIMEOUT_MS = 30_000
/** 上下文里最多带几轮问答：20 轮全带会拖慢首字，也容易让模型绕回旧话题 */
export const MAX_CONTEXT_TURNS = 12

/** 与 assembler.ts 同款的分节与列表写法，保持两个提示词模块观感一致 */
function section(title: string, body: string): string {
  return `# ${title}\n${body}`
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

/**
 * 组装 system prompt。
 * 分段风格与 assembler.ts 保持一致（`# 标题` + 短横线列表），
 * 但内容完全不同 —— 这个玩法不需要人设，只需要严格的提问纪律。
 */
export function buildGuessSystemPrompt(): string {
  const parts: string[] = []

  parts.push(
    section(
      '你正在玩「猜心」',
      [
        '对方心里想好了一样东西（可以是人、动物、物品、一部电影、一个学科概念等），但没有告诉你是什么。',
        '你的任务是通过逐个提问把它猜出来。对方只会回答「是」「否」或「不确定」。'
      ].join('\n')
    )
  )

  parts.push(
    section(
      '每轮只输出一个问题（最重要）',
      bullets([
        '每轮只能输出一个问题，且必须能用「是」或「否」回答',
        '一个问句里只允许有一个问号；禁止出现「是 A 还是 B」「是不是既……又……」这类一次问多件事的句子',
        '禁止重复提问：已经问过的问题，换个说法再问一遍也算重复',
        '不要在问题里夹带安慰、解说、追问或第二个问题',
        '提问要短，控制在 20 字以内，手机上要一眼能读完',
        '有一个明显领先且符合线索的具体候选时就可以尝试猜测，无需等到绝对确定或唯一答案；猜错可以继续',
        '猜测时 action 写 guess，question 写「它是 X 吗？」，guess 填 X；询问属性时 action 写 ask，guess 留空',
        `整局最多 ${MAX_ROUNDS} 轮；由你根据现有线索自主判断是继续提问，还是猜一个具体答案`
      ])
    )
  )

  parts.push(
    section(
      '被否定之后怎么办',
      bullets([
        '如果你提出的答案被对方否定，app 会明确告诉你「答案不是 X」——请把 X 彻底移出候选集',
        '否定一个具体答案只排除那个答案，不要推翻已经确认的大类和属性，也不要用别名再次猜它',
        '候选都被排除时，扩展同一范围的其他候选；不要从头重问已经有答案的属性',
        '一次具体猜测被否定后，优先问一个能区分其他合理候选的新属性；不要立即连续报另一个名字，除非有多条独立线索支持它明显领先'
      ])
    )
  )

  parts.push(
    section(
      '候选集收敛策略',
      bullets([
        '先大类后细节：区分「虚构角色 / 现实人物 / 实体物品或生物 / 抽象概念」，根据已有线索选择有效维度，不固定按类别逐项排查',
        '不要用含糊的「人造物」开局：动画角色也是人创作的，但不代表它是现实物品。确认实体之前不要问材料、用电、用途',
        '现实实体也可能是自然地貌、天体或自然物，并不等于人造用品；尚未确认是人造物之前，不要默认它有使用场景和用途。候选覆盖自然与人造两边，先问来源或可观察特征',
        '人造实体不等于日用品：固定的大型对象也可能是历史建筑、知名地标或基础设施，应先比较类别、尺寸、年代和结构，不要只在家用物品中寻找',
        '再逐层二分：每轮问题都应尽可能把当前候选集一分为二，优先问覆盖一半候选的问题',
        '对方答「不确定」时，说明这个问题区分度不够，下一轮换一个更客观、更容易判断的属性',
        '每轮更新 3~5 个可能的具体候选，填入 candidates；候选只是假设，绝不能作为用户确认的事实',
        '先区分现实实体与虚构角色；虚构角色继续问来源、外形、特征，不能按真实动物的栖息地和生理分类死问',
        '选能区分剩余候选的属性。例如都已经是卡通角色，就不要反复确认动画、虚构和角色这三个同义线索',
        '不要挨个枚举作品、品牌、国家来试答案。连续否定同类来源后，优先问外形、颜色、时代、用途等区分特征',
        '已确认是人造实体时，优先比较尺寸、结构、是否用电、使用场景等不同维度；不要连续枚举照明、穿戴、切割等用途来碰运气。某个用途大类已确认后，优先问工作方式或外形，避免反复细分用途',
        '不确定不等于否：换容易观察的属性，不凭空排除候选',
        '每轮在心里更新一次候选集与置信度，不要反复试探同一个属性',
        '用户事实清单是唯一可靠上下文：肯定、否定、不确定必须分别处理，任何候选和推断都不是事实',
        '先用全部已知线索检查候选的矛盾，移除违反明确线索和已被否定的候选及其别名；不要只考虑上一轮的 3~5 个候选',
        '中文用户可能想到国产作品和中文互联网常见对象；搜索时覆盖这些范围，不局限于欧美日经典作品，也不能因为用户说中文就认定答案来自中国',
        '只提出你确知存在的具体名称，想不出时允许候选较少或为空，不用描述性标签、杜撰的作品或角色填满候选数',
        '候选列表只是开放世界中的少量假设，不能当成完整答案空间；它们都不合适时扩大范围，保留已经确认的属性',
        '用途不等于品类，例如肯定娱乐用途不等于确认是玩具，还应比较乐器、体育器材等其他合理类别；不要把你自己的分类联想写成用户事实',
        '每个问题填写 questionKey，格式为「属性:取值」，同一个命题换措辞仍复用原键；不同颜色、国家、具体名称或否定关系要用不同键',
        '优先提出当前候选回答会不同、且用户容易判断的问题；如果所有候选答案相同，就换一个维度',
        '不确定或歧义较多时，改问可观察的外形、行为、用途等特征，不要求用户掌握专业分类',
        '用途提问明确写「主要用于」或「通常用来」，区分主要用途与偶尔具备的能力，不能从「能做某事」推断该物品专门用于该事',
        '连续猜错或候选不变时重新规划，不继续逐个报名字碰运气；存在符合线索且明显领先的具体对象时及时尝试猜测'
      ])
    )
  )

  parts.push(
    section(
      '输出格式（必须严格遵守）',
      [
        '只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：',
        '{"action":"ask","question":"你的下一个问题？","questionKey":"属性:取值","guess":"","confidence":0,"candidates":["具体候选甲","具体候选乙"],"split":{"yes":["具体候选甲"],"no":["具体候选乙"],"unsure":[]}}',
        '尝试猜测时格式：{"action":"guess","question":"它是具体名字吗？","guess":"具体名字","confidence":0.7,"candidates":["具体名字"]}',
        '',
        bullets([
          'question：本轮的问题，必须以「？」结尾',
          'guess：尝试指认具体答案时填写；不要填厨房电器、卡通角色这类分类',
          'confidence：0 到 1 之间的小数，表示你对 guess 的把握；guess 为空时写 0',
          '每个属性问题必须填写 questionKey（稳定的属性命题键）；有两轮用户回答后必须给出 2~5 个具体候选，不能一直留空',
          'split：把 candidates 按你预测它们对本轮问题的回答放入 yes、no、unsure；每个候选恰好出现一次，yes 与 no 都必须非空',
          '如果所有候选对问题的回答都相同，这个问题没有区分度，换一个问题；如果只剩一个明显领先的对象，请用 action=guess 尝试猜测',
          '格式中的具体候选甲、具体候选乙只是占位符，实际输出必须换成你根据线索想到的真实具体名称。不要输出思考过程'
        ])
      ].join('\n')
    )
  )

  return parts.join('\n\n')
}

/** 把历史问答渲染成给模型看的文字记录 */
export function formatTurns(turns: Array<{ question: string; answer: GuessAnswer }>, offset = 0): string {
  return turns
    .map((turn, index) => `${index + offset + 1}. 问：${turn.question}\n   答：${answerLabel(turn.answer)}`)
    .join('\n')
}

/** 回答的中文说法，界面与提示词共用一份，避免两处不一致 */
export function answerLabel(answer: GuessAnswer): string {
  if (answer === 'yes') return '是'
  if (answer === 'no') return '否'
  return '不确定'
}

/** 校验失败时组装重问指令：把上一轮的原样输出和违规点都摆出来 */
export function buildRetryMessage(hint: ViolationHint): string {
  return [
    `你上一轮的输出是：${hint.raw.trim() || '（空）'}`,
    `它违反了规则：${hint.reason}`,
    '请按系统要求重新输出完整的 JSON；属性问题须填写 questionKey、具体 candidates 及 split 区分计划，尝试猜具体答案时 action 写 guess 并填写 guess。',
    '如果上一轮已经问过的问题被判定为重复，请换一个全新的、能从另一个角度二分候选集的问题。'
  ].join('\n')
}

/**
 * 拼出本轮要发给模型的完整消息：system + 历史记录 + 本轮指令。
 *
 * 参数分成「已回答的轮次」和「总轮数」两个：正在提问的那一轮还没有答案，
 * 不能被渲染成「问：… 答：不确定」，但轮数计数又必须把它算进去。
 *
 * `rejected` 是用户明确否定过的答案。模型对自己猜过的东西有很强的复读倾向，
 * 光靠对话历史里那句「不是 X」压不住，所以这里再单独列一遍。
 */
export function buildGuessMessages(
  asked: Array<ReasoningTurn & { answer: GuessAnswer }>,
  totalRounds = asked.length,
  transcript: ChatMessage[] = [],
  retry?: ViolationHint,
  rejected: string[] = [],
  candidates: string[] = [],
  recovery = ''
): ChatMessage[] {
  const lines = [
    asked.length === 0
      ? '对局刚刚开始，请提出你的第一个问题：选择容易回答、能区分大类的属性，不预设目标是现实实体或虚构角色。'
      : `已经问了 ${totalRounds} 轮，本局最多 ${MAX_ROUNDS} 轮。下面是「你问过的」记录，请据此继续收敛，不要重复发问：\n${formatTurns(
          asked.slice(-MAX_CONTEXT_TURNS),
          Math.max(0, asked.length - MAX_CONTEXT_TURNS)
        )}`
  ]

  lines.push('记住：只返回一个 JSON 对象，本轮只问一个问题，且不能与上面的问题重复。')
  const evidence = buildEvidence(asked)
  lines.push(
    `用户事实清单（保留原始问句，不得擅自改写含义）：${JSON.stringify({
      confirmed: evidence.filter((item) => item.answer === 'yes'),
      denied: evidence.filter((item) => item.answer === 'no'),
      unknown: evidence.filter((item) => item.answer === 'unsure')
    })}`
  )
  const keys = asked.flatMap((turn, index) => (turn.questionKey ? [{ id: index + 1, key: turn.questionKey }] : []))
  if (keys.length) lines.push(`已使用的属性命题键（同义问题不能换键绕过）：${JSON.stringify(keys)}`)
  if (candidates.length) lines.push(`上一轮候选假设（不是事实，请结合最新回答更新）：${candidates.join('、')}`)
  if (asked.at(-1)?.answer === 'yes' && asked.at(-1)?.action === 'ask') {
    lines.push('上一条属性问题得到肯定：先判断问句是否已经包含一个可以独立称呼的具体对象名称。若是，优先用 action=guess 尝试该常用名称；若只是属性或宽泛分类，继续问。用户没有指定细分粒度，不能默认还需要猜具体地区、路段、品种、品牌或型号，更不能把已经肯定的名称遗漏掉。')
  }
  if (recovery) lines.push(`本轮重新规划：${recovery}`)

  // 上下文只带最近 MAX_CONTEXT_TURNS 轮，更早的问题先从 transcript 里掉出去了。
  // 这里把那些掉出去的原句再列一遍，防止模型绕回十几轮前的旧问题。
  if (asked.length > MAX_CONTEXT_TURNS) {
    const older = asked.slice(0, -MAX_CONTEXT_TURNS)
    lines.push(`更早的问答（保留这些线索，禁止重复提问）：\n${formatTurns(older)}`)
  }

  if (rejected.length > 0) {
    lines.push(
      `对方已经明确否定过这些答案，不要再猜它们，也不要再问「它是其中的某一个吗」：\n${rejected
        .map((item) => `- ${item}`)
        .join('\n')}`
    )
  }

  // transcript 由调用方按「一问一答」拼好（每轮两条消息）：
  // 历史里保留模型自己的 JSON 而不是解析后的问句 ——
  // 模型看到自己一贯的输出格式，下一轮更不容易跑偏。
  const messages: ChatMessage[] = [
    { role: 'system', content: buildGuessSystemPrompt() },
    ...transcript.slice(-MAX_CONTEXT_TURNS * 2)
  ]
  if (retry) messages.push({ role: 'user', content: buildRetryMessage(retry) })
  messages.push({ role: 'user', content: lines.join('\n\n') })
  return messages
}

/** 把一轮问答转成两条对话消息，供 store 追加到 transcript */
export function turnToMessages(turn: ReasoningTurn & { answer: GuessAnswer }): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: JSON.stringify({
        action: turn.action ?? 'ask',
        question: turn.question,
        questionKey: turn.questionKey,
        guess: turn.action === 'guess' ? (turn.guess ?? extractGuessCandidate(turn.question)) : '',
        confidence: 0,
        candidates: turn.candidates ?? []
      })
    },
    { role: 'user', content: answerLabel(turn.answer) }
  ]
}

/**
 * 抽出第一个「括号配对完整」的 JSON 对象。
 *
 * 不用 indexOf('{') + lastIndexOf('}') 是因为模型常写成
 * 「我的问题是 {"question":"...？"} 请回答」——末尾那句话会让
 * lastIndexOf 抓到错误的位置，整段解析直接失败。
 * 这里在字符串字面量内部跳过括号，避免把问题里的花括号当成结构符。
 */
function sliceFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
      if (depth < 0) return null
    }
  }

  return null
}

/**
 * 脱掉代码块围栏并截到第一个 JSON 对象。
 * 有些模型会把整个回复包成 ```json，有些只包一半，所以围栏是可选的。
 */
export function extractJsonText(raw: string): string | null {
  const text = raw
    .trim()
    .replace(/^```(?:json|JSON)?\s*/, '')
    .replace(/\s*```\s*$/, '')
  return sliceFirstJsonObject(text)
}

/** 先剥围栏再解析，失败时再直接解析整段（应对回复本身就是纯 JSON 的情况） */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const candidates = [extractJsonText(text), text.trim()]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const value: unknown = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      /* 换下一个候选继续试 */
    }
  }
  return null
}

/** 容错抽取第一个字符串字段；模型偶尔会把数组或对象塞进 question */
function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) return trimmed
    }
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim())
      if (typeof first === 'string') return first.trim()
    }
  }
  return ''
}

/** confidence 归一化：数字、字符串、百分数、"0.7 左右"都要能读出来，并夹到 0~1 */
function normalizeConfidence(value: unknown): number {
  let parsed: number | null = null

  if (typeof value === 'number' && Number.isFinite(value)) {
    parsed = value
  } else if (typeof value === 'string') {
    const match = value.match(/-?\d+(?:\.\d+)?/)
    if (match) {
      parsed = Number(match[0])
      // 写成 "70%" 的模型不少，只当 70 处理会得到一个离谱的 1
      if (value.includes('%')) parsed /= 100
    }
  }

  if (parsed === null || !Number.isFinite(parsed)) return 0
  if (parsed > 1 && parsed <= 100) parsed /= 100
  return Math.min(1, Math.max(0, parsed))
}

/** 只有一个问号、且以问号收尾，才可能是一个封闭式问题 */
function isClosedQuestion(question: string): boolean {
  const marks = question.match(/[?？]/g)?.length ?? 0
  return marks === 1 && (question.endsWith('?') || question.endsWith('？'))
}

/**
 * 开放式提问。
 * 单个疑问词就能说明「这不是能用是 / 否回答的问题」——
 * 比如「它是什么颜色的？」如果只靠逗号分句去抓，是抓不到的。
 */
const OPEN_PATTERN = /什么|谁|哪里|哪儿|哪一?个|哪个|多少|为什么|怎么|如何|几种|哪些/

/**
 * 违规模式。
 * 这里全部靠「问句结构」判断，而不是统计问号数量 ——
 * 模型最常见的违规是「是 A 还是 B」，整句只有末尾一个问号，数问号抓不到。
 * 宁可偶尔误判（代价只是重问一次），也不能把两个问题当成一个问题发给用户。
 */
const VIOLATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /还是|或是|抑或/, reason: '一次问了多个选项（是 A 还是 B），必须拆成每轮只有一个问题' },
  { pattern: /(^|[，,。；;、])\s*或者/, reason: '句中出现「或者」，像是在一次问多件事' },
  { pattern: /是不是[^，。！？?!]{0,24}(?:，|,)[^，。！？?!]{0,24}[吗么？?]/, reason: '一句话里问了多件事' },
  {
    pattern: /[，,][^，。！？?!]{0,24}(?:吗|呢|么)[？?]/,
    reason: '逗号前另有一个「……吗？」的小问句，属于一次问了多个问题'
  },
  {
    pattern: /(?:并且|而且|同时|以及|还有|另外|顺便)[^，。！？?!]{0,24}(?:[？?])/,
    reason: '用「并且/以及」这类词附加了第二个问题'
  },
  { pattern: OPEN_PATTERN, reason: '出现了开放式提问（什么/为什么/怎么……），不是封闭式问题' },
  {
    pattern: /(?:请|麻烦|能不能|能否|可以)?\s*(?:告诉|说说|描述|列举|介绍)我?(?:一下|下)?/,
    reason: '要求对方描述或列举，不是封闭式问题'
  }
]

/**
 * 校验「单问约束」。
 * FR-G2 要求每轮只问一个封闭式问题，所以问号数量、开放式提问、
 * 以及「是 A 还是 B」这类句式都要拦下来。
 */
export function validateSingleQuestion(question: string): Violation {
  const text = question.trim()
  if (!text) return { ok: false, reason: '模型没有给出问题', kind: 'multi' }

  const marks = text.match(/[?？]/g)?.length ?? 0
  if (marks > 1) return { ok: false, reason: `一句话里出现了 ${marks} 个问号，属于一次问了多个问题`, kind: 'multi' }

  if (!isClosedQuestion(text)) {
    return { ok: false, reason: '这不是一个以问号结尾的封闭式问题', kind: 'multi' }
  }

  for (const rule of VIOLATION_PATTERNS) {
    if (rule.pattern.test(text)) return { ok: false, reason: rule.reason, kind: 'multi' }
  }

  return { ok: true, reason: '', kind: 'multi' }
}

/** 归一化：去空白、去标点、去语气词、统一小写，用于判重 */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/[吗呢么呀啊吧啦哦噢嗯]/g, '')
}

/** 常见的是非问句换说法；保留否定、颜色和具体名字等有效区分。 */
function questionMeaning(text: string): string {
  return normalizeQuestion(text)
    .replace(/^(?:你想的|你心里想的|这个东西|这个角色|它)/, '')
    .replace(/是否|是不是/, '是')
    .replace(/某种|一种|一个/, '')
    .replace(/虚拟|虚构的/, '虚构')
    .replace(/卡通/, '动画')
    .replace(/需要用电|需要电力|使用电力|依靠电力/, '用电')
    .replace(/^(?:主要|通常|一般|平时)?(?:用于|用来)(?:帮助|辅助)?/, '用途')
    .replace(/主要颜色|主要是|颜色是|身体是|全身是/, '是')
    .replace(/的/g, '')
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>()
  if (text.length < 2) {
    if (text) set.add(text)
    return set
  }
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2))
  return set
}

/** Dice 系数：模型换个说法重问时，字面不同但相似度仍然很高 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const left = bigrams(a)
  const right = bigrams(b)
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return (2 * shared) / (left.size + right.size)
}

/** 相似度阈值：低于它就当作新问题，避免把「是活的吗」和「是人吗」误判成重复 */
const DUPLICATE_SIMILARITY = 0.82

/**
 * 重复检测（FR-G2 的「不得重复提问」）。
 * 两级判断：归一化后完全相同直接算重复；否则再过一遍相似度，
 * 抓住「换个说法再问一遍」这种更难发现的情况。
 */
export function isDuplicateQuestion(question: string, history: string[]): boolean {
  const normalized = normalizeQuestion(question)
  if (!normalized) return false

  for (const item of history) {
    const other = normalizeQuestion(item)
    if (!other) continue
    // 名字、具体属性值或否定不同，不能仅因句式相似就判成同一道题。
    const named = extractGuessCandidate(question)
    const previousName = extractGuessCandidate(item)
    if (named && previousName && named !== previousName) continue
    // 典型用途与偶尔能力是不同命题，不能因词面相似就抹掉这个差别。
    const intent = (value: string) => {
      if (/(?:能否|能不能|能够|可以|是否能|它能)/.test(value)) return 'capability'
      if (/(?:主要|通常|一般|平时)?(?:用于|用来)/.test(value)) return 'usage'
      return ''
    }
    const leftIntent = intent(question)
    const rightIntent = intent(item)
    if (leftIntent && rightIntent && leftIntent !== rightIntent) continue
    const details = (value: string) =>
      value.match(/不|没|非|红色|黄色|蓝色|绿色|黑色|白色|紫色|橙色|粉色|圆柱形?|长方形|正方形|三角形|圆形|球形|方形|锥形|金属|钢铁|木质|塑料|玻璃|陶瓷|\d+/g)?.join('|') ?? ''
    if (details(questionMeaning(question)) !== details(questionMeaning(item))) continue
    if (questionMeaning(item) === questionMeaning(question)) return true
    if (other === normalized) return true
    if (similarity(other, normalized) >= DUPLICATE_SIMILARITY) return true
    // 长问题里的核心短语被原样搬过来也算重复。
    // 门槛取 5 个字：再短就只剩「是活物」这种通用片段，会把真正的新问题误判成重复
    if (normalized.length >= 5 && other.includes(normalized)) return true
    if (other.length >= 5 && normalized.includes(other)) return true
  }

  return false
}

/**
 * 从模型回复里稳健地取出结构化结果（FR-G2 的解析环节）。
 * 任何一步失败都不抛异常，而是返回一个带 ok=false 的结果，
 * 让 store 决定「重问一次」还是「把原文透给用户」。
 */
export function parseGuessReply(
  text: string
): { ok: true; reply: GuessReply } | { ok: false; reason: string; kind: 'empty' | 'parse' } {
  const raw = text.trim()
  if (!raw) return { ok: false, reason: '模型返回了空内容', kind: 'empty' }

  const source = parseJsonLoose(raw)
  if (!source) return { ok: false, reason: '回复里没有找到合法的 JSON 对象', kind: 'parse' }

  let question = pickString(source, ['question', '问题', '下一个问题', 'q'])
  let guess = pickString(source, ['guess', 'answer', '答案', '猜测'])
  const confidence = normalizeConfidence(source.confidence ?? source.置信度 ?? source.conf)
  let action: GuessReply['action'] = source.action === 'ask' || source.action === 'guess' ? source.action : undefined
  if (action === 'guess' && guess && !/[?？\r\n]/.test(guess)) question = `它是${guess}吗？`
  if (question && !/[?？]/.test(question) && /[吗么]$/.test(question)) question += '？'
  const candidates = parseNames(source.candidates).slice(0, 5)
  // 模型可能将「它是候选名字吗」误标为 ask。仅对它自己列出的具体候选修正意图，
  // 属性词不会仅凭句型被升级为答案，随后仍须独立核对及用户确认。
  const namedCandidate = extractGuessCandidate(question)
  if (
    action === 'ask' &&
    namedCandidate &&
    candidates.some((name) => normalizeGuessName(name) === normalizeGuessName(namedCandidate))
  ) {
    action = 'guess'
    guess = namedCandidate
  }
  const partition = source.split && typeof source.split === 'object' ? (source.split as Record<string, unknown>) : null
  const split =
    partition && ['yes', 'no', 'unsure'].every((key) => Array.isArray(partition[key]))
      ? { yes: parseNames(partition.yes), no: parseNames(partition.no), unsure: parseNames(partition.unsure) }
      : undefined
  const questionKey =
    typeof source.questionKey === 'string' && normalizeGuessName(source.questionKey)
      ? source.questionKey.trim().slice(0, 100)
      : undefined

  // 兜底：模型把问题写进了 guess 字段（或反过来）时，取那一个看起来像问句的
  if (!question && /[?？]/.test(guess)) {
    return { ok: true, reply: { question: guess, guess: '', confidence, raw } }
  }
  if (!question) return { ok: false, reason: 'JSON 里缺少 question 字段', kind: 'parse' }

  return { ok: true, reply: { question, guess, confidence, raw, action, candidates, questionKey, split } }
}

/**
 * 三轮校验的收口：解析 → 单问约束 → 重复检测。
 * store 只调这一个函数，规则调整时不必再动状态机。
 */
export function validateReply(
  text: string,
  history: string[],
  rejected: string[] = [],
  questionKeys: string[] = []
): { ok: true; reply: GuessReply } | { ok: false; hint: ViolationHint } {
  const parsed = parseGuessReply(text)
  if (!parsed.ok) return { ok: false, hint: { raw: text, reason: parsed.reason, kind: parsed.kind } }

  const explicitGuess = parsed.reply.action === 'guess'
  const candidate = explicitGuess ? parsed.reply.guess : extractGuessCandidate(parsed.reply.question)
  if (explicitGuess) {
    if (!candidate || candidate.length > 60 || /[?？\r\n]/.test(candidate) || CANDIDATE_BROAD_WORDS.has(candidate)) {
      return { ok: false, hint: { raw: text, reason: '猜测必须是一个具体名称，不能是分类、问句或空值', kind: 'parse' } }
    }
  } else {
    const single = validateSingleQuestion(parsed.reply.question)
    if (!single.ok) return { ok: false, hint: { raw: text, reason: single.reason, kind: 'multi' } }
  }

  const repeatedQuestion = explicitGuess
    ? history.some((question) => normalizeGuessName(question) === normalizeGuessName(parsed.reply.question))
    : isDuplicateQuestion(parsed.reply.question, history)
  if (
    repeatedQuestion ||
    (parsed.reply.questionKey &&
      questionKeys.some((key) => normalizeGuessName(key) === normalizeGuessName(parsed.reply.questionKey!))) ||
    (parsed.reply.action === 'ask' ? [] : [candidate, parsed.reply.guess]).some(
      (x) => x && rejected.some((r) => normalizeGuessName(r) === normalizeGuessName(x))
    )
  ) {
    return {
      ok: false,
      hint: { raw: text, reason: '这个问题与之前问过的重复了', kind: 'duplicate' }
    }
  }

  // 演示友好：模型已经问出「它是 X 吗？」时，漏填 guess 不值得让整轮失败。
  // 直接从问句补齐，用户仍需亲自确认，准确性口径没有变化。
  if (parsed.reply.action === 'ask') parsed.reply.guess = ''
  else if (candidate) parsed.reply.guess = candidate
  else if (parsed.reply.guess && !extractGuessCandidate(`它是${parsed.reply.guess}吗？`)) parsed.reply.guess = ''
  if (!parsed.reply.guess) parsed.reply.confidence = 0
  parsed.reply.candidates = parsed.reply.candidates?.filter(
    (name) => !rejected.some((item) => normalizeGuessName(item) === normalizeGuessName(name))
  )

  return parsed
}

/**
 * 兜底问题：重问一次仍然违规时给用户看。
 * 宁可给出一个平庸但合法的问题，也不能把这轮直接吞掉让对局卡死。
 *
 * 之所以是一组而不是一个：实测里模型可能在同一个属性上反复违规，
 * 每次都端上同一个兜底问题，用户看到的就是「它卡住了」。
 * 这里按顺序挑第一个还没问过的；全部问过后返回 null，让状态机停下来等待重试。
 */
export const FALLBACK_QUESTIONS = [
  '它是人造的吗？',
  '它通常出现在日常生活里吗？',
  '它比一个成年人的手掌大吗？',
  '它和科学技术有关吗？',
  '它是具体存在、看得见摸得着的东西吗？'
] as const

/** 第一个兜底问题（保留单数导出，兼容既有调用方） */
export const FALLBACK_QUESTION = FALLBACK_QUESTIONS[0]

/** 从兜底问题里挑一个没问过的；全部耗尽时返回 null，绝不重复最后一个。 */
export function pickFallbackQuestion(history: string[]): string | null {
  return FALLBACK_QUESTIONS.find((question) => !isDuplicateQuestion(question, history)) ?? null
}

/**
 * 「它是 X 吗？」这类指认式问句里，这些词只是上位分类：
 * 对方答「是」说明范围缩小了，但绝不等于猜到了具体答案，
 * 拿它去宣布「猜中了」只会得到一个怪怪的结论。
 */
const CANDIDATE_BROAD_WORDS = new Set([
  '动物',
  '植物',
  '生物',
  '食物',
  '作品',
  '品牌',
  '工具',
  '机器',
  '厨房电器',
  '家用电器',
  '电器',
  '电子设备',
  '角色',
  '卡通角色',
  '动画角色',
  '虚构角色',
  '人物',
  '黄色',
  '红色',
  '蓝色',
  '绿色',
  '黑色',
  '白色',
  '圆形',
  '方形',
  '人',
  '人类',
  '东西',
  '物品',
  '物体',
  '人造物',
  '自然物',
  '天然物',
  '人工物',
  '物质',
  '固体',
  '液体',
  '气体',
  '有机物',
  '无机物',
  '存在',
  '概念',
  '抽象概念',
  '自然现象',
  '学科概念',
  '天体',
  '粒子',
  '能量',
  '辐射',
  '场'
])

/** 以这些词收尾的候选同样是分类，不是答案 */
const CANDIDATE_BROAD_SUFFIX =
  /(?:动物|植物|生物|物品|物体|东西|食物|概念|现象|物质|事件|活动|职业|学科|类型|种类|分类|范畴|用品|产品|工具|机器|作品|品种|型号|品牌|系列|款式)$/

/** 出现这些片段说明问的是「属性 / 范围」，不是「它是不是 X」 */
const CANDIDATE_REJECT_CONTAINS = /[的或还，,；;]|一种|一类|某种|某类|之一|一些|是否|能否|用来|属于|相关|有关|包含|包括/

/** 以这些词开头说明 X 是一段谓语（「能显示图像」），不是一个名词答案 */
const CANDIDATE_REJECT_PREFIX = /^(?:能|会|要|需|可以|可能|应该|用|由|被|在|有|没|经常|通常|主要|平时|比较)/

/** 候选答案的长度上限：再长就不是一个名字了 */
const CANDIDATE_MAX_LENGTH = 12

/**
 * 从「它是 X 吗？」这类指认式问句里抽出候选答案（没有就返回空串）。
 *
 * 这个函数是「猜中判定」的关键一环：模型经常把最后一步直接问成
 * 「它是微波炉吗？」，而把 guess 字段留空。只认 guess 字段的话，
 * 用户明明答了「是」，对局却不会结束。
 *
 * 反过来，抽错了也不致命 —— 抽出来的东西只会变成一句
 * 「我猜是 X，对吗？」，用户点「不是」就继续。
 */
export function extractGuessCandidate(question: string): string {
  const text = question.trim()
  if (!text) return ''
  // 一次只问一件事才有唯一的指认对象
  if ((text.match(/[?？]/g)?.length ?? 0) !== 1) return ''

  const body = text.replace(/[?？]\s*$/, '').trim()
  const match = body.match(/^它(?:是|叫|叫做|是叫)\s*(.+?)\s*(?:吗|吧|么)$/)
  if (!match) return ''

  const candidate = match[1]
    .trim()
    // 「它是一只猫吗」里的量词不属于答案本身
    .replace(/^一[只个台部件本位种名张把双套]/, '')
    .trim()

  if (!candidate || candidate.length > CANDIDATE_MAX_LENGTH) return ''
  if (CANDIDATE_BROAD_WORDS.has(candidate)) return ''
  if (CANDIDATE_BROAD_SUFFIX.test(candidate)) return ''
  if (CANDIDATE_REJECT_CONTAINS.test(candidate)) return ''
  if (CANDIDATE_REJECT_PREFIX.test(candidate)) return ''

  return candidate
}
