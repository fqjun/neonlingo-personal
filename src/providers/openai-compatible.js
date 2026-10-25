import { ProviderError } from './errors.js';
import { validate } from './validate.js';

// OpenAI 兼容的 /chat/completions 接口：DeepSeek、通义千问、Kimi、智谱、OpenAI、Ollama 等。
export async function completeOpenAI({ system, user, schema, maxTokens = 8000 }, cfg) {
  if (!cfg.baseURL) throw new ProviderError('no_key', '请先在设置页填写 OpenAI 兼容接口的 Base URL');
  if (!cfg.model) throw new ProviderError('no_key', '请先在设置页填写模型名');

  const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const messages = [
    {
      role: 'system',
      content:
        system +
        '\n\nRespond with a single JSON object only (no markdown fences, no commentary) that matches this JSON Schema:\n' +
        JSON.stringify(schema),
    },
    { role: 'user', content: user },
  ];

  let useJsonMode = true;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { model: cfg.model, messages, temperature: 0.3, max_tokens: maxTokens };
    if (useJsonMode) body.response_format = { type: 'json_object' };

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ProviderError('network', `无法连接 ${cfg.baseURL}，请检查网络或地址（本地 Ollama 需设置 OLLAMA_ORIGINS）`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 部分服务不支持 response_format，去掉后重试一次。
      if (res.status === 400 && useJsonMode && /response_format|json_object/i.test(text)) {
        useJsonMode = false;
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'API Key 无效或无权限：' + text.slice(0, 200));
      if (res.status === 429) throw new ProviderError('rate_limit', '请求太频繁或额度不足，请稍后再试');
      throw new ProviderError('api', `接口错误 ${res.status}：${text.slice(0, 300)}`);
    }

    const json = await res.json();
    const choice = json.choices?.[0];
    if (choice?.finish_reason === 'length') throw new ProviderError('truncated', '输出被截断，请减少单次处理的文字量');
    const data = parseJson(choice?.message?.content);
    const problems = data ? validate(schema, data) : ['not JSON'];
    if (!problems.length) {
      return {
        data,
        usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 },
        model: json.model || cfg.model,
      };
    }
    lastError = new ProviderError('bad_output', '模型返回的 JSON 格式不正确：' + problems.slice(0, 3).join('; '));
  }
  throw lastError;
}

function parseJson(content) {
  if (typeof content !== 'string') return null;
  let s = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}
