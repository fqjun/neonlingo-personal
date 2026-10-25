import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { ProviderError } from './errors.js';

// 支持服务端 fallbacks 的模型：遇到安全分类器拒绝时由服务端自动换模型重试。Haiku 5.5 不支持。
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export async function completeClaude({ system, user, schema, maxTokens = 16000 }, cfg) {
  if (!cfg.apiKey) throw new ProviderError('no_key', '请先在设置页填写 Claude API Key');

  const client = new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL || undefined,
    // 个人自用：Key 只保存在本机扩展存储里，由扩展后台直接请求 API。
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });

  const params = {
    model: cfg.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    // 选词/查词是简单任务，low 足够且省钱省时。
    output_config: { effort: 'low', format: jsonSchemaOutputFormat(schema) },
  };

  let msg;
  try {
    // 自定义中转地址不一定支持 beta 参数，只对官方地址启用 fallbacks。
    if (FALLBACK_MODELS.has(cfg.model) && !cfg.baseURL) {
      msg = await client.beta.messages.parse({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } else {
      msg = await client.messages.parse(params);
    }
  } catch (err) {
    throw mapError(err);
  }

  if (msg.stop_reason === 'refusal') throw new ProviderError('refusal', '模型拒绝处理这段内容');
  if (msg.stop_reason === 'max_tokens') throw new ProviderError('truncated', '输出被截断，请减少单次处理的文字量');
  if (!msg.parsed_output) throw new ProviderError('bad_output', '模型没有返回有效 JSON');

  return {
    data: msg.parsed_output,
    usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
    model: msg.model,
  };
}

function mapError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError('auth', 'Claude API Key 无效，请检查设置');
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', '没有权限使用该模型：' + err.message);
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('rate_limit', '请求太频繁或额度不足，请稍后再试');
  if (err instanceof Anthropic.BadRequestError) return new ProviderError('bad_request', '请求参数错误：' + err.message);
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', '无法连接 Claude API，请检查网络或中转地址');
  if (err instanceof Anthropic.APIError) return new ProviderError('api', `Claude API 错误 ${err.status ?? ''}：${err.message}`);
  return new ProviderError('api', String(err?.message || err));
}
