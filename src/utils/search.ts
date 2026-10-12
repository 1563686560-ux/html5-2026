/**
 * 跨会话搜索的纯逻辑
 * ------------------------------------------------------------------
 * 为什么把这些抽成纯函数：搜索真正难的地方不在 IndexedDB 游标，而在两件事上 ——
 *   1. 匹配与片段：中英文混排时的大小写、命中在开头/中间/结尾时怎么截、省略号加在哪边；
 *   2. 上限语义：扫到 5000 条、命中 50 条时到底算不算"搜完了"。
 * 两者都不依赖 DOM、不依赖数据库，写成纯函数就能直接对着边界情况写测试。
 *
 * 界面拿到的始终是「命中词的原文 + 前后文 + 两侧是否需要省略号」这种结构化片段，
 * 而不是拼好的字符串 —— 高亮要落成 <em> 标签，拼接发生在渲染层。
 */

/**
 * 关键词长度上限。
 * 超长关键词没有检索价值，还会让片段截取失去意义（前后文全被关键词本身占满），
 * 顺手也挡掉了「把一整段正文粘进搜索框」这种误操作。
 */
export const MAX_KEYWORD_LENGTH = 64

/** 片段里命中词前后各保留的字符数 */
export const SNIPPET_PADDING = 24

export interface SearchLimits {
  /** 最多扫描多少条消息 */
  maxScan: number
  /** 最多返回多少条命中 */
  maxHits: number
}

/** 默认预算：扫 5000 条、返回 50 条。到限即停，并且在界面上如实说明只显示了前 N 条 */
export const DEFAULT_SEARCH_LIMITS: SearchLimits = { maxScan: 5000, maxHits: 50 }

/**
 * 归一化关键词：去首尾空白、按上限截断。
 * 返回空串表示「不该发起搜索」—— 只敲了空格时不该去扫表。
 */
export function normalizeKeyword(raw: string): string {
  return raw.trim().slice(0, MAX_KEYWORD_LENGTH)
}

/**
 * 大小写不敏感地找第一个命中位置，找不到返回 -1。
 *
 * 为什么统一走 toLowerCase 而不是正则：用户输入的关键词里可能带 `.` `(` `*`
 * 这类正则元字符，走 RegExp 就得先转义，转义漏一个就会得到离谱的结果。
 * 中文没有大小写，toLowerCase 对它是恒等变换，所以中英文可以用同一条路径。
 */
export function matchIndex(text: string, keyword: string): number {
  if (!keyword) return -1
  return text.toLowerCase().indexOf(keyword.toLowerCase())
}

export interface SearchSnippet {
  /** 命中词之前的片段（不含省略号） */
  before: string
  /** 命中的原文，保留用户书写时的大小写 */
  match: string
  /** 命中词之后的片段 */
  after: string
  /** 开头被截掉了，渲染时要在前面补省略号 */
  clippedHead: boolean
  /** 结尾被截掉了，渲染时要在后面补省略号 */
  clippedTail: boolean
}

/**
 * 截取命中词附近的一小段作为展示片段；正文里没有该关键词时返回 null。
 * padding 可调：消息正文用默认的 24 字，会话标题直接传标题长度（标题本来就短，
 * 整条展示即可，不必加多余省略号）。
 */
export function buildSnippet(content: string, keyword: string, padding = SNIPPET_PADDING): SearchSnippet | null {
  const hit = matchIndex(content, keyword)
  if (hit < 0) return null

  const end = hit + keyword.length
  const head = Math.max(0, hit - padding)
  const tail = Math.min(content.length, end + padding)

  return {
    before: content.slice(head, hit),
    // 用原文而不是小写后的文本，高亮处要和消息里看到的字一模一样
    match: content.slice(hit, end),
    after: content.slice(end, tail),
    clippedHead: head > 0,
    clippedTail: tail < content.length
  }
}

/** 把片段拼成纯文本（界面用富文本渲染，测试与日志用这个）。 */
export function snippetText(snippet: SearchSnippet): string {
  const head = snippet.clippedHead ? '…' : ''
  const tail = snippet.clippedTail ? '…' : ''
  return `${head}${snippet.before}${snippet.match}${snippet.after}${tail}`
}

/** 搜索只需要消息的这五个字段，独立声明是为了让纯函数不依赖 store 的类型 */
export interface SearchableMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface MessageHit {
  kind: 'message'
  messageId: string
  sessionId: string
  role: 'user' | 'assistant'
  createdAt: number
  snippet: SearchSnippet
}

export interface TitleHit {
  kind: 'title'
  sessionId: string
  title: string
  updatedAt: number
  snippet: SearchSnippet
}

export type SearchHit = MessageHit | TitleHit

/** 停止扫描的原因，界面据此给出不同措辞 */
export type SearchStopReason = 'exhausted' | 'scan-limit' | 'hit-limit'

export interface HistorySearchResult {
  hits: SearchHit[]
  /** 实际扫描过的消息条数 */
  scanned: number
  /** 是否还有没看过的消息。为 true 时界面必须如实说明"只显示了前 N 条" */
  truncated: boolean
  reason: SearchStopReason
}

export interface HistoryScanner {
  /** 喂一条消息；返回 false 表示游标该提前退出了 */
  feed(message: SearchableMessage): boolean
  finish(): Omit<HistorySearchResult, 'truncated'>
}

/**
 * 逐条消费消息的搜索累加器。
 *
 * 上限判定故意放在「扫描之前」而不是「收集之后」：
 * 命中数满了就该立刻让游标停下，而不是继续把剩下的几千条读完再截断结果 ——
 * 那等于没有省下任何 IO。
 */
export function createHistorySearch(keyword: string, limits: SearchLimits = DEFAULT_SEARCH_LIMITS): HistoryScanner {
  const hits: MessageHit[] = []
  let scanned = 0
  let reason: SearchStopReason = 'exhausted'

  function feed(message: SearchableMessage): boolean {
    if (hits.length >= limits.maxHits) {
      reason = 'hit-limit'
      return false
    }
    if (scanned >= limits.maxScan) {
      reason = 'scan-limit'
      return false
    }

    scanned += 1
    const snippet = buildSnippet(message.content, keyword)
    if (snippet) {
      hits.push({
        kind: 'message',
        messageId: message.id,
        sessionId: message.sessionId,
        role: message.role,
        createdAt: message.createdAt,
        snippet
      })
    }
    return true
  }

  function finish(): Omit<HistorySearchResult, 'truncated'> {
    // 游标是按 [sessionId, createdAt] 升序走的，没有全局时间索引可用，
    // 所以"最新的排前面"只能在拿到命中之后局部排序（最多 50 条，代价可忽略）
    const sorted = [...hits].sort((a, b) => b.createdAt - a.createdAt)
    return { hits: sorted, scanned, reason }
  }

  return { feed, finish }
}

/**
 * 是否"没搜完"。
 * 两个来源任一为真都表示结果可能不全，界面都要如实说明：
 *   - reason 不是 exhausted：我们主动在某个上限处刹车了
 *   - indexExhausted 为 false：游标没走到索引末尾
 * 宁可多提示一次"只显示了前 N 条"，也不要让用户以为已经搜遍全部历史。
 */
export function isTruncated(reason: SearchStopReason, indexExhausted: boolean): boolean {
  return reason !== 'exhausted' || !indexExhausted
}

/**
 * 会话标题匹配。
 * 会话列表本来就整份在内存里（几十条），不必也不该为它单独建索引。
 */
export function matchSessionTitles(
  sessions: readonly { id: string; title: string; updatedAt: number }[],
  keyword: string,
  maxHits: number = DEFAULT_SEARCH_LIMITS.maxHits
): TitleHit[] {
  const hits: TitleHit[] = []
  for (const session of sessions) {
    if (hits.length >= maxHits) break
    // 标题短，padding 取标题长度即可让片段等于整条标题
    const snippet = buildSnippet(session.title, keyword, session.title.length)
    if (!snippet) continue
    hits.push({ kind: 'title', sessionId: session.id, title: session.title, updatedAt: session.updatedAt, snippet })
  }
  return hits
}
