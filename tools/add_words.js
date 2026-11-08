#!/usr/bin/env node
/*
  Добавляет или обновляет слова в words.json.
  Использование: node tools/add_words.js new-words.json [words.json]
  new-words.json — массив объектов:
    { "word": "ubiquitous", "ipa": "/juːˈbɪk.wɪ.təs/", "pos": "прил.",
      "tr": "вездесущий, повсеместный",
      "ex": "Smartphones have become *ubiquitous*.", "exRu": "Смартфоны стали повсеместными.",
      "ctx": "где встретил (необязательно)", "note": "формы, синонимы (необязательно)", "id": "необязательно" }
  Проверка дубликатов: слово, которое уже есть в words.json (без учёта регистра, «to» в начале
  и поля from), НЕ добавляется — скрипт пишет его в «Дубликаты» вместе с текущим переводом.
  Чтобы заменить старую запись новой, добавь в объект "replace": true — тогда запись обновится
  (id, дата добавления и прогресс на телефоне сохраняются).
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
const key = (w) => String(w || '').toLowerCase().replace(/['’`]/g, '').replace(/\s+/g, ' ').trim().replace(/^to /, '');
const byKey = new Map();
data.words.forEach((w, i) => {
  byKey.set('id:' + w.id, i);
  byKey.set(key(w.word), i);
  if (w.from) String(w.from).split('|').forEach((f) => byKey.set(key(f), i));
});
const added = [], updated = [], dups = [], problems = [];
const seen = new Set();

for (const e of incoming) {
  if (!e || !e.word || !e.tr) { problems.push(JSON.stringify(e)); continue; }
  const id = e.id || slug(e.word);
  if (!id) { problems.push(e.word + ' (пустой id — задай поле id)'); continue; }
  const k = key(e.word);
  if (seen.has(k)) { dups.push(e.word + ' — повтор в этом же списке'); continue; }
  seen.add(k);
  const clean = {};
  for (const f of FIELDS) if (e[f] != null && String(e[f]).trim() !== '') clean[f] = String(e[f]).trim();
  let i = byKey.has('id:' + id) ? byKey.get('id:' + id) : byKey.get(k);
  if (i === undefined && e.from) String(e.from).split('|').some((f) => (i = byKey.get(key(f))) !== undefined);
  if (i !== undefined) {
    const old = data.words[i];
    if (!e.replace) { dups.push(e.word + ' — уже есть: «' + old.word + '» — ' + old.tr); continue; }
    data.words[i] = Object.assign({}, old, clean, { id: old.id, added: old.added, edited: now.iso });
    if (old.from && clean.from && old.from !== clean.from) data.words[i].from = old.from + '|' + clean.from;
    updated.push(clean.word);
  } else {
    const w = Object.assign({ id }, clean, { added: e.added || now.date });
    byKey.set('id:' + id, data.words.length);
    byKey.set(k, data.words.length);
    data.words.push(w);
    added.push(clean.word);
  }
}

data.updated = now.iso;
fs.writeFileSync(wordsFile, JSON.stringify(data, null, 2) + '\n');
console.log('Добавлено: ' + added.length + (added.length ? ' — ' + added.join(', ') : ''));
console.log('Обновлено: ' + updated.length + (updated.length ? ' — ' + updated.join(', ') : ''));
if (dups.length) console.log('Дубликаты (не добавлены): ' + dups.length + '\n  ' + dups.join('\n  '));
console.log('Всего слов: ' + data.words.length);
if (problems.length) { console.log('Пропущено (нет word или tr): ' + problems.join('; ')); process.exitCode = 2; }
