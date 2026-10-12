// Read the requirements markdown and author it into the selected Univer Doc Unit.
// Injected by univer_execute: univerAPI, api, doc. Do not redeclare them.
// Multi-line Facade body, so it is kept in the workspace instead of inline `code`.

const { readFile } = await import('node:fs/promises');

const MD_PATH = 'D:/Project/html5课程设计/Myapp/docs/需求分析和项目进度安排.md';
const TOTAL_WIDTH = 602; // 96-DPI px = A4 width minus 1-inch margins
const MIN_COL = 52;

/** Split markdown inline markup into plain text plus bold spans (indices into the plain text). */
function stripInline(text) {
  let plain = '';
  const bolds = [];
  const re = /\*\*(.+?)\*\*|`([^`]*)`/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    plain += text.slice(last, match.index);
    if (match[1] !== undefined) {
      // 反引号可能出现在加粗区间内部（如 **Capacitor 打包 `.apk` 装到真机**）。
      // 正则的两个分支是择一的：**...** 一旦先匹配，区间内的反引号就不会再被第二个分支处理，
      // 于是反引号会被原样带进文档。这里显式去掉。
      const start = plain.length;
      plain += match[1].replace(/`/g, '');
      bolds.push([start, plain.length]);
    } else {
      plain += match[2];
    }
    last = re.lastIndex;
  }
  plain += text.slice(last);
  return { plain, bolds };
}

const isSeparatorRow = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

/** Parse the markdown into a flat list of blocks. */
function parseBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const text = lines[i].trim();
    if (!text) {
      i += 1;
      continue;
    }
    if (text.startsWith('|')) {
      const group = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        group.push(lines[i]);
        i += 1;
      }
      const header = splitRow(group[0]);
      const body = group.length > 1 && isSeparatorRow(group[1]) ? group.slice(2) : group.slice(1);
      const rows = [header, ...body.map(splitRow)].map((row) => row.map((cell) => stripInline(cell).plain));
      blocks.push({ type: 'table', rows });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, ...stripInline(heading[2]) });
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) {
      i += 1;
      continue;
    }
    if (text.startsWith('>')) {
      const quoted = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoted.push(lines[i].trim().slice(1).trim());
        i += 1;
      }
      blocks.push({ type: 'quote', ...stripInline(quoted.join(' ')) });
      continue;
    }
    if (/^[-*+]\s+/.test(text)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(stripInline(lines[i].trim().replace(/^[-*+]\s+/, '')));
        i += 1;
      }
      blocks.push({ type: 'bullets', items });
      continue;
    }
    blocks.push({ type: 'paragraph', ...stripInline(text) });
    i += 1;
  }
  return blocks;
}

/** Proportional column widths that always add up to TOTAL_WIDTH. */
function columnWidths(rows) {
  const columns = Math.max(...rows.map((row) => row.length));
  const weights = [];
  for (let c = 0; c < columns; c += 1) {
    let longest = 6;
    for (const row of rows) {
      const length = (row[c] ?? '').length;
      if (length > longest) longest = length;
    }
    weights.push(longest);
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.max(MIN_COL, Math.round((TOTAL_WIDTH * w) / sum)));
  let diff = TOTAL_WIDTH - widths.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (diff !== 0 && guard < 400) {
    const index = guard % widths.length;
    const step = diff > 0 ? 1 : -1;
    if (widths[index] + step >= MIN_COL) {
      widths[index] += step;
      diff -= step;
    }
    guard += 1;
  }
  return widths;
}

const enumOf = (name, key, fallback) => {
  const group = api.Enum[name];
  return group && group[key] !== undefined ? group[key] : fallback;
};

const HEADING_STYLE = {
  1: enumOf('NamedStyleType', 'HEADING_1', 'HEADING_1'),
  2: enumOf('NamedStyleType', 'HEADING_2', 'HEADING_2'),
  3: enumOf('NamedStyleType', 'HEADING_3', 'HEADING_3'),
  4: enumOf('NamedStyleType', 'HEADING_4', 'HEADING_4'),
};

/**
 * 标题字号（pt）。必须和 namedStyleType 一起给：
 * 导出 docx 时 namedStyleType 会被丢弃（产物的 styles.xml 里根本没有 Heading 样式定义，
 * 也不产生 pStyle 引用），标题会退化成最普通的段落，在 Word 里与正文无法区分。
 * textStyle 走的是直接格式，能正常导出（加粗、颜色已验证），所以用它兜住视觉层级。
 */
const HEADING_FONT_PT = { 1: 18, 2: 15, 3: 13, 4: 12 };

const BOLD = enumOf('BooleanNumber', 'TRUE', 1);
const BORDER_PRESET_KEY = Object.keys(api.Enum.DocsTableBorderPreset ?? {}).find((key) =>
  ['ALL', 'ALL_BORDERS', 'GRID', 'ALL_BORDER', 'ALL_BORDERS_AND_INNER'].includes(key.toUpperCase())
);

const markdown = await readFile(MD_PATH, 'utf8');
const blocks = parseBlocks(markdown);

const firstParagraph = doc.getParagraphs()[0];
if (!firstParagraph) throw new Error('new Doc has no initial paragraph');
let firstUsed = false;

const stats = { paragraphs: 0, headings: 0, bullets: 0, quotes: 0, tables: [], boldRanges: 0 };

const applyBold = (paragraph, bolds) => {
  if (!bolds || bolds.length === 0) return;
  const info = paragraph.getInfo();
  if (info == null || info.startOffset == null) throw new Error('paragraph offsets unavailable');
  for (const [start, end] of bolds) {
    if (end <= start) continue;
    const range = doc.getTextRange(info.startOffset + start, info.startOffset + end);
    if (!range) throw new Error(`text range ${start}-${end} unavailable`);
    range.setTextStyle({ bl: BOLD });
    stats.boldRanges += 1;
  }
};

const writeParagraph = (plain, bolds, kind, level) => {
  let paragraph;
  if (!firstUsed) {
    firstUsed = true;
    paragraph = firstParagraph;
    if (!paragraph.setText(plain)) throw new Error(`setText failed for: ${plain.slice(0, 24)}`);
  } else {
    paragraph = doc.appendParagraph(plain);
  }
  if (!paragraph) throw new Error(`paragraph creation failed for: ${plain.slice(0, 24)}`);
  stats.paragraphs += 1;

  if (kind === 'heading') {
    const changed = paragraph.setStyle({
      namedStyleType: HEADING_STYLE[level],
      textStyle: { fs: HEADING_FONT_PT[level] ?? 12, bl: BOLD },
    });
    if (!changed) {
      throw new Error(`heading style failed for: ${plain.slice(0, 24)}`);
    }
    stats.headings += 1;
  } else if (kind === 'quote') {
    paragraph.setStyle({
      indentStart: 24,
      textStyle: { it: BOLD, cl: { rgb: '#444444' } },
    });
    stats.quotes += 1;
  } else if (kind === 'bullet') {
    const list = doc.setBullet(paragraph);
    if (!list) throw new Error(`bullet failed for: ${plain.slice(0, 24)}`);
    stats.bullets += 1;
  }
  applyBold(paragraph, bolds);
};

for (const block of blocks) {
  if (block.type === 'table') {
    const widths = columnWidths(block.rows);
    const table = doc.insertTableFromData(block.rows, {
      width: TOTAL_WIDTH,
      columnWidths: widths,
      headerRowCount: 1,
    });
    if (!table) throw new Error(`table insert failed (${block.rows.length} rows)`);
    if (BORDER_PRESET_KEY) {
      table.setTableBorder({
        preset: api.Enum.DocsTableBorderPreset[BORDER_PRESET_KEY],
        color: '#808080',
        width: 1,
      });
    }
    stats.tables.push({ rows: block.rows.length, columns: widths.length });
    continue;
  }
  if (block.type === 'bullets') {
    for (const item of block.items) writeParagraph(item.plain, item.bolds, 'bullet');
    continue;
  }
  if (block.type === 'heading') {
    writeParagraph(block.plain, block.bolds, 'heading', block.level);
    continue;
  }
  if (block.type === 'quote') {
    writeParagraph(block.plain, block.bolds, 'quote');
    continue;
  }
  writeParagraph(block.plain, block.bolds, 'paragraph');
}

const paragraphs = doc.getParagraphs();
return {
  blocks: blocks.length,
  stats,
  borderPresetKey: BORDER_PRESET_KEY ?? null,
  flavor: doc.getDocumentFlavor ? doc.getDocumentFlavor() : null,
  paragraphCount: paragraphs.length,
  firstSix: paragraphs.slice(0, 6).map((p) => p.getText()),
  tableCount: doc.getTables().length,
};
