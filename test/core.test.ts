import { describe, expect, it } from "vitest";
import {
  defaultRoutings,
  nextTierOnFail,
  resolveTier,
  RoutingError,
  type RoutingsFile,
} from "../src/core";

describe("resolveTier", () => {
  it("routes each difficulty to its own tier", () => {
    const r = defaultRoutings();
    expect(resolveTier(r, "quick").tier).toBe("quick");
    expect(resolveTier(r, "build").tier).toBe("build");
    expect(resolveTier(r, "deep").tier).toBe("deep");
  });

  it("raises quick to build when risk is named", () => {
    const r = defaultRoutings();
    expect(resolveTier(r, "quick", "auth").tier).toBe("build");
    // whitespace-only risk is not a named risk
    expect(resolveTier(r, "quick", "   ").tier).toBe("quick");
  });

  it("never raises an explicitly requested deep tier", () => {
    const r = defaultRoutings();
    expect(resolveTier(r, "deep", "payments").tier).toBe("deep");
  });

  it("rejects unknown difficulty fail-closed", () => {
    const r = defaultRoutings();
    expect(() =>
      resolveTier(r, "cosmic" as never),
    ).toThrowError(RoutingError);
  });
});

describe("nextTierOnFail — capped cascade (S4)", () => {
  it("escalates quick -> build -> deep -> null", () => {
    const r = defaultRoutings();
    expect(nextTierOnFail(r, "quick")?.tier).toBe("build");
    expect(nextTierOnFail(r, "build")?.tier).toBe("deep");
    expect(nextTierOnFail(r, "deep")).toBeNull(); // cap: no step past deep
  });

  it("caps at the plan", () => {
    const r: RoutingsFile = {
      ...defaultRoutings(),
      plan: ["quick", "build"],
    };
    expect(nextTierOnFail(r, "quick")?.tier).toBe("build");
    expect(nextTierOnFail(r, "build")).toBeNull();
  });

  it("rejects a starting tier outside the plan", () => {
    const r: RoutingsFile = {
      ...defaultRoutings(),
      plan: ["build", "deep"],
    };
    expect(() => resolveTier(r, "quick")).toThrowError(/not in the configured plan/);
    // a named risk legitimately starts at build even under this plan
    expect(resolveTier(r, "quick", "auth").tier).toBe("build");
  });

  it("rejects configuration errors clearly", () => {
    const r: RoutingsFile = {
      ...defaultRoutings(),
      escalation: ["quick", "quick"] as never,
    };
    expect(() => nextTierOnFail(r, "quick")).toThrowError(/duplicate/);
    expect(() => resolveTier({ ...defaultRoutings() }, "quick")).not.toThrow();
    const broken: RoutingsFile = {
      tiers: {},
      escalation: ["quick"],
    };
    expect(() => resolveTier(broken, "quick")).toThrowError(
      /tiers\.quick\.model/,
    );
  });

  it("honours a shortened escalation chain", () => {
    const r: RoutingsFile = { ...defaultRoutings(), escalation: ["build", "deep"] };
    expect(nextTierOnFail(r, "build")?.tier).toBe("deep");
    expect(nextTierOnFail(r, "deep")).toBeNull();
  });
});
