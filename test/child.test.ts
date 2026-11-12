import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cascabelSessionDir,
  childArguments,
  type ChildRunOptions,
  ChildRunError,
  resolveNanProviderExtension,
  runChild,
  type SpawnLike,
} from "../src/child";
import { defaultRoutings, type TierSpec } from "../src/core";

const base: ChildRunOptions = {
  tierSpec: defaultRoutings().tiers.quick,
  cwd: "/tmp",
  task: "do the thing",
};

describe("childArguments", () => {
  it("declares model, thinking and RPC mode", () => {
    const args = childArguments(base);
    expect(args[0]).toBe("--mode");
    expect(args[1]).toBe("rpc");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe(
      "cli-proxy-api/gemini-3.8-flash-high",
    );
    expect(args[args.indexOf("--thinking") + 1]).toBe("medium");
  });

  it("defaults to auto approval because rpc children cannot answer prompts", () => {
    expect(childArguments(base)).toContain("-a");
  });

  it("honours a reject-only tier", () => {
    const spec: TierSpec = { ...base.tierSpec, approval: "reject" };
    expect(childArguments({ ...base, tierSpec: spec })).toContain("-na");
  });

  it("passes the worker system prompt through verbatim", () => {
    const args = childArguments({
      ...base,
      systemPrompt: "# The worker contract\nNever leave TODOs.",
    });
    const i = args.indexOf("--append-system-prompt");
    expect(args[i + 1]).toContain("Never leave TODOs.");
  });

  it("emits only documented flags", () => {
    const args = childArguments({ ...base, systemPrompt: "s" });
    const allowed = new Set([
      "--mode",
      "rpc",
      "--session-dir",
      "--model",
      "--thinking",
      "--append-system-prompt",
    ]);
    for (const arg of args) {
      if (arg.startsWith("--")) expect(allowed.has(arg)).toBe(true);
    }
    // short flags: auto approval only
    expect(args.filter((a) => a === "-a")).toHaveLength(1);
  });

  it("types the error detail for diagnostics", () => {
    expect(new ChildRunError("x").detail).toEqual({});
  });
});

describe("child session isolation", () => {
  afterEach(() => {
    delete process.env.CASCABEL_SESSION_DIR;
  });

  it("keeps its own sessions out of the user's cwd-scoped session store", () => {
    const args = childArguments(base);
    const i = args.indexOf("--session-dir");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(join(homedir(), ".pi", "cascabel", "sessions"));
  });

  it("honours CASCABEL_SESSION_DIR", () => {
    process.env.CASCABEL_SESSION_DIR = "/tmp/cascabel-sessions-override";
    expect(cascabelSessionDir()).toBe("/tmp/cascabel-sessions-override");
    const args = childArguments(base);
    expect(args[args.indexOf("--session-dir") + 1]).toBe(
      "/tmp/cascabel-sessions-override",
    );
  });
});

describe("runChild exit handling", () => {
  afterEach(() => {
    delete process.env.CASCABEL_SESSION_DIR;
  });

  it("fails fast when the child exits before settling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cascabel-child-exit-"));
    process.env.CASCABEL_SESSION_DIR = join(dir, "sessions");
    // Stand-in child: ignores stdio and dies with code 3 immediately.
    const dieFast: SpawnLike = (_command, _args, options) =>
      spawn(process.execPath, ["-e", "process.exit(3)"], options);
    const startedAt = Date.now();
    try {
      await expect(
        runChild(
          {
            tierSpec: base.tierSpec,
            cwd: dir,
            task: "never runs",
            timeoutMs: 60_000,
            piCommand: process.execPath,
          },
          dieFast,
        ),
      ).rejects.toThrow(/exited before settling.*exit code 3/);
      // The budget is 60s: a prompt failure must not wait for it.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

const tmpFiles: string[] = [];
afterAll(() => {
  for (const f of tmpFiles) rmSync(f, { force: true });
});

describe("nan-provider extension propagation", () => {
  it("resolves an explicit CASCABEL_NAN_PROVIDER_EXT and emits -e with it", () => {
    const fake = join(tmpdir(), `nan-provider-${Date.now()}.ts`);
    writeFileSync(fake, "export default () => {};\n");
    tmpFiles.push(fake);
    const previous = process.env.CASCABEL_NAN_PROVIDER_EXT;
    try {
      process.env.CASCABEL_NAN_PROVIDER_EXT = fake;
      const resolved = resolveNanProviderExtension();
      expect(resolved).toBe(fake);
      expect(childArguments(base)).toEqual(expect.arrayContaining(["-e", fake]));
    } finally {
      if (previous === undefined) delete process.env.CASCABEL_NAN_PROVIDER_EXT;
      else process.env.CASCABEL_NAN_PROVIDER_EXT = previous;
    }
  });

  // Environment-specific: only meaningful where gentle-shell is installed.
  const realInstallExists = existsSync(join(homedir(), ".gentle-shell", "versions"));
  it.runIf(realInstallExists)("resolves the installed gentle-pi nan-provider entrypoint", () => {
    const path = resolveNanProviderExtension();
    expect(path).toBeDefined();
    expect(path).toMatch(/extensions.nan-provider\.ts$/);
  });

  it("omits -e when the extension cannot be resolved", () => {
    const previous = process.env.CASCABEL_NAN_PROVIDER_EXT;
    try {
      process.env.CASCABEL_NAN_PROVIDER_EXT = "/nonexistent/nan-provider.ts";
      expect(resolveNanProviderExtension()).toBeUndefined();
      expect(childArguments(base)).not.toContain("-e");
    } finally {
      if (previous === undefined) delete process.env.CASCABEL_NAN_PROVIDER_EXT;
      else process.env.CASCABEL_NAN_PROVIDER_EXT = previous;
    }
  });

  it("honours CASCABEL_NO_NAN_PROVIDER=1", () => {
    const previous = process.env.CASCABEL_NO_NAN_PROVIDER;
    try {
      process.env.CASCABEL_NO_NAN_PROVIDER = "1";
      expect(resolveNanProviderExtension()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CASCABEL_NO_NAN_PROVIDER;
      else process.env.CASCABEL_NO_NAN_PROVIDER = previous;
    }
  });
});
