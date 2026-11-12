// Attempt receipts and miss logs (S6, S7). Everything Cascabel spawns leaves
// one JSONL line on disk. This is the raw material that later turns misses
// into routing rules ("log every miss and turn it into a rule").
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AttemptTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

export interface AttemptCost {
  total?: number;
  currency?: string;
}

/** Tokens/cost reported by the child session (S8); absent stays absent. */
export interface AttemptUsage {
  tokens?: AttemptTokens;
  cost?: AttemptCost;
}

export interface AttemptReceipt {
  timestamp: string; // ISO 8601
  label?: string;
  difficulty: string;
  risk?: string;
  tier: string;
  attempt: number;
  model: string;
  effort: string;
  ok: boolean;
  reason?: string;
  durationMs: number;
  sessionId?: string;
  cwd: string;
  tokens?: AttemptTokens;
  cost?: AttemptCost;
}

export function logDir(override?: string): string {
  if (override) return override;
  const env = process.env.CASCABEL_LOG_DIR;
  if (env) return env;
  return join(homedir(), ".pi", "cascabel", "logs");
}

/** Discardable logger: CASCABEL_LOG_DISABLE=1 turns all writes into no-ops. */
export interface ReceiptLogger {
  record(receipt: AttemptReceipt): void;
}

export function fileLogger(dir?: string): ReceiptLogger {
  const target = logDir(dir);
  if (process.env.CASCABEL_LOG_DISABLE === "1") {
    return { record: () => undefined };
  }
  return {
    record(receipt: AttemptReceipt): void {
      mkdirSync(target, { recursive: true });
      appendFileSync(
        join(target, "attempts.jsonl"),
        `${JSON.stringify(receipt)}\n`,
        { encoding: "utf8" },
      );
    },
  };
}

export const nullLogger: ReceiptLogger = { record: () => undefined };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only finite, non-negative numbers count as telemetry (S8: never invent). */
function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

const TOKEN_ALIASES: Record<keyof AttemptTokens, readonly string[]> = {
  input: ["input", "inputTokens", "input_tokens"],
  output: ["output", "outputTokens", "output_tokens"],
  cacheRead: ["cacheRead", "cache_read", "cacheReadTokens", "cache_read_input_tokens"],
  cacheWrite: ["cacheWrite", "cache_write", "cacheWriteTokens", "cache_creation_input_tokens"],
  total: ["total", "totalTokens", "total_tokens"],
};

function tokensFrom(source: JsonRecord): AttemptTokens | undefined {
  const tokens: AttemptTokens = {};
  let found = false;
  for (const key of Object.keys(TOKEN_ALIASES) as Array<keyof AttemptTokens>) {
    for (const alias of TOKEN_ALIASES[key]) {
      const value = amount(source[alias]);
      if (value !== undefined) {
        tokens[key] = value;
        found = true;
        break;
      }
    }
  }
  return found ? tokens : undefined;
}

function costFrom(value: unknown): AttemptCost | undefined {
  const direct = amount(value);
  if (direct !== undefined) return { total: direct };
  if (!isRecord(value)) return undefined;
  const total =
    amount(value.total) ?? amount(value.totalCost) ?? amount(value.cost);
  if (total === undefined) return undefined; // currency alone is not a cost
  const currency =
    typeof value.currency === "string" && value.currency.trim().length > 0
      ? value.currency.trim()
      : undefined;
  return currency ? { total, currency } : { total };
}

/**
 * Defensive extractor for `get_session_stats` payloads (S8). Shapes vary by
 * version and provider, so every field is optional and only real numbers are
 * copied. A missing or unreadable payload yields `{}` — never zero-filled
 * telemetry that would fake a free run.
 */
export function extractUsage(stats: unknown): AttemptUsage {
  if (!isRecord(stats)) return {};
  const data = isRecord(stats.data) ? stats.data : undefined;
  const usage = isRecord(stats.usage) ? stats.usage : undefined;

  const tokenSources: JsonRecord[] = [];
  for (const container of [stats, data, usage]) {
    if (!container) continue;
    if (isRecord(container.tokens)) tokenSources.push(container.tokens);
  }
  tokenSources.push(stats);
  if (data) tokenSources.push(data);
  if (usage) tokenSources.push(usage);

  let tokens: AttemptTokens | undefined;
  for (const source of tokenSources) {
    tokens = tokensFrom(source);
    if (tokens) break;
  }

  let cost: AttemptCost | undefined;
  for (const candidate of [
    stats.cost,
    usage?.cost,
    data?.cost,
    stats.totalCost,
    usage?.totalCost,
    data?.totalCost,
  ]) {
    cost = costFrom(candidate);
    if (cost) break;
  }
  if (cost && !cost.currency) {
    const currency =
      typeof stats.currency === "string" && stats.currency.trim().length > 0
        ? stats.currency.trim()
        : undefined;
    if (currency) cost = { ...cost, currency };
  }

  return {
    ...(tokens ? { tokens } : {}),
    ...(cost ? { cost } : {}),
  };
}

function tokenTotal(tokens?: AttemptTokens): number | undefined {
  if (!tokens) return undefined;
  if (tokens.total !== undefined) return tokens.total;
  const parts = [tokens.input, tokens.output].filter(
    (n): n is number => n !== undefined,
  );
  if (parts.length === 0) return undefined;
  return parts.reduce((sum, n) => sum + n, 0);
}

/** Compact token count for result headers, e.g. `12.3k tok`. */
export function formatTokens(tokens?: AttemptTokens): string | undefined {
  const total = tokenTotal(tokens);
  if (total === undefined) return undefined;
  const rounded = Math.round(total);
  if (rounded < 1000) return `${rounded} tok`;
  if (rounded < 1_000_000) {
    return `${trimZero((rounded / 1000).toFixed(1))}k tok`;
  }
  return `${trimZero((rounded / 1_000_000).toFixed(1))}M tok`;
}

function trimZero(fixed: string): string {
  return fixed.replace(/\.0$/, "");
}

/** Display cost for result headers, e.g. `$0.0042`. */
export function formatCost(cost?: AttemptCost): string | undefined {
  if (!cost || cost.total === undefined) return undefined;
  const digits = cost.total < 0.01 ? 4 : 2;
  const prefix =
    cost.currency && cost.currency.toUpperCase() !== "USD"
      ? `${cost.currency} `
      : "$";
  return `${prefix}${cost.total.toFixed(digits)}`;
}

/** `12.3k tok, $0.0042` — the telemetry part of an attempt line. */
export function formatUsageSuffix(usage: AttemptUsage): string | undefined {
  const parts = [formatTokens(usage.tokens), formatCost(usage.cost)].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

export interface UsageTotals {
  tokensTotal?: number;
  costTotal?: number;
  currency?: string;
}

/** Sum only values that were actually reported; unknown totals stay unknown. */
export function sumUsage(
  items: ReadonlyArray<AttemptUsage>,
): UsageTotals {
  let tokensTotal: number | undefined;
  let costTotal: number | undefined;
  let currency: string | undefined;
  for (const item of items) {
    const tokens = tokenTotal(item.tokens);
    if (tokens !== undefined) tokensTotal = (tokensTotal ?? 0) + tokens;
    if (item.cost?.total !== undefined) {
      costTotal = (costTotal ?? 0) + item.cost.total;
      currency ??= item.cost.currency;
    }
  }
  return {
    ...(tokensTotal !== undefined ? { tokensTotal } : {}),
    ...(costTotal !== undefined ? { costTotal } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
}
