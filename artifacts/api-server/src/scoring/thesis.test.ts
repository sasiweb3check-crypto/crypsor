import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { publicStory } from "./thesis.ts";

describe("publicStory", () => {
  it("stays quiet with no socials and does not invent a lock", () => {
    const s = publicStory({ description: "A frog on Solana." });
    assert.equal(s.sentiment, "quiet");
    assert.match(s.thesis, /not an entry/i);
    assert.match(s.thesis, /frog/i);
  });

  it("calls boosts paid attention, not proof", () => {
    const s = publicStory({
      description: "Community token",
      socials: ["twitter", "telegram"],
      boosted: true,
      replies: 120,
    });
    assert.equal(s.sentiment, "hot");
    assert.match(s.thesis, /paid attention/);
  });
});
