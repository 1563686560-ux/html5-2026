/**
 * CSV 解析（纯函数，便于单测）
 * ------------------------------------------------------------------
 * 为什么不直接 split(',')：真实 CSV 的引号字段里可以塞逗号、换行，
 * 还能用 "" 转义出双引号。一旦遇到这种字段，按分隔符切割就会把一条记录拆成两条、
 * 或者把列数算错 —— 后面的预览表格与选列全部跟着错位。
 * 所以这里用一个小状态机逐字符扫描，只在「引号之外」才认逗号与换行。
 */
import { isSeriesNumber } from './series'

export interface CsvTable {
  /** 表头。未识别到表头时自动生成「第 N 列」，长度恒等于列宽 */
  headers: string[]
  /** 数据行（不含表头）。已按列宽补齐或截断，每行长度都等于 headers.length */
  rows: string[][]
}

const BOM = '\uFEFF'

/**
 * 解析 CSV 文本。畸形输入一律「尽量对齐」而不抛异常：
 * 这是用户随手从 Excel/问卷导出的文件，报错不如把能看的部分显示出来。
 */
export function parseCsv(text: string): CsvTable {
  const records = splitRecords(text)
  // 列宽取「所有记录里最长的那个」，短的补空串、长的截掉，
  // 这样后面按下标取列值的代码不必到处判 undefined
  const width = records.reduce((max, record) => Math.max(max, record.length), 0)
  if (width === 0) return { headers: [], rows: [] }

  const hasHeader = detectHeader(records[0])
  const headerRecord = hasHeader ? records[0] : []
  const dataRecords = hasHeader ? records.slice(1) : records

  return {
    headers: normalizeRecord(headerRecord, width, true),
    rows: dataRecords.map((record) => normalizeRecord(record, width, false))
  }
}

/** 首行只要出现「非数字的非空单元格」就当表头；整行都是数字则视为数据 */
export function detectHeader(record: string[]): boolean {
  return record.some((cell) => cell.trim() !== '' && !isNumericCell(cell))
}

/**
 * 取某一列拼成与粘贴框同构的文本，交给 series.ts 的 parseSeries 去解析。
 * CSV 与「粘贴数字」因此共用同一条链路：文本 → 数字数组 → 训练。
 * 顺带一个好处：导入后用户还能在数据框里继续手改，两条入口行为完全一致。
 */
export function csvColumnText(table: CsvTable, index: number): string {
  return table.rows
    .map((row) => {
      const cell = (row[index] ?? '').trim().normalize('NFKC')
      // CSV 引号内的规范千分位转成一个数值，坏单元格保持原子性，防止拆成多个点。
      const number = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(cell) ? cell.replace(/,/g, '') : cell
      return !number || isSeriesNumber(number) || !/[\s,;"\\]/.test(number) ? number : JSON.stringify(number)
    })
    .join(', ')
}

function isNumericCell(cell: string): boolean {
  const value = cell.trim().normalize('NFKC')
  return isSeriesNumber(/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value) ? value.replace(/,/g, '') : value)
}

function normalizeRecord(record: string[], width: number, isHeader: boolean): string[] {
  const cells: string[] = []
  for (let i = 0; i < width; i += 1) {
    const raw = record[i] ?? ''
    if (!isHeader) {
      cells.push(raw)
      continue
    }
    // 表头缺名字时补一个可读的默认名，否则下拉框里会出现一个空白选项
    const name = raw.trim()
    cells.push(name === '' ? `第 ${i + 1} 列` : name)
  }
  return cells
}

/** 逐字符扫描出「记录 → 字段」；只有引号之外的分隔符和换行才有结构含义 */
function splitRecords(text: string): string[][] {
  // UTF-8 BOM：Excel 另存为 CSV 时几乎必带，不剥掉会污染第一个表头
  const source = text.startsWith(BOM) ? text.slice(1) : text
  const records: string[][] = []
  /** 与 records 一一对应：该记录是否出现过引号包裹的字段。剔除空行时要用 */
  const quotedRecords: boolean[] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let recordQuoted = false

  function endRecord(): void {
    record.push(field)
    records.push(record)
    quotedRecords.push(recordQuoted)
    record = []
    field = ''
    recordQuoted = false
  }

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          // "" 是一个字面双引号：吞掉第二个引号，别把它误当收尾
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        // 引号里的换行、逗号都只是普通字符
        field += char
      }
      continue
    }

    if (char === '"' && field === '') {
      // 只有字段开头的引号才是「包裹」；值中间的引号按字面量处理（宽松容错）
      quoted = true
      recordQuoted = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\r' || char === '\n') {
      // CRLF 要把 \r\n 当一个换行，否则每行都会多出一条空记录
      if (char === '\r' && source[i + 1] === '\n') i += 1
      endRecord()
    } else {
      field += char
    }
  }

  // 文件末尾没有换行时，最后一条记录还没入栈
  if (field !== '' || record.length > 0) endRecord()

  /**
   * 只移除文件外围的纯空白排版行，保留数据中间的空行作为缺失值。
   * 引号包裹的空白字段属于明确写下的数据，即使在外围也保留。
   */
  const blank = (index: number) =>
    records[index].length === 1 && records[index][0].trim() === '' && !quotedRecords[index]
  const first = records.findIndex((_, index) => !blank(index))
  if (first < 0) return []
  let last = records.length - 1
  while (blank(last)) last--
  // 仅忽略文件外围的排版空行；数据中间的空行保留，不能偷偷压缩时间轴。
  return records.slice(first, last + 1)
}
