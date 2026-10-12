import type { ChatMessage } from '@/api/types'
import type { GuessAnswer, GuessReply, ViolationHint } from './guess'

/** 事实仅来自用户回答；模型候选与模型推断始终不进入此清单。 */
export interface GuessEvidence {
  id: number
  question: string
  answer: GuessAnswer
}

export interface ReasoningTurn {
  question: string
  answer: GuessAnswer | ''
  guess?: string
  questionKey?: string
  candidates?: string[]
  action?: 'ask' | 'guess'
}

export function buildEvidence(turns: ReasoningTurn[]): GuessEvidence[] {
  return turns.flatMap((turn, index) =>
    turn.answer ? [{ id: index + 1, question: turn.question, answer: turn.answer }] : []
  )
}

export function normalizeGuessName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

export function parseNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = new Map<string, string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    const key = normalizeGuessName(name)
    if (key && name.length <= 60) names.set(key, name)
    if (names.size === 8) break
  }
  return [...names.values()]
}

/** 只识别提问的语言维度，不判断目标对象的属性。 */
function questionDimension(turn: Pick<ReasoningTurn, 'question' | 'questionKey'>): string {
  if (/用于|用来|用途/.test(turn.question)) return '用途'
  return turn.questionKey?.split(/[:：]/)[0].trim() ?? ''
}

function stalledDimension(turns: ReasoningTurn[]): string {
  const recent = turns.filter((turn) => turn.answer).slice(-3)
  if (recent.length !== 3 || recent.some((turn) => turn.answer !== 'no' || turn.action === 'guess')) return ''
  const dimension = questionDimension(recent[0])
  return dimension && recent.every((turn) => questionDimension(turn) === dimension) ? dimension : ''
}

/** 推进建议属于软校验；不能因模型没有采用建议而永久阻断新问题。 */
export function validateExplorationPlan(reply: GuessReply, turns: ReasoningTurn[]): ViolationHint | null {
  const dimension = stalledDimension(turns)
  if (!dimension || questionDimension(reply) !== dimension) return null
  return {
    raw: reply.raw,
    kind: 'conflict',
    reason: `最近在「${dimension}」维度连续三个回答是否，停止逐项枚举；本轮改问另一个适用且容易观察的维度（例如外形、结构或工作方式），保留全部用户事实。`
  }
}

/** 只检测对话是否缺少推进，不在本机推断目标是什么。 */
export function recoveryReason(turns: ReasoningTurn[]): string {
  const answered = turns.filter((turn) => turn.answer)
  const recent = answered.slice(-3)
  const last = answered.at(-1)
  if (last?.answer === 'no' && (last.action === 'guess' || (last.action !== 'ask' && last.guess))) {
    return '刚刚猜错：只排除该对象及其别名，保留全部用户事实，重新扩展候选；比较其他合理对象，先问一个容易回答且能区分它们的属性，不连续逐个报名字。'
  }
  if (recent.filter((turn) => turn.answer === 'unsure').length >= 2) {
    return '最近多次回答不确定：改问容易观察且没有歧义的属性，不得把不确定当成否。'
  }
  if (recent.filter((turn) => turn.action === 'guess' && turn.answer === 'no').length >= 2) {
    return '最近连续猜错：保留用户事实，重新扩展候选，并先问能区分新候选的属性。'
  }
  const dimension = stalledDimension(answered)
  if (dimension) {
    return `最近在「${dimension}」方向连续被否定：停止逐项枚举这个维度，保留已确认属性，换一个适用且容易观察的维度（外形、结构或工作方式）并扩展候选。`
  }
  if (recent.length === 3 && recent.every((turn) => turn.candidates?.length)) {
    const first = recent[0].candidates!.map(normalizeGuessName)
    if (
      recent.slice(1).every((turn) => {
        const next = turn.candidates!.map(normalizeGuessName)
        return next.length === first.length && first.every((name) => next.includes(name))
      })
    )
      return '连续三轮候选没有变化：检查是否过早锁定范围，重新生成符合全部线索的候选，换一个区分维度。'
  }
  if (answered.length >= 6 && answered.length % 6 === 0) {
    return '已积累多轮线索：重新独立发现候选，检查是否一直被最初几个名字限制，不重复已经排除的答案。'
  }
  return ''
}

/** 独立发现候选时只提供用户事实，不携带上一轮模型的候选锚点。 */
export function buildReplanningMessages(evidence: GuessEvidence[], rejected: string[], reason = ''): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你负责猜心游戏的独立候选发现。你不知道秘密答案，只能根据用户已回答的线索提出可能对象。',
        '只把 yes/no 原始问答作为已确认线索，注意问句本身的否定词；unsure 表示未知。',
        '不要沿用先前问过的作品名或专业分类限制搜索范围；它们只是问题，用户否定它们不等于排除同类所有对象。',
        '区分虚构形象和现实动物，虚构形象的外观不能直接套用真实动物的专业生理分类。',
        '重新比较来自不同地域、年代和媒介的常见对象，优先选择符合明确线索且用户可能想到的具体名称。',
        '现实存在不等于人造用品，未确认人造之前同时考虑自然物、地貌和天体；否定某个用途不等于已经确认它是工具。',
        '这是中文用户的游戏，候选搜索应覆盖中文文化、国产作品与中文互联网、短视频中的常见形象，不能只在欧美日经典作品中寻找。按明确线索判断，不能仅凭语言就认定目标来自中国。',
        '先回忆符合这些特征的真实名称，再筛选候选。想不到足够多的真实对象时允许少于两个或留空，绝不能用「某色小动物」「某作品中的角色」等描述凑数。',
        '禁止输出已被用户否定的对象或别名，禁止编造一个听起来符合线索的新角色或新作品。',
        '重新规划原因只是调整搜索和提问策略，不是新增用户事实。猜错后优先找新的区分属性；连续不确定时优先找用户容易观察的特征。',
        '连续用途问题被否定时，重新比较不同结构、尺寸、能源和工作方式，不能仅换一批用途继续枚举；已确认用途大类后也优先寻找外形或工作方式上的区别。',
        '如果某个具体对象有多条独立线索支持且明显领先，就在 guess 中尝试该名称，不需要证明它是开放世界唯一答案；猜错后仍可继续。证据不足时 guess 留空。',
        '目标可能是整个建筑地标、普通物品名称或常用动物名称，不默认要求细分到某个路段、品牌、型号或品种。用户已肯定的问句若包含可独立称呼的具体名称，也要纳入候选并优先考虑尝试，不要只保留它的细分对象。',
        '只返回 JSON：{"candidates":["真实具体名称一","真实具体名称二"],"guess":"","confidence":0}。最多 8 个按匹配程度排序的真实候选；guess 非空时必须包含在 candidates 中。不要输出推理过程。'
      ].join('\n')
    },
    { role: 'user', content: JSON.stringify({ evidence, rejected, reason }) }
  ]
}

/** 区分依据完全由模型提供；程序只检查它的提问计划是否自洽。 */
export function hasUniformCandidateAnswers(reply: GuessReply): boolean {
  const candidates = reply.candidates?.map(normalizeGuessName) ?? []
  if (candidates.length < 2 || new Set(candidates).size !== candidates.length || !reply.split) return false
  const groups = [reply.split.yes, reply.split.no, reply.split.unsure]
  const all = groups.flat().map(normalizeGuessName)
  return (
    all.length === candidates.length &&
    new Set(all).size === all.length &&
    candidates.every((name) => all.includes(name)) &&
    groups.some((group) => group.length === candidates.length)
  )
}

export function validateQuestionPlan(reply: GuessReply, answeredCount: number): ViolationHint | null {
  const fail = (reason: string): ViolationHint => ({ raw: reply.raw, kind: 'conflict', reason })
  if (!reply.questionKey)
    return fail('属性问题缺少 questionKey；用稳定的「属性:取值」表示本轮命题，禁止只返回一个问题而不规划。')
  if (answeredCount < 2) return null
  if (!reply.candidates || reply.candidates.length < 2 || !reply.split) {
    return fail(
      '已有用户线索，请给出 2~5 个具体候选及 split 区分计划，不要继续空候选提问；若某个对象明显领先，可尝试猜测。'
    )
  }
  const { yes, no, unsure } = reply.split
  const all = [...yes, ...no, ...unsure].map(normalizeGuessName)
  const candidates = reply.candidates.map(normalizeGuessName)
  if (
    !yes.length ||
    !no.length ||
    all.length !== candidates.length ||
    new Set(all).size !== all.length ||
    !candidates.every((name) => all.includes(name))
  ) {
    return fail(
      '本轮问题必须让当前具体候选产生不同回答：split 中 yes 和 no 都要有候选，每个候选恰好归入一组；否则换一个更有区分度的问题。'
    )
  }
  if (candidates.some((name) => /^(?:具体|测试)?候选[甲乙丙丁戊12345]$/.test(name))) {
    return fail('候选不能填写格式占位符，必须是根据线索提出的具体对象名称。')
  }
  return null
}

export function buildCandidateReviewMessages(
  evidence: GuessEvidence[],
  candidate: string,
  rejected: string[]
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你负责猜心游戏的候选一致性核对，只核对本次候选，不提出新问题或新答案。',
        '用户问答是唯一已确认线索。yes 表示肯定该问句，no 表示否定该问句，注意问句本身可能带否定词。',
        'unsure 表示未知，不能用它肯定或否定属性。不要把假设、常识联想或候选本身变成用户确认的事实。',
        '区分角色本身、现实生物与周边商品；含义有歧义的线索不能武断地作为冲突。',
        '候选必须是具体对象或具体作品名称；如果只是宽泛分类或属性，判为 contradicted，不得把分类当成答案。',
        '逐条核对全部非 unsure 线索；候选或其别名若已经被用户否定，必须判为 contradicted。',
        '尤其核对主要用途与典型工作方式：用户明确否定某种主要用途，而候选正以该用途为核心时，这是冲突，不能只因它符合厨房电器等大类就放行。不要把偶尔具备的能力当作主要用途。',
        'compatible 仅表示没有明确矛盾，绝不表示已经猜中，不要求开放世界中只有唯一答案。',
        '只返回 JSON：{"verdict":"compatible","checked":[1,2],"conflicts":[],"aliases":[]}。',
        'checked 填已逐条核对的非 unsure 线索编号，conflicts 填明确违反的线索编号；有冲突时 verdict 为 contradicted。',
        'aliases 只填该候选的常见别名或译名，不得填同类其他对象；不确定别名时留空。不要输出推理过程。'
      ].join('\n')
    },
    { role: 'user', content: JSON.stringify({ evidence, candidate, rejected }) }
  ]
}

export interface CandidateReview {
  verdict: 'compatible' | 'contradicted'
  checked: number[]
  conflicts: number[]
  aliases: string[]
}

/** 缺项、伪造编号和遗漏核对均不能被当成候选通过。 */
export function parseCandidateReview(source: unknown, evidence: GuessEvidence[]): CandidateReview | null {
  if (!source || typeof source !== 'object') return null
  const value = source as Record<string, unknown>
  if (value.verdict !== 'compatible' && value.verdict !== 'contradicted') return null
  const required = evidence.filter((item) => item.answer !== 'unsure').map((item) => item.id)
  const validIds = (ids: unknown): ids is number[] =>
    Array.isArray(ids) && ids.every((id) => Number.isInteger(id) && required.includes(id))
  if (
    !validIds(value.checked) ||
    !validIds(value.conflicts) ||
    !required.every((id) => (value.checked as number[]).includes(id)) ||
    !Array.isArray(value.aliases)
  )
    return null
  if (value.verdict === 'compatible' && value.conflicts.length) return null
  return {
    verdict: value.verdict,
    checked: [...new Set(value.checked)],
    conflicts: [...new Set(value.conflicts)],
    aliases: parseNames(value.aliases)
  }
}
