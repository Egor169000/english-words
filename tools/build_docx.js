#!/usr/bin/env node
/*
  Собирает Word-файл словаря из words.json.
  Использование: node tools/build_docx.js [words.json] [out.docx]
  Нужен пакет docx (npm). Порядок — по дате добавления, слова сгруппированы по дням.
*/
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType,
  BorderStyle, AlignmentType, VerticalAlign, Footer, PageNumber, TableLayoutType,
} = require('docx');

const [, , inFile = 'words.json', outFile = 'Мой английский словарь.docx'] = process.argv;
const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const words = (data.words || []).map((w, i) => ({ w, i }))
  .sort((a, b) => String(a.w.added || '').localeCompare(String(b.w.added || '')) || a.i - b.i)
  .map((x) => x.w);

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const dateRu = (s) => { if (!s) return 'Без даты'; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return d + ' ' + MONTHS[m - 1] + ' ' + y; };
const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? f[2] : b > 1 && b < 5 ? f[1] : b === 1 ? f[0] : f[2]; };

const FONT = 'Calibri';
const SERIF = 'Cambria';
const INK = '1A2232', MUTED = '5E6879', ACCENT = '2B48C2', RED = 'D04F63', RULE = 'D3DAE5', BAND = 'EEF1F6';

// *слово* в примере → жирный акцент
function exampleRuns(text, base) {
  const parts = String(text).split(/(\*[^*]+\*)/g).filter(Boolean);
  return parts.map((p) => /^\*[^*]+\*$/.test(p)
    ? new TextRun(Object.assign({}, base, { text: p.slice(1, -1), bold: true, color: ACCENT }))
    : new TextRun(Object.assign({}, base, { text: p })));
}

const PAGE_W = 11906, MARGIN = 1020;
const TABLE_W = PAGE_W - 2 * MARGIN; // 9866
const COLS = [560, 2700, 2650, 3956];

const border = { style: BorderStyle.SINGLE, size: 4, color: RULE };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 90, bottom: 90, left: 110, right: 110 };

function cell(children, i, opts = {}) {
  return new TableCell(Object.assign({
    children, borders, margins: cellMargins, verticalAlign: VerticalAlign.TOP,
    width: { size: COLS[i], type: WidthType.DXA },
  }, opts));
}
const P = (runs, opts = {}) => new Paragraph(Object.assign({ children: runs, spacing: { before: 0, after: 40, line: 264 } }, opts));

function headerRow() {
  const labels = ['№', 'Слово', 'Перевод', 'Пример'];
  return new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: labels.map((l, i) => cell([P([new TextRun({ text: l, bold: true, color: 'FFFFFF', font: FONT, size: 19 })])], i, {
      shading: { fill: ACCENT, type: ShadingType.CLEAR, color: 'auto' }, verticalAlign: VerticalAlign.CENTER,
    })),
  });
}
function dateRow(d, n) {
  return new TableRow({
    cantSplit: true,
    children: [new TableCell({
      columnSpan: 4, borders, margins: { top: 70, bottom: 70, left: 110, right: 110 },
      width: { size: TABLE_W, type: WidthType.DXA },
      shading: { fill: BAND, type: ShadingType.CLEAR, color: 'auto' },
      children: [P([
        new TextRun({ text: dateRu(d), bold: true, color: INK, font: FONT, size: 19 }),
        new TextRun({ text: '  ·  ' + n + ' ' + plural(n, ['слово', 'слова', 'слов']), color: MUTED, font: FONT, size: 18 }),
      ])],
    })],
  });
}
function wordRow(w, num) {
  const wordCell = [P([new TextRun({ text: w.word, bold: true, font: SERIF, size: 24, color: INK })], { spacing: { before: 0, after: 30 } })];
  const meta = [];
  if (w.ipa) meta.push(new TextRun({ text: w.ipa, font: FONT, size: 18, color: MUTED }));
  if (w.pos) meta.push(new TextRun({ text: (w.ipa ? '  ' : '') + w.pos, italics: true, font: SERIF, size: 18, color: MUTED }));
  if (meta.length) wordCell.push(P(meta));

  const trCell = [P([new TextRun({ text: w.tr, font: FONT, size: 20, color: INK })])];
  if (w.note) trCell.push(P([new TextRun({ text: w.note, font: FONT, size: 17, color: MUTED })]));

  const exCell = [];
  if (w.ex) exCell.push(P(exampleRuns(w.ex, { font: SERIF, size: 19, italics: true, color: INK })));
  if (w.exRu) exCell.push(P([new TextRun({ text: w.exRu, font: FONT, size: 18, color: MUTED })]));
  if (w.ctx) exCell.push(P([new TextRun({ text: 'Где встретил: ', font: FONT, size: 16, color: MUTED, bold: true }), new TextRun({ text: w.ctx, font: FONT, size: 16, color: MUTED })]));
  if (!exCell.length) exCell.push(P([new TextRun({ text: '' })]));

  return new TableRow({
    cantSplit: true,
    children: [
      cell([P([new TextRun({ text: String(num), font: FONT, size: 17, color: MUTED })], { alignment: AlignmentType.RIGHT })], 0),
      cell(wordCell, 1), cell(trCell, 2), cell(exCell, 3),
    ],
  });
}

const children = [];
children.push(new Paragraph({
  children: [new TextRun({ text: 'Мой английский словарь', bold: true, font: SERIF, size: 44, color: INK })],
  spacing: { before: 0, after: 60 },
}));
const n = words.length;
children.push(new Paragraph({
  children: [new TextRun({
    text: n ? n + ' ' + plural(n, ['слово', 'слова', 'слов']) + '  ·  обновлено ' + dateRu((data.updated || '').slice(0, 10)) : 'Пока пусто',
    font: FONT, size: 20, color: MUTED,
  })],
  border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: RED, space: 6 } },
  spacing: { before: 0, after: 240 },
}));

if (!n) {
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Присылай Claude незнакомые английские слова — каждое появится здесь с транскрипцией, переводом и примером, а заодно в приложении «Мои слова» на телефоне.', font: FONT, size: 21, color: INK })],
    spacing: { after: 120, line: 300 },
  }));
} else {
  const rows = [headerRow()];
  let cur = null, num = 0;
  const counts = {};
  words.forEach((w) => { const d = (w.added || '').slice(0, 10); counts[d] = (counts[d] || 0) + 1; });
  for (const w of words) {
    const d = (w.added || '').slice(0, 10);
    if (d !== cur) { cur = d; rows.push(dateRow(d, counts[d])); }
    rows.push(wordRow(w, ++num));
  }
  children.push(new Table({ width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: COLS, layout: TableLayoutType.FIXED, rows }));
}

const doc = new Document({
  creator: 'Claude',
  title: 'Мой английский словарь',
  styles: { default: { document: { run: { font: FONT, size: 20 } } } },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: 1020, bottom: 1020, left: MARGIN, right: MARGIN } } },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: MUTED })],
        })],
      }),
    },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(outFile, buf);
  console.log('Записан ' + outFile + ' (' + n + ' ' + plural(n, ['слово', 'слова', 'слов']) + ')');
});
