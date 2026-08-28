import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clip, dexTokenImage, httpsImage, tokenImageUrl } from "./image.ts";

describe("httpsImage", () => {
  it("upgrades ipfs and http, drops junk", () => {
    assert.equal(httpsImage("ipfs://Qmabc"), "https://ipfs.io/ipfs/Qmabc");
    assert.equal(httpsImage("http://cdn.dexscreener.com/x.png"), "https://cdn.dexscreener.com/x.png");
    assert.equal(httpsImage("https://pump.mypinata.cloud/ipfs/x"), "https://pump.mypinata.cloud/ipfs/x");
    assert.equal(httpsImage("not-a-url"), null);
    assert.equal(httpsImage(""), null);
  });

  it("builds a Dex thumb for a solana mint", () => {
    const mint = "So11111111111111111111111111111111111111112";
    assert.equal(
      dexTokenImage(mint),
      `https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png`,
    );
    assert.equal(dexTokenImage("nope"), null);
    assert.equal(tokenImageUrl(null, mint)?.includes(mint), true);
    assert.equal(tokenImageUrl("https://pump.fun/x.png", mint), "https://pump.fun/x.png");
  });

  it("clips copy for the live board", () => {
    assert.equal(clip("  hello   world  "), "hello world");
    assert.equal(clip("a".repeat(200))?.endsWith("…"), true);
  });
});
