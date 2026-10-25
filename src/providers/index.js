import { completeClaude } from './claude.js';
import { completeOpenAI } from './openai-compatible.js';

export { ProviderError } from './errors.js';

// 统一入口：业务代码只调用 complete()，返回 { data, usage, model }。
export async function complete(task, settings, secrets) {
  const started = Date.now();
  let result;
  if (settings.provider === 'openai') {
    result = await completeOpenAI(task, {
      baseURL: settings.openaiBaseURL,
      apiKey: secrets.openaiKey,
      model: settings.openaiModel,
    });
  } else {
    result = await completeClaude(task, {
      baseURL: settings.claudeBaseURL,
      apiKey: secrets.claudeKey,
      model: settings.claudeModel,
    });
  }
  result.ms = Date.now() - started;
  return result;
}

export function providerLabel(settings) {
  return settings.provider === 'openai' ? `openai:${settings.openaiModel}` : `claude:${settings.claudeModel}`;
}
