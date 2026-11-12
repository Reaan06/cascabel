import { describe, expect, it, vi } from "vitest";
import { defaultRoutings, type RoutingsFile } from "../src/core";
import { parseVerdict, runRoute, type RouteDeps, type RouteInput } from "../src/cascade";
import type { ChildRunResult } from "../src/child";
import { nullLogger, type AttemptReceipt } from "../src/log";

function childResult(text: string, sessionId = "child-sess"): ChildRunResult {
  return { text, exitCode: 0, sessionId, timedOut: false };
}

function childText(verdict: "pass" | "fail", extra = ""): string {
  return `${extra}\nwork done\nCASCABEL_VERDICT: ${verdict}\n`;
}

function makeDeps(
  outputs: Array<ChildRunResult | Error>,
  cfg?: Partial<RoutingsFile>,
): { deps: RouteDeps; calls: Array<{ model: string; effort: string; task: string }> } {
  const calls: Array<{ model: string; effort: string; task: string }> = [];
  let i = 0;
  const deps: RouteDeps = {
    routings: { ...defaultRoutings(), ...cfg, tiers: { ...defaultRoutings().tiers, ...cfg?.tiers } },
    workerPrompt: "# worker contract",
    logger: nullLogger,
    runChild: async (opts) => {
      calls.push({ model: opts.tierSpec.model, effort: opts.tierSpec.effort, task: opts.task });
      const next = outputs[i++];
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("test exhausted scripted outputs");
      return next;
    },
  };
  return { deps, calls };
}

const input: RouteInput = {
  task: "write the feature",
  difficulty: "quick",
  label: "unit flow",
  cwd: "/tmp/project",
};

describe("parseVerdict — fail-closed (S4)", () => {
  it("reads the last verdict line", () => {
    expect(parseVerdict("a\ncascabel_verdict: fail\nlater\ncascabel_verdict: pass").verdict).toBe("pass");
  });

  it("counts a missing verdict as fail with reason", () => {
    const parsed = parseVerdict("looks great but no verdict");
    expect(parsed.verdict).toBe("fail");
    expect(parsed.reason).toMatch(/no verdict line/);
  });

  it("only accepts exact pass/fail tokens", () => {
    expect(parseVerdict("cascabel_verdict: passish").verdict).toBe("fail");
  });
});

describe("runRoute — capped cascade (S4, S5, S6)", () => {
  it("passes on the first tier when checks pass", async () => {
    const { deps, calls } = makeDeps([childResult(childText("pass"))]);
    const result = await runRoute(input, deps);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("cli-proxy-api/gemini-3.8-flash-high");
    expect(calls[0].effort).toBe("medium");
    expect(calls[0].task).toContain("cascabel_verdict");
    expect(result.text).toContain("work done");
  });

  it("escalates quick -> build when quick fails its checks (0 retries)", async () => {
    const { deps, calls } = makeDeps(
      [
        childResult(childText("fail", "tests red")),
        childResult(childText("pass", "green")),
      ],
      { retriesPerTier: 0 },
    );
    const result = await runRoute(input, deps);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.model)).toEqual([
      "cli-proxy-api/gemini-3.8-flash-high",
      "nan/deepseek-v4-flash",
    ]);
  });

  it("walks the full chain with 0 retries and returns the human FAIL summary", async () => {
    const { deps, calls } = makeDeps(
      [
        childResult(childText("fail")),
        childResult(childText("fail")),
        childResult(childText("fail")),
      ],
      { retriesPerTier: 0 },
    );
    const result = await runRoute({ ...input, difficulty: "quick" }, deps);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/^Cascabel FAIL after/);
    expect(result.text).toContain("quick #1");
    expect(result.text).toContain("build #1");
    expect(result.text).toContain("deep #1");
    expect(calls).toHaveLength(3);
  });

  it("retries once per tier before stepping up (default retriesPerTier=1)", async () => {
    const { deps, calls } = makeDeps([
      childResult(childText("fail")),
      childResult(childText("fail")),
      childResult(childText("pass")),
    ]);
    const result = await runRoute(input, deps); // quick, quick, build
    expect(result.ok).toBe(true);
    expect(calls.map((c) => `${c.model}@${c.effort}`)).toEqual([
      "cli-proxy-api/gemini-3.8-flash-high@medium",
      "cli-proxy-api/gemini-3.8-flash-high@medium",
      "nan/deepseek-v4-flash@high",
    ]);
    const attempts = result.attempts;
    expect(attempts.map((a) => `${a.tier}#${a.attemptNo}`)).toEqual([
      "quick#1",
      "quick#2",
      "build#1",
    ]);
  });

  it("strict 0-retry config escalates on first fail", async () => {
    const cfg: Partial<RoutingsFile> = { retriesPerTier: 0 };
    const { deps, calls } = makeDeps(
      [childResult(childText("fail")), childResult(childText("pass"))],
      cfg,
    );
    const result = await runRoute(input, deps);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.model)).toEqual([
      "cli-proxy-api/gemini-3.8-flash-high",
      "nan/deepseek-v4-flash",
    ]);
  });

  it("never revisits a tier (no loops, ever)", async () => {
    const cfg: Partial<RoutingsFile> = {
      retriesPerTier: 3,
      escalation: ["quick", "build", "deep"],
    };
    const { deps, calls } = makeDeps(
      Array.from({ length: 12 }, () => childResult(childText("fail"))),
      cfg,
    );
    const result = await runRoute(input, deps);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(12); // 4 quick + 4 build + 4 deep, then cap
  });

  it("crashed children consume the tier retry instead of escalating", async () => {
    const { deps, calls } = makeDeps([
      new Error("child crashed"),
      childResult(childText("pass")),
    ]);
    const result = await runRoute(input, deps);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.model)).toEqual([
      "cli-proxy-api/gemini-3.8-flash-high",
      "cli-proxy-api/gemini-3.8-flash-high",
    ]);
  });

  it("raises before any spawn on unknown difficulty", async () => {
    const { deps, calls } = makeDeps([]);
    await expect(
      runRoute({ ...input, difficulty: "cosmic" as never }, deps),
    ).rejects.toThrowError(/unknown difficulty/);
    expect(calls).toHaveLength(0);
  });

  it("injects the verification contract into the child task", async () => {
    const { deps, calls } = makeDeps([childResult(childText("pass"))]);
    await runRoute(input, deps);
    expect(calls[0].task).toContain("Run every applicable check");
    expect(calls[0].task).toContain("cascabel_verdict");
  });

  it("logs a receipt per attempt (0-retry config)", async () => {
    const receipts: AttemptReceipt[] = [];
    const { deps } = makeDeps(
      [
        childResult(childText("fail")),
        childResult(childText("pass")),
      ],
      { retriesPerTier: 0 },
    );
    deps.logger = { record: (r) => receipts.push(r) };
    await runRoute(input, deps);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      tier: "quick",
      ok: false,
      model: "cli-proxy-api/gemini-3.8-flash-high",
      difficulty: "quick",
      label: "unit flow",
    });
    expect(receipts[1]).toMatchObject({ tier: "build", ok: true });
  });

  it("never spawns a child without the worker prompt", async () => {
    const { deps, calls } = makeDeps([childResult(childText("pass"))]);
    deps.workerPrompt = "live-read contract";
    await runRoute(input, deps);
    expect(calls[0].task).toBeDefined();
    // the runner receives the prompt; verified via child.test.ts flag assertions
  });
});

describe("risk widening (S3)", () => {
  it("starts named-risk tasks at build even when quick is requested", async () => {
    const { deps, calls } = makeDeps([childResult(childText("pass"))]);
    const result = await runRoute({ ...input, risk: "auth" }, deps);
    expect(result.ok).toBe(true);
    expect(calls[0].model).toBe("nan/deepseek-v4-flash");
    expect(calls[0].effort).toBe("high");
  });
});

describe("vi mocking sanity", () => {
  it("vi is available for future runChild integrations", () => {
    expect(typeof vi.fn()).toBe("function");
  });
});
