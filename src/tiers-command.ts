// /cascabel:tiers — inspect and edit the model/effort ladder (S9).
//
// Headless-safe by construction: args mode (`show`, `stats`,
// `set <tier> <model> <effort>`) never touches ctx.ui, and interactive mode
// guards every UI call so an RPC/print session falls back to the help text
// instead of crashing. Writes go through the same fail-closed path in both
// modes: rewrite the raw file, re-validate with loadRoutings, restore on error.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DIFFICULTIES,
  defaultRoutings,
  type Difficulty,
  type RoutingsFile,
  type TierSpec,
} from "./core";
import { EFFORTS, loadRoutings, routingsPath } from "./config";
import { formatCost, logDir, type AttemptReceipt } from "./log";

export interface TiersUi {
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  input?: (title: string, initial?: string) => Promise<string | undefined>;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
}

export interface TiersCommandDeps {
  routingsFile?: string;
  receiptsDir?: string;
}

export interface SetTierOutcome {
  ok: boolean;
  file: string;
  tier: Difficulty;
  spec?: TierSpec;
  error?: string;
  /** True when the file was written and then rolled back by validation. */
  reverted?: boolean;
}

export interface TierReceiptStats {
  attempts: number;
  passes: number;
  costs: number[];
  escalations: number;
}

export type ReceiptStats = Record<Difficulty, TierReceiptStats>;

export const GOLDEN_RULES = [
  "Golden rules",
  "  1. Difficulty comes from exploration — Cascabel never guesses it.",
  "  2. A named risk never routes below build.",
  "  3. The cap is the feature: one retry per tier, one step up (quick→build→deep).",
].join("\n");

/**
 * Read the receipt log, skipping any line that is not a usable receipt
 * (invalid JSON, unknown tier, non-object). Never throws: a missing log is
 * simply no receipts.
 */
export function readReceipts(file: string): AttemptReceipt[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const receipts: AttemptReceipt[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) continue;
      const tier = parsed.tier;
      if (typeof tier !== "string" || !isDifficulty(tier)) continue;
      receipts.push(parsed as unknown as AttemptReceipt);
    } catch {
      // Malformed line: skip it, keep the rest of the log usable.
    }
  }
  return receipts;
}

/** Aggregate receipts per tier: attempts, passes, known costs, escalations. */
export function receiptStats(receipts: AttemptReceipt[]): ReceiptStats {
  const stats = blankStats();
  for (const receipt of receipts) {
    const tierName = receipt.tier;
    if (!isDifficulty(tierName)) continue;
    const tier = stats[tierName];
    tier.attempts += 1;
    if (receipt.ok === true) tier.passes += 1;
    const cost = receiptCost(receipt);
    if (cost !== undefined) tier.costs.push(cost);
    // Without a run id, an escalation is a receipt that ran above the
    // requested difficulty (cascade step-up or named-risk widening).
    if (isDifficulty(receipt.difficulty) && receipt.difficulty !== tierName) {
      tier.escalations += 1;
    }
  }
  return stats;
}

/**
 * Rewrite one tier in the raw routings file, then re-validate it through the
 * normal loader. Any validation error restores the previous bytes (or the
 * absence of the file) and is returned for the caller to print.
 */
export function setTierInFile(opts: {
  file: string;
  tier: Difficulty;
  model: string;
  effort: string;
}): SetTierOutcome {
  const { file, tier } = opts;
  let previous: string | undefined;
  try {
    previous = readIfExists(file);
  } catch (err) {
    return {
      ok: false,
      file,
      tier,
      error: `cannot read ${file}: ${(err as Error).message}`,
    };
  }

  let doc: Record<string, unknown>;
  if (previous === undefined) {
    doc = defaultRoutings() as unknown as Record<string, unknown>;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(previous);
    } catch (err) {
      return {
        ok: false,
        file,
        tier,
        error: `cannot read ${file}: ${(err as Error).message}`,
      };
    }
    if (!isRecord(parsed)) {
      return { ok: false, file, tier, error: `${file}: expected a JSON object` };
    }
    doc = parsed;
  }

  if (doc.tiers !== undefined && !isRecord(doc.tiers)) {
    return { ok: false, file, tier, error: `${file}: tiers must be an object` };
  }
  const tiers: Record<string, unknown> = isRecord(doc.tiers) ? doc.tiers : {};
  const current = tiers[tier];
  if (current !== undefined && !isRecord(current)) {
    return {
      ok: false,
      file,
      tier,
      error: `${file}: tiers.${tier} must be an object`,
    };
  }
  tiers[tier] = {
    ...(isRecord(current) ? current : {}),
    model: opts.model,
    effort: opts.effort,
  };
  doc.tiers = tiers;

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  } catch (err) {
    restoreFile(file, previous);
    return {
      ok: false,
      file,
      tier,
      error: `cannot write ${file}: ${(err as Error).message}`,
      reverted: true,
    };
  }

  try {
    const loaded = loadRoutings(file);
    return { ok: true, file, tier, spec: loaded.tiers[tier] };
  } catch (err) {
    restoreFile(file, previous);
    return { ok: false, file, tier, error: (err as Error).message, reverted: true };
  }
}

export async function runTiersCommand(
  args: string,
  ui?: TiersUi,
  deps: TiersCommandDeps = {},
): Promise<string> {
  const routingsFile = deps.routingsFile ?? routingsPath();
  const receiptsFile = join(deps.receiptsDir ?? logDir(), "attempts.jsonl");
  const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

  switch (subcommand) {
    case "stats":
      return withRules(renderStats(receiptsFile));
    case "set":
      return withRules(handleSet(rest, routingsFile, receiptsFile));
    case "help":
      return withRules(helpText(routingsFile, receiptsFile));
    case "show":
      return withRules(renderShow(routingsFile, receiptsFile));
    case undefined:
      return interactiveOrShow(ui, routingsFile, receiptsFile);
    default:
      return withRules(
        `Cascabel tiers: unknown command "${subcommand}".\n\n${helpText(routingsFile, receiptsFile)}`,
      );
  }
}

function interactiveOrShow(
  ui: TiersUi | undefined,
  routingsFile: string,
  receiptsFile: string,
): Promise<string> | string {
  if (!ui?.select || !ui.input) {
    // Headless: `show` is the documented default.
    return withRules(renderShow(routingsFile, receiptsFile));
  }
  return runInteractive(ui, routingsFile, receiptsFile);
}

async function runInteractive(
  ui: TiersUi,
  routingsFile: string,
  receiptsFile: string,
): Promise<string> {
  let routings: RoutingsFile;
  try {
    routings = loadRoutings(routingsFile);
  } catch (err) {
    return withRules(
      `Cascabel tiers: ${(err as Error).message}\n\nFix ${routingsFile} first, or use /cascabel:tiers show.`,
    );
  }

  const chain = chainTiers(routings);
  const options = chain.map((tier) => {
    const spec = routings.tiers[tier];
    return `${tier} — ${spec.model}@${spec.effort}`;
  });

  try {
    const selected = await ui.select!("Cascabel: choose a tier to edit", options);
    if (!selected) return withRules("Cascabel tiers: cancelled; nothing changed.");
    const index = options.indexOf(selected);
    const tier =
      index >= 0
        ? chain[index]
        : chain.find((candidate) => selected.startsWith(`${candidate} `));
    if (!tier) return withRules(`Cascabel tiers: cancelled; unknown selection "${selected}".`);

    const model = (
      await ui.input!(
        `Model for ${tier} (provider/model)`,
        routings.tiers[tier].model,
      )
    )?.trim();
    if (!model) return withRules("Cascabel tiers: cancelled; nothing changed.");

    const effort = await ui.select!(`Effort for ${tier}`, [...EFFORTS]);
    if (!effort) return withRules("Cascabel tiers: cancelled; nothing changed.");

    return withRules(applyTier(routingsFile, tier, model, effort));
  } catch (err) {
    // Headless hosts reject dialogs: fall back to the args-mode help text.
    return withRules(
      `Cascabel tiers: ${(err as Error).message}\n\n${helpText(routingsFile, receiptsFile)}`,
    );
  }
}

function handleSet(
  parts: string[],
  routingsFile: string,
  receiptsFile: string,
): string {
  const [tier, model, effort] = parts;
  const usage = helpText(routingsFile, receiptsFile);
  if (!tier || !model || !effort || parts.length !== 3) {
    return `${usage}`;
  }
  if (!isDifficulty(tier)) {
    return `Cascabel tiers: unknown tier "${tier}"; expected ${DIFFICULTIES.join(", ")}.\n\n${usage}`;
  }
  return applyTier(routingsFile, tier, model.trim(), effort.trim());
}

function applyTier(
  file: string,
  tier: Difficulty,
  model: string,
  effort: string,
): string {
  const outcome = setTierInFile({ file, tier, model, effort });
  if (outcome.ok && outcome.spec) {
    return `Cascabel tiers: updated ${tier} → ${outcome.spec.model}@${outcome.spec.effort} (validated: ${file})`;
  }
  const restored = outcome.reverted
    ? `\nPrevious content of ${file} restored (fail-closed).`
    : "";
  return `Cascabel tiers: could not apply "${tier}": ${outcome.error}${restored}`;
}

function renderShow(routingsFile: string, receiptsFile: string): string {
  let routings: RoutingsFile;
  try {
    routings = loadRoutings(routingsFile);
  } catch (err) {
    return `${renderStats(receiptsFile)}\n\nCascabel tiers: ${(err as Error).message}\nFix ${routingsFile} before editing tiers.`;
  }

  const ladder = DIFFICULTIES.map((tier) => {
    const spec = routings.tiers[tier];
    return { tier, label: `${spec.model}@${spec.effort}`, spec };
  });
  const labelWidth = Math.max(...ladder.map((row) => row.label.length));
  const lines = [`Cascabel tier ladder — ${routingsFile}`];
  for (const row of ladder) {
    const description = row.spec.description ? `  ${row.spec.description}` : "";
    lines.push(`  ${row.tier.padEnd(6)} ${row.label.padEnd(labelWidth)}${description}`.trimEnd());
  }
  lines.push(
    `  escalation: ${routings.escalation.join(" → ")} · retriesPerTier: ${routings.retriesPerTier ?? 0}`,
  );
  lines.push(`  edit: /cascabel:tiers set <tier> <provider/model> <effort>`);
  return `${lines.join("\n")}\n\n${renderStats(receiptsFile)}`;
}

function renderStats(receiptsFile: string): string {
  const receipts = readReceipts(receiptsFile);
  const stats = receiptStats(receipts);
  const lines = [`Receipts — ${receiptsFile}`];
  if (receipts.length === 0) {
    lines.push("  (no receipts yet)");
    return lines.join("\n");
  }
  lines.push(
    `  ${"tier".padEnd(6)}  ${"attempts".padStart(8)}  ${"pass rate".padStart(9)}  ${"avg cost".padStart(9)}  ${"escalations".padStart(11)}`,
  );
  for (const tier of DIFFICULTIES) {
    const row = stats[tier];
    const passRate =
      row.attempts === 0
        ? "—"
        : `${Math.round((row.passes / row.attempts) * 100)}%`;
    const average =
      row.costs.length === 0
        ? "n/a"
        : (formatCost({
            total: row.costs.reduce((sum, cost) => sum + cost, 0) /
              row.costs.length,
          }) ?? "n/a");
    lines.push(
      `  ${tier.padEnd(6)}  ${String(row.attempts).padStart(8)}  ${passRate.padStart(9)}  ${average.padStart(9)}  ${String(row.escalations).padStart(11)}`,
    );
  }
  lines.push("  escalations = attempts that ran above the requested difficulty");
  return lines.join("\n");
}

function helpText(routingsFile: string, receiptsFile: string): string {
  return [
    "Cascabel tiers — model + effort per difficulty tier.",
    "",
    "Usage:",
    "  /cascabel:tiers                       interactive picker (when a TUI is available)",
    "  /cascabel:tiers show                  ladder, routings path and per-tier receipt stats",
    "  /cascabel:tiers stats                 receipt stats table only",
    "  /cascabel:tiers set <tier> <provider/model> <effort>",
    "                                        rewrite one tier, re-validate, revert on error",
    "",
    `  tiers: ${DIFFICULTIES.join(" | ")}`,
    `  effort: ${EFFORTS.join(" | ")}`,
    `  routings: ${routingsFile}`,
    `  receipts: ${receiptsFile}`,
  ].join("\n");
}

function withRules(body: string): string {
  return `${body}\n\n${GOLDEN_RULES}`;
}

function chainTiers(routings: RoutingsFile): Difficulty[] {
  return routings.escalation?.length ? [...routings.escalation] : [...DIFFICULTIES];
}

function blankStats(): ReceiptStats {
  return {
    quick: { attempts: 0, passes: 0, costs: [], escalations: 0 },
    build: { attempts: 0, passes: 0, costs: [], escalations: 0 },
    deep: { attempts: 0, passes: 0, costs: [], escalations: 0 },
  };
}

function receiptCost(receipt: AttemptReceipt): number | undefined {
  const total = receipt.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0
    ? total
    : undefined;
}

function isDifficulty(value: unknown): value is Difficulty {
  return (
    typeof value === "string" && (DIFFICULTIES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIfExists(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Put back the exact previous bytes, or remove the file we created. */
function restoreFile(file: string, previous: string | undefined): void {
  try {
    if (previous === undefined) unlinkSync(file);
    else writeFileSync(file, previous, "utf8");
  } catch {
    // Best-effort restore; the caller reports the validation error.
  }
}
