const transient = new Set([
  "53300",
  "57P03",
  "57P01",
  "08006",
  "08001",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);
export async function retryStartup(
  initialize: () => Promise<void>,
  options: {
    attempts?: number;
    wait?: (ms: number) => Promise<void>;
    report?: (code: string, attempt: number) => void;
  } = {},
) {
  const attempts = options.attempts ?? 12;
  const wait =
    options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      await initialize();
      return;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (!code || !transient.has(code) || attempt >= attempts) throw error;
      options.report?.(code, attempt);
      await wait(Math.min(5000, 1000 * 2 ** (attempt - 1)));
    }
  }
}
