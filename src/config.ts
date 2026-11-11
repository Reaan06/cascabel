// Loads and validates routings.json. Fail-closed (S6): any missing or invalid
// entry is a hard error — Cascabel never guesses a model.
import { readFileSync } from "node:fs";
import type { Difficulty, RoutingsFile } from "./core.js";
import { defaultRoutings, DIFFICULTIES, RoutingError } from "./core.js";

export const EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type Effort = (typeof EFFORTS)[number];

export function routingsPath(override?: string): string {
  if (override) return override;
  const env = process.env.CASCABEL_ROUTINGS;
  if (env) return env;
  return `${process.env.HOME ?? ""}/.pi/cascabel/routings.json`;
}

/** Load user config over shipped defaults; a missing file is the defaults. */
export function loadRoutings(path?: string): RoutingsFile {
  const file = routingsPath(path);
  let raw: unknown = undefined;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultRoutings();
    }
    throw new RoutingError(`cannot read ${file}: ${(err as Error).message}`);
  }
  return validateAgainstDefaults(raw, file);
}

function validateAgainstDefaults(raw: unknown, file: string): RoutingsFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RoutingError(`${file}: expected a JSON object`);
  }
  const input = raw as Partial<RoutingsFile>;
  const out = defaultRoutings();

  if (input.tiers !== undefined) {
    for (const tier of DIFFICULTIES) {
      const spec = (input.tiers as Record<string, unknown>)[tier];
      if (spec === undefined) continue; // default stays
      out.tiers[tier as Difficulty] = validateTierSpec(spec, file, `tiers.${tier}`);
    }
  }
  if (input.escalation !== undefined) {
    validateStringArray(input.escalation, file, "escalation");
    out.escalation = input.escalation as Difficulty[];
  }
  if (input.plan !== undefined) {
    validateStringArray(input.plan, file, "plan");
    out.plan = input.plan as Difficulty[];
  }
  // Fail-closed pass: every tier must resolve after merge.
  for (const tier of DIFFICULTIES) {
    if (!out.tiers[tier]?.model) {
      throw new RoutingError(
        `${file}: tiers.${tier}.model missing after merge; add it or remove [${tier}] from escalation`,
      );
    }
  }
  return out;
}

function validateTierSpec(
  spec: unknown,
  file: string,
  where: string,
): RoutingsFile["tiers"][Difficulty] {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new RoutingError(`${file}: ${where} must be an object`);
  }
  const s = spec as Record<string, unknown>;
  if (typeof s.model !== "string" || s.model.trim().length === 0) {
    throw new RoutingError(`${file}: ${where}.model must be a non-empty string`);
  }
  if (
    typeof s.effort !== "string" ||
    !EFFORTS.includes(s.effort as Effort)
  ) {
    throw new RoutingError(
      `${file}: ${where}.effort must be one of ${EFFORTS.join(", ")}`,
    );
  }
  const out: RoutingsFile["tiers"][Difficulty] = {
    model: s.model,
    effort: s.effort as Effort,
  };
  if (s.approval === "auto" || s.approval === "reject" || s.approval === "ask") {
    out.approval = s.approval;
  }
  if (typeof s.description === "string") out.description = s.description;
  return out;
}

function validateStringArray(
  value: unknown,
  file: string,
  where: string,
): void {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !(DIFFICULTIES as readonly string[]).includes(v))
  ) {
    throw new RoutingError(
      `${file}: ${where} must be an array of ${DIFFICULTIES.join(", ")}`,
    );
  }
}
