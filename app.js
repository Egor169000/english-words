'use strict';
/* Мои слова — офлайн-карточки для английских слов.
   Слова: words.json (их добавляет Claude). Прогресс: localStorage этого устройства. */
(() => {
  const VERSION = '1.1';
  const INTERVALS = [0, 1, 3, 7, 14, 30, 60, 120]; // дни до следующего повтора на уровне 0..7
  const MAX_LVL = 7;
  const LEARNED_LVL = 5;
  const K = { words: 'mw.words', progress: 'mw.progress', settings: 'mw.settings', synced: 'mw.syncedAt', local: 'mw.local' };

  // ---------- storage ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };

  const state = {
    data: LS.get(K.words, null) || { updated: null, words: [] },
    progress: LS.get(K.progress, {}) || {},
    settings: Object.assign({ dir: 'en', newPerDay: 20, accent: 'en-GB' }, LS.get(K.settings, {}) || {}),
    syncedAt: LS.get(K.synced, null),
    local: LS.get(K.local, []) || [], // слова, добавленные прямо в приложении (ещё не у Claude)
    addOpen: false,
    sync: 'idle', // idle | loading | ok | offline | error
    newCount: 0,
    tab: 'home',
    dict: { q: '', filter: 'all', open: null, confirmReset: null },
    restoreOpen: false,
  };
  let session = null;
  let quiz = null;

  const saveProgress = () => LS.set(K.progress, state.progress);
  const saveSettings = () => LS.set(K.settings, state.settings);
  const saveLocal = () => LS.set(K.local, state.local);

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const z = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
  const diffDays = (a, b) => { const p = a.split('-').map(Number), q = b.split('-').map(Number); return Math.round((Date.UTC(q[0], q[1] - 1, q[2]) - Date.UTC(p[0], p[1] - 1, p[2])) / 86400000); };
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const WDFULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const dateRu = (s) => { if (!s) return ''; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return d + ' ' + MONTHS[m - 1] + (y !== new Date().getFullYear() ? ' ' + y : ''); };
  const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? f[2] : b > 1 && b < 5 ? f[1] : b === 1 ? f[0] : f[2]; };
  const W = ['слово', 'слова', 'слов'];
  const D = ['день', 'дня', 'дней'];
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const when = (due) => {
    const n = diffDays(today(), due);
    if (n <= 0) return 'сегодня';
    if (n === 1) return 'завтра';
    return 'через ' + n + ' ' + plural(n, D);
  };
  const short = (n) => (n <= 0 ? 'снова' : n === 1 ? '1 д' : n < 30 ? n + ' д' : Math.round(n / 30) + ' мес');

  // id слова — так же, как в tools/add_words.js
  const slug = (w) => String(w || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const serverWords = () => (state.data && Array.isArray(state.data.words) ? state.data.words : []);
  // слова для повторения: от Claude (с учётом замен, сделанных на телефоне) + свои, у которых есть перевод
  const words = () => {
    const ov = new Map(state.local.filter((l) => l.replaces).map((l) => [l.replaces, l]));
    const s = serverWords().map((w) => {
      const o = ov.get(w.id);
      if (!o) return w;
      const m = Object.assign({}, w, { word: o.word, local: true, replaced: true });
      if (o.tr) m.tr = o.tr;
      if (o.ex) { m.ex = o.ex; delete m.exRu; }
      return m;
    });
    return s.concat(state.local.filter((l) => l.tr && !l.replaces));
  };
  const pendingLocal = () => state.local.filter((l) => !l.tr && !l.replaces);
  const byId = (id) => words().find((w) => w.id === id) || state.local.find((w) => w.id === id);

  // Когда Claude добавил слово из приложения в words.json, локальная копия больше не нужна.
  function reconcileLocal() {
    const s = serverWords();
    if (!s.length || !state.local.length) return 0;
    const keys = new Map();
    s.forEach((w) => {
      keys.set(w.id, w.id);
      keys.set(slug(w.word), w.id);
      keys.set(slug(String(w.word).replace(/^to /i, '')), w.id);
      if (w.from) String(w.from).split('|').forEach((f) => keys.set(slug(f), w.id));
    });
    let merged = 0;
    state.local = state.local.filter((l) => {
      if (l.replaces) {
        // замена держится, пока Claude не обновит это слово в words.json
        const sw = s.find((w) => w.id === l.replaces);
        if (sw && sw.edited && Date.parse(sw.edited) > Date.parse(l.createdAt || 0)) { merged++; return false; }
        return true;
      }
      const sid = keys.get(l.id) || keys.get(slug(l.word));
      if (!sid) return true;
      if (l.id !== sid && state.progress[l.id] && !state.progress[sid]) { state.progress[sid] = state.progress[l.id]; }
      if (l.id !== sid) delete state.progress[l.id];
      merged++;
      return false;
    });
    if (merged) { saveLocal(); saveProgress(); }
    return merged;
  }
  const prog = (id) => state.progress[id] || null;
  const status = (w) => { const p = prog(w.id); return !p ? 'new' : p.lvl >= LEARNED_LVL ? 'learned' : 'learning'; };

  function fmtEx(ex, word, blank) {
    if (!ex) return '';
    let s = esc(ex);
    if (/\*[^*]+\*/.test(s)) return s.replace(/\*([^*]+)\*/g, blank ? '<mark>＿＿＿</mark>' : '<mark>$1</mark>');
    if (!word) return s;
    const w = String(word).trim().toLowerCase().replace(/^to /, '');
    let stem = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!w.includes(' ') && w.length > 4) stem = stem.replace(/(e|y)$/, '');
    try {
      const re = new RegExp('\\b(' + stem + "[\\w'’-]*)", 'gi');
      return s.replace(re, blank ? '<mark>＿＿＿</mark>' : '<mark>$1</mark>');
    } catch (e) { return s; }
  }

  function leitner(w) {
    const p = prog(w.id);
    const lvl = p ? p.lvl : 0;
    let h = '';
    for (let i = 1; i <= MAX_LVL; i++) h += '<i class="' + (i <= lvl ? 'on' : '') + '"></i>';
    const title = !p ? 'Новое слово' : 'Уровень ' + lvl + ' из ' + MAX_LVL;
    return '<span class="leitner' + (lvl >= LEARNED_LVL ? ' learned' : '') + '" title="' + title + '" aria-label="' + title + '">' + h + '</span>';
  }

  const ICON = {
    speak: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  // ---------- speech ----------
  const canSpeak = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  function pickVoice() {
    const vs = speechSynthesis.getVoices() || [];
    const want = state.settings.accent;
    return vs.find((v) => v.lang === want && v.localService) || vs.find((v) => v.lang === want) ||
      vs.find((v) => v.lang && v.lang.replace('_', '-').startsWith(want)) || vs.find((v) => /^en/i.test(v.lang || ''));
  }
  function speak(text) {
    if (!canSpeak || !text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/\*/g, ''));
      u.lang = state.settings.accent;
      const v = pickVoice(); if (v) u.voice = v;
      u.rate = 0.92;
      speechSynthesis.speak(u);
    } catch (e) { /* без звука */ }
  }
  if (canSpeak) { try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => {}; } catch (e) { /* */ } }
  const speakBtn = (text, label) => (canSpeak ? '<button class="icon-btn speak" data-speak="' + esc(text) + '" aria-label="' + esc(label || 'Произнести') + '">' + ICON.speak + '</button>' : '');

  // ---------- toast ----------
  let toastT = null;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- queue / SRS ----------
  function introducedToday() { const t = today(); return Object.values(state.progress).filter((p) => p && p.first === t).length; }
  function buildQueue() {
    const t = today();
    const ws = words();
    const due = ws.filter((w) => { const p = prog(w.id); return p && p.due <= t; })
      .sort((a, b) => prog(a.id).due.localeCompare(prog(b.id).due) || prog(a.id).lvl - prog(b.id).lvl);
    const limit = Number(state.settings.newPerDay) || 0;
    const room = limit > 0 ? Math.max(0, limit - introducedToday()) : Infinity;
    const allNew = ws.filter((w) => !prog(w.id)).sort((a, b) => String(a.added || '').localeCompare(String(b.added || '')));
    const fresh = room === Infinity ? allNew : allNew.slice(0, room);
    return { due, fresh, waitingNew: allNew.length - fresh.length };
  }
  function nextFor(id, g) {
    const t = today();
    const p = prog(id);
    const lvl = p ? p.lvl : 0;
    if (g === 'forgot') return { lvl: 0, due: t };
    if (g === 'hard') { const l = Math.max(1, lvl); return { lvl: l, due: addDays(t, Math.max(1, Math.round(INTERVALS[l] / 2))) }; }
    const l = Math.min(lvl + 1, MAX_LVL);
    return { lvl: l, due: addDays(t, INTERVALS[l]) };
  }
  function applyGrade(id, g) {
    const t = today();
    const old = prog(id);
    const p = old ? Object.assign({}, old) : { lvl: 0, due: t, reps: 0, lapses: 0, first: t };
    const n = nextFor(id, g);
    p.lvl = n.lvl; p.due = n.due; p.reps = (p.reps || 0) + 1; p.last = t;
    if (g === 'forgot') p.lapses = (p.lapses || 0) + 1;
    state.progress[id] = p;
    saveProgress();
  }
  function forecast(days) {
    const t = today();
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(t, i);
      const n = words().filter((w) => { const p = prog(w.id); return p && (i === 0 ? p.due <= d : p.due === d); }).length;
      out.push({ d, n });
    }
    return out;
  }

  // ---------- sync ----------
  async function sync(manual) {
    state.sync = 'loading';
    if (state.tab === 'home' || state.tab === 'settings') render();
    try {
      const r = await fetch('words.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (!data || !Array.isArray(data.words)) throw new Error('bad data');
      const before = new Set(words().map((w) => w.id));
      const hadAny = before.size > 0;
      state.data = data;
      LS.set(K.words, data);
      reconcileLocal();
      state.syncedAt = new Date().toISOString();
      LS.set(K.synced, state.syncedAt);
      const added = data.words.filter((w) => !before.has(w.id)).length;
      if (hadAny && added) state.newCount = added;
      state.sync = r.headers.get('X-From-Cache') ? 'offline' : 'ok';
      if (manual) toast(added ? 'Новых слов: ' + added : 'Новых слов нет');
    } catch (e) {
      state.sync = navigator.onLine === false ? 'offline' : 'error';
      if (manual) toast(state.sync === 'offline' ? 'Нет интернета — показываю сохранённые слова' : 'Не удалось обновить, попробуй позже');
    }
    if (!session && !quiz) render(); else updateBadge();
  }
  function syncLine() {
    const n = words().length;
    const at = state.syncedAt ? new Date(state.syncedAt) : null;
    const atTxt = at ? (ymd(at) === today() ? 'сегодня в ' + z(at.getHours()) + ':' + z(at.getMinutes()) : dateRu(ymd(at))) : '';
    let dot = 'dot', txt;
    if (state.sync === 'loading') txt = 'Проверяю новые слова…';
    else if (state.sync === 'ok') { dot += ' ok'; txt = 'Слова обновлены ' + atTxt; }
    else if (state.sync === 'offline') { dot += ' off'; txt = 'Без интернета' + (at ? ' · слова от ' + atTxt : ''); }
    else if (state.sync === 'error') { dot += ' err'; txt = 'Не удалось проверить новые слова' + (at ? ' · последние от ' + atTxt : ''); }
    else txt = at ? 'Слова от ' + atTxt : 'Слова ещё не загружены';
    return '<div class="sync"><span class="' + dot + '"></span><span>' + txt + ' · ' + n + ' ' + plural(n, W) + '</span></div>';
  }

  const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function installNote() {
    if (standalone()) return '';
    const ios = isIOS();
    return '<div class="note"><b>Установи на главный экран</b>' +
      (ios
        ? '<ol><li>Открой эту страницу в Safari.</li><li>Нажми «Поделиться» (квадрат со стрелкой).</li><li>Выбери «На экран „Домой“» → «Добавить».</li></ol>'
        : '<ol><li>Открой эту страницу в Chrome.</li><li>Нажми ⋮ в правом верхнем углу.</li><li>Выбери «Установить приложение» или «Добавить на главный экран».</li></ol>') +
      '<span>После этого «Мои слова» открываются как обычное приложение и работают без интернета.</span></div>';
  }

  // ---------- views ----------
  function viewHome() {
    const ws = words();
    const now = new Date();
    const head = '<header class="top"><div class="eyebrow">' + WDFULL[now.getDay()] + ', ' + now.getDate() + ' ' + MONTHS[now.getMonth()] + '</div><h1>Мои слова</h1></header>';
    let html = head;
    if (state.newCount) html += '<div class="news">+' + state.newCount + ' ' + plural(state.newCount, ['новое слово', 'новых слова', 'новых слов']) + ' от Claude</div>';
    html += localPanel(true);

    if (!ws.length) {
      html += '<section class="panel"><div class="done-mark">Слов пока нет</div>' +
        '<p class="muted" style="margin:0">Пришли Claude незнакомые английские слова. Он добавит их сюда с переводом и примером, а заодно запишет в Word-файл. Новые слова появятся здесь, как только телефон будет в сети.</p>' +
        '<button class="btn block" data-act="add">+ Добавить слово самому</button></section>' +
        '<article class="icard" aria-label="Пример карточки"><div class="icard-meta"><span class="example-tag">Так выглядит карточка</span>' + '<span class="leitner"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></div>' +
        '<div class="icard-body"><div class="headword"><div class="hw">ubiquitous</div></div>' +
        '<div class="answer"><div class="tr">вездесущий, повсеместный</div>' +
        '<div class="ex">Smartphones have become <mark>ubiquitous</mark> in daily life.</div></div></div></article>';
      html += installNote() + syncLine();
      return html;
    }

    const q = buildQueue();
    const total = q.due.length + q.fresh.length;
    if (total) {
      html += '<section class="panel today"><div class="today-head"><div class="today-num">' + total + '</div><div class="today-lbl"><b>' + plural(total, ['карточка', 'карточки', 'карточек']) + ' на сегодня</b><span class="muted small">' +
        q.due.length + ' на повтор · ' + q.fresh.length + ' ' + plural(q.fresh.length, ['новое', 'новых', 'новых']) + '</span></div></div>' +
        '<button class="btn primary block" data-act="start">Начать повторение</button>' +
        '<button class="btn block" data-act="add">+ Добавить слово</button></section>';
    } else {
      const next = words().map((w) => prog(w.id)).filter(Boolean).map((p) => p.due).sort()[0];
      const nextN = next ? words().filter((w) => { const p = prog(w.id); return p && p.due === next; }).length : 0;
      html += '<section class="panel today"><div class="done-mark">На сегодня всё повторено</div><p class="muted" style="margin:0">' +
        (q.waitingNew ? 'Ещё ' + q.waitingNew + ' ' + plural(q.waitingNew, ['новое слово ждёт', 'новых слова ждут', 'новых слов ждут']) + ' — лимит новых на сегодня исчерпан. ' : '') +
        (next ? 'Следующее повторение ' + when(next) + ': ' + nextN + ' ' + plural(nextN, W) + '.' : '') + '</p>' +
        (q.waitingNew ? '<button class="btn block" data-act="more-new">Добавить ещё 10 новых на сегодня</button>' : '') +
        '<button class="btn block" data-act="add">+ Добавить слово</button>' +
        '<button class="btn ghost" data-tab-go="quiz">Пройти тест по словам</button></section>';
    }

    const counts = { new: 0, learning: 0, learned: 0 };
    ws.forEach((w) => counts[status(w)]++);
    html += '<section class="stats"><div class="stat"><b>' + ws.length + '</b><span>всего</span></div><div class="stat"><b>' + (counts.learning) + '</b><span>изучаю</span></div><div class="stat"><b>' + counts.learned + '</b><span>выучено</span></div></section>';

    // уровни (коробки Лейтнера)
    const lv = new Array(MAX_LVL + 1).fill(0);
    ws.forEach((w) => { const p = prog(w.id); lv[p ? p.lvl : 0]++; });
    const newOnly = counts.new;
    const maxLv = Math.max(1, ...lv);
    const labels = ['нов.', '1 д', '3 д', '7 д', '14 д', '30 д', '60 д', '120 д'];
    let bars = '';
    lv.forEach((n, i) => {
      const cls = n === 0 ? 'zero' : i === 0 ? 'new' : i >= LEARNED_LVL ? 'learned' : '';
      bars += '<div class="bar"><em>' + (n || '') + '</em><i class="' + cls + '" style="height:' + Math.max(3, Math.round((n / maxLv) * 72)) + 'px"></i></div>';
    });
    html += '<section class="panel"><div class="row spread"><h2>Коробки Лейтнера</h2><span class="small muted">интервал повтора</span></div><div class="bars">' + bars + '</div><div class="bar-labels">' +
      labels.map((l) => '<span>' + l + '</span>').join('') + '</div>' +
      (newOnly ? '' : '') + '</section>';

    const fc = forecast(7);
    html += '<section class="panel"><h2>Повторы на неделю</h2><div class="week">' + fc.map((f, i) => {
      const [y, m, d] = f.d.split('-').map(Number);
      const wd = WD[new Date(y, m - 1, d).getDay()];
      return '<div class="day' + (f.n ? '' : ' zero') + '"><b>' + f.n + '</b><span>' + (i === 0 ? 'сег.' : wd) + '</span></div>';
    }).join('') + '</div></section>';

    html += installNote() + syncLine();
    return html;
  }

  function viewQuiz() {
    const n = words().length;
    let html = '<header class="top"><div class="eyebrow">10 вопросов · не влияет на расписание</div><h1>Тест</h1></header>';
    if (n < 1) return html + '<div class="panel empty">Сначала нужны слова — пришли их Claude.</div>';
    html += '<section class="panel">' +
      '<button class="mode" data-act="quiz-choice"' + (n < 4 ? ' disabled' : '') + '><b>Выбери перевод</b><span>Слово по-английски и четыре варианта перевода' + (n < 4 ? ' · нужно минимум 4 слова' : '') + '</span></button>' +
      '<button class="mode" data-act="quiz-type"><b>Напиши слово</b><span>Перевод по-русски — вспомни и напиши английское слово</span></button>' +
      '<button class="mode" data-act="quiz-listen"' + (canSpeak && n >= 4 ? '' : ' disabled') + '><b>На слух</b><span>Слушаешь произношение и выбираешь слово' + (!canSpeak ? ' · озвучка недоступна' : n < 4 ? ' · нужно минимум 4 слова' : '') + '</span></button>' +
      '</section><p class="small muted" style="margin:0 4px">В тест чаще попадают слова, которые ты знаешь хуже всего.</p>';
    return html;
  }

  function viewDict() {
    const ws = words();
    const f = state.dict.filter;
    const q = state.dict.q.trim().toLowerCase();
    const counts = { all: ws.length, new: 0, learning: 0, learned: 0, due: 0 };
    const t = today();
    ws.forEach((w) => { counts[status(w)]++; const p = prog(w.id); if (p && p.due <= t) counts.due++; });
    const list = ws.filter((w) => {
      if (f === 'due') { const p = prog(w.id); if (!(p && p.due <= t)) return false; }
      else if (f !== 'all' && status(w) !== f) return false;
      if (!q) return true;
      return [w.word, w.tr, w.note].some((x) => String(x || '').toLowerCase().includes(q));
    }).sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')) || String(a.word).localeCompare(String(b.word)));

    const chip = (k, l) => '<button class="chip" data-filter="' + k + '" aria-pressed="' + (f === k) + '">' + l + '<em>' + counts[k] + '</em></button>';
    let html = '<header class="top row spread" style="flex-direction:row;align-items:flex-end"><div><div class="eyebrow">' + ws.length + ' ' + plural(ws.length, W) + '</div><h1>Словарь</h1></div>' +
      '<button class="btn primary" data-act="add" style="min-height:42px;padding:9px 14px">+ Добавить</button></header>' +
      localPanel(false) +
      '<input class="search" id="dict-q" type="search" placeholder="Поиск по слову или переводу" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(state.dict.q) + '">' +
      '<div class="chips">' + chip('all', 'Все') + chip('new', 'Новые') + chip('learning', 'Изучаю') + chip('learned', 'Выучено') + chip('due', 'К повтору') + '</div>';
    if (!list.length) return html + '<div class="list"><div class="empty">' + (ws.length ? 'Ничего не нашлось' : 'Слов пока нет — пришли их Claude') + '</div></div>';
    html += '<div class="list">' + list.map(itemHtml).join('') + '</div>';
    return html;
  }

  // Блок «добавлено на телефоне»: слова ещё не у Claude и не в Word-файле.
  function localPanel(compact) {
    const all = state.local;
    if (!all.length) return '';
    const pend = pendingLocal();
    if (compact && !pend.length) return '';
    const n = all.length;
    let h = '<section class="panel local">';
    h += '<div class="row spread"><b>' + (compact
      ? pend.length + ' ' + plural(pend.length, ['слово ждёт', 'слова ждут', 'слов ждут']) + ' перевода'
      : 'Добавлено на телефоне: ' + n) + '</b></div>';
    h += '<p class="small muted" style="margin:0">' + (compact
      ? 'Отправь их Claude: он переведёт, добавит примеры и впишет в Word-файл.'
      : 'Этих слов ещё нет в Word-файле. Отправь их Claude: он дополнит карточки и впишет слова в файл.') + '</p>';
    if (!compact) {
      h += '<div class="local-list">' + all.map((l) => '<div class="local-item"><span><b>' + esc(l.word) + '</b>' + (l.tr ? ' — ' + esc(l.tr) : (l.replaces ? '' : ' <span class="tag">ждёт перевода</span>')) + (l.replaces ? ' <span class="tag">замена</span>' : '') + '</span>' +
        (state.dict.confirmDel === l.id
          ? '<span class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn danger" style="min-height:34px;padding:6px 10px;font-size:14px" data-del="' + esc(l.id) + '">Удалить</button><button class="btn" style="min-height:34px;padding:6px 10px;font-size:14px" data-del-cancel="1">Нет</button></span>'
          : '<button class="icon-btn" style="width:34px;height:34px" data-del-ask="' + esc(l.id) + '" aria-label="Удалить ' + esc(l.word) + '">' + ICON.close + '</button>') +
        '</div>').join('') + '</div>';
    }
    h += '<button class="btn primary block" data-act="send">Отправить Claude</button>';
    if (all.some((l) => l.sentAt)) h += '<p class="small muted" style="margin:0">Уже отправлял? Слова пропадут из этого списка сами, когда Claude их добавит и телефон будет в сети.</p>';
    return h + '</section>';
  }

  function itemHtml(w) {
    const open = state.dict.open === w.id;
    const p = prog(w.id);
    let h = '<div class="item"><button class="item-head" data-open="' + esc(w.id) + '" aria-expanded="' + open + '"><span class="item-word">' + esc(w.word) +
      (w.pos ? '<span class="pos">' + esc(w.pos) + '</span>' : '') + (w.local ? '<span class="tag">на телефоне</span>' : '') + '</span><span class="item-tr">' + esc(w.tr) + '</span>' + leitner(w) + '</button>';
    if (open) {
      h += '<div class="item-body">' +
        '<div class="row spread"><span class="ipa">' + esc(w.ipa || '') + '</span>' + speakBtn(w.word) + '</div>' +
        (w.ex ? '<div class="ex">' + fmtEx(w.ex, w.word) + '</div>' : '') +
        (w.exRu ? '<div class="ex-ru">' + esc(w.exRu) + '</div>' : '') +
        (w.note ? '<div class="small">' + esc(w.note) + '</div>' : '') +
        (w.ctx ? '<div class="ctx"><b>Где встретил:</b> ' + esc(w.ctx) + '</div>' : '') +
        '<dl class="facts"><dt>Добавлено</dt><dd>' + esc(dateRu(w.added)) + '</dd>' +
        '<dt>Уровень</dt><dd>' + (p ? p.lvl + ' из ' + MAX_LVL + (p.lvl >= LEARNED_LVL ? ' · выучено' : '') : 'новое, ещё не повторял') + '</dd>' +
        (p ? '<dt>Повтор</dt><dd>' + when(p.due) + '</dd><dt>Ошибок</dt><dd>' + (p.lapses || 0) + '</dd>' : '') + '</dl>' +
        (p ? (state.dict.confirmReset === w.id
          ? '<div class="row"><button class="btn danger" data-reset="' + esc(w.id) + '">Да, сбросить</button><button class="btn" data-reset-cancel="1">Отмена</button></div>'
          : '<div><button class="btn ghost" data-reset-ask="' + esc(w.id) + '" style="padding-left:0">Сбросить прогресс слова</button></div>') : '') +
        '</div>';
    }
    return h + '</div>';
  }

  function viewSettings() {
    const s = state.settings;
    const seg = (key, opts) => '<div class="seg" role="group">' + opts.map(([v, l]) => '<button data-set="' + key + '" data-val="' + v + '" aria-pressed="' + (String(s[key]) === String(v)) + '">' + l + '</button>').join('') + '</div>';
    let html = '<header class="top"><div class="eyebrow">Версия ' + VERSION + '</div><h1>Настройки</h1></header>';
    html += '<section class="panel">' +
      '<div class="setting"><span class="label">Сторона карточки</span>' + seg('dir', [['en', 'EN → RU'], ['ru', 'RU → EN'], ['mix', 'Вперемешку']]) + '<p>Что показывать сначала: английское слово или перевод.</p></div>' +
      '<div class="setting"><span class="label">Новых слов в день</span>' + seg('newPerDay', [['10', '10'], ['20', '20'], ['30', '30'], ['0', 'Все']]) + '<p>Если пришлёшь много слов сразу, они будут добавляться в повторение постепенно.</p></div>' +
      (canSpeak ? '<div class="setting"><span class="label">Произношение</span>' + seg('accent', [['en-GB', 'Британское'], ['en-US', 'Американское']]) + '<p>Голос берётся из телефона и работает без интернета.</p></div>' : '') +
      '</section>';
    html += '<section class="panel"><div class="setting"><span class="label">Новые слова</span><p>Приложение само проверяет новые слова при каждом запуске, если есть интернет.</p></div>' + syncLine() +
      '<button class="btn block" data-act="sync">Проверить сейчас</button></section>';
    html += '<section class="panel"><div class="setting"><span class="label">Резервная копия прогресса</span><p>Прогресс хранится только на этом устройстве. Скопируй его и сохрани, например, в Заметки, или перенеси на другое устройство.</p></div>' +
      '<button class="btn block" data-act="backup">Скопировать прогресс</button>' +
      (state.restoreOpen
        ? '<textarea class="backup" id="restore-text" placeholder="Вставь сюда скопированный прогресс"></textarea><div class="row"><button class="btn primary" data-act="restore">Восстановить</button><button class="btn" data-act="restore-cancel">Отмена</button></div>'
        : '<button class="btn ghost" data-act="restore-open">Восстановить из копии</button>') +
      '</section>';
    html += installNote();
    return html;
  }

  // ---------- session ----------
  function pickDir() { const d = state.settings.dir; return d === 'mix' ? (Math.random() < 0.5 ? 'en' : 'ru') : d; }
  function startSession() {
    const q = buildQueue();
    const items = q.due.concat(q.fresh).map((w) => ({ id: w.id, dir: pickDir() }));
    if (!items.length) return;
    session = { queue: items, pos: 0, revealed: false, first: {}, total: items.length };
    openOverlay(); renderSession();
  }
  function cardFront(w, dir) {
    const isNew = !prog(w.id);
    const meta = '<div class="icard-meta"><span>' + (dir === 'en' ? 'EN → RU' : 'RU → EN') + (isNew ? ' · новое' : '') + '</span>' + leitner(w) + '</div>';
    let body;
    // На карточке только слово, перевод и пример.
    if (dir === 'en') {
      body = '<div class="headword"><div class="hw">' + esc(w.word) + '</div>' + speakBtn(w.word) + '</div>';
    } else {
      body = '<div class="headword"><div class="hw ru">' + esc(w.tr) + '</div></div>';
    }
    return { meta, body };
  }
  function cardBack(w, dir) {
    let h = '<div class="answer">';
    if (dir === 'en') h += '<div class="tr">' + esc(w.tr) + '</div>';
    else h += '<div class="headword"><div class="hw">' + esc(w.word) + '</div>' + speakBtn(w.word) + '</div>';
    if (w.ex) h += '<div class="ex">' + fmtEx(w.ex, w.word) + '</div>';
    return h + '</div>';
  }
  function renderSession() {
    const ov = $('#overlay');
    if (session.pos >= session.queue.length) return renderSessionDone();
    const item = session.queue[session.pos];
    const w = byId(item.id);
    if (!w) { session.pos++; return renderSession(); }
    const done = Object.keys(session.first).length;
    const pct = Math.round((done / session.total) * 100);
    const f = cardFront(w, item.dir);
    let h = '<div class="sheet"><div class="sheet-top"><button class="icon-btn" data-act="close" aria-label="Закончить">' + ICON.close + '</button><div class="progress"><i style="width:' + pct + '%"></i></div><span class="count">' + done + '/' + session.total + '</span></div>' +
      '<article class="icard" data-act="' + (session.revealed ? '' : 'reveal') + '">' + f.meta + '<div class="icard-body">' + f.body + (session.revealed ? cardBack(w, item.dir) : '') + '</div></article>';
    if (!session.revealed) {
      h += '<button class="btn primary block" data-act="reveal">Показать ответ</button><div class="keys">Пробел — показать ответ</div>';
    } else {
      const lbl = (g) => short(diffDays(today(), nextFor(w.id, g).due));
      h += '<div class="grades"><button class="grade bad" data-grade="forgot">Не помню<small>' + lbl('forgot') + '</small></button>' +
        '<button class="grade warn" data-grade="hard">С трудом<small>' + lbl('hard') + '</small></button>' +
        '<button class="grade good" data-grade="know">Помню<small>' + lbl('know') + '</small></button></div><div class="keys">Клавиши 1 · 2 · 3</div>';
    }
    h += '</div>';
    ov.innerHTML = h;
    ov.scrollTop = 0;
  }
  function grade(g) {
    const item = session.queue[session.pos];
    applyGrade(item.id, g);
    if (!(item.id in session.first)) session.first[item.id] = g;
    if (g === 'forgot') {
      const at = Math.min(session.pos + 4, session.queue.length);
      session.queue.splice(at, 0, { id: item.id, dir: item.dir });
    }
    session.pos++;
    session.revealed = false;
    renderSession();
  }
  function renderSessionDone() {
    const v = Object.values(session.first);
    const c = { know: 0, hard: 0, forgot: 0 };
    v.forEach((g) => c[g]++);
    $('#overlay').innerHTML = '<div class="sheet"><div class="sheet-top"><button class="icon-btn" data-act="close" aria-label="Закрыть">' + ICON.close + '</button><div class="progress"><i style="width:100%"></i></div><span class="count">' + v.length + '/' + session.total + '</span></div>' +
      '<section class="panel summary"><div class="big">' + v.length + '</div><div class="done-mark">' + plural(v.length, ['слово повторено', 'слова повторено', 'слов повторено']) + '</div>' +
      '<div class="tally"><div class="t-good"><b>' + c.know + '</b><span>помню</span></div><div class="t-warn"><b>' + c.hard + '</b><span>с трудом</span></div><div class="t-bad"><b>' + c.forgot + '</b><span>не помнил</span></div></div>' +
      '<button class="btn primary block" data-act="close">Готово</button></section></div>';
  }

  // ---------- quiz ----------
  function weakFirst(n) {
    const rated = words().map((w) => { const p = prog(w.id); return { w, k: (p ? p.lvl : 0) + Math.random() * 2.5 }; });
    rated.sort((a, b) => a.k - b.k);
    return shuffle(rated.slice(0, n).map((r) => r.w));
  }
  function startQuiz(mode) {
    const pool = weakFirst(Math.min(10, words().length));
    const items = pool.map((w) => {
      if (mode === 'type') return { id: w.id };
      const others = shuffle(words().filter((x) => x.id !== w.id)).slice(0, 3);
      return { id: w.id, options: shuffle([w].concat(others)).map((x) => x.id) };
    });
    quiz = { mode, items, pos: 0, answer: null, right: 0, wrong: [], hint: 0 };
    openOverlay(); renderQuiz();
    if (mode === 'listen') setTimeout(() => speak(byId(items[0].id).word), 250);
  }
  function renderQuiz() {
    const ov = $('#overlay');
    if (quiz.pos >= quiz.items.length) return renderQuizDone();
    const it = quiz.items[quiz.pos];
    const w = byId(it.id);
    const pct = Math.round((quiz.pos / quiz.items.length) * 100);
    let h = '<div class="sheet"><div class="sheet-top"><button class="icon-btn" data-act="close" aria-label="Закончить тест">' + ICON.close + '</button><div class="progress"><i style="width:' + pct + '%"></i></div><span class="count">' + (quiz.pos + 1) + '/' + quiz.items.length + '</span></div>';
    const a = quiz.answer;
    if (quiz.mode === 'choice' || quiz.mode === 'listen') {
      const listen = quiz.mode === 'listen';
      h += '<article class="icard"><div class="icard-meta"><span>' + (listen ? 'На слух' : 'Выбери перевод') + '</span>' + leitner(w) + '</div><div class="icard-body">' +
        (listen
          ? '<div class="headword"><div><div class="hw">' + (a ? esc(w.word) : '?') + '</div>' + (a && w.ipa ? '<div class="ipa">' + esc(w.ipa) + '</div>' : '<div class="hint">Нажми, чтобы послушать ещё раз</div>') + '</div>' + speakBtn(w.word, 'Послушать') + '</div>'
          : '<div class="headword"><div><div class="hw">' + esc(w.word) + '</div>' + (w.pos ? '<div class="pos">' + esc(w.pos) + '</div>' : '') + '</div>' + speakBtn(w.word) + '</div>') +
        '</div></article><div class="options">' + it.options.map((id) => {
          const o = byId(id);
          let cls = 'opt';
          if (a) { if (id === w.id) cls += ' right'; else if (id === a.chosen) cls += ' wrong'; }
          const label = listen ? '<span style="font-family:var(--serif);font-weight:700;font-size:18px">' + esc(o.word) + '</span> <span class="muted">— ' + esc(o.tr) + '</span>' : esc(o.tr);
          return '<button class="' + cls + '" data-choice="' + esc(id) + '"' + (a ? ' disabled' : '') + '>' + label + '</button>';
        }).join('') + '</div>';
    } else {
      const hintEx = w.ex ? fmtEx(w.ex, w.word, true) : '';
      h += '<article class="icard"><div class="icard-meta"><span>Напиши по-английски</span>' + leitner(w) + '</div><div class="icard-body">' +
        '<div class="hw ru">' + esc(w.tr) + '</div>' + (w.pos ? '<div class="pos">' + esc(w.pos) + '</div>' : '') +
        (quiz.hint >= 1 && hintEx ? '<div class="ex">' + hintEx + '</div>' : '') +
        (quiz.hint >= 2 ? '<div class="hint">Начинается на «' + esc(String(w.word).replace(/^to /i, '').charAt(0)) + '», ' + String(w.word).replace(/^to /i, '').length + ' ' + plural(String(w.word).replace(/^to /i, '').length, ['буква', 'буквы', 'букв']) + '</div>' : '') +
        '</div></article>' +
        '<form id="type-form" autocomplete="off"><input class="field' + (a ? (a.ok ? ' right' : ' wrong') : '') + '" id="type-in" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="Слово по-английски" value="' + esc(a ? a.typed : '') + '"' + (a ? ' readonly' : '') + '></form>';
      if (!a) h += '<div class="row"><button class="btn primary" style="flex:1" data-act="check">Проверить</button>' + (quiz.hint < 2 ? '<button class="btn" data-act="hint">Подсказка</button>' : '') + '</div>';
      else h += '<div class="verdict ' + (a.ok ? 'ok' : 'no') + '">' + (a.ok ? 'Верно' : 'Правильно: <span style="font-family:var(--serif);font-size:19px">' + esc(w.word) + '</span>') + '</div>' +
        (w.ex ? '<div class="ex">' + fmtEx(w.ex, w.word) + '</div>' : '');
    }
    if (a) h += '<button class="btn primary block" data-act="next">' + (quiz.pos + 1 < quiz.items.length ? 'Дальше' : 'Результат') + '</button>';
    h += '</div>';
    ov.innerHTML = h;
    if (quiz.mode === 'type' && !a) { const inp = $('#type-in'); if (inp) setTimeout(() => inp.focus(), 50); }
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[’`]/g, "'").replace(/\*/g, '').replace(/\s+/g, ' ').trim().replace(/^to /, '');
  function answerChoice(id) {
    const w = byId(quiz.items[quiz.pos].id);
    const ok = id === w.id;
    quiz.answer = { chosen: id, ok };
    if (ok) quiz.right++; else quiz.wrong.push(w.id);
    renderQuiz();
  }
  function answerType() {
    const inp = $('#type-in');
    const typed = inp ? inp.value : '';
    if (!typed.trim()) { if (inp) inp.focus(); return; }
    const w = byId(quiz.items[quiz.pos].id);
    const ok = norm(typed) === norm(w.word);
    quiz.answer = { typed, ok };
    if (ok) quiz.right++; else quiz.wrong.push(w.id);
    renderQuiz();
  }
  function nextQuestion() {
    quiz.pos++; quiz.answer = null; quiz.hint = 0;
    renderQuiz();
    if (quiz.mode === 'listen' && quiz.pos < quiz.items.length) setTimeout(() => speak(byId(quiz.items[quiz.pos].id).word), 200);
  }
  function renderQuizDone() {
    const n = quiz.items.length;
    $('#overlay').innerHTML = '<div class="sheet"><div class="sheet-top"><button class="icon-btn" data-act="close" aria-label="Закрыть">' + ICON.close + '</button><div class="progress"><i style="width:100%"></i></div><span class="count">' + n + '/' + n + '</span></div>' +
      '<section class="panel summary"><div class="big">' + quiz.right + '<span class="muted" style="font-size:28px"> / ' + n + '</span></div><div class="done-mark">' +
      (quiz.right === n ? 'Без единой ошибки' : quiz.right >= n * 0.7 ? 'Хороший результат' : 'Эти слова стоит повторить') + '</div>' +
      (quiz.wrong.length ? '<div class="mistakes">' + quiz.wrong.map((id) => { const w = byId(id); return '<div><b>' + esc(w.word) + '</b> — ' + esc(w.tr) + '</div>'; }).join('') + '</div>' : '') +
      '<div class="row" style="width:100%"><button class="btn" style="flex:1" data-act="quiz-again">Ещё раз</button><button class="btn primary" style="flex:1" data-act="close">Готово</button></div></section></div>';
  }

  // ---------- добавление слова в приложении ----------
  function openAdd() {
    state.addOpen = true;
    openOverlay();
    $('#overlay').innerHTML = '<div class="sheet"><div class="sheet-top"><button class="icon-btn" data-act="close" aria-label="Закрыть">' + ICON.close + '</button><h2 style="flex:1">Новое слово</h2></div><div id="add-dup"></div>' +
      '<form id="add-form" class="panel" autocomplete="off">' +
      '<div class="setting"><label for="add-word">Слово или выражение</label><input class="field" id="add-word" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next" placeholder="например, ubiquitous"></div>' +
      '<div class="setting"><label for="add-tr">Перевод</label><input class="field sm" id="add-tr" enterkeyhint="next" placeholder="можно оставить пустым — переведёт Claude"></div>' +
      '<div class="setting"><label for="add-ex">Где встретил</label><textarea class="field sm" id="add-ex" rows="3" placeholder="предложение с этим словом (необязательно)"></textarea></div>' +
      '<button class="btn primary block" type="submit">Сохранить</button>' +
      '<p class="small muted" style="margin:0">С переводом слово сразу попадёт в повторение. Без перевода — подождёт, пока ты отправишь его Claude.</p>' +
      '</form><div id="add-saved" class="small muted" style="text-align:center"></div></div>';
    setTimeout(() => { const i = $('#add-word'); if (i) i.focus(); }, 60);
  }
  // Есть ли слово уже в словаре (у Claude или добавленное на телефоне)
  function findExisting(word) {
    const n = norm(word), s2 = slug(String(word).replace(/^to /i, ''));
    const match = (w) => norm(w.word) === n || slug(String(w.word).replace(/^to /i, '')) === s2 ||
      (w.from && String(w.from).split('|').some((f) => norm(f) === n));
    const loc = state.local.find((l) => !l.replaces && match(l));
    if (loc) return { kind: 'local', w: loc };
    const srv = serverWords().find((w) => match(w) || state.local.some((l) => l.replaces === w.id && match(l)));
    if (srv) return { kind: 'server', w: words().find((x) => x.id === srv.id) || srv };
    return null;
  }
  function saveNewWord() {
    const wi = $('#add-word'), ti = $('#add-tr'), ei = $('#add-ex');
    const word = wi.value.trim().replace(/\s+/g, ' ');
    if (!word) { wi.focus(); return; }
    const entry = { id: slug(word) || ('w-' + Date.now().toString(36)), word, added: today(), local: true };
    const tr = ti.value.trim(); const ex = ei.value.trim();
    if (tr) entry.tr = tr;
    if (ex) entry.ex = ex;
    const existing = findExisting(word);
    if (existing) { state.dup = { entry, existing }; renderDup(); return; }
    commitNew(entry);
  }
  function commitNew(entry) {
    state.local.push(entry);
    saveLocal();
    toast(entry.tr ? '«' + entry.word + '» добавлено в повторение' : '«' + entry.word + '» сохранено — переведёт Claude');
    afterSave();
  }
  function afterSave() {
    state.dup = null;
    const box = $('#add-dup'); if (box) box.innerHTML = '';
    const wi = $('#add-word'), ti = $('#add-tr'), ei = $('#add-ex');
    if (!wi) return;
    wi.value = ''; ti.value = ''; ei.value = '';
    const n = state.local.length;
    $('#add-saved').textContent = n ? 'На телефоне ' + n + ' ' + plural(n, ['слово', 'слова', 'слов']) + ' для Claude' : '';
    wi.focus();
  }
  function renderDup() {
    const { entry, existing } = state.dup;
    const old = existing.w;
    $('#add-dup').innerHTML = '<section class="dup" role="alert">' +
      '<b>«' + esc(old.word) + '» уже есть в словаре</b>' +
      '<div class="dup-grid"><span class="muted">Сейчас</span><span>' + (old.tr ? esc(old.tr) : '<span class="tag">ждёт перевода</span>') + '</span>' +
      '<span class="muted">Новое</span><span>' + esc(entry.word) + (entry.tr ? ' — ' + esc(entry.tr) : ' <span class="muted">(без перевода)</span>') + '</span></div>' +
      '<div class="dup-actions"><button class="btn" data-act="dup-discard">Удалить новое слово</button>' +
      '<button class="btn primary" data-act="dup-replace">Заменить старое новым</button></div>' +
      '<p class="small muted" style="margin:0">При замене прогресс по этому слову начнётся заново.</p></section>';
    const b = $('#add-dup [data-act=dup-replace]'); if (b) b.focus({ preventScroll: true });
    $('#overlay').scrollTo({ top: 0, behavior: 'smooth' });
  }
  function dupReplace() {
    const { entry, existing } = state.dup;
    if (existing.kind === 'local') {
      const id = existing.w.id;
      const i = state.local.indexOf(existing.w);
      state.local[i] = Object.assign({}, entry, { id });
      delete state.progress[id];
    } else {
      const sid = existing.w.id;
      state.local = state.local.filter((l) => l.replaces !== sid);
      state.local.push(Object.assign({}, entry, { id: 'r-' + sid, replaces: sid, createdAt: new Date().toISOString() }));
      delete state.progress[sid];
    }
    saveLocal(); saveProgress();
    toast('Старая карточка заменена новой');
    afterSave();
  }
  function dupDiscard() {
    toast('Новое слово не добавлено');
    afterSave();
  }
  function sendText() {
    const lines = state.local.map((l) => {
      const extra = [];
      if (l.replaces) extra.push('заменить старую карточку');
      if (l.ex) extra.push('встретил: «' + l.ex + '»');
      return '- ' + l.word + (l.tr ? ' — ' + l.tr : '') + (extra.length ? ' (' + extra.join('; ') + ')' : '');
    });
    return 'Добавь в «Мои слова»:\n' + lines.join('\n');
  }
  async function sendToClaude() {
    if (!state.local.length) return;
    const text = sendText();
    const mark = () => { const t = new Date().toISOString(); state.local.forEach((l) => { l.sentAt = l.sentAt || t; }); saveLocal(); render(); };
    if (navigator.share) {
      try { await navigator.share({ text }); mark(); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text); mark(); toast('Скопировано — вставь в чат с Claude'); }
    catch (e) {
      openOverlay();
      $('#overlay').innerHTML = '<div class="sheet"><div class="sheet-top"><button class="icon-btn" data-act="close" aria-label="Закрыть">' + ICON.close + '</button><h2 style="flex:1">Скопируй и отправь Claude</h2></div>' +
        '<textarea class="backup" id="send-text" readonly>' + esc(text) + '</textarea></div>';
      const t = $('#send-text'); if (t) { t.focus(); t.select(); }
      mark();
    }
  }

  // ---------- overlay / render ----------
  function openOverlay() { $('#overlay').hidden = false; document.body.style.overflow = 'hidden'; }
  function closeOverlay() {
    session = null; quiz = null; state.addOpen = false; state.dup = null;
    if (canSpeak) try { speechSynthesis.cancel(); } catch (e) { /* */ }
    const ov = $('#overlay'); ov.hidden = true; ov.innerHTML = '';
    document.body.style.overflow = '';
    render();
  }
  function updateBadge() {
    const b = $('#badge');
    const q = buildQueue();
    const n = q.due.length + q.fresh.length;
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = !n;
  }
  function render() {
    const v = $('#view');
    const map = { home: viewHome, quiz: viewQuiz, dict: viewDict, settings: viewSettings };
    v.innerHTML = (map[state.tab] || viewHome)();
    document.querySelectorAll('.tab').forEach((t) => { if (t.dataset.tab === state.tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
    updateBadge();
  }
  function goTab(tab) {
    state.tab = tab;
    if (tab !== 'home') state.newCount = 0;
    render();
    window.scrollTo(0, 0);
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-speak],[data-tab],[data-tab-go],[data-act],[data-grade],[data-choice],[data-filter],[data-open],[data-reset],[data-reset-ask],[data-reset-cancel],[data-set],[data-del],[data-del-ask],[data-del-cancel]');
    if (!el) return;
    if (el.dataset.delAsk) { state.dict.confirmDel = el.dataset.delAsk; return render(); }
    if (el.dataset.delCancel) { state.dict.confirmDel = null; return render(); }
    if (el.dataset.del) {
      const id = el.dataset.del;
      state.local = state.local.filter((l) => l.id !== id); saveLocal();
      if (!words().some((w) => w.id === id)) { delete state.progress[id]; saveProgress(); }
      state.dict.confirmDel = null; toast('Слово удалено'); return render();
    }
    if (el.dataset.speak !== undefined) { e.stopPropagation(); speak(el.dataset.speak); return; }
    if (el.dataset.tab) return goTab(el.dataset.tab);
    if (el.dataset.tabGo) return goTab(el.dataset.tabGo);
    if (el.dataset.grade) return grade(el.dataset.grade);
    if (el.dataset.choice) return answerChoice(el.dataset.choice);
    if (el.dataset.filter) { state.dict.filter = el.dataset.filter; return render(); }
    if (el.dataset.open) { state.dict.open = state.dict.open === el.dataset.open ? null : el.dataset.open; state.dict.confirmReset = null; return render(); }
    if (el.dataset.resetAsk) { state.dict.confirmReset = el.dataset.resetAsk; return render(); }
    if (el.dataset.resetCancel) { state.dict.confirmReset = null; return render(); }
    if (el.dataset.reset) { delete state.progress[el.dataset.reset]; saveProgress(); state.dict.confirmReset = null; toast('Прогресс слова сброшен'); return render(); }
    if (el.dataset.set) {
      const k = el.dataset.set; let v = el.dataset.val;
      if (k === 'newPerDay') v = Number(v);
      state.settings[k] = v; saveSettings();
      if (k === 'accent') speak('pronunciation');
      return render();
    }
    switch (el.dataset.act) {
      case 'start': return startSession();
      case 'add': return openAdd();
      case 'dup-replace': return state.dup && dupReplace();
      case 'dup-discard': return state.dup && dupDiscard();
      case 'send': return sendToClaude();
      case 'reveal': if (session && !session.revealed) { session.revealed = true; renderSession(); } return;
      case 'close': return closeOverlay();
      case 'quiz-choice': return startQuiz('choice');
      case 'quiz-type': return startQuiz('type');
      case 'quiz-listen': return startQuiz('listen');
      case 'quiz-again': { const m = quiz.mode; return startQuiz(m); }
      case 'check': return answerType();
      case 'hint': quiz.hint++; return renderQuiz();
      case 'next': return nextQuestion();
      case 'sync': return sync(true);
      case 'more-new': {
        const cur = Number(state.settings.newPerDay) || 0;
        if (cur > 0) { state.settings.newPerDay = introducedToday() + 10; saveSettings(); }
        render(); toast('Лимит новых на сегодня увеличен'); return;
      }
      case 'backup': return backup();
      case 'restore-open': state.restoreOpen = true; render(); setTimeout(() => { const t = $('#restore-text'); if (t) t.focus(); }, 30); return;
      case 'restore-cancel': state.restoreOpen = false; return render();
      case 'restore': return restore();
      default: return;
    }
  });

  document.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'add-form') return saveNewWord();
    if (quiz && quiz.mode === 'type' && !quiz.answer) answerType();
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'dict-q') {
      state.dict.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = $('#dict-q'); if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch (err) { /* */ } }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (state.addOpen) {
      if (e.key === 'Escape') closeOverlay();
      // Enter в поле слова/перевода — к следующему полю
      if (e.key === 'Enter' && (e.target.id === 'add-word' || e.target.id === 'add-tr')) {
        e.preventDefault(); const next = e.target.id === 'add-word' ? '#add-tr' : '#add-ex'; const n = $(next); if (n) n.focus();
      }
      return;
    }
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) {
      if (quiz && quiz.answer && e.key === 'Enter') { e.preventDefault(); nextQuestion(); }
      return;
    }
    if (session) {
      if (session.pos >= session.queue.length) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeOverlay(); } return; }
      if (!session.revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); session.revealed = true; renderSession(); return; }
      if (session.revealed) { const g = { 1: 'forgot', 2: 'hard', 3: 'know' }[e.key]; if (g) { e.preventDefault(); grade(g); } }
      if (e.key === 'Escape') closeOverlay();
      return;
    }
    if (quiz) {
      if (quiz.answer && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (quiz.pos < quiz.items.length) nextQuestion(); else closeOverlay(); return; }
      if (!quiz.answer && quiz.mode !== 'type' && quiz.pos < quiz.items.length) { const i = Number(e.key) - 1; const it = quiz.items[quiz.pos]; if (it.options && it.options[i]) answerChoice(it.options[i]); }
      if (e.key === 'Escape') closeOverlay();
    }
  });

  // ---------- backup ----------
  async function backup() {
    const payload = JSON.stringify({ app: 'mw', v: 1, at: new Date().toISOString(), progress: state.progress, settings: state.settings });
    try { await navigator.clipboard.writeText(payload); toast('Прогресс скопирован — вставь его в Заметки'); }
    catch (e) {
      state.restoreOpen = true; render();
      const t = $('#restore-text'); if (t) { t.value = payload; t.select(); }
      toast('Скопируй текст из поля вручную');
    }
  }
  function restore() {
    const t = $('#restore-text');
    try {
      const d = JSON.parse(t.value);
      if (!d || d.app !== 'mw' || typeof d.progress !== 'object') throw new Error('bad');
      state.progress = d.progress; saveProgress();
      if (d.settings) { state.settings = Object.assign(state.settings, d.settings); saveSettings(); }
      state.restoreOpen = false; render(); toast('Прогресс восстановлен');
    } catch (e) { toast('Это не похоже на копию прогресса'); }
  }

  // ---------- start ----------
  reconcileLocal();
  render();
  sync(false);
  let lastSync = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (Date.now() - lastSync > 5 * 60 * 1000) { lastSync = Date.now(); sync(false); }
      else if (!session && !quiz) render(); // новый день — новая очередь
    }
  });
  window.addEventListener('online', () => { lastSync = Date.now(); sync(false); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded || session || quiz) return;
      reloaded = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
