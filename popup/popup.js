import { LEVELS, DIFFICULTY, levelInfo, targetLevel, loadSettings, saveSettings } from '../common/settings.js';
import { call } from '../common/messaging.js';

const $ = (id) => document.getElementById(id);
let settings;
let host = '';

async function main() {
  settings = await loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab?.url || '');
    if (/^https?:$/.test(u.protocol)) host = u.hostname;
  } catch {}

  $('level').innerHTML = LEVELS.map((l) => `<option value="${l.id}">${l.label}（${l.exam}）</option>`).join('');
  render();
  bind();
  refreshStats();
}

function render() {
  $('enabled').checked = settings.enabled;
  $('autoSaveLookup').checked = settings.autoSaveLookup;
  $('host').textContent = host || '此页面';
  $('siteOn').disabled = !host;
  $('siteOn').checked = !!host && !settings.blockedSites.includes(host);
  $('level').value = settings.level;
  $('vocabSize').value = settings.vocabSize;
  $('levelDesc').textContent = levelInfo(settings.level).desc;
  document.querySelectorAll('#density button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.density));
  document.querySelectorAll('#wordDifficulty button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.wordDifficulty));
  const d = DIFFICULTY[settings.wordDifficulty] || DIFFICULTY.next;
  $('difficultyDesc').textContent = `${d.title}：${d.desc}（选 ${targetLevel(settings.level, settings.wordDifficulty).id} 级词汇）`;
}

async function update(patch) {
  settings = await saveSettings(patch);
  render();
  refreshStats();
}

function bind() {
  $('enabled').addEventListener('change', (e) => update({ enabled: e.target.checked }));
  $('autoSaveLookup').addEventListener('change', (e) => update({ autoSaveLookup: e.target.checked }));
  $('siteOn').addEventListener('change', (e) => {
    const list = settings.blockedSites.filter((s) => s !== host);
    if (!e.target.checked) list.push(host);
    update({ blockedSites: list });
  });
  $('level').addEventListener('change', (e) => update({ level: e.target.value, vocabSize: levelInfo(e.target.value).vocab }));
  let t;
  $('vocabSize').addEventListener('input', (e) => {
    clearTimeout(t);
    const n = Math.round(Number(e.target.value));
    if (n >= 300) t = setTimeout(() => update({ vocabSize: n }), 600);
  });
  for (const key of ['density', 'wordDifficulty']) {
    $(key).addEventListener('click', (e) => {
      const v = e.target.closest('button')?.dataset.v;
      if (v) update({ [key]: v });
    });
  }
  document.querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const target = el.dataset.open;
      if (target === 'options') chrome.runtime.openOptionsPage();
      else chrome.tabs.create({ url: chrome.runtime.getURL(`vocab/vocab.html${target === 'review' ? '#review' : ''}`) });
      window.close();
    }),
  );
}

async function refreshStats() {
  try {
    const s = await call('stats');
    $('sNew').textContent = s.newToday;
    $('sLearning').textContent = s.learning;
    $('sMastered').textContent = s.mastered;
    $('sReplaced').textContent = s.today.replaced;
    $('sDue').textContent = s.due;
    $('keyNotice').hidden = s.hasKey;
    $('effVocab').textContent = s.mastered ? `（+${s.mastered} 已掌握 = ${settings.vocabSize + s.mastered}）` : '';
    if (s.lastUsage) {
      const u = s.lastUsage;
      $('usage').textContent = `上次请求：${u.model}，${(u.ms / 1000).toFixed(1)} 秒，输入 ${u.input} / 输出 ${u.output} tokens`;
    }
  } catch (e) {
    $('usage').textContent = '读取统计失败：' + e.message;
  }
}

main();
