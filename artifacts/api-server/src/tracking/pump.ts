// Account layouts/discriminators from pump-fun/pump-public-docs/idl/pump.json.
// Successful buy instructions prove the purchased mint even when enhanced events
// omit Token-2022 transfers or label the transaction UNKNOWN.
const program = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const layouts = [
  { discriminator: [102, 6, 61, 18, 1, 218, 235, 234], mint: 2, user: 6 }, // buy
  { discriminator: [56, 252, 116, 8, 158, 223, 205, 95], mint: 2, user: 6 }, // buy_exact_sol_in
  { discriminator: [184, 23, 238, 97, 103, 197, 211, 61], mint: 1, user: 13 }, // buy_v2
  { discriminator: [194, 171, 28, 70, 104, 77, 91, 47], mint: 1, user: 13 }, // buy_exact_quote_in_v2
  { discriminator: [7, 5, 29, 196, 245, 23, 101, 80], mint: 1, user: 8 }, // buy_v3
  { discriminator: [225, 247, 80, 30, 213, 179, 132, 136], mint: 1, user: 8 }, // buy_exact_quote_in_v3
].map((v) => ({
  ...v,
  discriminator: Buffer.from(v.discriminator).toString("hex"),
}));
export type Instruction = {
  programId?: string;
  accounts?: string[];
  data?: string;
  innerInstructions?: Instruction[];
};
function decode(data: string) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (!data || data.length > 200) return null;
  let value = 0n;
  for (const c of data) {
    const i = alphabet.indexOf(c);
    if (i < 0) return null;
    value = value * 58n + BigInt(i);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.concat([
    Buffer.alloc(data.match(/^1*/)?.[0].length ?? 0),
    Buffer.from(hex, "hex"),
  ]);
}
export function pumpPurchases(
  instructions: Instruction[],
  wallet: string,
): string[] {
  const mints = new Set<string>();
  const visit = (items: Instruction[]) => {
    for (const i of items) {
      if (i.programId === program && typeof i.data === "string") {
        const bytes = decode(i.data);
        const layout =
          bytes && bytes.length >= 24
            ? layouts.find(
                (v) => v.discriminator === bytes.subarray(0, 8).toString("hex"),
              )
            : undefined;
        const mint = layout && i.accounts?.[layout.mint];
        if (
          layout &&
          mint &&
          i.accounts?.[layout.user] === wallet &&
          bytes!.readBigUInt64LE(8) > 0n &&
          /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)
        )
          mints.add(mint);
      }
      // A caller may catch an inner CPI failure. Overall transaction success proves
      // top-level Pump calls; nested routes still need enhanced swap attribution.
    }
  };
  visit(instructions);
  return [...mints];
}
