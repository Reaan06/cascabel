import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTiersCommand, type TiersUi } from "../src/tiers-command";

let sandbox: string;
let routingsFile: string;
let receiptsDir: string;
let receiptsFile: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "cascabel-tiers-"));
  routingsFile = join(sandbox, "config", "routings.json");
  receiptsDir = join(sandbox, "logs");
  receiptsFile = join(receiptsDir, "attempts.jsonl");
  process.env.CASCABEL_ROUTINGS = routingsFile;
  process.env.CASCABEL_LOG_DIR = receiptsDir;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.CASCABEL_ROUTINGS;
  delete process.env.CASCABEL_LOG_DIR;
});

function writeRoutings(content: unknown): string {
  mkdirSync(dirname(routingsFile), { recursive: true });
  writeFileSync(
    routingsFile,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
  return routingsFile;
}

function readRoutings(): Record<string, any> {
  return JSON.parse(readFileSync(routingsFile, "utf8"));
}

function writeReceipts(lines: string[]): void {
  mkdirSync(receiptsDir, { recursive: true });
  writeFileSync(receiptsFile, `${lines.join("\n")}\n`);
}

function receipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-11-12T00:00:00.000Z",
    difficulty: "quick",
    tier: "quick",
    attempt: 1,
    model: "cli-proxy-api/gemini-3.8-flash-high",
    effort: "medium",
    ok: true,
    durationMs: 1000,
    cwd: "/tmp/project",
    ...overrides,
  });
}

const GOLDEN = [
  "Difficulty comes from exploration",
  "A named risk never routes below build",
  "The cap is the feature",
];

describe("/cascabel:tiers show (S9)", () => {
  it("prints the ladder, the routings path in effect and the golden rules", async () => {
    const out = await runTiersCommand("");
    expect(out).toContain(routingsFile);
    expect(out).toMatch(/quick\s+cli-proxy-api\/gemini-3\.8-flash-high@medium/);
    expect(out).toMatch(/build\s+nan\/deepseek-v4-flash@high/);
    expect(out).toMatch(/deep\s+nan\/glm5\.3@max/);
    expect(out).toContain("escalation: quick → build → deep");
    for (const rule of GOLDEN) expect(out).toContain(rule);
  });

  it("prints the tier description from the raw file", async () => {
    writeRoutings({
      tiers: {
        build: {
          model: "custom/mid",
          effort: "xhigh",
          description: "Custom mid tier description",
        },
      },
    });
    const out = await runTiersCommand("show");
    expect(out).toContain("custom/mid@xhigh");
    expect(out).toContain("Custom mid tier description");
  });

  it("says (no receipts yet) when the log does not exist", async () => {
    const out = await runTiersCommand("show");
    expect(out).toContain("(no receipts yet)");
  });

  it("reports a config error without crashing", async () => {
    writeRoutings("{not json");
    const out = await runTiersCommand("show");
    expect(out).toContain("cannot read");
    for (const rule of GOLDEN) expect(out).toContain(rule);
  });
});

describe("/cascabel:tiers stats (S9)", () => {
  it("computes attempts, pass rate, average cost and escalations per tier", async () => {
    writeReceipts([
      receipt({ cost: { total: 0.002 } }),
      receipt({ ok: false, attempt: 2, cost: { total: 0.004 } }),
      receipt({ attempt: 3, cost: { total: 0.01, currency: "USD" } }),
      receipt({ tier: "build", difficulty: "quick", ok: false }),
    ]);
    const out = await runTiersCommand("stats");
    expect(out).toMatch(/quick\s+3\s+67%\s+\$0\.0053\s+0/);
    expect(out).toMatch(/build\s+1\s+0%\s+n\/a\s+1/);
    expect(out).toMatch(/deep\s+0\s+—\s+n\/a\s+0/);
    expect(out).toContain(receiptsFile);
    for (const rule of GOLDEN) expect(out).toContain(rule);
  });

  it("tolerates a missing log and an empty log", async () => {
    expect(await runTiersCommand("stats")).toContain("(no receipts yet)");
    writeReceipts([]);
    expect(await runTiersCommand("stats")).toContain("(no receipts yet)");
  });

  it("skips malformed lines instead of crashing", async () => {
    writeReceipts([
      "not json at all",
      "{broken",
      JSON.stringify({}),
      JSON.stringify({ tier: "apex", ok: true }),
      receipt({ ok: true }),
      JSON.stringify({ tier: "quick", ok: "yes", cost: { total: "free" } }),
    ]);
    const out = await runTiersCommand("stats");
    expect(out).toMatch(/quick\s+2\s+50%/);
    expect(out).not.toContain("apex");
  });
});

describe("/cascabel:tiers set (S9, fail-closed)", () => {
  it("rewrites one tier, preserves the rest and re-validates", async () => {
    writeRoutings({
      tiers: {
        build: {
          model: "old/model",
          effort: "low",
          description: "keep me",
        },
      },
      retriesPerTier: 2,
      escalation: ["quick", "build", "deep"],
    });
    const out = await runTiersCommand("set build new/model xhigh");
    expect(out).toContain("updated build");
    expect(out).toContain("new/model@xhigh");
    expect(out).toContain("validated");

    const saved = readRoutings();
    expect(saved.tiers.build).toEqual({
      model: "new/model",
      effort: "xhigh",
      description: "keep me",
    });
    expect(saved.retriesPerTier).toBe(2);
    expect(saved.escalation).toEqual(["quick", "build", "deep"]);
    // 2-space JSON on disk
    expect(readFileSync(routingsFile, "utf8")).toMatch(/^\{\n {2}"tiers"/);
  });

  it("creates the ~/.pi/cascabel tree when no file exists", async () => {
    expect(existsSync(routingsFile)).toBe(false);
    const out = await runTiersCommand("set quick cli-proxy-api/gemini-3.8-flash-high high");
    expect(out).toContain("updated quick");
    expect(existsSync(routingsFile)).toBe(true);
    expect(readRoutings().tiers.build.model).toBe("nan/deepseek-v4-flash");
    expect(readRoutings().tiers.quick.effort).toBe("high");
  });

  it("reverts the file and errors clearly when the effort is invalid", async () => {
    writeRoutings({
      tiers: { build: { model: "stable/model", effort: "high" } },
      retriesPerTier: 1,
    });
    const before = readFileSync(routingsFile, "utf8");
    const out = await runTiersCommand("set build new/model cosmic");
    expect(out).toMatch(/effort must be one of off, minimal, low, medium, high, xhigh, max/);
    expect(out).toMatch(/restored/);
    expect(readFileSync(routingsFile, "utf8")).toBe(before);
  });

  it("removes the file again when an invalid edit created it", async () => {
    const out = await runTiersCommand("set build new/model cosmic");
    expect(out).toMatch(/effort must be one of/);
    expect(existsSync(routingsFile)).toBe(false);
  });

  it("rejects an unknown tier without touching the file", async () => {
    const before = readFileSync(writeRoutings({}), "utf8");
    const out = await runTiersCommand("set apex some/model high");
    expect(out).toMatch(/unknown tier "apex"/);
    expect(readFileSync(routingsFile, "utf8")).toBe(before);
  });

  it("prints usage for a malformed set invocation", async () => {
    const out = await runTiersCommand("set build only-two-args");
    expect(out).toContain("Usage:");
    for (const rule of GOLDEN) expect(out).toContain(rule);
  });
});

describe("/cascabel:tiers interactive mode (S9)", () => {
  it("edits a tier through ctx.ui and persists through the validated path", async () => {
    const calls: string[] = [];
    const ui: TiersUi = {
      select: async (title, options) => {
        calls.push(`select:${title}`);
        if (title.includes("tier")) return options.find((o) => o.startsWith("build"))!;
        return "xhigh";
      },
      input: async (title, initial) => {
        calls.push(`input:${title}:${initial}`);
        return "custom/interactive-model";
      },
    };
    const out = await runTiersCommand("", ui);
    expect(out).toContain("updated build");
    expect(out).toContain("custom/interactive-model@xhigh");
    expect(readRoutings().tiers.build.model).toBe("custom/interactive-model");
    expect(readRoutings().tiers.build.effort).toBe("xhigh");
    expect(calls[0]).toContain("tier");
    expect(calls[1]).toContain("nan/deepseek-v4-flash");
    for (const rule of GOLDEN) expect(out).toContain(rule);
  });

  it("defaults to show when no TUI is available at all", async () => {
    const out = await runTiersCommand("");
    expect(out).toContain("Cascabel tier ladder");
    for (const rule of GOLDEN) expect(out).toContain(rule);
  });

  it("never throws when a ctx.ui call fails headless", async () => {
    const broken: TiersUi = {
      select: async () => {
        throw new Error("no TUI in rpc mode");
      },
      input: async () => {
        throw new Error("no TUI in rpc mode");
      },
    };
    const out = await runTiersCommand("", broken);
    expect(out).toContain("Usage:");
    expect(out).toContain("no TUI in rpc mode");
  });

  it("cancels cleanly when the picker returns nothing", async () => {
    const out = await runTiersCommand("", {
      select: async () => undefined,
      input: async () => undefined,
    });
    expect(out.toLowerCase()).toContain("cancelled");
    expect(existsSync(routingsFile)).toBe(false);
  });
});
