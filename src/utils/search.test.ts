import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEARCH_LIMITS,
  MAX_KEYWORD_LENGTH,
  buildSnippet,
  createHistorySearch,
  isTruncated,
  matchIndex,
  matchSessionTitles,
  normalizeKeyword,
  snippetText
} from './search'
import type { SearchSnippet, SearchableMessage } from './search'

function message(id: string, content: string, createdAt = 1, sessionId = 's1'): SearchableMessage {
  return { id, sessionId, role: 'user', content, createdAt }
}

/** 造 n 条都命中同一关键词的消息，时间递增 */
function matchingMessages(n: number, keyword = '关键词'): SearchableMessage[] {
  return Array.from({ length: n }, (_, i) => message(`m${i}`, `第 ${i} 条里有${keyword}`, i + 1))
}

/** 取片段，顺带把"预期该命中却没命中"变成一条清晰的失败信息 */
function snippetOf(content: string, keyword: string, padding?: number): SearchSnippet {
  const snippet = buildSnippet(content, keyword, padding)
  if (!snippet) throw new Error(`预期命中但没命中：${content} / ${keyword}`)
  return snippet
}

describe('normalizeKeyword 关键词归一化', () => {
  it('去掉首尾空白', () => {
    expect(normalizeKeyword('  你好  ')).toBe('你好')
  })

  it('空关键词与只有空白的关键词都归一化成空串', () => {
    expect(normalizeKeyword('')).toBe('')
    expect(normalizeKeyword('   ')).toBe('')
    expect(normalizeKeyword('\n\t ')).toBe('')
  })

  it('超过长度上限的关键词被截断', () => {
    const long = 'a'.repeat(100)
    expect(normalizeKeyword(long)).toHaveLength(MAX_KEYWORD_LENGTH)
    expect(normalizeKeyword(long)).toBe('a'.repeat(MAX_KEYWORD_LENGTH))
  })

  it('关键词内部的空白原样保留（用户可能就是在搜一个短语）', () => {
    expect(normalizeKeyword(' 灵魂 三问 ')).toBe('灵魂 三问')
  })
})

describe('matchIndex 大小写不敏感匹配', () => {
  it('英文大小写都能命中，且返回的是原文位置', () => {
    expect(matchIndex('Hello World', 'hello')).toBe(0)
    expect(matchIndex('hello world', 'WORLD')).toBe(6)
    expect(matchIndex('HeLLo', 'llO')).toBe(2)
  })

  it('中文不受大小写处理影响', () => {
    expect(matchIndex('仁者爱人，智者利人', '智者')).toBe(5)
  })

  it('中英文混排的关键词能找到', () => {
    expect(matchIndex('用 React 写一个 TodoList', 'react 写')).toBe(2)
  })

  it('找不到时返回 -1', () => {
    expect(matchIndex('仁者爱人', '兼爱')).toBe(-1)
    expect(matchIndex('abc', 'abcd')).toBe(-1)
  })

  it('空关键词直接返回 -1，不会命中任何东西', () => {
    expect(matchIndex('随便什么内容', '')).toBe(-1)
  })

  it('正则元字符按普通字符处理，不会被当成模式', () => {
    expect(matchIndex('调用 foo(1).bar 取值', 'foo(1).bar')).toBe(3)
    expect(matchIndex('a.b 与 axb', 'a.b')).toBe(0)
  })
})

describe('buildSnippet 片段截取', () => {
  const padding = 2

  it('命中在开头：只截尾，左侧不加省略号', () => {
    const snippet = snippetOf('关键词ABCDEFGH', '关键词', padding)
    expect(snippet.before).toBe('')
    expect(snippet.match).toBe('关键词')
    expect(snippet.after).toBe('AB')
    expect(snippet.clippedHead).toBe(false)
    expect(snippet.clippedTail).toBe(true)
    expect(snippetText(snippet)).toBe('关键词AB…')
  })

  it('命中在中间：两侧都截，两端都加省略号', () => {
    const snippet = snippetOf('XYZW关键词ABCD', '关键词', padding)
    expect(snippet.before).toBe('ZW')
    expect(snippet.after).toBe('AB')
    expect(snippet.clippedHead).toBe(true)
    expect(snippet.clippedTail).toBe(true)
    expect(snippetText(snippet)).toBe('…ZW关键词AB…')
  })

  it('命中在结尾：只截头，右侧不加省略号', () => {
    const snippet = snippetOf('XYZW关键词', '关键词', padding)
    expect(snippet.before).toBe('ZW')
    expect(snippet.after).toBe('')
    expect(snippet.clippedHead).toBe(true)
    expect(snippet.clippedTail).toBe(false)
    expect(snippetText(snippet)).toBe('…ZW关键词')
  })

  it('正文本来就短：两侧都不截，一个省略号都不加', () => {
    const snippet = snippetOf('AB关键词', '关键词', padding)
    expect(snippet.clippedHead).toBe(false)
    expect(snippet.clippedTail).toBe(false)
    expect(snippetText(snippet)).toBe('AB关键词')
  })

  it('命中的高亮片段保留原文大小写', () => {
    const snippet = snippetOf('前面 HELLO 后面', 'hello', 3)
    expect(snippet.match).toBe('HELLO')
  })

  it('正文里没有关键词时返回 null', () => {
    expect(buildSnippet('仁者爱人', '兼爱', padding)).toBeNull()
    expect(buildSnippet('有内容', '', padding)).toBeNull()
  })

  it('padding 为 0 时只留命中词本身', () => {
    expect(snippetText(snippetOf('AB关键词CD', '关键词', 0))).toBe('…关键词…')
  })

  it('正文里的换行会被原样保留（由渲染层折叠成空格）', () => {
    const snippet = snippetOf('第一行\n关键词\n第三行', '关键词', 10)
    expect(snippet.before).toBe('第一行\n')
    expect(snippet.after).toBe('\n第三行')
  })

  it('用默认 padding 时也能截出前后文', () => {
    const snippet = snippetOf(`很长的一段前缀${'甲'.repeat(50)}关键词`, '关键词')
    expect(snippet.before).toHaveLength(24)
    expect(snippet.clippedHead).toBe(true)
    expect(snippet.clippedTail).toBe(false)
  })
})

describe('createHistorySearch 上限与截断', () => {
  it('没有命中时全部扫完，报告 exhausted', () => {
    const scanner = createHistorySearch('找不到的词', { maxScan: 100, maxHits: 10 })
    const messages = ['甲', '乙', '丙'].map((text, i) => message(`m${i}`, text, i + 1))

    expect(messages.map((m) => scanner.feed(m))).toEqual([true, true, true])

    const result = scanner.finish()
    expect(result.hits).toEqual([])
    expect(result.scanned).toBe(3)
    expect(result.reason).toBe('exhausted')
    expect(isTruncated(result.reason, true)).toBe(false)
  })

  it('命中数到达上限时立即叫停，不再往下扫', () => {
    const scanner = createHistorySearch('关键词', { maxScan: 100, maxHits: 2 })
    const messages = matchingMessages(10)

    // 前两条正常消费，第三条一进来就发现命中已满 —— 此时还没读它的正文
    expect(messages.map((m) => scanner.feed(m))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false
    ])

    const result = scanner.finish()
    expect(result.hits).toHaveLength(2)
    expect(result.scanned).toBe(2)
    expect(result.reason).toBe('hit-limit')
    // 游标是被主动刹住的，索引里必然还有记录没看
    expect(isTruncated(result.reason, false)).toBe(true)
  })

  it('扫描数到达上限时叫停，命中可以不满', () => {
    const scanner = createHistorySearch('关键词', { maxScan: 3, maxHits: 50 })
    const messages = matchingMessages(10)

    expect(messages.map((m) => scanner.feed(m))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false
    ])

    const result = scanner.finish()
    expect(result.scanned).toBe(3)
    expect(result.hits).toHaveLength(3)
    expect(result.reason).toBe('scan-limit')
    expect(isTruncated(result.reason, false)).toBe(true)
  })

  it('命中上限为 0（标题已经占满名额）时一条都不扫', () => {
    const scanner = createHistorySearch('关键词', { maxScan: 100, maxHits: 0 })
    expect(scanner.feed(message('m1', '正文里有命中词关键词'))).toBe(false)

    const result = scanner.finish()
    expect(result.scanned).toBe(0)
    expect(result.hits).toEqual([])
    expect(result.reason).toBe('hit-limit')
  })

  it('命中按时间倒序返回，扫描本身是升序的', () => {
    const scanner = createHistorySearch('关键词', { maxScan: 100, maxHits: 50 })
    const messages = matchingMessages(3).reverse() // 故意乱序喂进去
    messages.forEach((m) => scanner.feed(m))

    const times = scanner.finish().hits.map((hit) => (hit.kind === 'message' ? hit.createdAt : hit.updatedAt))
    expect(times).toEqual([3, 2, 1])
  })

  it('结果里带出所属会话与消息 id，供界面跳转', () => {
    const scanner = createHistorySearch('关键词', { maxScan: 100, maxHits: 50 })
    scanner.feed({ id: 'msg-9', sessionId: 'sess-7', role: 'assistant', content: '这里有关键词', createdAt: 9 })

    const hit = scanner.finish().hits[0]
    expect(hit.kind).toBe('message')
    if (hit.kind !== 'message') throw new Error('类型收窄失败')
    expect(hit.messageId).toBe('msg-9')
    expect(hit.sessionId).toBe('sess-7')
    expect(hit.role).toBe('assistant')
    expect(snippetText(hit.snippet)).toBe('这里有关键词')
  })

  it('空关键词不产生任何命中（不会把整表当成命中）', () => {
    const scanner = createHistorySearch('', { maxScan: 100, maxHits: 50 })
    scanner.feed(message('m1', '任意内容'))
    expect(scanner.finish().hits).toEqual([])
  })

  it('默认上限就是扫描 5000 条、命中 50 条', () => {
    expect(DEFAULT_SEARCH_LIMITS).toEqual({ maxScan: 5000, maxHits: 50 })

    const scanner = createHistorySearch('关键词')
    matchingMessages(60).forEach((m) => scanner.feed(m))
    const result = scanner.finish()

    expect(result.hits).toHaveLength(50)
    expect(result.reason).toBe('hit-limit')
  })
})

describe('isTruncated 是否"没搜完"', () => {
  it('扫到索引末尾且没触发任何上限时才算搜完', () => {
    expect(isTruncated('exhausted', true)).toBe(false)
  })

  it('游标没走到末尾（索引里还有记录）就算没搜完', () => {
    expect(isTruncated('exhausted', false)).toBe(true)
  })

  it('任一上限被触发都算没搜完', () => {
    expect(isTruncated('hit-limit', true)).toBe(true)
    expect(isTruncated('scan-limit', true)).toBe(true)
  })
})

describe('matchSessionTitles 会话标题匹配', () => {
  const sessions = [
    { id: 's1', title: '聊聊 Vue 的响应式', updatedAt: 3 },
    { id: 's2', title: 'vite 打包优化', updatedAt: 2 },
    { id: 's3', title: '今日天气', updatedAt: 1 }
  ]

  it('大小写不敏感地匹配标题', () => {
    expect(matchSessionTitles(sessions, 'vue').map((hit) => hit.sessionId)).toEqual(['s1'])
    expect(matchSessionTitles(sessions, 'VITE').map((hit) => hit.sessionId)).toEqual(['s2'])
  })

  it('标题片段整条展示，不加多余的省略号', () => {
    const [hit] = matchSessionTitles(sessions, '天气')
    expect(hit.kind).toBe('title')
    expect(snippetText(hit.snippet)).toBe('今日天气')
    expect(hit.snippet.clippedHead).toBe(false)
    expect(hit.snippet.clippedTail).toBe(false)
    expect(hit.updatedAt).toBe(1)
  })

  it('标题命中数量同样受上限约束', () => {
    expect(matchSessionTitles(sessions, 'e', 1)).toHaveLength(1)
  })

  it('没有任何标题命中时返回空数组', () => {
    expect(matchSessionTitles(sessions, '不存在的词')).toEqual([])
  })
})
