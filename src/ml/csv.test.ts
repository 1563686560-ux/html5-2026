import { describe, expect, it } from 'vitest'
import { parseSeries } from './series'
import { csvColumnText, detectHeader, parseCsv } from './csv'

describe('parseCsv 基础解析', () => {
  it('逗号分隔，且识别文字表头', () => {
    const table = parseCsv('name,value\n一月,42\n二月,45')
    expect(table.headers).toEqual(['name', 'value'])
    expect(table.rows).toEqual([
      ['一月', '42'],
      ['二月', '45']
    ])
  })

  it('没有表头时自动生成「第 N 列」', () => {
    const table = parseCsv('1,2\n3,4')
    expect(table.headers).toEqual(['第 1 列', '第 2 列'])
    expect(table.rows).toEqual([
      ['1', '2'],
      ['3', '4']
    ])
  })

  it('CRLF 与 LF 结果一致', () => {
    const crlf = parseCsv('a,b\r\n1,2\r\n3,4\r\n')
    const lf = parseCsv('a,b\n1,2\n3,4\n')
    expect(crlf).toEqual(lf)
    expect(crlf.rows).toEqual([
      ['1', '2'],
      ['3', '4']
    ])
  })

  it('剥离 UTF-8 BOM，不让它污染第一个表头', () => {
    const table = parseCsv('\uFEFFvalue,label\n1,a')
    expect(table.headers).toEqual(['value', 'label'])
    expect(table.rows).toEqual([['1', 'a']])
  })

  it('末行没有换行也能解析', () => {
    expect(parseCsv('a,b\n1,2').rows).toEqual([['1', '2']])
  })
})

describe('parseCsv 引号处理', () => {
  it('引号内含逗号时不当成分隔符', () => {
    const table = parseCsv('a,b\n1,"x,y"')
    expect(table.rows).toEqual([['1', 'x,y']])
  })

  it('引号内含换行时不当成换行', () => {
    const table = parseCsv('a,b\n1,"第一行\n第二行"\n2,z')
    expect(table.headers).toEqual(['a', 'b'])
    expect(table.rows).toEqual([
      ['1', '第一行\n第二行'],
      ['2', 'z']
    ])
  })

  it('转义双引号 "" 还原成一个双引号', () => {
    const table = parseCsv('a\n"say ""hi"""')
    expect(table.rows).toEqual([['say "hi"']])
  })

  it('引号包裹的表头里的逗号不影响列数', () => {
    const table = parseCsv('"日期,时间",数值\n2024,7')
    expect(table.headers).toEqual(['日期,时间', '数值'])
    expect(table.rows).toEqual([['2024', '7']])
  })

  it('引号内只有换行的字段也算有内容', () => {
    const table = parseCsv('a\n"\n"')
    expect(table.rows).toEqual([['\n']])
  })
})

describe('parseCsv 边界情况', () => {
  it('空文件返回空表', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] })
    expect(parseCsv('\n')).toEqual({ headers: [], rows: [] })
    expect(parseCsv('\uFEFF')).toEqual({ headers: [], rows: [] })
  })

  it('只有表头时数据行为空', () => {
    const table = parseCsv('a,b,c\n')
    expect(table.headers).toEqual(['a', 'b', 'c'])
    expect(table.rows).toEqual([])
  })

  it('行列不齐时按最长行补齐', () => {
    const table = parseCsv('a,b,c\n1,2\n3,4,5,6')
    expect(table.headers).toEqual(['a', 'b', 'c', '第 4 列'])
    expect(table.rows).toEqual([
      ['1', '2', '', ''],
      ['3', '4', '5', '6']
    ])
    expect(table.rows.every((row) => row.length === table.headers.length)).toBe(true)
  })

  it('表头比数据行短时也补齐到同一列宽', () => {
    const table = parseCsv('a\n1,2,3')
    expect(table.headers).toEqual(['a', '第 2 列', '第 3 列'])
    expect(table.rows).toEqual([['1', '2', '3']])
  })

  it('空单元格（缺失值）原样保留，不抛异常', () => {
    const table = parseCsv('a,b\n1,\n,2')
    expect(table.rows).toEqual([
      ['1', ''],
      ['', '2']
    ])
  })

  it('单列纯数字不会被误判成表头', () => {
    const table = parseCsv('10\n20\n30')
    expect(table.headers).toEqual(['第 1 列'])
    expect(table.rows).toEqual([['10'], ['20'], ['30']])
  })
})

describe('detectHeader 表头识别', () => {
  it('文字行是表头', () => {
    expect(detectHeader(['日期', '数值'])).toBe(true)
  })

  it('数字行不是表头', () => {
    expect(detectHeader(['1', '2.5'])).toBe(false)
    expect(detectHeader(['-3', '1e3'])).toBe(false)
  })

  it('文字与数字混排按表头处理', () => {
    expect(detectHeader(['日期', '2024'])).toBe(true)
  })

  it('空行不是表头', () => {
    expect(detectHeader(['', ''])).toBe(false)
  })
})

describe('csvColumnText 取列', () => {
  it('取出指定列并拼成 parseSeries 能吃的文本', () => {
    const table = parseCsv('x,y\n1,10\n2,20\n3,30')
    expect(csvColumnText(table, 1)).toBe('10, 20, 30')
    expect(parseSeries(csvColumnText(table, 1))).toEqual([10, 20, 30])
  })

  it('缺失值被 parseSeries 跳过，不影响其余数值', () => {
    const table = parseCsv('x,y\n1,a\n,b\n3,c')
    expect(csvColumnText(table, 0)).toBe('1, , 3')
    expect(parseSeries(csvColumnText(table, 0))).toEqual([1, 3])
  })

  it('列越界返回空串而不是 undefined', () => {
    const table = parseCsv('a,b\n1,2')
    expect(csvColumnText(table, 5)).toBe('')
  })
})
