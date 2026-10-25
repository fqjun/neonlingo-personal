// 极简 JSON Schema 校验，只覆盖本项目用到的 object / array / string / number / boolean / required。
// Claude 的结构化输出已保证格式，这里给 OpenAI 兼容接口兜底。
export function validate(schema, value, path = '$') {
  const problems = [];
  switch (schema.type) {
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} 应为对象`];
      for (const key of schema.required || []) {
        if (!(key in value)) problems.push(`${path}.${key} 缺失`);
      }
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        if (key in value) problems.push(...validate(sub, value[key], `${path}.${key}`));
      }
      break;
    case 'array':
      if (!Array.isArray(value)) return [`${path} 应为数组`];
      value.forEach((v, i) => problems.push(...validate(schema.items, v, `${path}[${i}]`)));
      break;
    case 'string':
      if (typeof value !== 'string') problems.push(`${path} 应为字符串`);
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number') problems.push(`${path} 应为数字`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path} 应为布尔值`);
      break;
  }
  return problems;
}
