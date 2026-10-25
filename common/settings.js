// 设置默认值与常量。后台（经 esbuild 打包）和扩展页面（popup / options / vocab，ES module）共用。
// 内容脚本不能 import 模块，它通过后台的 `init` 消息拿到合并后的设置。

// 当前外语水平（CEFR）。exam 为国内考试的大致对应，仅作参考。
export const LEVELS = [
  { id: 'A1', label: 'A1 入门', desc: '从基础词汇和日常短句开始。', exam: '≈ 小学', vocab: 600 },
  { id: 'A2', label: 'A2 基础', desc: '能理解常见表达，适合短篇日常内容。', exam: '≈ 初中', vocab: 1200 },
  { id: 'B1', label: 'B1 中级', desc: '能阅读熟悉话题，偶尔需要词汇帮助。', exam: '≈ 高中 / 四级', vocab: 2500 },
  { id: 'B2', label: 'B2 中高级', desc: '能读懂大多数文章，适当拓展进阶词汇。', exam: '≈ 六级 / 考研 / 雅思 6', vocab: 4000 },
  { id: 'C1', label: 'C1 高级', desc: '能理解复杂文章，侧重细微语义与表达。', exam: '≈ 雅思 7+ / 托福 100+ / 专八', vocab: 6500 },
  { id: 'C2', label: 'C2 精通', desc: '接近母语阅读水平，探索专业与低频词汇。', exam: '≈ GRE', vocab: 10000 },
];

// 旧版本按考试划分的水平 id → CEFR
const LEGACY_LEVELS = { primary: 'A1', junior: 'A2', senior: 'B1', cet4: 'B1', cet6: 'B2', kaoyan: 'B2', ielts: 'C1', gre: 'C2' };

// 替换密度：被替换的词占段落总词数的比例。
export const DENSITY = {
  low: { label: '少 2%', pct: 0.02 },
  medium: { label: '中 5%', pct: 0.05 },
  high: { label: '多 8%', pct: 0.08 },
};

// 想学的单词难度：相对「当前外语水平」的偏移（单位：LEVELS 中的档位）。
export const DIFFICULTY = {
  review: { label: '轻松巩固', title: '巩固已经会的词', desc: '以已掌握的词汇为主，轻松巩固。', offset: 0 },
  next: { label: '稍有挑战', title: '比现在会的，多一点点', desc: '在熟悉的内容中遇见少量新词，保持阅读流畅。', offset: 1 },
  challenge: { label: '更有挑战', title: '接触更有挑战的新词', desc: '增加进阶词汇的挑战，适合专注学习。', offset: 2 },
};

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（默认，质量最好）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（更快更便宜）' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（最便宜，适合大量浏览）' },
];

// OpenAI 兼容接口预设。模型名会随厂商更新，设置页里可以随时改。
export const OPENAI_PRESETS = {
  deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
  qwen: { label: '通义千问 (DashScope)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  kimi: { label: 'Kimi 国内版 (platform.moonshot.cn)', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k2-turbo-preview' },
  kimi_intl: { label: 'Kimi 国际版 (platform.moonshot.ai)', baseURL: 'https://api.moonshot.ai/v1', model: 'kimi-k2-turbo-preview' },
  zhipu: { label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  ollama: { label: '本地 Ollama', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  custom: { label: '自定义', baseURL: '', model: '' },
};

export const DEFAULTS = {
  enabled: true,
  level: 'B1',
  vocabSize: 2500,
  density: 'medium',
  wordDifficulty: 'next',
  displayMode: 'en', // 'en' 只显示英文 | 'en_zh' 英文(中文)
  provider: 'claude', // 'claude' | 'openai'
  claudeModel: 'claude-opus-5-5',
  claudeBaseURL: '',
  openaiPreset: 'deepseek',
  openaiBaseURL: OPENAI_PRESETS.deepseek.baseURL,
  openaiModel: OPENAI_PRESETS.deepseek.model,
  highlightColor: '#7c3aed',
  highlightStyle: 'underline', // 'underline' | 'background' | 'bold'
  cardPosition: 'below', // 'below' | 'right' | 'corner'
  selectionMode: 'icon', // 'icon' 先显示小图标 | 'auto' 划词即翻译 | 'off'
  autoSaveLookup: true, // 查词后自动收藏
  lookupColor: '#f59e0b', // 查词收藏的单词在网页上的提示颜色
  globalHighlight: true,
  maxCharsPerPage: 20000,
  blockedSites: [],
  syncApiKey: false,
  speechRate: 0.9,
};

export function levelInfo(id) {
  id = LEGACY_LEVELS[id] || id;
  return LEVELS.find((l) => l.id === id) || LEVELS[2];
}

// 目标词汇档位 = 当前水平 + 难度偏移（不超过最高档）。
export function targetLevel(levelId, difficulty) {
  const i = LEVELS.indexOf(levelInfo(levelId));
  const offset = (DIFFICULTY[difficulty] || DIFFICULTY.next).offset;
  return LEVELS[Math.min(LEVELS.length - 1, i + offset)];
}

export async function loadSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  const s = { ...DEFAULTS, ...(settings || {}) };
  s.level = levelInfo(s.level).id; // 兼容旧版本的考试水平
  return s;
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

export function hostBlocked(settings, url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  return settings.blockedSites.some((s) => host === s || host.endsWith('.' + s));
}
