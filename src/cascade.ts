// The capped cascade (S4): initial tier from the explorer's difficulty call,
// one retry per tier on a failed verification, then exactly one step up the
// escalation chain. Verdicts come from the child's own final text; a missing
// verdict is a fail (fail-closed). All attempts are logged before returning.
import type { Difficulty, RoutingsFile, TierSpec } from "./core";
import { nextTierOnFail, resolveTier } from "./core";
import type {
  AttemptCost,
  AttemptReceipt,
  AttemptTokens,
  AttemptUsage,
  ReceiptLogger,
} from "./log";
import { extractUsage, formatCost, formatTokens, formatUsageSuffix, sumUsage } from "./log";
import type { ChildRunResult } from "./child";
import { ChildRunError } from "./child";

export interface RouteInput {
  task: string;
  difficulty: Difficulty;
  risk?: string;
  label?: string;
  cwd: string;
  /** Per-attempt budget; defaults to 30 minutes. */
  timeoutMs?: number;
  /** Parent abort signal; aborting fails the whole route immediately. */
  signal?: AbortSignal;
}

export interface AttemptRecord {
  tier: Difficulty;
  attemptNo: number;
  model: string;
  effort: string;
  ok: boolean;
  reason?: string;
  durationMs: number;
  sessionId?: string;
  tokens?: AttemptTokens;
  cost?: AttemptCost;
}

export interface RouteResult {
  ok: boolean;
  /** Final verification verdict reason or the winning output text. */
  text: string;
  attempts: AttemptRecord[];
}

export interface RouteDeps {
  routings: RoutingsFile;
  workerPrompt: string;
  logger: ReceiptLogger;
  runChild: (opts: {
    tierSpec: TierSpec;
    cwd: string;
    task: string;
    systemPrompt?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<ChildRunResult>;
  /** Invoked when each attempt starts, for parent progress feedback. */
  onAttempt?: (info: {
    attempt: number;
    tier: Difficulty;
    model: string;
    effort: string;
  }) => void;
}

export const VERDICT_PREFIX = "cascabel_verdict:";

export function parseVerdict(text: string): VerificationParsed {
  const matches = text.toLowerCase().matchAll(
    new RegExp(`${VERDICT_PREFIX}\\s*(pass|fail)\\b`, "g"),
  );
  let last: { verdict: "pass" | "fail"; index: number } | undefined;
  for (const m of matches) last = { verdict: m[1] as "pass" | "fail", index: m.index ?? 0 };
  if (!last) {
    return { verdict: "fail", reason: "child reported no verdict line" };
  }
  return { verdict: last.verdict };
}

export interface VerificationParsed {
  verdict: "pass" | "fail";
  reason?: string;
}



/** Run the capped cascade for one routed task. */
export async function runRoute(
  input: RouteInput,
  deps: RouteDeps,
): Promise<RouteResult> {
  const start = resolveTier(deps.routings, input.difficulty, input.risk);
  const retries = clampRetries(deps.routings.retriesPerTier ?? 1);

  const attempts: AttemptRecord[] = [];
  let currentTier: Difficulty | null = start.tier;

  while (currentTier) {
    const tier: Difficulty = currentTier;
    if (input.signal?.aborted) {
      return { ok: false, text: "Cascabel: aborted by user.", attempts };
    }
    const spec = deps.routings.tiers[tier];
    // Retry budget for this tier: 1 initial attempt + retries.
    for (let attemptNo = 1; attemptNo <= 1 + retries; attemptNo++) {
      deps.onAttempt?.({
        attempt: attemptNo,
        tier,
        model: spec.model,
        effort: spec.effort,
      });
      const startedAt = Date.now();
      let result: ChildRunResult | undefined;
      let runError: unknown;
      try {
        result = await deps.runChild({
          tierSpec: spec,
          cwd: input.cwd,
          task: enhancedTask(input.task),
          systemPrompt: deps.workerPrompt,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        });
      } catch (err) {
        runError = err;
      }
      const durationMs = Date.now() - startedAt;

      if (result) {
        const verification = parseVerdict(result.text);
        // Telemetry is best-effort (S8): extract what the child reported and
        // leave everything else absent rather than zero-filled.
        attempts.push({
          tier,
          attemptNo,
          model: spec.model,
          effort: spec.effort,
          ok: verification.verdict === "pass",
          reason: verification.reason,
          durationMs,
          sessionId: result.sessionId,
          ...extractUsage(result.stats),
        });
        deps.logger.record(receipt(input, attempts.at(-1)!, spec));
        if (verification.verdict === "pass") {
          return { ok: true, text: trimmedText(result.text), attempts };
        }
      } else {
        attempts.push({
          tier,
          attemptNo,
          model: spec.model,
          effort: spec.effort,
          ok: false,
          reason: runErrorText(runError),
          durationMs,
        });
        deps.logger.record(receipt(input, attempts.at(-1)!, spec));
        // Crashed or timed-out children consume this tier's retry too:
        // an infrastructure miss is still a miss.
      }
    }

    currentTier = nextTierOnFail(deps.routings, tier)?.tier ?? null;
  }

  return {
    ok: false,
    text: failSummary(input, attempts),
    attempts,
  };
}

function enhancedTask(task: string): string {
  return [
    task,
    "",
    "## Cascabel verification contract",
    `- Run every applicable check yourself (tests, types, lint) before finishing.`,
    `- End your final message with exactly one line: ${VERDICT_PREFIX} pass or ${VERDICT_PREFIX} fail.`,
    `- A missing verdict line counts as fail. Do not claim pass without executed checks.`,
  ].join("\n");
}

function trimmedText(text: string): string {
  return text.trimEnd();
}

function clampRetries(n: number): number {
  return Math.max(0, Math.min(3, Math.floor(n)));
}

function runErrorText(err: unknown): string {
  if (err instanceof ChildRunError) {
    const detail = err.detail?.stderr ? `; stderr: …${err.detail.stderr.slice(-600)}` : "";
    return `${err.message}${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function receipt(
  input: RouteInput,
  attempt: AttemptRecord,
  spec: TierSpec,
): AttemptReceipt {
  return {
    timestamp: new Date().toISOString(),
    label: input.label,
    difficulty: input.difficulty,
    risk: input.risk,
    tier: attempt.tier,
    attempt: attempt.attemptNo,
    model: spec.model,
    effort: spec.effort,
    ok: attempt.ok,
    reason: attempt.reason,
    durationMs: attempt.durationMs,
    sessionId: attempt.sessionId,
    cwd: input.cwd,
    ...(attempt.tokens ? { tokens: attempt.tokens } : {}),
    ...(attempt.cost ? { cost: attempt.cost } : {}),
  };
}

function withTelemetry(prefix: string, attempt: AttemptUsage): string {
  const suffix = formatUsageSuffix(attempt);
  return suffix ? `${prefix}, ${suffix}` : prefix;
}

/** One attempt as the parent model sees it in the result header. */
export function attemptLine(attempt: AttemptRecord): string {
  const timing = withTelemetry(
    `${(attempt.durationMs / 1000).toFixed(1)}s`,
    attempt,
  );
  return `- [${attempt.tier} #${attempt.attemptNo}] ${attempt.model}@${attempt.effort} → ${
    attempt.ok ? "pass" : "fail"
  } (${timing})${attempt.reason ? ` — ${attempt.reason}` : ""}`;
}

/**
 * Run-level totals. Emitted only when at least one attempt reported cost
 * (S8): token-only data does not fabricate a money figure.
 */
export function totalsLine(attempts: AttemptRecord[]): string | undefined {
  const totals = sumUsage(attempts);
  if (totals.costTotal === undefined) return undefined;
  const parts = [`${attempts.length} attempt(s)`];
  const tokens = formatTokens(
    totals.tokensTotal !== undefined ? { total: totals.tokensTotal } : undefined,
  );
  if (tokens) parts.push(tokens);
  const cost = formatCost({
    total: totals.costTotal,
    ...(totals.currency ? { currency: totals.currency } : {}),
  });
  if (cost) parts.push(cost);
  return `Total: ${parts.join(", ")}`;
}

function failSummary(input: RouteInput, attempts: AttemptRecord[]): string {
  const lines = [
    `Cascabel FAIL after ${attempts.length} attempt(s); cascade cap reached (S4). Diagnosis for the human:`,
  ];
  for (const a of attempts) {
    lines.push(
      `- [${a.tier} #${a.attemptNo}] ${a.model}@${a.effort}: FAIL${a.reason ? ` — ${a.reason}` : ""} (${withTelemetry(`${a.durationMs}ms`, a)})`,
    );
  }
  lines.push(
    `Next step: read the attempt receipts under ~/.pi/cascabel/logs/attempts.jsonl and decide whether to adjust routings.json, retry with a different tier, or escalate by hand.`,
  );
  return lines.join("\n");
}
