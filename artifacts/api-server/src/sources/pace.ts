/** Small waits so free APIs do not get hammered. */

const last = new Map<string, number>();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pace(key: string, minMs: number): Promise<void> {
  const wait = minMs - (Date.now() - (last.get(key) ?? 0));
  if (wait > 0) await sleep(wait);
  last.set(key, Date.now());
}
