import { DENSITY, DIFFICULTY, levelInfo, targetLevel } from '../common/settings.js';

// ---- 整页替换 ----

export const PAGE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          replacements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                original: { type: 'string' },
                word: { type: 'string' },
                phonetic: { type: 'string' },
                pos: { type: 'string' },
                meaning: { type: 'string' },
              },
              required: ['original', 'word', 'phonetic', 'pos', 'meaning'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'replacements'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

export const PAGE_SYSTEM = `You are the engine of an immersive English-learning browser extension for native Chinese speakers. The learner reads ordinary Chinese web pages; for each paragraph you choose a few Chinese words that the extension will replace inline with English words, so the learner picks up vocabulary from context (comprehensible input, "i+1").

How to choose words:
- Follow the requested difficulty mode and target CEFR band. Every chosen word should be guessable from the surrounding Chinese; skip rare jargon far above the band.
- \`original\` must be copied exactly, character for character, from the paragraph: a contiguous substring, usually a 2-4 character Chinese word. Never cross punctuation, and never cut a piece out of a longer word.
- Don't replace person names, place names, brand names, numbers, code or URLs.
- \`word\` is the English word that fits this exact context, normally in base form (a short fixed phrase of up to 3 words is fine when that's the natural translation).
- \`phonetic\` is US IPA between slashes, e.g. /ˈmɪn.ɪ.məl/. \`pos\` is a short part of speech such as n. v. adj. adv. phr. \`meaning\` is a concise Chinese meaning of the English word in this context (12 characters or fewer).
- Each paragraph has a target count \`n\`: make about \`n\` replacements in it, never more. Spread them across the paragraph. If fewer suitable words exist, return fewer; when \`n\` is 0, return none.
- If a paragraph contains the Chinese meaning of one of the learner's words in progress, prefer replacing it with that English word: repeated exposure is how those words stick.
- Treat the learner's known-words list exactly as the request says: in consolidation mode prefer those words, otherwise never use them.

Return exactly one item per input paragraph, using the paragraph's id.`;

// 与 common/settings.js 的 DIFFICULTY 对应：轻松巩固 / 稍有挑战 / 更有挑战
const DIFFICULTY_EN = {
  review:
    "easy consolidation: mostly words the learner already knows. Whenever their meaning appears, prefer words from the learner's known-words list and words in progress; otherwise use common words within the learner's own band. Almost no new words.",
  next: 'a little challenge: mostly familiar words plus a small number of new words one band above the learner (i+1), so reading stays fluent.',
  challenge: 'more challenge: favor new, more advanced words two bands above the learner, for focused study.',
};

// 估算段落词数：中文按约 1.7 字一词，英文按空格分词。
export function estimateWords(text) {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const latin = (text.match(/[A-Za-z]+/g) || []).length;
  return cjk / 1.7 + latin;
}

// 按替换比例给每段分配替换数；小数部分在段落间累积，保证短段落多的页面整体比例也准确。
export function assignTargets(items, densityId) {
  const pct = (DENSITY[densityId] || DENSITY.medium).pct;
  let carry = 0;
  return items.map((it) => {
    const exact = estimateWords(it.text) * pct + carry;
    const n = Math.floor(exact);
    carry = exact - n;
    return { ...it, n };
  });
}

export function buildPageUser({ items, settings, effectiveVocab, learning, known }) {
  const level = levelInfo(settings.level);
  const target = targetLevel(settings.level, settings.wordDifficulty);
  const density = DENSITY[settings.density] || DENSITY.medium;
  const difficulty = DIFFICULTY[settings.wordDifficulty] ? settings.wordDifficulty : 'next';
  const lines = [
    `Learner level: CEFR ${level.id}; estimated English vocabulary about ${effectiveVocab} words.`,
    `Difficulty mode: ${DIFFICULTY_EN[difficulty]}`,
    `Target word band: CEFR ${target.id}.`,
    `Density: about ${Math.round(density.pct * 100)}% of the words in each paragraph; per-paragraph counts are given as \`n\`.`,
  ];
  if (learning.length) {
    lines.push(`Words in progress (reuse when the meaning appears): ${learning.map((w) => `${w.word}=${w.meaning}`).join('; ')}`);
  }
  if (known.length) {
    lines.push(`Known words (${difficulty === 'review' ? 'consolidation mode: prefer reusing these' : 'never use'}): ${known.join(', ')}`);
  }
  lines.push('', 'Paragraphs (JSON):', JSON.stringify(items));
  return lines.join('\n');
}

// ---- 划词翻译 ----

export const LOOKUP_SCHEMA = {
  type: 'object',
  properties: {
    word: { type: 'string' },
    phonetic: { type: 'string' },
    pos: { type: 'string' },
    meaning: { type: 'string' },
    other_meanings: { type: 'array', items: { type: 'string' } },
    example_en: { type: 'string' },
    example_zh: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['word', 'phonetic', 'pos', 'meaning', 'other_meanings', 'example_en', 'example_zh', 'note'],
  additionalProperties: false,
};

export const LOOKUP_SYSTEM = `You are a concise English-Chinese learner's dictionary inside a browser extension. The user selected some text on a web page; explain it, in the context of the sentence it came from, for a native Chinese speaker learning English.
- If the selection is English, \`word\` is its dictionary headword (lemma); keep a phrase as a phrase.
- If the selection is Chinese, \`word\` is the most natural English equivalent in this context.
- \`phonetic\`: US IPA between slashes (empty string for long phrases). \`pos\`: short part of speech such as n. v. adj. adv. phr.
- \`meaning\`: the Chinese meaning in this context, 16 characters or fewer.
- \`other_meanings\`: up to 3 other common Chinese meanings of the headword (may be empty).
- \`example_en\` / \`example_zh\`: one short, natural example sentence using the headword, and its Chinese translation.
- \`note\`: an optional one-line usage note in Chinese (collocation, register, a common confusion), or an empty string.`;

export function buildLookupUser({ text, context, level }) {
  return [
    `Learner level: CEFR ${levelInfo(level).id}.`,
    `Selected text: ${text}`,
    `Sentence context: ${context || '(none)'}`,
  ].join('\n');
}
