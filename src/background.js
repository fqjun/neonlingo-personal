import { loadSettings, hostBlocked, DEFAULTS } from '../common/settings.js';
import { complete, providerLabel, ProviderError } from './providers/index.js';
import { PAGE_SCHEMA, PAGE_SYSTEM, buildPageUser, assignTargets, LOOKUP_SCHEMA, LOOKUP_SYSTEM, buildLookupUser } from './prompts.js';
import { previewIntervals } from './fsrs.js';
import * as vocab from './vocab.js';

// ---------- API Key ----------

async function getSecrets() {
  const [{ secrets: local }, { secrets: synced }] = await Promise.all([
    chrome.storage.local.get('secrets'),
    chrome.storage.sync.get('secrets'),
  ]);
  return { ...(synced || {}), ...(local || {}) };
}

function hasKey(settings, secrets) {
  return settings.provider === 'openai' ? !!settings.openaiBaseURL : !!secrets.claudeKey;
}

// ---------- 翻译缓存（本机，LRU） ----------

const CACHE_MAX = 2000;
let cache = null;
let cacheSaveTimer = null;

async function loadCache() {
  if (!cache) {
    const { tcache } = await chrome.storage.local.get('tcache');
    cache = new Map(Object.entries(tcache || {}));
  }
  return cache;
}

function saveCacheSoon() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    chrome.storage.local.set({ tcache: Object.fromEntries(cache) });
  }, 1500);
}

function hash(str) {
  // 两个 32 位 FNV-1a 拼成 64 位，足够区分缓存条目。
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

// ---------- 统计 ----------

const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD

async function bumpStats(patch) {
  const { stats } = await chrome.storage.local.get('stats');
  const s = stats?.date === today() ? stats : { date: today(), lookups: 0, replaced: 0, pages: 0 };
  for (const [k, v] of Object.entries(patch)) s[k] = (s[k] || 0) + v;
  await chrome.storage.local.set({ stats: s });
}

async function recordUsage(settings, result) {
  await chrome.storage.local.set({
    last_usage: { provider: providerLabel(settings), model: result.model, ms: result.ms, ...result.usage, at: Date.now() },
  });
}

// ---------- 循序渐进：有效词汇量、在学词、已掌握词 ----------

async function learnerContext(settings) {
  const words = await vocab.all();
  const learning = words
    .filter((w) => w.status === 'learning')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50)
    .map((w) => ({ word: w.word, meaning: w.meaning }));
  const mastered = words.filter((w) => w.status === 'mastered');
  const known = mastered
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200)
    .map((w) => w.word);
  // 每掌握一个词，有效词汇量 +1，选词难度随之缓慢上升。
  const effectiveVocab = settings.vocabSize + mastered.length;
  return { learning, known, masteredSet: new Set(mastered.map((w) => vocab.keyOf(w.word))), effectiveVocab };
}

// ---------- 业务 ----------

const WORD_RE = /^[A-Za-z][A-Za-z '\-]{0,40}$/;

async function translatePage({ items }) {
  const settings = await loadSettings();
  const secrets = await getSecrets();
  const ctx = await learnerContext(settings);
  const c = await loadCache();
  // 有效词汇量按 250 分档，避免每掌握一个词就让缓存失效。
  const bucket = Math.round(ctx.effectiveVocab / 250) * 250;
  const salt = [providerLabel(settings), settings.level, settings.wordDifficulty, bucket, settings.density].join('|');

  const results = new Map();
  const misses = [];
  for (const it of assignTargets(items, settings.density)) {
    // 按比例这一段不需要替换：不调用模型，也不写缓存（下次累积的比例可能分到它）
    if (it.n === 0) {
      results.set(it.id, []);
      continue;
    }
    const k = hash(salt + '|' + it.text);
    if (c.has(k)) {
      const v = c.get(k);
      c.delete(k);
      c.set(k, v); // LRU：移到末尾
      results.set(it.id, v);
    } else {
      misses.push({ ...it, k });
    }
  }

  if (misses.length) {
    const result = await complete(
      {
        system: PAGE_SYSTEM,
        user: buildPageUser({
          items: misses.map(({ id, text, n }) => ({ id, n, text })),
          settings,
          effectiveVocab: ctx.effectiveVocab,
          learning: ctx.learning,
          known: ctx.known,
        }),
        schema: PAGE_SCHEMA,
      },
      settings,
      secrets,
    );
    await recordUsage(settings, result);
    const byId = new Map(result.data.items.map((x) => [String(x.id), x.replacements || []]));
    for (const m of misses) {
      const reps = (byId.get(m.id) || [])
        .filter((r) => r.original && r.original.length <= 12 && m.text.includes(r.original) && WORD_RE.test(r.word.trim()))
        .slice(0, m.n);
      c.set(m.k, reps);
      results.set(m.id, reps);
    }
    saveCacheSoon();
  }

  let count = 0;
  const out = items.map((it) => {
    // 模型偶尔会无视「已掌握」列表，这里再过滤一次；「轻松巩固」模式本来就要复用已掌握的词，不过滤。
    const reps = (results.get(it.id) || []).filter(
      (r) => settings.wordDifficulty === 'review' || !ctx.masteredSet.has(vocab.keyOf(r.word)),
    );
    count += reps.length;
    return { id: it.id, replacements: reps };
  });
  await bumpStats({ replaced: count });
  return { items: out };
}

async function lookup({ text, context, url, title }) {
  const settings = await loadSettings();
  const result = await complete(
    {
      system: LOOKUP_SYSTEM,
      user: buildLookupUser({ text, context, level: settings.level }),
      schema: LOOKUP_SCHEMA,
      maxTokens: 4000,
    },
    settings,
    await getSecrets(),
  );
  await recordUsage(settings, result);
  await bumpStats({ lookups: 1 });
  const r = result.data;
  let entry = await vocab.get(r.word);
  if (settings.autoSaveLookup && WORD_RE.test(r.word.trim())) {
    entry = await vocab.add(
      {
        word: r.word,
        meaning: r.meaning,
        phonetic: r.phonetic,
        pos: r.pos,
        original: /[一-鿿]/.test(text) ? text : '',
        source: 'lookup',
      },
      { status: entry?.status === 'mastered' ? 'mastered' : 'learning', example: context ? { s: context, url, title } : null },
    );
  }
  return { result: r, entry };
}

async function vocabSummary() {
  const words = await vocab.all();
  return words.map((w) => ({ w: w.word, m: w.meaning, p: w.phonetic, pos: w.pos, st: w.status, seen: w.seen, src: w.source }));
}

async function stats() {
  const settings = await loadSettings();
  const words = await vocab.all();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const { stats: s, last_usage, sync_info } = await chrome.storage.local.get(['stats', 'last_usage', 'sync_info']);
  return {
    total: words.length,
    learning: words.filter((w) => w.status === 'learning').length,
    mastered: words.filter((w) => w.status === 'mastered').length,
    newToday: words.filter((w) => w.addedAt >= start.getTime()).length,
    due: (await vocab.dueList()).length,
    today: s?.date === today() ? s : { lookups: 0, replaced: 0, pages: 0 },
    hasKey: hasKey(settings, await getSecrets()),
    lastUsage: last_usage || null,
    syncInfo: sync_info || null,
  };
}

async function testProvider() {
  const settings = await loadSettings();
  const result = await complete(
    {
      system: LOOKUP_SYSTEM,
      user: buildLookupUser({ text: 'resilient', context: 'The city proved remarkably resilient after the storm.', level: settings.level }),
      schema: LOOKUP_SCHEMA,
      maxTokens: 4000,
    },
    settings,
    await getSecrets(),
  );
  await recordUsage(settings, result);
  return { model: result.model, ms: result.ms, usage: result.usage, sample: result.data };
}

// ---------- 徽标：待复习数 ----------

async function updateBadge() {
  const n = (await vocab.dueList()).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
  await chrome.action.setBadgeText({ text: n ? String(n > 999 ? '999+' : n) : '' });
}

// ---------- 同步调度 ----------

function scheduleSync() {
  // service worker 可能随时被回收，用 alarm 而不是 setTimeout 做 30 秒防抖。
  chrome.alarms.create('syncFlush', { delayInMinutes: 0.5 });
}

vocab.setChangeListener(() => {
  scheduleSync();
  updateBadge();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'syncFlush') {
    try {
      await vocab.flushToSync();
    } catch (err) {
      console.warn('[NeonLingo] 同步失败，稍后重试', err);
      chrome.alarms.create('syncFlush', { delayInMinutes: 2 });
    }
  } else if (alarm.name === 'badge') {
    await vocab.mergeAndNotify();
    await updateBadge();
  }
});

let mergeTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (Object.keys(changes).some((k) => k.startsWith('vocab_'))) {
    clearTimeout(mergeTimer);
    mergeTimer = setTimeout(() => vocab.mergeAndNotify(), 1000);
  }
});

// ---------- 安装 / 启动 ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.create({ id: 'nl-lookup', title: '用 NeonLingo 翻译「%s」', contexts: ['selection'] });
  chrome.alarms.create('badge', { periodInMinutes: 30 });
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) await chrome.storage.sync.set({ settings: DEFAULTS });
  await updateBadge();
  if (reason === 'install') {
    const s = await loadSettings();
    if (!hasKey(s, await getSecrets())) chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await vocab.mergeAndNotify();
  await updateBadge();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'nl-lookup' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'lookupSelection', text: info.selectionText }).catch(() => {});
  }
});

// ---------- 消息路由 ----------

const handlers = {
  async init({ url }) {
    const settings = await loadSettings();
    await bumpStats({ pages: 1 });
    return { settings, blocked: hostBlocked(settings, url), vocab: await vocabSummary() };
  },
  translatePage: (msg) => translatePage(msg),
  lookup: (msg) => lookup(msg),
  stats: () => stats(),
  testProvider: () => testProvider(),
  'vocab:summary': () => vocabSummary(),
  'vocab:list': () => vocab.all(),
  'vocab:get': ({ word }) => vocab.get(word),
  'vocab:add': ({ info, status, example }) => vocab.add(info, { status, example }),
  'vocab:mark': ({ word, action, info, example }) => vocab.mark(word, action, info, example),
  'vocab:seen': ({ words }) => vocab.markSeen(words),
  'vocab:update': ({ word, patch }) => vocab.update(word, patch),
  async 'vocab:due'() {
    const now = Date.now();
    return (await vocab.dueList(now)).map((e) => ({ ...e, intervals: previewIntervals(e.card, now) }));
  },
  async 'vocab:review'({ word, grade }) {
    const e = await vocab.review(word, grade);
    return e && { ...e, intervals: previewIntervals(e.card) };
  },
  'vocab:export': () => vocab.exportAll(),
  'vocab:import': ({ data }) => vocab.importAll(data),
  'vocab:syncNow': () => vocab.flushToSync(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (data) => sendResponse({ ok: true, data }),
      (err) => {
        if (!(err instanceof ProviderError)) console.error('[NeonLingo]', msg.type, err);
        sendResponse({ ok: false, error: { code: err.code || 'internal', message: err.message || String(err) } });
      },
    );
  return true;
});
