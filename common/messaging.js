// 扩展页面调用后台的小工具：失败时抛出带 code 的错误。
export async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) {
    const err = new Error(res?.error?.message || '后台无响应');
    err.code = res?.error?.code;
    throw err;
  }
  return res.data;
}

export function speak(word, rate = 0.9) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  u.rate = rate;
  speechSynthesis.speak(u);
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
