import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buyFloorUsd, coinWorthCrawl, draftFromDexPair, draftFromNativeIn, draftFromPumpTrade,
  draftFromRhTx, intelKey, pickCrawlCoins, rumorHit, skipWallet, weiToEth,
  BUY_MIN_USD, CRAWL_MC_MIN, DEX_MAX_AGE_MS, FUND_MIN_USD, RH_FUND_ETH, RUMOR_BUY_MIN_USD,
} from "./intel.ts";

describe("intel fund tape", () => {
  it("tags rumor names without treating them as official", () => {
    assert.equal(rumorHit("Official Trump", "TRUMP"), "trump");
    assert.equal(rumorHit("World Liberty", "WLFI"), "wlfi");
    assert.equal(rumorHit("RING", "one ring"), null);
  });

  it("uses a lower buy floor only when the name hit a rumor term", () => {
    assert.equal(buyFloorUsd("trump"), RUMOR_BUY_MIN_USD);
    assert.equal(buyFloorUsd(null), BUY_MIN_USD);
  });

  it("skips tracked desk wallets", () => {
    const w = "Walletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    assert.equal(skipWallet(w, new Set([w])), true);
    assert.equal(skipWallet(w, new Set()), false);
    assert.equal(skipWallet("", new Set()), true);
  });

  it("reads Robinhood wei as ETH and logs funds ≥ 5 ETH", () => {
    const five = "0x" + (5n * 10n ** 18n).toString(16);
    assert.ok(Math.abs((weiToEth(five) ?? 0) - RH_FUND_ETH) < 0.001);
    const draft = draftFromRhTx(
      { hash: "0xabc", from: "0xfrom", to: "0xto", value: five, input: "0x" },
      { at: 1_700_000_000_000, ethUsd: 3_000 },
    );
    assert.equal(draft?.kind, "fund");
    assert.equal(draft?.wallet, "0xto");
    assert.equal(draft?.counterparty, "0xfrom");
    assert.equal(draft?.usd, 15_000);
    assert.ok((draft?.usd ?? 0) >= FUND_MIN_USD);
  });

  it("logs a Robinhood contract create as deploy", () => {
    const d = draftFromRhTx(
      { hash: "0xdef", from: "0xfrom", to: null, value: "0x0", input: "0x6080604052" },
      { at: 1, ethUsd: 3000 },
    );
    assert.equal(d?.kind, "deploy");
  });

  it("keeps a unique key per chain/tx/kind/wallet", () => {
    assert.equal(
      intelKey({ chain: "sol", tx: "sig", kind: "buy", wallet: "w" }),
      "sol:sig:buy:w",
    );
  });

  it("drops small pump buys unless the name is a rumor hit", () => {
    const coin = { mint: "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", symbol: "CAT", name: "cat" };
    const rumor = { mint: coin.mint, symbol: "TRUMP", name: "Trump coin" };
    const smallBuy = { signature: "s1", is_buy: true, user: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", timestamp: 1_700_000_000, sol_amount: 2e9 };
    assert.equal(draftFromPumpTrade(smallBuy, coin, 150), null);
    const hit = draftFromPumpTrade(smallBuy, rumor, 150);
    assert.equal(hit?.kind, "buy");
    assert.equal(hit?.rumor, "trump");
    assert.equal(hit?.usd, 300);
  });

  it("crawls rumor names, fresh coins, and higher-MC coins only", () => {
    const now = 1_700_000_000_000;
    assert.equal(coinWorthCrawl({ mint: "a", symbol: "CAT", name: "cat", usd_market_cap: 1_000, created_timestamp: now - 3_600_000 }, now), false);
    assert.equal(coinWorthCrawl({ mint: "b", symbol: "TRUMP", name: "trump", usd_market_cap: 100, created_timestamp: now - 3_600_000 }, now), true);
    assert.equal(coinWorthCrawl({ mint: "c", symbol: "CAT", name: "cat", usd_market_cap: CRAWL_MC_MIN, created_timestamp: now - 3_600_000 }, now), true);
    assert.equal(coinWorthCrawl({ mint: "d", symbol: "CAT", name: "cat", usd_market_cap: 100, created_timestamp: now - 60_000 }, now), true);
  });

  it("drops nsfw, banned, and quote-like coins from the crawl list", () => {
    const now = Date.now();
    const picked = pickCrawlCoins([
      { mint: "1", symbol: "USDC", name: "usd coin", usd_market_cap: 50_000, created_timestamp: now },
      { mint: "2", symbol: "CAT", name: "cat", nsfw: true, created_timestamp: now },
      { mint: "3", symbol: "WLFI", name: "world liberty", usd_market_cap: 400, created_timestamp: now - 3_600_000 },
    ], now, 15);
    assert.deepEqual(picked.map((c) => c.mint), ["3"]);
  });

  it("logs native SOL inbound only at the fund floor", () => {
    const big = draftFromNativeIn(
      { signature: "sig", timestamp: 1_700_000_000, from: "Funderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", to: "Walletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", lamports: 100e9 },
      150,
    );
    assert.equal(big?.kind, "fund");
    assert.equal(big?.usd, 15_000);
    assert.equal(big?.counterparty?.startsWith("Funder"), true);
    const small = draftFromNativeIn(
      { signature: "s2", timestamp: 1_700_000_000, from: "Funderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", to: "Walletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", lamports: 10e9 },
      150,
    );
    assert.equal(small, null);
  });

  it("logs a young rumor Dex pair and skips old official TRUMP", () => {
    const now = 1_700_000_000_000;
    const young = draftFromDexPair({
      chainId: "solana",
      pairAddress: "Pairxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      pairCreatedAt: now - 3_600_000,
      marketCap: 40_000,
      baseToken: { address: "Mintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", symbol: "TRUMP", name: "Trump" },
    }, now);
    assert.equal(young?.kind, "deploy");
    assert.equal(young?.rumor, "trump");
    assert.equal(young?.chain, "sol");
    const old = draftFromDexPair({
      chainId: "solana",
      pairAddress: "OldPairxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      pairCreatedAt: now - DEX_MAX_AGE_MS - 1,
      marketCap: 2_000_000_000,
      baseToken: { address: "OfficialTrumpMintxxxxxxxxxxxxxxxxxxxxxxx", symbol: "TRUMP", name: "OFFICIAL TRUMP" },
    }, now);
    assert.equal(old, null);
    const rh = draftFromDexPair({
      chainId: "robinhood",
      pairAddress: "0xpair",
      pairCreatedAt: now - 60_000,
      baseToken: { address: "0xmint", symbol: "WLFI", name: "World Liberty" },
    }, now);
    assert.equal(rh?.chain, "robinhood");
    assert.equal(rh?.rumor, "wlfi");
    assert.equal(draftFromDexPair({
      chainId: "ethereum",
      pairAddress: "0xeth",
      pairCreatedAt: now - 60_000,
      baseToken: { address: "0xmint", symbol: "TRUMP", name: "Trump" },
    }, now), null);
  });
});
