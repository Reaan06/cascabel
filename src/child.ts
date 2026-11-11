// RPC child runner. Spawns a headless `pi --mode rpc` session and drives it
// with the documented protocol only (docs/rpc.md, docs/rpc-commands.md):
// spawn -> get_state -> prompt -> agent_settled -> get_last_assistant_text.
// No agent flags exist, so worker identity arrives as --append-system-prompt.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { TierSpec } from "./core.js";
import { decodeFrames, encodeFrame } from "./jsonl.js";

export interface ChildRunOptions {
  /** Tier/model/thinking for this spawn (validated upstream). */
  tierSpec: TierSpec;
  /** Absolute working directory the child session operates in. */
  cwd: string;
  /** The delegated task text, delivered as the child's first prompt. */
  task: string;
  /** Worker system prompt (live-read from the agent file, S1). */
  systemPrompt?: string;
  /** Wall-clock budget for the whole run. */
  timeoutMs?: number;
  /** pi executable; overridable for tests and multi-version setups. */
  piCommand?: string;
}

export interface ChildRunResult {
  sessionId?: string;
  text: string;
  exitCode: number | null;
  /** `get_session_stats` payload; best-effort, absent when unavailable. */
  stats?: Record<string, unknown>;
  timedOut: boolean;
}

export interface SpawnLike {
  (
    command: string,
    args: string[],
    options: { cwd: string; stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
  ): ChildProcess;
}

export class ChildRunError extends Error {
  constructor(
    message: string,
    readonly detail: { stderr?: string; exitCode?: number | null } = {},
  ) {
    super(message);
  }
}

export function childArguments(opts: ChildRunOptions): string[] {
  const args = ["--mode", "rpc", "--model", opts.tierSpec.model];
  args.push("--thinking", opts.tierSpec.effort);
  args.push(approvalFlag(opts.tierSpec.approval));
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  return args;
}

/**
 * Tool approval for the headless child. RPC children cannot answer approval
 * prompts interactively, so the default is `auto`; a tier may pin `reject`
 * (read-only probe) instead.
 */
export function approvalFlag(approval: TierSpec["approval"]): string {
  return approval === "reject" ? "-na" : "-a";
}

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `cascabel-${requestCounter}`;
}

/** Drive one child run to settlement; resolves with its final assistant text. */
export async function runChild(
  opts: ChildRunOptions,
  spawnFn: SpawnLike = spawn,
): Promise<ChildRunResult> {
  const command = opts.piCommand ?? process.env.CASCABEL_PI ?? "pi";
  const child = spawnFn(command, childArguments(opts), {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(),
  });

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
    stderrChunks.splice(0, Math.max(0, stderrChunks.length - 50));
  });
  child.stderr?.resume();

  type Waiter = {
    resolve: (frame: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer?: NodeJS.Timeout;
  };
  const waiters = new Map<string, Waiter>();
  let settled = false;
  let timedOut = false;
  let sessionId: string | undefined;
  let finalText: string | undefined;
  let stats: Record<string, unknown> | undefined;
  let firstError: Error | undefined;

  const rejectAll = (err: Error) => {
    if (settled) return;
    if (!firstError) firstError = err;
    for (const [, waiter] of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    waiters.clear();
    killChild(child);
  };

  const wrapup = async () => {
    let text: string | undefined;
    try {
      const textRes = await request({ type: "get_last_assistant_text" }, 30_000);
      text = extractText(textRes);
    } catch (err) {
      firstError ??= err as Error;
    }
    try {
      const statsRes = await request({ type: "get_session_stats" }, 15_000);
      stats = (statsRes.data as Record<string, unknown>) ?? statsRes;
    } catch {
      stats = undefined; // stats are best-effort; the text already stands
    }
    if (text !== undefined) finalText = text;
    settled = true;
    killChild(child);
  };

  const handleFrame = (frame: Record<string, unknown>) => {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (id && waiters.has(id)) {
      const waiter = waiters.get(id)!;
      waiters.delete(id);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (frame.type === "error") {
        waiter.reject(
          new ChildRunError(
            `child RPC error for ${id}: ${JSON.stringify(frame).slice(0, 500)}`,
          ),
        );
      } else {
        waiter.resolve(frame);
      }
      return;
    }
    if (frame.type === "session_start" || frame.type === "session_info") {
      const sid = (frame as { sessionId?: string }).sessionId;
      if (sid) sessionId = sid;
      return;
    }
    if (frame.type === "agent_settled") {
      if (!settled) void wrapup().catch(rejectAll);
      return;
    }
    // message_update and other events are consumed, never replayed upwards
  };

  const stdout = child.stdout;
  if (!stdout) {
    throw new ChildRunError("cascabel child has no stdout pipe");
  }
  stdout.setEncoding("utf8");
  let buffer = "";
  stdout.on("data", (chunk: string) => {
    if (settled) return;
    let parsed;
    try {
      parsed = decodeFrames(chunk, buffer);
    } catch (err) {
      rejectAll(err as Error);
      return;
    }
    buffer = parsed.remainder;
    for (const frame of parsed.frames) handleFrame(frame);
  });

  const request = (
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = requestId();
      const frame = encodeFrame({ ...payload, id });
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(
          new ChildRunError(
            `child did not answer ${String(payload.type)} within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      waiters.set(id, { resolve, reject, timer });
      child.stdin?.write(frame, (err) => {
        if (err) {
          waiters.delete(id);
          clearTimeout(timer);
          reject(new ChildRunError(`failed to write to child stdin: ${err.message}`));
        }
      });
    });

  const exitPromise: Promise<{ code: number | null }> = once(child, "close")
    .then(([code]) => ({ code: code ?? null }))
    .catch(() => ({ code: null }));

  const budgetMs = opts.timeoutMs ?? 1_800_000;
  const budget = setTimeout(() => {
    timedOut = true;
    rejectAll(
      new ChildRunError(`child exceeded its ${budgetMs}ms budget`, {
        stderr: lastStderr(stderrChunks),
      }),
    );
  }, budgetMs);
  budget.unref?.();

  try {
    await request({ type: "get_state" }, 60_000);
    const promptRes = await request(
      { type: "prompt", message: opts.task, images: [] },
      60_000,
    );
    const disposition = (promptRes.data as { disposition?: string } | undefined)
      ?.disposition;
    if (disposition === "handled") {
      // No run starts, so no agent_settled will ever arrive (docs/rpc.md:65).
      if (!settled) await wrapup();
    }
  } catch (err) {
    rejectAll(err as Error);
  }

  const { code } = await exitPromise;
  clearTimeout(budget);
  if (!settled || firstError) {
    if (timedOut) {
      throw new ChildRunError(
        `cascabel child timed out after ${budgetMs}ms`,
        { stderr: lastStderr(stderrChunks) },
      );
    }
    throw (firstError as Error) ??
      new ChildRunError(
        `cascabel child ended before settling (exit code ${code})`,
        { stderr: lastStderr(stderrChunks), exitCode: code },
      );
  }
  return { sessionId, text: finalText ?? "", exitCode: code, stats, timedOut };
}

function extractText(frame: Record<string, unknown>): string | undefined {
  if (typeof frame.text === "string") return frame.text;
  const data = frame.data as { text?: unknown } | undefined;
  if (typeof data?.text === "string") return data.text;
  return undefined;
}

/** Headless peer: strip interactive-host hints, keep auth and proxies. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PI|GENTLE)_(TUI|INTERACTIVE|CLAUDE)/i.test(key)) delete env[key];
  }
  // Cascabel's own config must not leak into children.
  delete env.CASCABEL_ROUTINGS;
  return env;
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill();
  const enforce = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 2_500);
  enforce.unref?.();
}

function lastStderr(stderrChunks: string[]): string | undefined {
  const joined = stderrChunks.join("").trim();
  return joined.length > 0 ? joined.slice(-4000) : undefined;
}
