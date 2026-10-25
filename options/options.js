import { LEVELS, DIFFICULTY, CLAUDE_MODELS, OPENAI_PRESETS, levelInfo, targetLevel, loadSettings, saveSettings } from '../common/settings.js';
import { call } from '../common/messaging.js';

const $ = (id) => document.getElementById(id);
let settings;

const SIMPLE_FIELDS = [
  'claudeModel',
  'claudeBaseURL',
  'openaiBaseURL',
  'openaiModel',
  'level',
  'density',
  'wordDifficulty',
  'displayMode',
  'highlightColor',
  'lookupColor',
  'highlightStyle',
  'cardPosition',
  'selectionMode',
];
const NUMBER_FIELDS = ['vocabSize', 'maxCharsPerPage', 'speechRate'];
const BOOL_FIELDS = ['autoSaveLookup', 'globalHighlight'];

async function main() {
  settings = await loadSettings();
  $('level').innerHTML = LEVELS.map((l) => `<option value="${l.id}">${l.label}（${l.exam}，约 ${l.vocab} 词）</option>`).join('');
  $('claudeModel').innerHTML = CLAUDE_MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  $('openaiPreset').innerHTML = Object.entries(OPENAI_PRESETS)
    .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
    .join('');

  for (const f of SIMPLE_FIELDS) $(f).value = settings[f];
  for (const f of NUMBER_FIELDS) $(f).value = settings[f];
  for (const f of BOOL_FIELDS) $(f).checked = settings[f];
  $('openaiPreset').value = settings.openaiPreset;
  $('blockedSites').value = settings.blockedSites.join('\n');
  $('syncApiKey').checked = settings.syncApiKey;

  const secrets = await readSecrets();
  $('claudeKey').value = secrets.claudeKey || '';
  $('openaiKey').value = secrets.openaiKey || '';

  renderProvider();
  renderLevelDesc();
  bind();
  showSyncInfo();
}

// ---- 保存 ----

const pending = {};
let saveTimer;
function queueSave(patch) {
  Object.assign(pending, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    settings = await saveSettings({ ...pending });
    for (const k of Object.keys(pending)) delete pending[k];
    flashSaved();
  }, 400);
}

function flashSaved() {
  $('saved').classList.add('show');
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => $('saved').classList.remove('show'), 1500);
}

async function readSecrets() {
  const [{ secrets: local }, { secrets: synced }] = await Promise.all([chrome.storage.local.get('secrets'), chrome.storage.sync.get('secrets')]);
  return { ...(synced || {}), ...(local || {}) };
}

async function writeSecrets() {
  const secrets = { claudeKey: $('claudeKey').value.trim(), openaiKey: $('openaiKey').value.trim() };
  await chrome.storage.local.set({ secrets });
  if ($('syncApiKey').checked) await chrome.storage.sync.set({ secrets });
  else await chrome.storage.sync.remove('secrets');
  flashSaved();
}

// ---- 交互 ----

function renderProvider() {
  document.querySelectorAll('#provider button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.provider));
  $('claudeBox').hidden = settings.provider !== 'claude';
  $('openaiBox').hidden = settings.provider !== 'openai';
}

function renderLevelDesc() {
  const level = $('level').value;
  const d = DIFFICULTY[$('wordDifficulty').value] || DIFFICULTY.next;
  $('levelDesc').textContent = `水平：${levelInfo(level).desc} 难度：${d.desc} 当前会选 ${targetLevel(level, $('wordDifficulty').value).id} 级的词来替换。`;
}

function bind() {
  $('provider').addEventListener('click', async (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    settings = await saveSettings({ provider: v });
    renderProvider();
    flashSaved();
  });

  for (const f of SIMPLE_FIELDS) {
    $(f).addEventListener($(f).tagName === 'SELECT' || $(f).type === 'color' ? 'change' : 'input', (e) => {
      const patch = { [f]: e.target.value.trim() };
      if (f === 'level') {
        patch.vocabSize = levelInfo(e.target.value).vocab;
        $('vocabSize').value = patch.vocabSize;
      }
      if (f === 'level' || f === 'wordDifficulty') renderLevelDesc();
      if (f === 'openaiBaseURL' || f === 'openaiModel') {
        patch.openaiPreset = 'custom';
        $('openaiPreset').value = 'custom';
      }
      queueSave(patch);
    });
  }
  for (const f of NUMBER_FIELDS) {
    $(f).addEventListener('input', (e) => {
      const n = Number(e.target.value);
      if (Number.isFinite(n) && n > 0) queueSave({ [f]: n });
    });
  }
  for (const f of BOOL_FIELDS) $(f).addEventListener('change', (e) => queueSave({ [f]: e.target.checked }));
  const syncLookupColor = () => ($('lookupColorRow').hidden = !$('autoSaveLookup').checked);
  $('autoSaveLookup').addEventListener('change', syncLookupColor);
  syncLookupColor();

  $('openaiPreset').addEventListener('change', (e) => {
    const p = OPENAI_PRESETS[e.target.value];
    const patch = { openaiPreset: e.target.value };
    if (p.baseURL) {
      patch.openaiBaseURL = p.baseURL;
      patch.openaiModel = p.model;
      $('openaiBaseURL').value = p.baseURL;
      $('openaiModel').value = p.model;
    }
    queueSave(patch);
  });

  $('blockedSites').addEventListener('input', (e) => {
    const list = e.target.value
      .split(/\s+/)
      .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    queueSave({ blockedSites: [...new Set(list)] });
  });

  let keyTimer;
  for (const id of ['claudeKey', 'openaiKey']) {
    $(id).addEventListener('input', () => {
      clearTimeout(keyTimer);
      keyTimer = setTimeout(writeSecrets, 400);
    });
  }
  $('syncApiKey').addEventListener('change', async (e) => {
    settings = await saveSettings({ syncApiKey: e.target.checked });
    await writeSecrets();
  });

  $('test').addEventListener('click', testConnection);
  $('syncNow').addEventListener('click', async () => {
    $('syncInfo').textContent = '同步中…';
    try {
      await call('vocab:syncNow');
    } catch (e) {
      $('syncInfo').textContent = '同步失败：' + e.message;
      return;
    }
    showSyncInfo();
  });
  $('exportJson').addEventListener('click', exportJson);
  $('importJson').addEventListener('change', importJson);
}

async function testConnection() {
  const out = $('testResult');
  // 先把还没写入的改动保存掉，确保后台用的是最新设置
  clearTimeout(saveTimer);
  if (Object.keys(pending).length) settings = await saveSettings({ ...pending });
  await writeSecrets();
  out.className = 'small';
  out.textContent = '测试中…';
  try {
    const r = await call('testProvider');
    out.className = 'small ok';
    out.textContent = `✓ 连接成功：${r.model}，${(r.ms / 1000).toFixed(1)} 秒，${r.usage.input}+${r.usage.output} tokens。示例：resilient = ${r.sample.meaning}`;
  } catch (e) {
    out.className = 'small err';
    out.textContent = '✗ ' + e.message;
  }
}

async function showSyncInfo() {
  const { sync_info: s } = await chrome.storage.local.get('sync_info');
  const used = await chrome.storage.sync.getBytesInUse(null);
  const quota = chrome.storage.sync.QUOTA_BYTES;
  let text = `同步空间已用 ${(used / 1024).toFixed(1)} KB / ${(quota / 1024).toFixed(0)} KB。`;
  if (s) {
    text += ` 上次同步：${new Date(s.at).toLocaleString()}，生词本 ${s.synced} / ${s.total} 个词已同步`;
    if (s.synced < s.total) text += `（空间不足，其余 ${s.total - s.synced} 个较早掌握的词只保存在本机）`;
    text += '。';
  }
  $('syncInfo').textContent = text;
}

async function exportJson() {
  const data = await call('vocab:export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `neonlingo-vocab-${new Date().toLocaleDateString('sv')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJson(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const n = await call('vocab:import', { data });
    alert(`导入完成：新增或更新 ${n} 个词`);
  } catch (err) {
    alert('导入失败：' + err.message);
  }
  e.target.value = '';
}

main();
