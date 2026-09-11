// Host 插件通过 hooks.json/.mcp.json 传入的多为 `--name=value` 形式，
// 手工敲命令时也可能用 `--name value`；两种形式都必须解析成功，
// 否则参数会静默回退到默认值（例如 --host=zcode 退化成 plain，导致 Host 丢弃输出）。
export function option(argv, name, fallback) {
  if (!Array.isArray(argv)) return fallback;
  const prefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (typeof value !== 'string') continue;
    if (value === name) {
      const next = argv[index + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-')) return next;
      continue;
    }
    if (value.startsWith(prefix)) {
      const inline = value.slice(prefix.length);
      if (inline.length > 0) return inline;
    }
  }
  return fallback;
}

export function hasFlag(argv, name) {
  return Array.isArray(argv) && argv.includes(name);
}
