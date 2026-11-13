'use strict';
/* Мои слова — офлайн-карточки для английских слов.
   Слова: words.json (их добавляет Claude). Прогресс: localStorage этого устройства. */
(() => {
  const VERSION = '1.5';
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
    settings: Object.assign({ dir: 'en', newPerDay: 20, accent: 'en-GB', topic: 'all', lastTopic: '' }, LS.get(K.settings, {}) || {}),
    syncedAt: LS.get(K.synced, null),
    local: LS.get(K.local, []) || [], // слова, добавленные прямо в приложении (ещё не у Claude)
    addOpen: false,
    sync: 'idle', // idle | loading | ok | offline | error
    newCount: 0,
    tab: 'home',
    dict: { q: '', filter: 'all', topic: 'all', open: null, confirmReset: null },
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
      if (o.topic) m.topic = o.topic;
      return m;
    });
    return s.concat(state.local.filter((l) => l.tr && !l.replaces));
  };
  const pendingLocal = () => state.local.filter((l) => !l.tr && !l.replaces);

  // ---------- темы ----------
  const ESSAY = 'Слова для эссе', MISC = 'Разное';
  const topicOf = (w) => w.topic || MISC;
  // приглушённые цвета-метки тем (только точки и полоски, не заливки)
  const TOPIC_COLORS = {
    'Технологии и медиа': '#4A7BD0', 'Экономика, деньги и покупки': '#2E9C7C', 'Работа и карьера': '#8A68C9',
    'Учёба и наука': '#2F9DBA', 'Общество, политика и право': '#A06D4E', 'Люди и отношения': '#D9775F',
    'Чувства и характер': '#C9618E', 'Здоровье и спорт': '#4FA65A', 'Природа и экология': '#7A9A33',
    'Город, дом и путешествия': '#C99A2E', 'Еда и рестораны': '#DE8034', 'Культура: кино, книги, искусство': '#6E73D6',
    'Микроэкономика': '#A0509E', 'Слова для эссе': '#64748B', 'Разное': '#9AA3B0',
  };
  const EXTRA_COLORS = ['#4A7BD0', '#2E9C7C', '#8A68C9', '#D9775F', '#C99A2E', '#C9618E', '#2F9DBA', '#7A9A33'];
  function topicColor(t) {
    if (TOPIC_COLORS[t]) return TOPIC_COLORS[t];
    let h = 0; for (const ch of String(t)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return EXTRA_COLORS[h % EXTRA_COLORS.length];
  }
  const tdot = (t) => '<i class="tdot" style="--tc:' + topicColor(t) + '" aria-hidden="true"></i>';
  const inTopic = (w, t) => !t || t === 'all' || topicOf(w) === t || (t === ESSAY && w.essay === true);
  function allTopics() {
    const base = state.data && Array.isArray(state.data.topics) ? state.data.topics.slice() : [];
    const extra = [];
    serverWords().concat(state.local).forEach((w) => { const t = w.topic; if (t && !base.includes(t) && !extra.includes(t)) extra.push(t); });
    const i = base.indexOf(ESSAY);
    if (i >= 0) base.splice(i, 0, ...extra); else base.push(...extra);
    if (!base.includes(ESSAY)) base.push(ESSAY);
    if (!base.includes(MISC)) base.push(MISC);
    return base;
  }
  function topicCounts(ws) {
    const c = {};
    ws.forEach((w) => { const t = topicOf(w); c[t] = (c[t] || 0) + 1; if (w.essay === true && t !== ESSAY) c[ESSAY] = (c[ESSAY] || 0) + 1; });
    return c;
  }
  const usedTopics = (ws) => { const c = topicCounts(ws); return allTopics().filter((t) => c[t]); };
  const studyTopic = () => { const t = state.settings.topic; return t && t !== 'all' && usedTopics(words()).includes(t) ? t : 'all'; };
  function topicSelect(id, withCounts, dark) {
    const ws = words();
    const used = usedTopics(ws);
    if (used.length < 2) return '';
    const cur = studyTopic();
    const label = (t) => {
      if (!withCounts) return t;
      const q = buildQueue(t); const n = q.due.length + q.fresh.length;
      return t + (n ? ' · ' + n : '');
    };
    const qa = buildQueue('all'); const na = qa.due.length + qa.fresh.length;
    return '<label class="topic-pick' + (dark ? ' on-dark' : '') + '" for="' + id + '"><span>Тема</span><select id="' + id + '" class="select">' +
      '<option value="all"' + (cur === 'all' ? ' selected' : '') + '>Все темы' + (withCounts && na ? ' · ' + na : '') + '</option>' +
      used.map((t) => '<option value="' + esc(t) + '"' + (cur === t ? ' selected' : '') + '>' + esc(label(t)) + '</option>').join('') +
      '</select></label>';
  }
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
  function buildQueue(topic) {
    const t = today();
    const tp = topic === undefined ? studyTopic() : topic;
    const ws = words().filter((w) => inTopic(w, tp));
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
      setTimeout(autoFillPending, 300);
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
    let html = '<header class="top row spread" style="flex-direction:row;align-items:center"><h1>Мои слова</h1>' +
      '<button class="btn add-btn" data-act="add" aria-label="Добавить слово"><span aria-hidden="true">+</span> Слово</button></header>';
    if (state.newCount) html += '<div class="news">+' + state.newCount + ' ' + plural(state.newCount, ['новое слово', 'новых слова', 'новых слов']) + ' от Claude</div>';
    html += localPanel(true);

    if (!ws.length) {
      html += '<section class="hero"><div class="hero-done">Слов пока нет</div>' +
        '<p class="hero-sub">Пришли Claude незнакомые английские слова или добавь их сам кнопкой «+ Слово». Они появятся здесь вместе с переводом и примером.</p>' +
        '<button class="btn hero-btn block" data-act="add">Добавить первое слово</button></section>' +
        '<article class="icard" aria-label="Пример карточки"><div class="icard-meta"><span class="meta-topic">' + tdot('Слова для эссе') + 'Так выглядит карточка</span>' + '<span class="leitner"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></div>' +
        '<div class="icard-body"><div class="headword"><div class="hw">ubiquitous</div></div>' +
        '<div class="answer"><div class="tr">вездесущий, повсеместный</div>' +
        '<div class="ex">Smartphones have become <mark>ubiquitous</mark> in daily life.</div></div></div></article>';
      html += installNote();
      return html;
    }

    const q = buildQueue();
    const total = q.due.length + q.fresh.length;
    if (total) {
      html += '<section class="hero">' + topicSelect('study-topic', true, true) +
        '<div class="hero-main"><div class="hero-num">' + total + '</div><div class="hero-lbl"><b>' + plural(total, ['карточка', 'карточки', 'карточек']) + ' на сегодня</b><span>' +
        q.due.length + ' на повтор · ' + q.fresh.length + ' ' + plural(q.fresh.length, ['новое', 'новых', 'новых']) + '</span></div></div>' +
        '<button class="btn hero-btn block" data-act="start">Начать повторение</button></section>';
    } else {
      const tws = words().filter((w) => inTopic(w, studyTopic()));
      const next = tws.map((w) => prog(w.id)).filter(Boolean).map((p) => p.due).sort()[0];
      const nextN = next ? tws.filter((w) => { const p = prog(w.id); return p && p.due === next; }).length : 0;
      html += '<section class="hero done">' + topicSelect('study-topic', true, true) +
        '<div class="hero-done"><span class="hero-check" aria-hidden="true">✓</span>' + (studyTopic() === 'all' ? 'На сегодня всё повторено' : 'По этой теме на сегодня всё') + '</div>' +
        '<p class="hero-sub">' +
        (q.waitingNew ? 'Ещё ' + q.waitingNew + ' ' + plural(q.waitingNew, ['новое слово ждёт', 'новых слова ждут', 'новых слов ждут']) + ' — лимит новых на сегодня исчерпан. ' : '') +
        (next ? 'Следующее повторение ' + when(next) + ': ' + nextN + ' ' + plural(nextN, W) + '.' : '') + '</p>' +
        (q.waitingNew ? '<button class="btn hero-btn block" data-act="more-new">Добавить ещё 10 новых на сегодня</button>' : '') +
        '<button class="btn hero-ghost" data-tab-go="quiz">Пройти тест по словам →</button></section>';
    }

    const counts = { new: 0, learning: 0, learned: 0 };
    ws.forEach((w) => counts[status(w)]++);
    html += '<section class="strip"><div><b>' + ws.length + '</b><span>всего</span></div><div><b class="c-learn">' + counts.learning + '</b><span>изучаю</span></div><div><b class="c-good">' + counts.learned + '</b><span>выучено</span></div></section>';

    // уровни (коробки Лейтнера): цвет темнеет с уровнем, выученные — зелёные
    const lv = new Array(MAX_LVL + 1).fill(0);
    ws.forEach((w) => { const p = prog(w.id); lv[p ? p.lvl : 0]++; });
    const maxLv = Math.max(1, ...lv);
    const labels = ['нов.', '1 д', '3 д', '7 д', '14 д', '30 д', '60 д', '120 д'];
    let bars = '';
    lv.forEach((n, i) => {
      bars += '<div class="bar"><em>' + (n || '') + '</em><i class="l' + i + (n === 0 ? ' zero' : '') + '" style="height:' + Math.max(3, Math.round((n / maxLv) * 72)) + 'px"></i></div>';
    });
    html += '<section class="panel"><div class="sec-h"><h2>Коробки Лейтнера</h2><span>через сколько повтор</span></div><div class="bars">' + bars + '</div><div class="bar-labels">' +
      labels.map((l) => '<span>' + l + '</span>').join('') + '</div></section>';

    const fc = forecast(7);
    html += '<section class="panel"><div class="sec-h"><h2>Повторы на неделю</h2></div><div class="week">' + fc.map((f, i) => {
      const [y, m, d] = f.d.split('-').map(Number);
      const wd = WD[new Date(y, m - 1, d).getDay()];
      return '<div class="day' + (i === 0 ? ' today' : '') + (f.n ? '' : ' zero') + '"><b>' + f.n + '</b><span>' + (i === 0 ? 'сег.' : wd) + '</span></div>';
    }).join('') + '</div></section>';

    html += installNote();
    return html;
  }

  function viewQuiz() {
    const n = words().length;
    let html = '<header class="top"><div class="eyebrow">10 вопросов · не влияет на расписание</div><h1>Тест</h1></header>';
    if (n < 1) return html + '<div class="panel empty">Сначала нужны слова — пришли их Claude.</div>';
    html += '<section class="quiz-modes">' + topicSelect('quiz-topic', false) +
      '<button class="mode" data-act="quiz-choice"' + (n < 4 ? ' disabled' : '') + '><i class="mode-ic m1"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="11" width="18" height="5" rx="1.5"/><path d="M7 20h10"/></svg></i><b>Выбери перевод</b><span>Слово по-английски и четыре варианта перевода' + (n < 4 ? ' · нужно минимум 4 слова' : '') + '</span></button>' +
      '<button class="mode" data-act="quiz-type"><i class="mode-ic m2"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></i><b>Напиши слово</b><span>Перевод по-русски — вспомни и напиши английское слово</span></button>' +
      '<button class="mode" data-act="quiz-listen"' + (canSpeak && n >= 4 ? '' : ' disabled') + '><i class="mode-ic m3"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg></i><b>На слух</b><span>Слушаешь произношение и выбираешь слово' + (!canSpeak ? ' · озвучка недоступна' : n < 4 ? ' · нужно минимум 4 слова' : '') + '</span></button>' +
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
    const tp = state.dict.topic !== 'all' && !usedTopics(ws).includes(state.dict.topic) ? 'all' : state.dict.topic;
    const list = ws.filter((w) => {
      if (!inTopic(w, tp)) return false;
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
      topicChips(ws, tp) +
      '<div class="chips">' + chip('all', 'Все') + chip('new', 'Новые') + chip('learning', 'Изучаю') + chip('learned', 'Выучено') + chip('due', 'К повтору') + '</div>';
    if (!list.length) return html + '<div class="list"><div class="empty">' + (ws.length ? 'Ничего не нашлось' : 'Слов пока нет — пришли их Claude') + '</div></div>';
    if (tp === 'all' && !q) {
      // по темам, внутри — новые сверху
      const groups = usedTopics(list).filter((t) => t !== ESSAY || list.some((w) => topicOf(w) === ESSAY));
      html += groups.map((t) => {
        const g = list.filter((w) => topicOf(w) === t);
        if (!g.length) return '';
        return '<section class="tgroup" style="--tc:' + topicColor(t) + '"><div class="tgroup-h"><span>' + esc(t) + '</span><em>' + g.length + '</em></div><div class="list">' + g.map(itemHtml).join('') + '</div></section>';
      }).join('');
    } else {
      html += '<div class="list">' + list.map(itemHtml).join('') + '</div>';
    }
    return html;
  }

  function topicChips(ws, cur) {
    const used = usedTopics(ws);
    if (used.length < 2) return '';
    const c = topicCounts(ws);
    return '<div class="chips topics">' + '<button class="chip" data-dtopic="all" aria-pressed="' + (cur === 'all') + '">Все темы</button>' +
      used.map((t) => '<button class="chip" data-dtopic="' + esc(t) + '" aria-pressed="' + (cur === t) + '">' + tdot(t) + esc(t) + '<em>' + c[t] + '</em></button>').join('') + '</div>';
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
        '<dl class="facts"><dt>Тема</dt><dd>' + esc(topicOf(w)) + (w.essay === true && topicOf(w) !== ESSAY ? ' · годится для эссе' : '') + '</dd><dt>Добавлено</dt><dd>' + esc(dateRu(w.added)) + '</dd>' +
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
    const meta = '<div class="icard-meta"><span class="meta-topic">' + tdot(topicOf(w)) + esc(topicOf(w)) + (isNew ? '<span class="tag new">новое</span>' : '') + '</span>' + leitner(w) + '</div>';
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
    const rated = words().filter((w) => inTopic(w, studyTopic())).map((w) => { const p = prog(w.id); return { w, k: (p ? p.lvl : 0) + Math.random() * 2.5 }; });
    rated.sort((a, b) => a.k - b.k);
    return shuffle(rated.slice(0, n).map((r) => r.w));
  }
  function startQuiz(mode) {
    const pool = weakFirst(10);
    if (!pool.length) return;
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
  // ---------- автоперевод и примеры (нужен интернет) ----------
  // Перевод: Wiktionary (переводы по значениям), если нет — машинный перевод MyMemory.
  // Примеры: Tatoeba — реальные предложения с русским переводом.
  const lookupCache = new Map();
  const POS_RU = { Noun: 'сущ.', Verb: 'гл.', Adjective: 'прил.', Adverb: 'нареч.', Phrase: 'выраж.', Idiom: 'идиома', Preposition: 'предл.', Conjunction: 'союз', 'Prepositional phrase': 'выраж.', Interjection: 'межд.', Pronoun: 'мест.' };
  const cleanRu = (t) => String(t).replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1').normalize('NFD').replace(/[̀́]/g, '').normalize('NFC').replace(/\s+/g, ' ').trim();
  function parseTrans(en) {
    const out = [];
    let gloss = null;
    for (const line of en.split('\n')) {
      const top = line.match(/^\{\{trans-top(?:-also)?\|(.*)\}\}\s*$/);
      if (top) { gloss = top[1].split('|').filter((x) => !/^id=/.test(x)).pop() || ''; continue; }
      if (/^\{\{trans-bottom/.test(line)) { gloss = null; continue; }
      if (gloss !== null && /^\*\s*Russian\s*:/.test(line)) {
        const terms = [];
        for (const m of line.matchAll(/\{\{tt?\+?\|ru\|([^|}]+)/g)) { const t = cleanRu(m[1]); if (t && !terms.includes(t)) terms.push(t); }
        if (terms.length) out.push({ gloss, ru: terms });
      }
    }
    return out;
  }
  async function wikiLookup(term, signal, depth) {
    const url = 'https://en.wiktionary.org/w/api.php?action=parse&page=' + encodeURIComponent(term) + '&prop=wikitext&format=json&formatversion=2&redirects=1&origin=*';
    const d = await fetch(url, { signal }).then((r) => r.json());
    if (!d || d.error || !d.parse) return null;
    const t = d.parse.wikitext || '';
    const i = t.search(/(^|\n)==\s*English\s*==/);
    if (i < 0) return null;
    const rest = t.slice(i + 1);
    const j = rest.slice(12).search(/\n==[^=]/);
    const en = j < 0 ? rest : rest.slice(0, j + 12);
    let senses = parseTrans(en);
    if (depth === 0 && /\{\{(see translation subpage|trans-see)/i.test(en)) {
      const sub = await wikiLookup(term + '/translations', signal, 1).catch(() => null);
      if (sub && sub.senses.length) senses = sub.senses.concat(senses);
    }
    const ipa = (en.match(/\{\{IPA\|en\|(\/[^/|}]+\/)/) || [])[1] || '';
    const posH = (en.match(/\n===+\s*(Noun|Verb|Adjective|Adverb|Phrase|Idiom|Preposition|Conjunction|Prepositional phrase|Interjection|Pronoun)\s*===+/) || [])[1];
    let pos = posH ? POS_RU[posH] : '';
    if (pos === 'гл.' && /\s/.test(term)) pos = 'фраз. гл.';
    if (!senses.length && depth === 0) {
      const lemma = (en.match(/\{\{(?:infl of|inflection of|[a-z -]+ of)\|en\|([^|}]+)/) || en.match(/\{\{en-[a-z -]+ of\|([^|}]+)/) || [])[1];
      if (lemma && lemma.toLowerCase() !== term.toLowerCase()) {
        const L = await wikiLookup(lemma, signal, 1).catch(() => null);
        if (L) return Object.assign(L, { lemma });
      }
    }
    const labels = [];
    for (const m of en.matchAll(/\{\{(?:lb|lbl|label|C|topics|top|cln)\|en\|([^}]+)\}\}/g)) m[1].split('|').forEach((x) => { if (!/=/.test(x)) labels.push(x.trim()); });
    for (const m of en.matchAll(/\[\[Category:en:([^\]|]+)/g)) labels.push(m[1]);
    return { senses, ipa, pos, labels };
  }
  const TOPIC_HINTS = [
    [/econom|financ|business|commerce|trade|marketing|accounting|banking|money|shopping|retail|currenc/i, 'Экономика, деньги и покупки'],
    [/comput|internet|software|\bmedia\b|television|journalism|technolog|telecom|video|photograph|electronic|online/i, 'Технологии и медиа'],
    [/employment|labou?r|occupation|management|workplace|\bjobs?\b|career/i, 'Работа и карьера'],
    [/education|school|science|mathemat|physics|chemistry|statistic|academ|linguistic|grammar|universit/i, 'Учёба и наука'],
    [/\blaw\b|legal|politic|government|military|sociolog|religio|crime|justice/i, 'Общество, политика и право'],
    [/emotion|psycholog|personality|character|feeling|mood/i, 'Чувства и характер'],
    [/medic|health|disease|anatomy|\bsports?\b|fitness|patholog|pharmac|physiolog/i, 'Здоровье и спорт'],
    [/ecolog|environment|biolog|botany|zoology|nature|weather|climat|geolog|animal|plant/i, 'Природа и экология'],
    [/food|cooking|culinary|beverage|drink|restaurant|cuisine|baking/i, 'Еда и рестораны'],
    [/music|\bfilm|cinema|literature|\barts?\b|theat|poetry|painting/i, 'Культура: кино, книги, искусство'],
    [/travel|touris|transport|\bcity\b|urban|housing|architecture|building/i, 'Город, дом и путешествия'],
    [/relationship|family|kinship|friend|marriage|dating/i, 'Люди и отношения'],
  ];
  function hintTopic(labels) {
    for (const l of labels || []) for (const [re, t] of TOPIC_HINTS) if (re.test(l)) return t;
    return '';
  }
  async function mmLookup(term, signal) {
    const d = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(term) + '&langpair=en|ru', { signal }).then((r) => r.json());
    const c = [];
    const add = (x) => {
      x = String(x || '').trim().replace(/[.!]+$/, '');
      if (!x || /[a-z]/i.test(x) || x.length > 40) return;
      x = x.charAt(0).toLowerCase() + x.slice(1);
      if (!c.includes(x)) c.push(x);
    };
    (d.matches || []).filter((m) => m['created-by'] === 'MT!').forEach((m) => add(m.translation));
    add(d.responseData && d.responseData.translatedText);
    (d.matches || []).forEach((m) => add(m.translation));
    return c.slice(0, 4);
  }
  function formsRe(base) {
    const b = base.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (/\s/.test(base)) return new RegExp(b.replace(/\\? /g, '\\w*\\s+'), 'i');
    const stem = b.length > 3 ? b.replace(/(e|y)$/, '') : b;
    return new RegExp('\\b(' + b + '|' + stem + ")\\w*", 'i');
  }
  async function exampleLookup(term, signal) {
    const base = term.replace(/^to /i, '');
    const q = /\s/.test(base) ? '"' + base + '"' : base;
    const d = await fetch('https://api.tatoeba.org/unstable/sentences?lang=eng&q=' + encodeURIComponent(q) + '&trans:lang=rus&sort=relevance&limit=30', { signal }).then((r) => r.json());
    const list = (d.data || []).map((x) => {
      const tr = [].concat(x.translations || []).flat().find((y) => y && y.lang === 'rus');
      return { en: x.text, ru: tr ? tr.text : '' };
    }).filter((x) => x.ru && x.en.length <= 110);
    const re = formsRe(base);
    const exact = list.filter((x) => re.test(x.en));
    const pool = (exact.length ? exact : list).sort((a, b) => Math.abs(a.en.length - 55) - Math.abs(b.en.length - 55));
    return pool.slice(0, 3);
  }
  async function lookupWord(word, signal) {
    const term = word.trim().replace(/\s+/g, ' ');
    const key = term.toLowerCase();
    if (lookupCache.has(key)) return lookupCache.get(key);
    const page = /[A-Z]{2,}/.test(term) ? term : key;
    const res = { tr: [], options: [], ipa: '', pos: '', lemma: '', source: '', examples: [], topic: '' };
    const [wiki, exs] = await Promise.all([
      wikiLookup(page.replace(/^to /, ''), signal, 0).catch((e) => { if (e && e.name === 'AbortError') throw e; return null; }),
      exampleLookup(term, signal).catch((e) => { if (e && e.name === 'AbortError') throw e; return []; }),
    ]);
    res.examples = exs || [];
    if (wiki) {
      res.ipa = wiki.ipa || ''; res.pos = wiki.pos || ''; res.lemma = wiki.lemma || ''; res.topic = hintTopic(wiki.labels);
      const all = [];
      wiki.senses.slice(0, 8).forEach((s) => s.ru.forEach((r) => { if (!all.includes(r)) all.push(r); }));
      const pick = [];
      wiki.senses.slice(0, 4).forEach((s, i) => s.ru.slice(0, i === 0 ? 2 : 1).forEach((r) => { if (!pick.includes(r) && pick.length < 3 && (pick.join(', ') + r).length <= 48) pick.push(r); }));
      if (pick.length) { res.tr = pick; res.options = all.slice(0, 8); res.source = 'Wiktionary'; }
    }
    if (!res.tr.length) {
      const mm = await mmLookup(term, signal).catch((e) => { if (e && e.name === 'AbortError') throw e; return []; });
      if (mm.length) { res.tr = mm.slice(0, 2); res.options = mm; res.source = 'машинный перевод'; }
    }
    if (res.tr.length || res.examples.length) lookupCache.set(key, res);
    return res;
  }

  let lookupTimer = null, lookupCtl = null;
  const addUI = { autoTr: '', res: null, pickedEx: null, topicTouched: false };
  function scheduleLookup(immediate) {
    clearTimeout(lookupTimer);
    const run = () => runLookup();
    if (immediate) run(); else lookupTimer = setTimeout(run, 650);
  }
  async function runLookup() {
    const wi = $('#add-word'); if (!wi) return;
    const word = wi.value.trim();
    const box = $('#add-sugg'), exBox = $('#add-exs');
    if (lookupCtl) lookupCtl.abort();
    addUI.res = null;
    if (word.length < 2 || !/[a-z]/i.test(word)) { box.innerHTML = ''; exBox.innerHTML = ''; return; }
    if (navigator.onLine === false) {
      box.innerHTML = '<p class="sugg-status">Без интернета перевод не подобрать. Сохрани так — переведу сам, когда появится сеть.</p>';
      exBox.innerHTML = '';
      return;
    }
    const ctl = lookupCtl = new AbortController();
    box.innerHTML = '<p class="sugg-status">Подбираю перевод…</p>';
    try {
      const res = await lookupWord(word, ctl.signal);
      if (ctl.signal.aborted || !$('#add-word') || $('#add-word').value.trim() !== word) return;
      addUI.res = res;
      const ti = $('#add-tr');
      if (res.tr.length && (!ti.value.trim() || ti.value === addUI.autoTr)) { ti.value = res.tr.join(', '); addUI.autoTr = ti.value; }
      const ts = $('#add-topic');
      if (res.topic && ts && !addUI.topicTouched && [...ts.options].some((o) => o.value === res.topic)) { ts.value = res.topic; }
      renderSugg();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      box.innerHTML = '<p class="sugg-status">Не получилось подобрать перевод. Впиши сам или оставь пустым.</p>';
    }
  }
  function renderSugg() {
    const res = addUI.res; const box = $('#add-sugg'), exBox = $('#add-exs');
    if (!res || !box) return;
    const ti = $('#add-tr');
    const cur = ti.value.split(',').map((x) => x.trim()).filter(Boolean);
    let h = '';
    if (res.options.length) {
      h += '<div class="chips wrap">' + res.options.map((o) => '<button type="button" class="chip" data-trchip="' + esc(o) + '" aria-pressed="' + cur.includes(o) + '">' + esc(o) + '</button>').join('') + '</div>' +
        '<p class="sugg-status">' + (res.source === 'Wiktionary' ? 'Варианты из Wiktionary — нажми, чтобы добавить или убрать' : 'Машинный перевод — проверь его') + '</p>';
    } else {
      h += '<p class="sugg-status">Перевод не нашёл — впиши сам или оставь пустым, переведёт Claude.</p>';
    }
    if (res.lemma && norm(res.lemma) !== norm($('#add-word').value)) h += '<button type="button" class="btn ghost" data-lemma="' + esc(res.lemma) + '" style="padding-left:0">Записать в словарной форме: ' + esc(res.lemma) + '</button>';
    box.innerHTML = h;
    exBox.innerHTML = res.examples.length
      ? '<div class="ex-sugg"><span class="sugg-status">Примеры — нажми, чтобы выбрать</span>' + res.examples.map((x, i) =>
        '<button type="button" class="ex-opt" data-expick="' + i + '" aria-pressed="' + (addUI.pickedEx && addUI.pickedEx.en === x.en && $('#add-ex').value === x.en) + '"><span class="ex">' + fmtEx(x.en, res.lemma || $('#add-word').value) + '</span><span class="ex-ru">' + esc(x.ru) + '</span></button>').join('') + '</div>'
      : '';
  }
  function toggleTrChip(o) {
    const ti = $('#add-tr');
    let cur = ti.value.split(',').map((x) => x.trim()).filter(Boolean);
    cur = cur.includes(o) ? cur.filter((x) => x !== o) : cur.concat(o);
    ti.value = cur.join(', ');
    addUI.autoTr = ti.value;
    renderSugg();
  }
  function pickExample(i) {
    const x = addUI.res && addUI.res.examples[i]; if (!x) return;
    const ei = $('#add-ex');
    if (addUI.pickedEx && addUI.pickedEx.en === x.en && ei.value === x.en) { ei.value = ''; addUI.pickedEx = null; }
    else { ei.value = x.en; addUI.pickedEx = x; }
    renderSugg();
  }

  // Слова, добавленные без интернета, переводим, когда сеть появилась.
  let autoFilling = false;
  async function autoFillPending() {
    if (autoFilling || navigator.onLine === false) return;
    const list = pendingLocal();
    if (!list.length) return;
    autoFilling = true;
    let n = 0;
    for (const l of list) {
      try {
        const res = await lookupWord(l.word);
        const cur = state.local.find((x) => x.id === l.id);
        if (!cur || cur.tr || !res.tr.length) continue;
        cur.tr = res.tr.join(', '); cur.auto = true;
        if (res.ipa && !cur.ipa) cur.ipa = res.ipa;
        if (res.pos && !cur.pos) cur.pos = res.pos;
        if (!cur.ex && res.examples[0]) { cur.ex = res.examples[0].en; cur.exRu = res.examples[0].ru; cur.exAuto = true; }
        n++;
      } catch (e) { /* попробуем в следующий раз */ }
    }
    autoFilling = false;
    if (n) { saveLocal(); toast('Перевёл ' + n + ' ' + plural(n, ['слово', 'слова', 'слов']) + ', добавленных без интернета'); if (!session && !quiz && !state.addOpen) render(); }
  }

  function addTopicSelect() {
    const list = allTopics();
    const last = state.settings.lastTopic && list.includes(state.settings.lastTopic) ? state.settings.lastTopic : MISC;
    return '<select class="select field sm" id="add-topic">' + list.map((t) => '<option value="' + esc(t) + '"' + (t === last ? ' selected' : '') + '>' + esc(t) + '</option>').join('') +
      '<option value="__new">+ Новая тема…</option></select>';
  }
  function chosenTopic() {
    const ts = $('#add-topic'); if (!ts) return MISC;
    if (ts.value === '__new') { const v = ($('#add-topic-new').value || '').trim().replace(/\s+/g, ' '); return v || MISC; }
    return ts.value || MISC;
  }
  function openAdd() {
    state.addOpen = true;
    addUI.autoTr = ''; addUI.res = null; addUI.pickedEx = null; addUI.topicTouched = false;
    openOverlay();
    $('#overlay').innerHTML = '<div class="sheet"><div class="sheet-top"><button class="icon-btn" data-act="close" aria-label="Закрыть">' + ICON.close + '</button><h2 style="flex:1">Новое слово</h2></div><div id="add-dup"></div>' +
      '<form id="add-form" class="panel" autocomplete="off">' +
      '<div class="setting"><label for="add-word">Слово или выражение</label><input class="field" id="add-word" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next" placeholder="например, ubiquitous"></div>' +
      '<div class="setting"><label for="add-tr">Перевод</label><input class="field sm" id="add-tr" enterkeyhint="next" placeholder="подставится сам, можно поправить"><div id="add-sugg"></div></div>' +
      '<div class="setting"><label for="add-ex">Пример</label><textarea class="field sm" id="add-ex" rows="3" placeholder="предложение, где встретил, или выбери пример ниже"></textarea><div id="add-exs"></div></div>' +
      '<div class="setting"><label for="add-topic">Тема</label>' + addTopicSelect() +
      '<input class="field sm" id="add-topic-new" placeholder="Название новой темы" hidden>' +
      '<p class="sugg-status">Подбирается сама по слову, можно сменить.</p></div>' +
      '<button class="btn primary block" type="submit">Сохранить</button>' +
      '<p class="small muted" style="margin:0">С переводом слово сразу попадёт в повторение. Чтобы оно попало в Word-файл, отправь его Claude из «Словаря».</p>' +
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
    const res = addUI.res;
    if (res && $('#add-word').value.trim() === word) {
      if (res.ipa) entry.ipa = res.ipa;
      if (res.pos) entry.pos = res.pos;
      if (tr && tr === addUI.autoTr) entry.auto = true;
    }
    if (ex && addUI.pickedEx && addUI.pickedEx.en === ex) { entry.exRu = addUI.pickedEx.ru; entry.exAuto = true; }
    entry.topic = chosenTopic();
    if ($('#add-topic').value === '__new' && !$('#add-topic-new').value.trim()) { $('#add-topic-new').focus(); toast('Впиши название новой темы'); return; }
    state.settings.lastTopic = entry.topic; saveSettings();
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
    addUI.autoTr = ''; addUI.res = null; addUI.pickedEx = null; addUI.topicTouched = false;
    const ts = $('#add-topic');
    if (ts) { const t = state.settings.lastTopic; if (![...ts.options].some((o) => o.value === t)) { const o = document.createElement('option'); o.value = t; o.textContent = t; ts.insertBefore(o, ts.lastElementChild); } ts.value = t; }
    const tn = $('#add-topic-new'); if (tn) { tn.value = ''; tn.hidden = true; }
    if (lookupCtl) lookupCtl.abort();
    const sb = $('#add-sugg'); if (sb) sb.innerHTML = '';
    const eb = $('#add-exs'); if (eb) eb.innerHTML = '';
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
      if (l.topic) extra.push('тема: ' + l.topic);
      if (l.auto) extra.push('перевод подобран автоматически');
      if (l.ex) extra.push((l.exAuto ? 'пример: «' : 'встретил: «') + l.ex + '»');
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
    const q = buildQueue('all');
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
    const el = e.target.closest('[data-speak],[data-tab],[data-tab-go],[data-act],[data-grade],[data-choice],[data-filter],[data-open],[data-reset],[data-reset-ask],[data-reset-cancel],[data-set],[data-del],[data-del-ask],[data-del-cancel],[data-trchip],[data-expick],[data-lemma],[data-dtopic]');
    if (!el) return;
    if (el.dataset.dtopic) { state.dict.topic = el.dataset.dtopic; state.dict.open = null; return render(); }
    if (el.dataset.trchip !== undefined) return toggleTrChip(el.dataset.trchip);
    if (el.dataset.expick !== undefined) return pickExample(Number(el.dataset.expick));
    if (el.dataset.lemma) { const wi = $('#add-word'); wi.value = el.dataset.lemma; return scheduleLookup(true); }
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
  document.addEventListener('change', (e) => {
    const id = e.target.id;
    if (id === 'study-topic' || id === 'quiz-topic') { state.settings.topic = e.target.value; saveSettings(); return render(); }
    if (id === 'add-topic') {
      addUI.topicTouched = true;
      const tn = $('#add-topic-new');
      if (tn) { tn.hidden = e.target.value !== '__new'; if (!tn.hidden) tn.focus(); }
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'add-word') { if (state.dup) { state.dup = null; $('#add-dup').innerHTML = ''; } return scheduleLookup(false); }
    if (e.target.id === 'add-tr' || e.target.id === 'add-ex') return renderSugg();
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
        e.preventDefault(); if (e.target.id === 'add-word') scheduleLookup(true);
        const next = e.target.id === 'add-word' ? '#add-tr' : '#add-ex'; const n = $(next); if (n) n.focus();
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
