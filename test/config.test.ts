import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRoutings, routingsPath } from "../src/config";
import { RoutingError } from "../src/core";
import { defaultRoutings } from "../src/core";

const sandbox = mkdtempSync(join(tmpdir(), "cascabel-test-"));
const sandboxPath = join(sandbox, "routings.json");

afterEach(() => {
  try {
    // keep each case isolated without cross-test keying
  } catch {
    /* noop */
  }
});

function writeConfig(content: unknown): string {
  writeFileSync(
    sandboxPath,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
  return sandboxPath;
}

describe("loadRoutings — fail-closed config (S6)", () => {
  it("falls back to defaults when the file is absent", () => {
    const loaded = loadRoutings(join(sandbox, "missing.json"));
    expect(loaded.tiers.quick.model).toBe(
      "cli-proxy-api/gemini-3.8-flash-high",
    );
  });

  it("merges user overrides over shipped defaults", () => {
    const loaded = loadRoutings(
      writeConfig({
        tiers: {
          quick: { model: "custom/cheap", effort: "low" },
        },
      }),
    );
    expect(loaded.tiers.quick.model).toBe("custom/cheap");
    // untouched tiers keep defaults
    expect(loaded.tiers.build.model).toBe("nan/deepseek-v4-flash");
    expect(loaded.tiers.deep.effort).toBe("max");
  });

  it("rejects a tier with a bad effort", () => {
    expect(() =>
      loadRoutings(
        writeConfig({
          tiers: { quick: { model: "x/y", effort: "cosmic" } },
        }),
      ),
    ).toThrowError(RoutingError);
  });

  it("rejects a tier model that is not a string", () => {
    expect(() =>
      loadRoutings(
        writeConfig({ tiers: { quick: { model: 42, effort: "low" } } }),
      ),
    ).toThrowError(/model must be a non-empty string/);
  });

  it("rejects an escalation chain with unknown tiers", () => {
    expect(() =>
      loadRoutings(writeConfig({ escalation: ["quick", "apex"] })),
    ).toThrowError(/escalation must be an array of quick, build, deep/);
  });

  it("rejects a plan with unknown tiers", () => {
    expect(() => loadRoutings(writeConfig({ plan: ["wat"] }))).toThrowError(
      /must be an array/,
    );
  });

  it("rejects malformed JSON with the file path", () => {
    expect(() => loadRoutings(writeConfig("{nope")).toThrowError(
      /cannot read/,
    ));
  });

  it("rejects non-object JSON", () => {
    expect(() => loadRoutings(writeConfig("[]"))).toThrowError(/JSON object/);
  });

  it("rejects primitive tiers", () => {
    expect(() =>
      loadRoutings(writeConfig({ tiers: { quick: "fast" } })),
    ).toThrowError(/must be an object/);
  });
});

describe("routingsPath", () => {
  it("prefers the explicit argument, then CASCABEL_ROUTINGS", () => {
    const previous = process.env.CASCABEL_ROUTINGS;
    try {
      process.env.CASCABEL_ROUTINGS = "/tmp/from-env.json";
      expect(routingsPath()).toBe("/tmp/from-env.json");
      expect(routingsPath("/tmp/explicit.json")).toBe("/tmp/explicit.json");
    } finally {
      if (previous === undefined) delete process.env.CASCABEL_ROUTINGS;
      else process.env.CASCABEL_ROUTINGS = previous;
    }
  });

  it("defaults under ~/.pi/cascabel", () => {
    const previous = process.env.CASCABEL_ROUTINGS;
    try {
      delete process.env.CASCABEL_ROUTINGS;
      expect(routingsPath()).toContain("/.pi/cascabel/routings.json");
    } finally {
      if (previous !== undefined) process.env.CASCABEL_ROUTINGS = previous;
    }
  });
});

describe("shipped defaults (S5)", () => {
  it("matches the agreed tier alignment", () => {
    const d = defaultRoutings();
    expect(d.tiers.quick).toMatchObject({
      model: "cli-proxy-api/gemini-3.8-flash-high",
      effort: "medium",
    });
    expect(d.tiers.build).toMatchObject({
      model: "nan/deepseek-v4-flash",
      effort: "high",
    });
    expect(d.tiers.deep).toMatchObject({
      model: "nan/glm5.3",
      effort: "max",
    });
    expect(d.escalation).toEqual(["quick", "build", "deep"]);
  });
});
