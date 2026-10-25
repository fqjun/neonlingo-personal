import { call, speak, esc } from '../common/messaging.js';
import { loadSettings } from '../common/settings.js';

const $ = (id) => document.getElementById(id);
let words = [];
let settings;

async function main() {
  settings = await loadSettings();
  bindList();
  bindReview();
  window.addEventListener('hashchange', route);
  // 其他页面或其他电脑改了生词本时自动刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.vocab_all && currentTab() === 'list') loadList();
  });
  route();
}

const currentTab = () => (location.hash === '#review' ? 'review' : 'list');

function route() {
  const tab = currentTab();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  $('tab-list').hidden = tab !== 'list';
  $('tab-review').hidden = tab !== 'review';
  if (tab === 'list') loadList();
  else startReview();
}

// ---------------- 列表 ----------------

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : '—');

function dueText(e) {
  if (e.status === 'mastered') return '已掌握';
  if (!e.card) return '待复习（新词）';
  const diff = e.card.due - Date.now();
  if (diff <= 0) return '待复习';
  const days = Math.round(diff / 86400000);
  return days >= 1 ? `${days} 天后复习` : '今天稍后复习';
}

async function loadList() {
  words = await call('vocab:list');
  const now = Date.now();
  const due = words.filter((e) => e.status === 'learning' && (!e.card || e.card.due <= now)).length;
  $('dueCount').textContent = due;
  $('summary').innerHTML = `
    <div><b>${words.length}</b><span>总词数</span></div>
    <div><b>${words.filter((e) => e.status === 'learning').length}</b><span>学习中</span></div>
    <div><b>${words.filter((e) => e.status === 'mastered').length}</b><span>已掌握</span></div>
    <div><b>${due}</b><span>待复习</span></div>`;
  renderList();
}

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  const f = $('filter').value;
  const now = Date.now();
  let list = words.filter((e) => {
    if (f === 'learning' && e.status !== 'learning') return false;
    if (f === 'mastered' && e.status !== 'mastered') return false;
    if (f === 'due' && !(e.status === 'learning' && (!e.card || e.card.due <= now))) return false;
    if (!q) return true;
    return [e.word, e.meaning, e.original].some((x) => (x || '').toLowerCase().includes(q));
  });
  const sort = $('sort').value;
  const cmp = {
    recent: (a, b) => b.addedAt - a.addedAt,
    seen: (a, b) => (b.seen || 0) - (a.seen || 0),
    due: (a, b) => (a.card?.due || 0) - (b.card?.due || 0),
    alpha: (a, b) => a.word.localeCompare(b.word),
  }[sort];
  return list.sort(cmp);
}

function renderList() {
  const list = filtered();
  $('empty').hidden = words.length > 0;
  $('list').innerHTML = list
    .map(
      (e) => `
    <div class="item" data-word="${esc(e.word)}">
      <div class="top">
        <span class="w">${esc(e.word)}</span>
        <span class="muted">${esc(e.phonetic)}</span>
        <span><i class="muted">${esc(e.pos)}</i> ${esc(e.meaning)}</span>
        ${e.original ? `<span class="muted small">原文：${esc(e.original)}</span>` : ''}
        <span class="meta">
          ${e.source === 'lookup' ? '<span class="tag looked">查过</span>' : ''}
          <span class="tag ${e.status === 'mastered' ? 'ok' : ''}">${dueText(e)}</span>
          <span class="muted small">见过 ${e.seen || 0} 次 · ${fmtDate(e.addedAt)}</span>
          <button data-act="speak" title="发音">🔊</button>
          <button data-act="${e.status === 'mastered' ? 'learning' : 'mastered'}">${e.status === 'mastered' ? '重新学习' : '标记掌握'}</button>
          <button data-act="remove" class="danger">删除</button>
        </span>
      </div>
      ${(e.examples || [])
        .map(
          (x) =>
            `<div class="ex">${highlight(x.s, e)}${x.url ? ` <a href="${esc(x.url)}" target="_blank" rel="noreferrer">${esc(x.title || '来源')}</a>` : ''}</div>`,
        )
        .join('')}
    </div>`,
    )
    .join('');
}

// 例句里把原文 / 单词标出来
function highlight(s, e) {
  let html = esc(s);
  for (const t of [e.original, e.word]) {
    if (t) html = html.split(esc(t)).join(`<b>${esc(t)}</b>`);
  }
  return html;
}

function bindList() {
  for (const id of ['q', 'filter', 'sort']) $(id).addEventListener('input', renderList);
  $('list').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const word = btn.closest('.item').dataset.word;
    const act = btn.dataset.act;
    if (act === 'speak') return speak(word, settings.speechRate);
    if (act === 'remove' && !confirm(`从生词本删除「${word}」？`)) return;
    await call('vocab:mark', { word, action: act });
    loadList();
  });
  $('exportCsv').addEventListener('click', exportCsv);
}

function exportCsv() {
  const cell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['word', 'phonetic', 'pos', 'meaning', 'original', 'example', 'status', 'seen', 'added']];
  for (const e of filtered()) {
    rows.push([e.word, e.phonetic, e.pos, e.meaning, e.original, e.examples?.[0]?.s || '', e.status, e.seen || 0, fmtDate(e.addedAt)]);
  }
  // 加 BOM，Excel 打开中文不乱码；Anki 导入时选「逗号分隔」并勾选「第一行是字段名」
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `neonlingo-vocab-${new Date().toLocaleDateString('sv')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- 复习（FSRS） ----------------

let queue = [];
let current = null;
let revealed = false;
let doneCount = 0;

async function startReview() {
  queue = await call('vocab:due');
  $('dueCount').textContent = queue.length;
  doneCount = 0;
  next();
}

function next() {
  current = queue.shift() || null;
  revealed = false;
  renderReview();
  if (current) speak(current.word, settings.speechRate);
}

function renderReview() {
  const box = $('reviewBox');
  if (!current) {
    box.innerHTML = `
      <div class="w">🎉</div>
      <h2>${doneCount ? `完成了 ${doneCount} 个单词的复习` : '现在没有需要复习的单词'}</h2>
      <p class="muted">继续浏览中文网页积累生词吧。到期的单词会显示在扩展图标的角标上。</p>
      <a class="btn" href="#list">查看生词本</a>`;
    return;
  }
  const e = current;
  const ex = e.examples?.[0];
  box.innerHTML = `
    <p class="muted small">剩余 ${queue.length + 1} 个</p>
    <div class="w">${esc(e.word)}</div>
    <div class="row"><span class="muted">${esc(e.phonetic)}</span><button id="speakBtn" title="发音 (P)">🔊</button></div>
    ${
      revealed
        ? `<div class="answer">
            <div class="mean"><i class="muted">${esc(e.pos)}</i> ${esc(e.meaning)}</div>
            ${e.original ? `<div class="muted">原文：${esc(e.original)}</div>` : ''}
            ${ex ? `<div class="ex">${highlight(ex.s, e)}</div>` : ''}
          </div>
          <div class="grades">
            ${[
              [1, '重来'],
              [2, '困难'],
              [3, '良好'],
              [4, '简单'],
            ]
              .map(([g, label]) => `<button class="g${g}" data-grade="${g}">${label}<small>${e.intervals[g]}</small></button>`)
              .join('')}
          </div>`
        : `<button id="revealBtn" class="primary">显示答案（空格）</button>`
    }`;
}

async function grade(g) {
  if (!current || !revealed) return;
  const updated = await call('vocab:review', { word: current.word, grade: g });
  doneCount++;
  // 「重来」的卡 10 分钟后到期，本轮结束时再来一遍
  if (g === 1 && updated) queue.push(updated);
  next();
}

function bindReview() {
  $('reviewBox').addEventListener('click', (ev) => {
    if (ev.target.closest('#revealBtn')) {
      revealed = true;
      renderReview();
    } else if (ev.target.closest('#speakBtn')) {
      speak(current.word, settings.speechRate);
    } else {
      const b = ev.target.closest('[data-grade]');
      if (b) grade(Number(b.dataset.grade));
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (currentTab() !== 'review' || !current || ev.target.matches('input,textarea,select')) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      if (!revealed) {
        revealed = true;
        renderReview();
      }
    } else if (/^[1-4]$/.test(ev.key)) grade(Number(ev.key));
    else if (ev.key.toLowerCase() === 'p') speak(current.word, settings.speechRate);
  });
}

main();
