#!/usr/bin/env node
/*
  Добавляет или обновляет слова в words.json.
  Использование: node tools/add_words.js new-words.json [words.json]
  new-words.json — массив объектов:
    { "word": "ubiquitous", "ipa": "/juːˈbɪk.wɪ.təs/", "pos": "прил.",
      "tr": "вездесущий, повсеместный",
      "ex": "Smartphones have become *ubiquitous*.", "exRu": "Смартфоны стали повсеместными.",
      "ctx": "где встретил (необязательно)", "note": "формы, синонимы (необязательно)", "id": "необязательно" }
  Существующее слово (тот же id) обновляется, дата добавления и прогресс сохраняются.
*/
const fs = require('fs');

const [, , inFile, wordsFile = 'words.json'] = process.argv;
if (!inFile) { console.error('Нужен файл с новыми словами'); process.exit(1); }

const FIELDS = ['word', 'ipa', 'pos', 'tr', 'ex', 'exRu', 'ctx', 'note', 'from'];

function moscowNow() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  const iso = d.toISOString().replace('Z', '+03:00').replace(/\.\d{3}/, '');
  return { date: iso.slice(0, 10), iso };
}
function slug(w) {
  return String(w).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

const incoming = JSON.parse(fs.readFileSync(inFile, 'utf8'));
if (!Array.isArray(incoming)) { console.error('Ожидался массив слов'); process.exit(1); }
const data = fs.existsSync(wordsFile) ? JSON.parse(fs.readFileSync(wordsFile, 'utf8')) : { updated: null, words: [] };
const now = moscowNow();
const index = new Map(data.words.map((w, i) => [w.id, i]));
const added = [], updated = [], problems = [];

for (const e of incoming) {
  if (!e || !e.word || !e.tr) { problems.push(JSON.stringify(e)); continue; }
  const id = e.id || slug(e.word);
  if (!id) { problems.push(e.word + ' (пустой id — задай поле id)'); continue; }
  const clean = {};
  for (const f of FIELDS) if (e[f] != null && String(e[f]).trim() !== '') clean[f] = String(e[f]).trim();
  if (index.has(id)) {
    const i = index.get(id);
    data.words[i] = Object.assign({}, data.words[i], clean, { id, added: data.words[i].added, edited: now.iso });
    updated.push(clean.word);
  } else {
    const w = Object.assign({ id }, clean, { added: e.added || now.date });
    index.set(id, data.words.length);
    data.words.push(w);
    added.push(clean.word);
  }
}

data.updated = now.iso;
fs.writeFileSync(wordsFile, JSON.stringify(data, null, 2) + '\n');
console.log('Добавлено: ' + added.length + (added.length ? ' — ' + added.join(', ') : ''));
console.log('Обновлено: ' + updated.length + (updated.length ? ' — ' + updated.join(', ') : ''));
console.log('Всего слов: ' + data.words.length);
if (problems.length) { console.log('Пропущено (нет word или tr): ' + problems.join('; ')); process.exitCode = 2; }
