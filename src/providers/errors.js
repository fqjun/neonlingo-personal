// 统一的模型调用错误。code 供界面给出针对性提示。
// code: 'no_key' | 'auth' | 'rate_limit' | 'network' | 'refusal' | 'truncated' | 'bad_output' | 'bad_request' | 'api'
export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
