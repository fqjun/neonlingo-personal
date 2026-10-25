// 生词本存储。
// - 完整数据（含例句、出处）存 chrome.storage.local 的 `vocab_all`，是本机的权威副本。
// - 精简数据分片写入 chrome.storage.sync（`vocab_meta` + `vocab_0..n` + `vocab_deleted`），随 Chrome 账号同步到其他电脑。
// - 合并规则：同一个词以 updatedAt 较新的为准；删除用墓碑记录，避免被其他电脑写回来。
import { schedule, MASTERED_STABILITY } from './fsrs.js';

const SHARD_BYTES = 7000; // 单项上限 8192
const SYNC_BUDGET = 88 * 1024; // 总量上限 102400，给设置等留余量
const TOMBSTONE_TTL = 60 * 86400000;
const MAX_EXAMPLES = 3;
const STATUS = { learning: 1, mastered: 2 };
const STATUS_NAME = { 1: 'learning', 2: 'mastered' };

let state = null; // { words: {key: entry}, deleted: {key: ms} }
let loading = null;
let onChange = () => {};

export const keyOf = (word) => String(word || '').trim().toLowerCase();

export function setChangeListener(fn) {
  onChange = fn;
}

export async function load() {
  if (state) return state;
  if (!loading) {
    loading = (async () => {
      const { vocab_all, vocab_deleted } = await chrome.storage.local.get(['vocab_all', 'vocab_deleted']);
      state = { words: vocab_all || {}, deleted: vocab_deleted || {} };
      if (await mergeFromSync()) await persistLocal();
      return state;
    })();
  }
  return loading;
}

async function persistLocal() {
  await chrome.storage.local.set({ vocab_all: state.words, vocab_deleted: state.deleted });
}

async function commit() {
  await persistLocal();
  onChange();
}

// ---- 读取 ----

export async function all() {
  return Object.values((await load()).words);
}

export async function get(word) {
  return (await load()).words[keyOf(word)] || null;
}

export async function dueList(now = Date.now()) {
  return (await all())
    .filter((e) => e.status === 'learning' && (!e.card || e.card.due <= now))
    .sort((a, b) => (a.card?.due || a.addedAt) - (b.card?.due || b.addedAt));
}

// ---- 写入 ----

function addExample(entry, example) {
  if (!example?.s) return;
  const s = example.s.trim().slice(0, 300);
  entry.examples = [{ ...example, s, t: example.t || Date.now() }, ...(entry.examples || []).filter((x) => x.s !== s)].slice(
    0,
    MAX_EXAMPLES,
  );
}

function upsertEntry(info, status) {
  const key = keyOf(info.word);
  const now = Date.now();
  let e = state.words[key];
  if (!e) {
    e = state.words[key] = {
      word: info.word.trim(),
      meaning: info.meaning || '',
      phonetic: info.phonetic || '',
      pos: info.pos || '',
      original: info.original || '',
      source: info.source || 'page', // 'page' 网页替换词 | 'lookup' 划词查词
      status,
      seen: 0,
      known: 0,
      card: null,
      addedAt: now,
      updatedAt: now,
      examples: [],
    };
  } else {
    for (const f of ['meaning', 'phonetic', 'pos', 'original']) if (!e[f] && info[f]) e[f] = info[f];
    // 主动查过的词标记为查词来源，用查词颜色提示
    if (info.source === 'lookup') e.source = 'lookup';
  }
  return e;
}

export async function add(info, { status = 'learning', example } = {}) {
  await load();
  const e = upsertEntry(info, status);
  if (status === 'learning' && e.status === 'mastered') {
    e.status = 'learning';
    e.known = 0;
  }
  addExample(e, example);
  e.updatedAt = Date.now();
  await commit();
  return e;
}

// action: 'known' 认识 | 'unknown' 不认识 | 'mastered' | 'learning' | 'remove'
export async function mark(word, action, info = {}, example) {
  await load();
  const key = keyOf(word);
  const now = Date.now();
  let e = state.words[key];

  if (action === 'remove') {
    if (e) {
      delete state.words[key];
      state.deleted[key] = now;
      await commit();
    }
    return null;
  }

  const created = !e;
  if (created) e = upsertEntry({ word, ...info }, action === 'known' || action === 'mastered' ? 'mastered' : 'learning');
  addExample(e, example);

  if (action === 'known') {
    e.known = (e.known || 0) + 1;
    // 已在学的词需要连续点 3 次「认识」才算掌握；第一次见就点「认识」直接视为已掌握。
    if (e.known >= 3 || created) e.status = 'mastered';
  } else if (action === 'unknown') {
    e.status = 'learning';
    e.known = 0;
    if (e.card) e.card = { ...e.card, due: now };
  } else if (action === 'mastered') {
    e.status = 'mastered';
  } else if (action === 'learning') {
    e.status = 'learning';
    e.known = 0;
  }
  e.updatedAt = now;
  await commit();
  return e;
}

export async function markSeen(words) {
  await load();
  let changed = false;
  for (const w of words) {
    const e = state.words[keyOf(w)];
    if (e) {
      e.seen = (e.seen || 0) + 1;
      e.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) await commit();
}

export async function review(word, grade) {
  await load();
  const e = state.words[keyOf(word)];
  if (!e) return null;
  e.card = schedule(e.card, grade);
  if (e.card.s >= MASTERED_STABILITY) e.status = 'mastered';
  e.updatedAt = Date.now();
  await commit();
  return e;
}

export async function update(word, patch) {
  await load();
  const e = state.words[keyOf(word)];
  if (!e) return null;
  for (const f of ['meaning', 'phonetic', 'pos', 'original']) if (typeof patch[f] === 'string') e[f] = patch[f];
  e.updatedAt = Date.now();
  await commit();
  return e;
}

export async function exportAll() {
  await load();
  return { app: 'neonlingo-personal', version: 1, exportedAt: new Date().toISOString(), words: Object.values(state.words) };
}

export async function importAll(data) {
  await load();
  const list = Array.isArray(data) ? data : data?.words;
  if (!Array.isArray(list)) throw new Error('文件格式不对：缺少 words 数组');
  let added = 0;
  for (const r of list) {
    if (!r?.word) continue;
    const key = keyOf(r.word);
    const l = state.words[key];
    if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) {
      state.words[key] = { seen: 0, known: 0, card: null, examples: [], status: 'learning', addedAt: Date.now(), ...r, updatedAt: r.updatedAt || Date.now() };
      added++;
    }
  }
  await commit();
  return added;
}

// ---- 同步 ----

const min36 = (ms) => (ms ? Math.round(ms / 60000).toString(36) : '');
const fromMin36 = (s) => (s ? parseInt(s, 36) * 60000 : 0);
const sec = (ms) => Math.round((ms || 0) / 1000);

function compact(e) {
  const c = e.card;
  return [
    e.word,
    e.meaning,
    e.phonetic,
    e.pos,
    e.original,
    STATUS[e.status] || 1,
    e.seen || 0,
    e.known || 0,
    c ? c.s : 0,
    c ? c.d : 0,
    c ? min36(c.due) : '',
    c ? c.reps : 0,
    c ? c.lapses : 0,
    c ? min36(c.last) : '',
    min36(e.addedAt),
    sec(e.updatedAt).toString(36),
    e.source === 'lookup' ? 1 : 0,
  ];
}

function expand(a) {
  const [word, meaning, phonetic, pos, original, st, seen, known, s, d, due, reps, lapses, last, addedAt, updatedAt, lookup] = a;
  return {
    word,
    meaning,
    phonetic,
    pos,
    original,
    source: lookup ? 'lookup' : 'page',
    status: STATUS_NAME[st] || 'learning',
    seen,
    known,
    card: reps ? { s, d, due: fromMin36(due), reps, lapses, last: fromMin36(last) } : null,
    addedAt: fromMin36(addedAt),
    updatedAt: parseInt(updatedAt, 36) * 1000,
    examples: [],
  };
}

// 把 sync 里其他电脑的改动合并进本机，返回是否有变化。
export async function mergeFromSync() {
  const remote = await chrome.storage.sync.get(null);
  const meta = remote.vocab_meta;
  let changed = false;

  for (const [key, ts] of Object.entries(remote.vocab_deleted || {})) {
    if (!state.deleted[key] || state.deleted[key] < ts) state.deleted[key] = ts;
    const e = state.words[key];
    if (e && sec(e.updatedAt) <= sec(ts)) {
      delete state.words[key];
      changed = true;
    }
  }
  if (!meta) return changed;

  for (let i = 0; i < meta.n; i++) {
    for (const arr of remote['vocab_' + i] || []) {
      const r = expand(arr);
      const key = keyOf(r.word);
      if (state.deleted[key] && sec(state.deleted[key]) >= sec(r.updatedAt)) continue;
      const l = state.words[key];
      if (!l) {
        state.words[key] = r;
        changed = true;
      } else if (sec(r.updatedAt) > sec(l.updatedAt)) {
        state.words[key] = { ...r, examples: l.examples || [] };
        changed = true;
      }
    }
  }
  return changed;
}

export async function mergeAndNotify() {
  await load();
  if (await mergeFromSync()) await commit();
}

// 把本机数据写入 sync。学习中的词优先，空间不够时最早掌握的词只留在本机。
export async function flushToSync() {
  await load();
  if (await mergeFromSync()) await persistLocal();

  const now = Date.now();
  for (const [k, ts] of Object.entries(state.deleted)) if (now - ts > TOMBSTONE_TTL) delete state.deleted[k];

  const enc = new TextEncoder();
  const deletedBytes = enc.encode(JSON.stringify(state.deleted)).length;
  const entries = Object.values(state.words).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'learning' ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  const shards = [];
  let cur = [];
  let curBytes = 2;
  let total = deletedBytes;
  let synced = 0;
  for (const e of entries) {
    const c = compact(e);
    const bytes = enc.encode(JSON.stringify(c)).length + 1;
    if (total + bytes > SYNC_BUDGET) break;
    if (curBytes + bytes > SHARD_BYTES) {
      shards.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(c);
    curBytes += bytes;
    total += bytes;
    synced++;
  }
  if (cur.length) shards.push(cur);

  const { vocab_meta: oldMeta } = await chrome.storage.sync.get('vocab_meta');
  const payload = { vocab_meta: { n: shards.length, at: now }, vocab_deleted: state.deleted };
  shards.forEach((s, i) => (payload['vocab_' + i] = s));
  await chrome.storage.sync.set(payload);
  const stale = [];
  for (let i = shards.length; i < (oldMeta?.n || 0); i++) stale.push('vocab_' + i);
  if (stale.length) await chrome.storage.sync.remove(stale);

  const info = { synced, total: entries.length, bytes: total, budget: SYNC_BUDGET, at: now };
  await chrome.storage.local.set({ sync_info: info });
  return info;
}
