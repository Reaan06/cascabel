// Cascabel routing core — pure functions, no I/O. Fail-closed per spec S6:
// an unmatched task is an error, never a guess.
export type Difficulty = "quick" | "build" | "deep";
export type VerificationOutcome = "pass" | "fail";

export interface TierSpec {
  /** Provider/model id accepted by `pi --model <pattern>`. */
  model: string;
  /** Thinking level accepted by `pi --thinking <level>`. */
  effort:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  /** Tool approval for the headless child session: default `auto` (RPC children
   * cannot answer prompts); `reject` pins a read-only probe. */
  approval?: "auto" | "reject";
  /** Description surfaced in the receipt. */
  description?: string;
}

export interface RoutingsFile {
  tiers: Record<Difficulty, TierSpec>;
  /** Ordered escalation chain, e.g. ["quick", "build", "deep"]. */
  escalation: Difficulty[];
  /** Hard ceiling per run: tiers this task may ever try. */
  plan?: Difficulty[];
  /** Check-failed retries allowed within one tier before stepping up (S4).
   * The approved cap was "one retry per tier"; keep 0 for strict cascades. */
  retriesPerTier?: number;
}

export function defaultRoutings(): RoutingsFile {
  return {
    tiers: {
      quick: {
        model: "cli-proxy-api/gemini-3.8-flash-high",
        effort: "medium",
        description: "Docs, small edits, renames, low-risk writes",
      },
      build: {
        // Effort-first escalation (playbook rule 1): same proven model, higher
        // thinking, before a model switch. The previous nan/deepseek-v4-flash
        // tier does not resolve in headless children (nan provider comes from
        // a TUI-side bridge extension); restore it only when its catalog
        // resolves via get_available_models in `pi --mode rpc`.
        model: "cli-proxy-api/gemini-3.8-flash-high",
        effort: "high",
        description: "Default behavior work with tests",
      },
      deep: {
        model: "cli-proxy-api/gpt-5.6-sol",
        effort: "high",
        description: "High-risk items and post-failure escalation only",
      },
    },
    escalation: ["quick", "build", "deep"],
  };
}

export interface TierResolution {
  tier: Difficulty;
  spec: TierSpec;
}

/** Difficulty tiers valid as input values. */
export const DIFFICULTIES: readonly Difficulty[] = [
  "quick",
  "build",
  "deep",
];

export class RoutingError extends Error {}

/**
 * Resolve the starting tier for a task. `risk` is a free-form label from the
 * parent; a non-empty risk value never routes below the caller's stated
 * difficulty (fail-safe: risk widens, never shrinks).
 */
export function resolveTier(
  routings: RoutingsFile,
  difficulty: Difficulty,
  risk?: string,
): TierResolution {
  const restricted = restrictForRisk(routings, difficulty, risk);
  return pickTierAtOrAbove(routings, restricted);
}

/**
 * Map (difficulty, risk) to the lowest starting tier the policy allows.
 *
 * - Unknown difficulty values are rejected (fail-closed).
 * - A named risk never starts below `build`: the user's risk taxonomy treats
 *   risky work as at least default-tier work (S2b: false passes are costly).
 */
function restrictForRisk(
  routings: RoutingsFile,
  difficulty: Difficulty,
  risk?: string,
): Difficulty {
  if (!DIFFICULTIES.includes(difficulty)) {
    throw new RoutingError(
      `unknown difficulty "${String(difficulty)}"; expected one of ${DIFFICULTIES.join(", ")}`,
    );
  }
  const hasRisk = typeof risk === "string" && risk.trim().length > 0;
  if (hasRisk && difficulty === "quick") return "build";
  return difficulty;
}

function pickTierAtOrAbove(
  routings: RoutingsFile,
  wanted: Difficulty,
): TierResolution {
  const chain = escalatableChain(routings, wanted);
  return lookUpTierSpec(routings, chain[0], `starting tier for "${wanted}"`);
}

/** Tier the next attempt should use after `current` failed verification. */
export function nextTierOnFail(
  routings: RoutingsFile,
  current: Difficulty,
): TierResolution | null {
  const chain = escalatableChain(routings, current);
  if (chain.length < 2) return null; // capped: current is the last allowed tier
  return lookUpTierSpec(routings, chain[1], `escalation from "${current}"`);
}

/**
 * The escalation chain starting at `wanted`: config `escalation` order, cut
 * at the requested tier. If `plan` is present it is authoritative and the
 * chain is cut to tiers the plan permits.
 */
function escalatableChain(
  routings: RoutingsFile,
  wanted: Difficulty,
): Difficulty[] {
  const base = validateEscalation(routings);
  let chain = base.slice(base.indexOf(wanted));
  if (routings.plan?.length) {
    const plan = routings.plan.filter((t) => DIFFICULTIES.includes(t));
    if (!plan.includes(wanted)) {
      throw new RoutingError(
        `difficulty "${wanted}" is not in the configured plan [${plan.join(", ")}]`,
      );
    }
    chain = chain.filter((t) => plan.includes(t));
  }
  if (chain.length === 0) {
    throw new RoutingError(
      `tier "${wanted}" resolves to an empty escalation chain`,
    );
  }
  return chain;
}

function validateEscalation(routings: RoutingsFile): Difficulty[] {
  const esc = routings.escalation?.length ? routings.escalation : DIFFICULTIES;
  for (const t of esc) {
    if (!DIFFICULTIES.includes(t)) {
      throw new RoutingError(
        `escalation chain contains unknown tier "${String(t)}"`,
      );
    }
  }
  const seen = new Set(esc);
  if (seen.size !== esc.length) {
    throw new RoutingError("escalation chain contains duplicate tiers");
  }
  return esc as Difficulty[];
}

function lookUpTierSpec(
  routings: RoutingsFile,
  tier: Difficulty,
  what: string,
): TierResolution {
  const spec = routings.tiers?.[tier];
  if (!spec?.model) {
    throw new RoutingError(
      `cannot resolve ${what}: tiers.${tier}.model is missing in routings.json`,
    );
  }
  return { tier, spec };
}
