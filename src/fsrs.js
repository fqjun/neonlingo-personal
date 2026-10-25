// 简化版 FSRS（参数取 FSRS-4.5 默认权重），目标记忆保持率 90%。
// 评分：1 重来 / 2 困难 / 3 良好 / 4 简单。stability 单位为天。
const W = [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61];
const DAY = 86400000;
const AGAIN_DELAY = 10 * 60000;

const clampD = (d) => Math.min(10, Math.max(1, d));
const initD = (g) => clampD(W[4] - (g - 3) * W[5]);
const retrievability = (elapsedDays, s) => Math.pow(1 + elapsedDays / (9 * s), -1);

// card: { s, d, due, reps, lapses, last } 或 null（新卡）
export function schedule(card, grade, now = Date.now()) {
  let s;
  let d;
  if (!card || !card.reps) {
    s = W[grade - 1];
    d = initD(grade);
  } else {
    const elapsed = Math.max(0, (now - (card.last || now)) / DAY);
    const r = retrievability(elapsed, card.s);
    d = card.d - W[6] * (grade - 3);
    d = clampD(W[7] * initD(3) + (1 - W[7]) * d);
    if (grade === 1) {
      s = W[11] * Math.pow(d, -W[12]) * (Math.pow(card.s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
    } else {
      const hard = grade === 2 ? W[15] : 1;
      const easy = grade === 4 ? W[16] : 1;
      s = card.s * (Math.exp(W[8]) * (11 - d) * Math.pow(card.s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy + 1);
    }
  }
  s = Math.max(0.1, Math.min(s, 36500));
  // 保持率 90% 时，间隔天数 = stability。
  const due = grade === 1 ? now + AGAIN_DELAY : now + Math.max(1, Math.round(s)) * DAY;
  return {
    s: Math.round(s * 100) / 100,
    d: Math.round(d * 100) / 100,
    due,
    reps: (card?.reps || 0) + 1,
    lapses: (card?.lapses || 0) + (grade === 1 && card?.reps ? 1 : 0),
    last: now,
  };
}

export function previewIntervals(card, now = Date.now()) {
  const out = {};
  for (const g of [1, 2, 3, 4]) out[g] = formatInterval(schedule(card, g, now).due - now);
  return out;
}

export function formatInterval(ms) {
  if (ms < 3600000) return `${Math.max(1, Math.round(ms / 60000))} 分钟`;
  if (ms < DAY) return `${Math.round(ms / 3600000)} 小时`;
  const days = Math.round(ms / DAY);
  if (days < 30) return `${days} 天`;
  if (days < 365) return `${Math.round(days / 30)} 个月`;
  return `${(days / 365).toFixed(1)} 年`;
}

// 稳定度超过这个天数视为已掌握，不再出现在整页替换里。
export const MASTERED_STABILITY = 60;
