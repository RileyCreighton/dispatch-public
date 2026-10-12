// JSON object property order is not part of the public x402 semantic contract.
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item==='object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)) : item);
}
