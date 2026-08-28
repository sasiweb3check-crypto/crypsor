/**
 * Majors, LSTs, and stables that show up in wallet tapes as "buys"
 * but are not names the desk should ever pass.
 */
export const NOISE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euXUPjt1qYq3acW3", // bSOL
  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", // jupSOL
  "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", // INF
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // WBTC (portal)
  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", // cbBTC
  "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU", // tBTC
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // WETH (portal)
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", // JTO
]);

const NOISE_SYMBOLS = new Set([
  "SOL", "WSOL", "BTC", "WBTC", "CBBTC", "TBTC", "ETH", "WETH",
  "USDC", "USDT", "PYUSD", "USD1",
  "JITOSOL", "MSOL", "BSOL", "JUPSOL", "INFSOL", "INF", "JTO",
]);

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export function isNoiseMint(mint: string | null | undefined): boolean {
  return Boolean(mint && NOISE_MINTS.has(mint));
}

export function isNoiseSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  const s = symbol.replace(/^\$/, "").trim().toUpperCase();
  return NOISE_SYMBOLS.has(s);
}

export function isNoiseToken(mint: string | null | undefined, symbol?: string | null): boolean {
  return isNoiseMint(mint) || isNoiseSymbol(symbol);
}

export function isQuoteMint(mint: string | null | undefined): boolean {
  return Boolean(mint && QUOTE_MINTS.has(mint));
}

export const NOISE_MINT_LIST = [...NOISE_MINTS];
