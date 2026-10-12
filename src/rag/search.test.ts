import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { chunkText } from './chunker'
import { cosineSimilarity, keywordSearch, vectorSearch, mergeSearchHits } from './search'
import type { RagChunk } from './types'

function makeChunk(id: string, content: string, vector?: number[]): RagChunk {
  return {
    id,
    documentId: 'd1',
    documentTitle: '测试资料',
    index: 0,
    content,
    start: 0,
    end: content.length,
    vector: vector ? new Float32Array(vector) : undefined,
    createdAt: 0
  }
}

describe('cosineSimilarity 余弦相似度', () => {
  it('相同向量为 1，正交为 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5)
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 5)
  })

  it('长度不匹配或空向量返回 0', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
})

describe('keywordSearch 关键词检索', () => {
  it('中英混合问句能命中独立英文技术名', () => {
    expect(keywordSearch([makeChunk('vue', 'Vue 是前端框架。')], 'Vue是什么')).toHaveLength(1)
  })
  it('融合检索保留尚未向量化的关键词命中并去重', () => {
    const a = makeChunk('a', '甲')
    const b = makeChunk('b', '乙')
    const hits = mergeSearchHits(
      [{ chunk: a, score: 0.5, mode: 'keyword' }],
      [
        { chunk: b, score: 0.9, mode: 'vector' },
        { chunk: a, score: 0.8, mode: 'vector' }
      ],
      2
    )
    expect(hits.map((h) => h.chunk.id)).toEqual(['a', 'b'])
  })
  const chunks = [
    makeChunk('a', '人工智能可以用于医疗影像诊断'),
    makeChunk('b', '今天天气很好适合出门散步'),
    makeChunk('c', '机器学习与人工智能的关系密切')
  ]

  it('把命中的块排在最前', () => {
    const hits = keywordSearch(chunks, '人工智能')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].chunk.id).toBe('a')
  })

  it('支持中文二元词组', () => {
    const hits = keywordSearch(chunks, '医疗影像')
    expect(hits[0].chunk.id).toBe('a')
  })

  it('无命中返回空数组', () => {
    expect(keywordSearch(chunks, '不存在的关键词xyz')).toEqual([])
  })
})

/**
 * 相关度下限（回归）。
 *
 * 旧实现只数「命中了几个不同的查询 token」，命中率再低也能排在前面：
 * 查询「这个项目用了什么技术」会命中一段微波炉说明书 —— 只因为它里面有个「用」字。
 * 这类噪声片段会被当成「参考资料」塞进提示词，模型只好照着它答或者答
 * 「资料里没有相关内容」，用户看到的就是「回答怪怪的」。
 */
describe('keywordSearch 相关度下限', () => {
  it.each(['冥王星的卫星轨道周期是多少？', '卫星的运行周期为多少？'])('问句套语不应导致日期资料误召回：%s', (query) => {
    const text = readFileSync(new URL('../../tests/fixtures/rag/星桥项目.txt', import.meta.url), 'utf8')
    const chunks = chunkText(text).map((part, i) => makeChunk(String(i), part.content))
    expect(keywordSearch(chunks, query)).toEqual([])
  })

  it('排除套语后仍能检索真正的天文资料', () => {
    const corpus = [
      makeChunk('date', '报名截止日期是2026年10月28日。'),
      makeChunk('space', '冥王星卫星的轨道周期需要依照各卫星分别确定。')
    ]
    expect(keywordSearch(corpus, '冥王星的卫星轨道周期是多少？').map((hit) => hit.chunk.id)).toEqual(['space'])
  })

  it.each([
    ['报名截止日期是多少？', '报名截止日期是2026年10月28日。'],
    ['物料经费上限是多少？', '物料经费上限为1200元。'],
    ['Vue是什么？', 'Vue 是前端框架。'],
    ['什么是是非观？', '是非观是判断对错的观念。'],
    ['运行', '程序正在运行。'],
    ['水', '水可以用于清洁。']
  ])('正常短查询仍然可用：%s', (query, content) => {
    expect(keywordSearch([makeChunk('relevant', content)], query)).toHaveLength(1)
  })

  it('只包含问句套语时不返回无关资料', () => {
    expect(keywordSearch([makeChunk('a', '这是一个项目。')], '请问是什么？')).toEqual([])
  })
  const corpus = [
    makeChunk('oven-1', '本微波炉使用 220V 电源，加热食物时请使用专用容器。'),
    makeChunk('oven-2', '清洁前请断电，用湿布擦拭内腔。'),
    makeChunk('project', '你好，这是本项目的第三章内容，讨论了好用的界面设计。'),
    makeChunk('stack', '本项目的技术栈是 Vue 3 与 Vite，构建产物部署在静态服务器上。')
  ]

  it('只撞上几个常用字、一条强单元都没命中的片段被淘汰', () => {
    const hits = keywordSearch(corpus, '这个项目用了什么技术')
    const ids = hits.map((hit) => hit.chunk.id)
    expect(ids).not.toContain('oven-1')
    expect(ids).not.toContain('oven-2')
  })

  it('真正相关的片段仍然找得出来，并排在只是「沾了同一个词」的段落前面', () => {
    const hits = keywordSearch(corpus, '这个项目用了什么技术')
    const ids = hits.map((hit) => hit.chunk.id)
    expect(ids).toContain('stack')
    // 「讨论了好用的界面设计」也含「项目 / 用 / 了」，但它回答不了技术栈的问题
    expect(ids.indexOf('stack')).toBeLessThan(ids.indexOf('project'))
  })

  it('纯寒暄 / 与资料无关的问句不召回任何片段', () => {
    expect(keywordSearch(corpus, '今天午饭吃什么好呢')).toEqual([])
  })

  it('单字查询仍然可用（没有二元词组时不做强单元要求）', () => {
    const hits = keywordSearch(corpus, '微波炉')
    expect(hits[0].chunk.id).toBe('oven-1')
  })

  it('同一份资料里的相关片段都能留下', () => {
    const hits = keywordSearch(corpus, '微波炉怎么清洁')
    expect(hits.map((hit) => hit.chunk.id)).toContain('oven-2')
  })
})

describe('vectorSearch 向量检索', () => {
  it('只考虑长度匹配的向量并按相似度排序', () => {
    const chunks = [
      makeChunk('near', '相关', [1, 0, 0]),
      makeChunk('far', '不相关', [0, 1, 0]),
      makeChunk('novec', '没有向量')
    ]
    const hits = vectorSearch(chunks, [1, 0, 0], 5)
    expect(hits).toHaveLength(2)
    expect(hits[0].chunk.id).toBe('near')
  })
})
