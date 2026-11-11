// Attempt receipts and miss logs (S6, S7). Everything Cascabel spawns leaves
// one JSONL line on disk. This is the raw material that later turns misses
// into routing rules ("log every miss and turn it into a rule").
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
