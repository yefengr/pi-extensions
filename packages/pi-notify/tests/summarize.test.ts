import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRecapText, summarizeLastMessage } from "../src/summarize.ts";

describe("recap summarization", () => {
  it("removes Markdown and flattens whitespace", () => {
    assert.equal(
      normalizeRecapText("## Done\n\n**Updated** the [`recap`](https://example.test) prompt."),
      "Updated the recap prompt.",
    );
  });

  it("limits output to 45 Unicode characters", () => {
    const recap = normalizeRecapText("你".repeat(46));

    assert.equal(Array.from(recap).length, 45);
    assert.equal(recap, `${"你".repeat(42)}...`);
  });

  it("normalizes fallback text after a failed model request", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("network unavailable"))) as typeof fetch;

    try {
      const recap = await summarizeLastMessage(
        "## Done\n\n**Deployment** completed successfully.",
        "api-key",
        "https://example.test",
        "openai-completions",
        "test-model",
      );

      assert.equal(recap, "Deployment completed successfully.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
