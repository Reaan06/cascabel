import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  extractUsage,
  fileLogger,
  formatCost,
  formatTokens,
  logDir,
  nullLogger,
  sumUsage,
  type AttemptReceipt,
} from "../src/log";

const base = mkdtempSync(join(tmpdir(), "cascabel-log-"));
afterAll(() => {
  // leave the sandbox for forensics; tmp cleaners handle it
});

function sample(): AttemptReceipt {
  return {
    timestamp: new Date().toISOString(),
    label: "map footer",
    difficulty: "quick",
    tier: "quick",
    attempt: 1,
    model: "cli-proxy-api/gemini-3.8-flash-high",
    effort: "medium",
    ok: true,
    durationMs: 1234,
    cwd: "/project",
  };
}

describe("receipt log (S6)", () => {
  it("respects an explicit dir", () => {
    expect(logDir("/custom/dir")).toBe("/custom/dir");
  });

  it("respects CASCABEL_LOG_DIR", () => {
    const previous = process.env.CASCABEL_LOG_DIR;
    try {
      process.env.CASCABEL_LOG_DIR = "/env/dir";
      expect(logDir()).toBe("/env/dir");
    } finally {
      if (previous === undefined) delete process.env.CASCABEL_LOG_DIR;
      else process.env.CASCABEL_LOG_DIR = previous;
    }
  });

  it("defaults under ~/.pi/cascabel/logs", () => {
    const previous = process.env.CASCABEL_LOG_DIR;
    try {
      delete process.env.CASCABEL_LOG_DIR;
      expect(logDir()).toContain(".pi/cascabel/logs");
    } finally {
      if (previous !== undefined) process.env.CASCABEL_LOG_DIR = previous;
    }
  });

  it("appends one JSON line per receipt and nothing else", () => {
    const dir = join(base, "appends");
    const logger = fileLogger(dir);
    logger.record(sample());
    logger.record({ ...sample(), ok: false, tier: "build" });
    const raw = readFileSync(join(dir, "attempts.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const second = JSON.parse(lines[1]) as AttemptReceipt;
    expect(second.ok).toBe(false);
    expect(second.tier).toBe("build");
  });

  it("creates the directory tree lazily", () => {
    const dir = join(base, "deep", "nested", "tree");
    expect(existsSync(dir)).toBe(false);
    fileLogger(dir).record(sample());
    expect(existsSync(join(dir, "attempts.jsonl"))).toBe(true);
  });

  it("honours CASCABEL_LOG_DISABLE=1 as a true no-op", () => {
    const previous = process.env.CASCABEL_LOG_DISABLE;
    try {
      process.env.CASCABEL_LOG_DISABLE = "1";
      const dir = join(base, "disabled");
      fileLogger(dir).record(sample());
      expect(existsSync(dir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CASCABEL_LOG_DISABLE;
      else process.env.CASCABEL_LOG_DISABLE = previous;
    }
  });

  it("exposes a null logger for tests", () => {
    expect(() => nullLogger.record(sample())).not.toThrow();
  });
});

describe("cost telemetry extraction (S8)", () => {
  it("stays absent for missing or garbage stats", () => {
    expect(extractUsage(undefined)).toEqual({});
    expect(extractUsage(null)).toEqual({});
    expect(extractUsage("garbage")).toEqual({});
    expect(extractUsage({})).toEqual({});
    expect(extractUsage({ tokens: "lots", cost: { total: "0.4" } })).toEqual({});
    expect(
      extractUsage({ tokens: { input: "12", output: Number.NaN, total: null } }),
    ).toEqual({});
  });

  it("reads the documented tokens/cost shape and passes only numbers", () => {
    expect(
      extractUsage({
        tokens: {
          input: 100,
          output: 900,
          cacheRead: 50,
          cacheWrite: 10,
          total: 1060,
        },
        cost: { total: 0.0042, currency: "USD" },
      }),
    ).toEqual({
      tokens: {
        input: 100,
        output: 900,
        cacheRead: 50,
        cacheWrite: 10,
        total: 1060,
      },
      cost: { total: 0.0042, currency: "USD" },
    });
  });

  it("accepts a plain numeric cost and nested usage objects", () => {
    expect(
      extractUsage({ usage: { tokens: { input: 3, output: 7 } }, cost: 0.5 }),
    ).toEqual({ tokens: { input: 3, output: 7 }, cost: { total: 0.5 } });
  });

  it("rejects negative and non-finite numbers", () => {
    expect(extractUsage({ tokens: { input: -1, output: Infinity } })).toEqual({});
    expect(extractUsage({ cost: { total: -0.2 } })).toEqual({});
  });

  it("formats tokens compactly and costs with a currency", () => {
    expect(formatTokens({ total: 12300 })).toBe("12.3k tok");
    expect(formatTokens({ input: 100, output: 400 })).toBe("500 tok");
    expect(formatTokens({})).toBeUndefined();
    expect(formatCost({ total: 0.0042 })).toBe("$0.0042");
    expect(formatCost({ total: 0.0042, currency: "USD" })).toBe("$0.0042");
    expect(formatCost({ total: 1.5 })).toBe("$1.50");
    expect(formatCost({ total: 0.25, currency: "EUR" })).toBe("EUR 0.25");
    expect(formatCost(undefined)).toBeUndefined();
  });

  it("sums only known values and never invents a zero", () => {
    expect(
      sumUsage([
        { tokens: { total: 100 }, cost: { total: 0.1 } },
        { tokens: { input: 10, output: 20 } },
      ]),
    ).toEqual({ tokensTotal: 130, costTotal: 0.1 });
    expect(sumUsage([{}, {}])).toEqual({});
  });
});
