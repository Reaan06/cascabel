import { describe, expect, it } from "vitest";
import { childArguments, ChildRunOptions, ChildRunError } from "../src/child.js";
import { defaultRoutings, type TierSpec } from "../src/core.js";

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
    const allowed = new Set(["--mode", "rpc", "--model", "--thinking", "--append-system-prompt"]);
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
