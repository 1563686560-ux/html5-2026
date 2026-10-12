import { describe, expect, it } from 'vitest'
import { buildRetrievalQuery } from './queryContext'

describe('buildRetrievalQuery', () => {
  it('为省略对象的短追问补上上一条用户问题', () => {
    expect(
      buildRetrievalQuery('什么时候退回？', [
        { role: 'user', content: '云镜展示屏的押金是多少？' },
        { role: 'assistant', content: '押金为 500 元。' }
      ])
    ).toBe('云镜展示屏的押金是多少？\n什么时候退回？')
  })

  it('独立的新问题不混入旧问题', () => {
    expect(buildRetrievalQuery('活动日期和报名截止时间分别是什么？', [{ role: 'user', content: '押金是多少？' }])).toBe(
      '活动日期和报名截止时间分别是什么？'
    )
  })

  it('带明确主题的多少问题不被当成追问', () => {
    expect(
      buildRetrievalQuery('顾言的电话号码和停车费用分别是多少？', [{ role: 'user', content: '归还需要什么？' }])
    ).toBe('顾言的电话号码和停车费用分别是多少？')
  })

  it('没有历史时保留追问原文', () => {
    expect(buildRetrievalQuery('谁负责？', [])).toBe('谁负责？')
  })
})

it('连续省略追问保留主题起点及近期问题', () => {
  expect(
    buildRetrievalQuery('谁负责？', [
      { role: 'user', content: '云镜展示屏的押金是多少？' },
      { role: 'assistant', content: '500元' },
      { role: 'user', content: '什么时候退回？' },
      { role: 'assistant', content: '验收后' }
    ])
  ).toBe('云镜展示屏的押金是多少？\n什么时候退回？\n谁负责？')
})
it('追问遇到新主题不回带更早的旧主题', () => {
  expect(
    buildRetrievalQuery('谁负责？', [
      { role: 'user', content: '云镜展示屏的押金是多少？' },
      { role: 'user', content: '什么时候退回？' },
      { role: 'user', content: '活动日期和报名截止时间分别是什么？' }
    ])
  ).toBe('活动日期和报名截止时间分别是什么？\n谁负责？')
})
