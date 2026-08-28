import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clip, httpsImage } from "./image.ts";

describe("httpsImage", () => {
  it("upgrades ipfs and http, drops junk", () => {
    assert.equal(httpsImage("ipfs://Qmabc"), "https://ipfs.io/ipfs/Qmabc");
    assert.equal(httpsImage("http://cdn.dexscreener.com/x.png"), "https://cdn.dexscreener.com/x.png");
    assert.equal(httpsImage("https://pump.mypinata.cloud/ipfs/x"), "https://pump.mypinata.cloud/ipfs/x");
    assert.equal(httpsImage("not-a-url"), null);
    assert.equal(httpsImage(""), null);
  });

  it("clips copy for the live board", () => {
    assert.equal(clip("  hello   world  "), "hello world");
    assert.equal(clip("a".repeat(200))?.endsWith("…"), true);
  });
});
