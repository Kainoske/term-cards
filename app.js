'use strict';

// ---------- 保存（IndexedDB） ----------
const DB_NAME = 'term-cards';
const STORE = 'terms';
let db;
let terms = [];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('field', 'field');
      s.createIndex('date', 'date');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
}
const dbAll = () => idb('readonly', s => s.getAll());
const dbPut = o => idb('readwrite', s => s.put(o));
const dbPutMany = list => idb('readwrite', s => list.forEach(o => s.put(o)));
const dbDel = id => idb('readwrite', s => s.delete(id));
const dbClear = () => idb('readwrite', s => s.clear());

// ---------- ユーティリティ ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const norm = s => String(s || '').trim().toLowerCase().normalize('NFKC');
const collator = new Intl.Collator('ja');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

// 復習間隔（ライトナー方式）: レベル0〜6 → 次回までの日数
const INTERVALS = [0, 1, 2, 4, 7, 15, 30];
const MAX_LV = INTERVALS.length - 1;
const LV_LABEL = lv => (lv >= MAX_LV ? '習得' : `Lv${lv}`);

function newTerm(f) {
  const now = new Date().toISOString();
  return {
    id: uid(), term: f.term.trim(), reading: (f.reading || '').trim(), definition: f.definition.trim(),
    field: (f.field || '未分類').trim(), date: f.date || today(), note: (f.note || '').trim(),
    level: 0, due: today(), correct: 0, wrong: 0, lastReviewed: null, createdAt: now, updatedAt: now,
  };
}

function fieldsWithCount() {
  const m = new Map();
  terms.forEach(t => m.set(t.field, (m.get(t.field) || 0) + 1));
  return [...m].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
}
function datesWithCount() {
  const m = new Map();
  terms.forEach(t => m.set(t.date, (m.get(t.date) || 0) + 1));
  return [...m].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

// ---------- タブ ----------
function show(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'dict') renderDict();
  if (view === 'study' && !$('#studySetup').hidden) renderStudySetup();
  if (view === 'data') renderData();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));

// ---------- 登録 ----------
const form = $('#termForm');
function resetForm(keepContext = true) {
  const field = $('#f-field').value, date = $('#f-date').value;
  form.reset();
  $('#f-id').value = '';
  $('#f-field').value = keepContext ? field : (localStorageGet('lastField') || '');
  $('#f-date').value = keepContext && date ? date : today();
  $('#saveBtn').textContent = '登録してカード化';
  $('#cancelEdit').hidden = true;
  $('#dupWarn').hidden = true;
}
function localStorageGet(k) { try { return localStorage.getItem('tc:' + k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem('tc:' + k, v); } catch { /* 無視 */ } }

function renderFieldInputs() {
  const fs = fieldsWithCount();
  $('#fieldList').innerHTML = fs.map(([f]) => `<option value="${esc(f)}">`).join('');
  const cur = $('#f-field').value;
  $('#fieldChips').innerHTML = fs.slice(0, 12)
    .map(([f]) => `<button type="button" class="chip${f === cur ? ' on' : ''}" data-f="${esc(f)}">${esc(f)}</button>`).join('');
}
$('#fieldChips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  $('#f-field').value = b.dataset.f; renderFieldInputs();
});
$('#f-field').addEventListener('input', renderFieldInputs);

$('#f-term').addEventListener('input', () => {
  const v = norm($('#f-term').value), id = $('#f-id').value;
  const hit = v && terms.find(t => t.id !== id && norm(t.term) === v);
  const w = $('#dupWarn');
  if (hit) {
    w.innerHTML = `「${esc(hit.term)}」は登録済みです（${esc(hit.field)}・${esc(hit.date)}）。<button type="button" class="link" data-edit="${hit.id}">登録済みを編集</button>`;
    w.hidden = false;
  } else w.hidden = true;
});
$('#dupWarn').addEventListener('click', e => { const id = e.target.dataset.edit; if (id) startEdit(id); });

form.addEventListener('submit', async e => {
  e.preventDefault();
  const f = {
    term: $('#f-term').value, reading: $('#f-reading').value, definition: $('#f-def').value,
    field: $('#f-field').value, date: $('#f-date').value, note: $('#f-note').value,
  };
  if (!f.term.trim() || !f.definition.trim() || !f.field.trim()) return;
  const id = $('#f-id').value;
  let rec;
  if (id) {
    rec = terms.find(t => t.id === id);
    Object.assign(rec, {
      term: f.term.trim(), reading: f.reading.trim(), definition: f.definition.trim(),
      field: f.field.trim(), date: f.date || rec.date, note: f.note.trim(), updatedAt: new Date().toISOString(),
    });
  } else {
    rec = newTerm(f);
    terms.push(rec);
  }
  await dbPut(rec);
  localStorageSet('lastField', rec.field);
  toast(id ? '更新しました' : `「${rec.term}」をカード化しました`);
  resetForm(true);
  refreshAll();
  $('#f-term').focus();
});
form.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
$('#cancelEdit').addEventListener('click', () => resetForm(false));

function startEdit(id) {
  const t = terms.find(x => x.id === id); if (!t) return;
  show('add');
  $('#f-id').value = t.id; $('#f-term').value = t.term; $('#f-reading').value = t.reading;
  $('#f-def').value = t.definition; $('#f-field').value = t.field; $('#f-date').value = t.date; $('#f-note').value = t.note;
  $('#saveBtn').textContent = '更新する'; $('#cancelEdit').hidden = false; $('#dupWarn').hidden = true;
  renderFieldInputs();
  $('#f-term').focus();
}

async function removeTerm(id) {
  const t = terms.find(x => x.id === id); if (!t) return;
  if (!confirm(`「${t.term}」を削除しますか？`)) return;
  await dbDel(id);
  terms = terms.filter(x => x.id !== id);
  toast('削除しました');
  refreshAll();
}

function itemHTML(t, open = false) {
  return `<li class="item"><details${open ? ' open' : ''}><summary>
    <span class="t">${esc(t.term)}</span>${t.reading ? `<span class="r">${esc(t.reading)}</span>` : ''}
    <div class="labels"><span class="lab">${esc(t.field)}</span><span class="lab date">${esc(t.date)}</span><span class="lab lv">${LV_LABEL(t.level)}</span></div>
  </summary>
  <div class="d">${esc(t.definition)}</div>
  ${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}
  <div class="acts"><button data-act="edit" data-id="${t.id}">編集</button><button data-act="del" data-id="${t.id}">削除</button></div>
  </details></li>`;
}
function onListClick(e) {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  if (b.dataset.act === 'edit') startEdit(b.dataset.id);
  if (b.dataset.act === 'del') removeTerm(b.dataset.id);
}

function renderRecent() {
  const list = [...terms].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 5);
  $('#recent').innerHTML = list.length
    ? `<h2>最近の登録</h2><ul class="list">${list.map(t => itemHTML(t)).join('')}</ul>`
    : '<p class="muted">まだ用語がありません。上のフォームから最初の用語を登録しましょう。</p>';
}
$('#recent').addEventListener('click', onListClick);

// ---------- 辞書 ----------
function fillSelect(sel, items, allLabel) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + items.map(([v, n]) => `<option value="${esc(v)}">${esc(v)}（${n}）</option>`).join('');
  if (items.some(([v]) => v === cur)) sel.value = cur;
}
function renderDict() {
  fillSelect($('#dictField'), fieldsWithCount(), 'すべての分野');
  fillSelect($('#dictDate'), datesWithCount(), 'すべての日付');
  const q = norm($('#q').value), f = $('#dictField').value, d = $('#dictDate').value, sort = $('#dictSort').value;
  let list = terms.filter(t =>
    (!f || t.field === f) && (!d || t.date === d) &&
    (!q || [t.term, t.reading, t.definition, t.note].some(x => norm(x).includes(q))));
  const cmp = {
    new: (a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : (a.date < b.date ? 1 : -1)),
    old: (a, b) => (a.date === b.date ? (a.createdAt > b.createdAt ? 1 : -1) : (a.date > b.date ? 1 : -1)),
    abc: (a, b) => collator.compare(a.reading || a.term, b.reading || b.term),
    weak: (a, b) => a.level - b.level || (b.wrong - b.correct) - (a.wrong - a.correct),
  }[sort];
  list.sort(cmp);
  $('#dictCount').textContent = `${list.length} 件 / 全 ${terms.length} 件`;
  $('#dictList').innerHTML = list.map(t => itemHTML(t, !!q)).join('') || '<p class="muted">該当する用語がありません。</p>';
}
['#q', '#dictField', '#dictDate', '#dictSort'].forEach(s => $(s).addEventListener('input', renderDict));
$('#dictList').addEventListener('click', onListClick);

// ---------- 暗記 ----------
const selFields = new Set(JSON.parse(localStorageGet('studyFields') || 'null') || []);
let fieldsInitialized = selFields.size > 0;

function renderStudySetup() {
  const fs = fieldsWithCount();
  if (!fieldsInitialized && fs.length) { fs.forEach(([f]) => selFields.add(f)); fieldsInitialized = true; }
  $('#studyFields').innerHTML = fs.map(([f, n]) =>
    `<button type="button" class="chip${selFields.has(f) ? ' on' : ''}" data-f="${esc(f)}">${esc(f)}<span class="n">${n}</span></button>`).join('')
    || '<span class="muted">用語を登録すると分野が表示されます</span>';
  const from = $('#dFrom').value, to = $('#dTo').value;
  $('#studyDates').innerHTML = datesWithCount().slice(0, 30).map(([d, n]) =>
    `<button type="button" class="chip${from === d && to === d ? ' on' : ''}" data-d="${d}">${d.slice(5).replace('-', '/')}<span class="n">${n}</span></button>`).join('');
  updateStartBtn();
}
function studyFilter() {
  const from = $('#dFrom').value, to = $('#dTo').value;
  const mode = document.querySelector('input[name=mode]:checked').value;
  const t0 = today();
  return terms.filter(t =>
    selFields.has(t.field) && (!from || t.date >= from) && (!to || t.date <= to) &&
    (mode === 'all' || (mode === 'due' && t.due <= t0) || (mode === 'weak' && t.level <= 1 && (t.wrong > 0 || t.lastReviewed))));
}
function updateStartBtn() {
  const n = studyFilter().length;
  $('#startBtn').textContent = n ? `${n} 枚で開始` : '該当するカードがありません';
  $('#startBtn').disabled = !n;
}
$('#studyFields').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  selFields.has(b.dataset.f) ? selFields.delete(b.dataset.f) : selFields.add(b.dataset.f);
  localStorageSet('studyFields', JSON.stringify([...selFields]));
  renderStudySetup();
});
$('#fieldAll').addEventListener('click', () => { fieldsWithCount().forEach(([f]) => selFields.add(f)); localStorageSet('studyFields', JSON.stringify([...selFields])); renderStudySetup(); });
$('#fieldNone').addEventListener('click', () => { selFields.clear(); localStorageSet('studyFields', '[]'); renderStudySetup(); });
$('#studyDates').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  const on = b.classList.contains('on');
  $('#dFrom').value = on ? '' : b.dataset.d; $('#dTo').value = on ? '' : b.dataset.d;
  renderStudySetup();
});
$('#dClear').addEventListener('click', () => { $('#dFrom').value = ''; $('#dTo').value = ''; renderStudySetup(); });
['#dFrom', '#dTo'].forEach(s => $(s).addEventListener('change', renderStudySetup));
document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', updateStartBtn));

let session = null;
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startSession(cards) {
  session = {
    queue: shuffle(cards.map(c => c.id)), total: cards.length, done: 0,
    dir: document.querySelector('input[name=dir]:checked').value,
    results: { again: 0, hard: 0, good: 0 }, missed: new Set(), requeued: new Set(),
  };
  $('#studySetup').hidden = true; $('#studyDone').hidden = true; $('#studyRun').hidden = false;
  nextCard();
}
$('#startBtn').addEventListener('click', () => startSession(studyFilter()));

function nextCard() {
  if (!session.queue.length) return finishSession();
  const t = terms.find(x => x.id === session.queue[0]);
  if (!t) { session.queue.shift(); return nextCard(); }
  const card = $('#card');
  card.classList.remove('flipped');
  $('#rateBtns').classList.remove('show');
  const meta = `<span class="lab">${esc(t.field)}</span><span class="lab date">${esc(t.date)}</span>`;
  $('#cMetaF').innerHTML = meta; $('#cMetaB').innerHTML = meta;
  const termHTML = `${esc(t.term)}${t.reading ? `<span class="sub">${esc(t.reading)}</span>` : ''}`;
  // 裏返しのアニメーション中に答えが見えないよう、少し遅らせて差し替える
  const set = () => {
    $('#cFront').innerHTML = session.dir === 'term' ? termHTML : esc(t.definition);
    $('#cBack').innerHTML = session.dir === 'term' ? esc(t.definition) : termHTML;
    $('#cNote').textContent = t.note || '';
  };
  card.dataset.wasFlipped === '1' ? setTimeout(set, 180) : set();
  card.dataset.wasFlipped = '0';
  const pct = Math.round((session.done / session.total) * 100);
  $('#progBar').style.width = pct + '%';
  $('#progText').textContent = `${session.done} / ${session.total}（残り ${session.queue.length}）`;
}
function flip() {
  const card = $('#card');
  card.classList.toggle('flipped');
  card.dataset.wasFlipped = '1';
  if (card.classList.contains('flipped')) $('#rateBtns').classList.add('show');
}
$('#card').addEventListener('click', flip);

async function rate(r) {
  if (!session || !$('#rateBtns').classList.contains('show')) return;
  const id = session.queue.shift();
  const t = terms.find(x => x.id === id);
  const first = !session.requeued.has(id);
  if (t && first) {
    // 1回目の回答だけを記録に反映する
    if (r === 'good') { t.level = Math.min(MAX_LV, t.level + 1); t.correct++; }
    if (r === 'hard') { t.level = Math.max(1, t.level === 0 ? 1 : t.level); t.correct++; }
    if (r === 'again') { t.level = 0; t.wrong++; }
    t.due = addDays(today(), INTERVALS[t.level]);
    t.lastReviewed = new Date().toISOString();
    await dbPut(t);
    session.results[r]++;
    session.done++;
  }
  if (r === 'again') {
    session.missed.add(id);
    if (first) { session.requeued.add(id); session.queue.push(id); } // セッション内でもう一度出す
  }
  nextCard();
}
$('#rateBtns').addEventListener('click', e => { const b = e.target.closest('button'); if (b) rate(b.dataset.r); });

function finishSession() {
  $('#studyRun').hidden = true; $('#studyDone').hidden = false;
  const r = session.results;
  $('#doneText').innerHTML = `${session.total} 枚を学習しました。<br>覚えた ${r.good} ・ あいまい ${r.hard} ・ まだ ${r.again}`;
  $('#retryWeak').hidden = session.missed.size === 0;
  refreshAll();
}
$('#retryWeak').addEventListener('click', () => {
  const ids = session.missed;
  startSession(terms.filter(t => ids.has(t.id)));
});
$('#backSetup').addEventListener('click', backToSetup);
$('#quitBtn').addEventListener('click', () => (session && session.done ? finishSession() : backToSetup()));
function backToSetup() {
  session = null;
  $('#studyRun').hidden = true; $('#studyDone').hidden = true; $('#studySetup').hidden = false;
  renderStudySetup();
}

document.addEventListener('keydown', e => {
  if (!session || $('#studyRun').hidden || !$('#view-study').classList.contains('active')) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
  if (e.key === '1') rate('again');
  if (e.key === '2') rate('hard');
  if (e.key === '3') rate('good');
});

// ---------- データ ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#exportJson').addEventListener('click', () => {
  download(`term-cards-${today()}.json`, JSON.stringify({ app: 'term-cards', version: 1, exportedAt: new Date().toISOString(), terms }, null, 2), 'application/json');
});
$('#exportCsv').addEventListener('click', () => {
  const cols = ['term', 'reading', 'definition', 'field', 'date', 'note', 'level', 'correct', 'wrong'];
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + [cols.join(','), ...terms.map(t => cols.map(c => cell(t[c])).join(','))].join('\r\n');
  download(`term-cards-${today()}.csv`, csv, 'text/csv');
});
$('#importJson').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.terms;
    if (!Array.isArray(list)) throw new Error('形式が違います');
    const byId = new Map(terms.map(t => [t.id, t]));
    const incoming = list.filter(x => x && x.term && x.definition).map(x => {
      const base = newTerm(x);
      const rec = { ...base, ...x, id: x.id || base.id };
      const cur = byId.get(rec.id);
      return cur && cur.updatedAt > rec.updatedAt ? cur : rec; // 新しい方を残す
    });
    await dbPutMany(incoming);
    terms = await dbAll();
    toast(`${incoming.length} 件を読み込みました`);
    refreshAll();
  } catch (err) {
    alert('読み込めませんでした: ' + err.message);
  }
  e.target.value = '';
});
$('#bulkBtn').addEventListener('click', async () => {
  const lines = $('#bulk').value.split(/\r?\n/).filter(l => l.trim());
  const existing = new Set(terms.map(t => norm(t.term)));
  const added = [], skipped = [];
  lines.forEach(l => {
    const [term, definition, field, date, reading, note] = l.split('\t').map(s => (s || '').trim());
    if (!term || !definition) { skipped.push(l); return; }
    if (existing.has(norm(term))) { skipped.push(term); return; }
    existing.add(norm(term));
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(date)
      ? date.split('/').map((x, i) => (i ? pad(x) : x)).join('-') : today();
    added.push(newTerm({ term, definition, field: field || '未分類', date: d, reading, note }));
  });
  if (added.length) { await dbPutMany(added); terms.push(...added); }
  $('#bulk').value = '';
  toast(`${added.length} 件登録${skipped.length ? `・${skipped.length} 件スキップ（重複/不足）` : ''}`);
  refreshAll();
});
$('#wipe').addEventListener('click', async () => {
  if (!terms.length) return;
  if (!confirm(`全 ${terms.length} 件を削除します。元に戻せません。先にJSONで書き出しましたか？`)) return;
  if (prompt('確認のため「削除」と入力してください') !== '削除') return;
  await dbClear(); terms = []; toast('全データを削除しました'); refreshAll();
});

async function renderData() {
  const t0 = today();
  const due = terms.filter(t => t.due <= t0).length;
  const mastered = terms.filter(t => t.level >= MAX_LV).length;
  $('#stats').textContent = `用語 ${terms.length} 件 ・ 分野 ${fieldsWithCount().length} ・ 今日の復習 ${due} 件 ・ 習得 ${mastered} 件`;
  let txt = 'このブラウザでは確認できません。';
  if (navigator.storage && navigator.storage.persisted) {
    const p = await navigator.storage.persisted();
    txt = p ? '有効：ブラウザが容量不足になってもデータは自動削除されません。'
      : '未許可：ブラウザの判断で消える可能性があります。アプリとしてインストールすると許可されやすくなります。';
  }
  $('#persistText').textContent = txt;
}

function refreshAll() {
  renderFieldInputs();
  renderRecent();
  if ($('#view-dict').classList.contains('active')) renderDict();
  if ($('#view-study').classList.contains('active') && !$('#studySetup').hidden) renderStudySetup();
  if ($('#view-data').classList.contains('active')) renderData();
  else if (!$('#studySetup').hidden) updateStartBtn();
}

// ---------- オンライン表示・オフライン化 ----------
function updateNet() { $('#netStatus').textContent = navigator.onLine ? '' : 'オフライン'; }
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW登録失敗', err));
}

// ---------- 起動 ----------
(async () => {
  db = await openDB();
  terms = await dbAll();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  $('#f-date').value = today();
  $('#f-field').value = localStorageGet('lastField') || '';
  updateNet();
  refreshAll();
  renderStudySetup();
})();
