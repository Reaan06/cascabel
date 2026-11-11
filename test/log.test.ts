import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fileLogger, logDir, nullLogger, type AttemptReceipt } from "../src/log";

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
