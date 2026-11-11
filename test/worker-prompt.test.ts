import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadWorkerPrompt, stripFrontmatter, WorkerPromptError } from "../src/worker-prompt.js";

const dir = mkdtempSync(join(tmpdir(), "cascabel-worker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("worker identity (S1) — live-read, no clones", () => {
  it("strips frontmatter and keeps the operating contract", () => {
    const md = [
      "---",
      "name: gentle-ai-worker",
      "description: does work",
      "---",
      "# Contract",
      "Never leave TODOs.",
    ].join("\n");
    expect(stripFrontmatter(md)).toBe("# Contract\nNever leave TODOs.");
  });

  it("keeps a file without frontmatter intact", () => {
    expect(stripFrontmatter("# Direct\nbody")).toBe("# Direct\nbody");
  });

  it("handles CRLF files", () => {
    const md = "---\r\nname: x\r\n---\r\nbody line";
    expect(stripFrontmatter(md)).toBe("body line");
  });

  it("normalizes a frontmatter-only file to empty body (caught below)", () => {
    expect(stripFrontmatter("---\nname: x\n---\n")).toBe("");
  });

  it("hard-fails when the worker agent file is missing", () => {
    expect(() => loadWorkerPrompt(join(dir, "nope.md"))).toThrowError(
      WorkerPromptError,
    );
  });

  it("hard-fails on an empty body instead of launching instruction-less children", () => {
    const empty = join(dir, "empty.md");
    writeFileSync(empty, "---\nname: x\n---\n");
    expect(() => loadWorkerPrompt(empty)).toThrowError(/no body after frontmatter/);
  });

  it("reads the real file content at call time (no cache)", () => {
    const file = join(dir, "live.md");
    writeFileSync(file, "first body");
    expect(loadWorkerPrompt(file)).toBe("first body");
    writeFileSync(file, "second body");
    expect(loadWorkerPrompt(file)).toBe("second body");
  });
});
