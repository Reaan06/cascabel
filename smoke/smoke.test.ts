// Manual end-to-end smoke: spawns a real `pi --mode rpc` child through the
// whole route_run path. Run with:  CASCABEL_SMOKE=1 npx vitest run smoke
// Uses the quick tier (cheapest model) on a trivial echo task.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRoutings } from "../src/config";
import { loadWorkerPrompt } from "../src/worker-prompt";
import { fileLogger, type AttemptReceipt } from "../src/log";
import { runRoute } from "../src/cascade";
import { runChild } from "../src/child";

const enabled = Boolean(process.env.CASCABEL_SMOKE);

describe.runIf(enabled)("cascabel smoke (real child)", () => {
  it("routes a trivial task through quick and settles with a verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cascabel-smoke-"));
    const receipts: AttemptReceipt[] = [];
    const result = await runRoute(
      {
        task:
          "This is a smoke test of the Cascabel routing harness. Do not run any tools. " +
          "Reply with exactly: smoke ok. Then finish with the verdict line.",
        difficulty: "quick",
        label: "smoke",
        cwd: dir,
        timeoutMs: 240_000,
      },
      {
        routings: loadRoutings(),
        workerPrompt: loadWorkerPrompt(),
        logger: { record: (r) => receipts.push(r) },
        runChild: (opts) =>
          runChild({
            ...opts,
            // The worker contract expects real work; for the smoke we hand it
            // only the task so the cheapest tier should answer directly.
            systemPrompt: undefined,
          }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts[0].tier).toBe("quick");
    expect(result.text.toLowerCase()).toContain("smoke ok");
    expect(receipts).toHaveLength(1);
  }, 300_000);
});
