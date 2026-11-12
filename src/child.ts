// RPC child runner. Spawns a headless `pi --mode rpc` session and drives it
// with the documented protocol only (docs/rpc.md, docs/rpc-commands.md):
// spawn -> get_state -> prompt -> agent_settled -> get_last_assistant_text.
// No agent flags exist, so worker identity arrives as --append-system-prompt.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TierSpec } from "./core";
import { decodeFrames, encodeFrame } from "./jsonl";

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
  /** Parent abort signal; aborting kills the child and fails the run. */
  signal?: AbortSignal;
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
    options: {
      cwd: string;
      stdio: ["pipe", "pipe", "pipe"];
      env: NodeJS.ProcessEnv;
      detached?: boolean;
    },
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
  const args = ["--mode", "rpc", "--session-dir", cascabelSessionDir()];
  args.push("--model", opts.tierSpec.model);
  args.push("--thinking", opts.tierSpec.effort);
  args.push(approvalFlag(opts.tierSpec.approval));
  const nanExt = resolveNanProviderExtension();
  if (nanExt) args.push("-e", nanExt);
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  return args;
}

/**
 * Resolve the installed gentle-pi nan-provider extension so routed children
 * can reach provider `nan` (GLM / DeepSeek). Plain `pi --mode rpc` children
 * only load global packages; gentle-pi injects this extension only into its
 * own runner's children. Loading the published extension ENTRYPOINT file via
 * the documented `-e` flag keeps us off gentle-pi internals. A missing file
 * degrades gracefully: nan-tier models then fail closed at spawn with a
 * clear "model not found" receipt instead of a silent guess.
 * Env: CASCABEL_NAN_PROVIDER_EXT (explicit path) or CASCABEL_NO_NAN_PROVIDER=1 (skip).
 */
export function resolveNanProviderExtension(): string | undefined {
  const override = process.env.CASCABEL_NAN_PROVIDER_EXT;
  if (override !== undefined) return existsSync(override) ? override : undefined;
  if (process.env.CASCABEL_NO_NAN_PROVIDER === "1") return undefined;
  const base = join(homedir(), ".gentle-shell", "versions");
  let best: string | undefined;
  let bestTime = 0;
  try {
    for (const version of readdirSync(base)) {
      for (const candidate of [
        join(base, version, "node_modules", ".pnpm", `gentle-pi@${version}`, "node_modules", "gentle-pi", "extensions", "nan-provider.ts"),
        join(base, version, "node_modules", "gentle-pi", "extensions", "nan-provider.ts"),
      ]) {
        if (!existsSync(candidate)) continue;
        const mtime = statSync(candidate).mtimeMs;
        if (mtime >= bestTime) {
          bestTime = mtime;
          best = candidate;
        }
      }
    }
  } catch {
    return undefined;
  }
  return best;
}

/**
 * Session storage for cascabel children. Without this, headless children write
 * into Pi's cwd-scoped user session store (`~/.pi/agent/sessions/<cwd>/`), the
 * same place the user's own sessions live — so a later resume picks up a
 * cascabel run. Children get their own directory, like gentle-pi's runner.
 */
export function cascabelSessionDir(): string {
  const env = process.env.CASCABEL_SESSION_DIR;
  if (env) return env;
  return join(homedir(), ".pi", "cascabel", "sessions");
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
  try {
    mkdirSync(cascabelSessionDir(), { recursive: true });
  } catch (err) {
    throw new ChildRunError(
      `cannot create cascabel session dir ${cascabelSessionDir()}: ${(err as Error).message}`,
    );
  }
  const child = spawnFn(command, childArguments(opts), {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(),
    // Own process group: killChild can then reap grandchildren that inherit
    // the stdio pipes and would otherwise keep `close` from ever firing.
    detached: true,
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
  // `close` waits for all stdio streams; a straggler grandchild can hold them
  // open long after every child process died. That case is covered elsewhere:
  // the exit handler below surfaces an early death immediately, the budget
  // timer kills a silent child, and wrapup kills the whole process group on
  // settle so `close` always fires in healthy runs. There is deliberately NO
  // fixed close race here: one would kill healthy children that legitimately
  // need more than its window to settle.

  // A child that dies before settling (unknown model, spawn failure) must
  // surface immediately: waiting for a request timer would burn the whole
  // budget and report a timeout instead of the real exit.
  child.on("exit", (code, signal) => {
    if (settled) return;
    rejectAll(
      new ChildRunError(
        `cascabel child exited before settling (exit code ${code}${signal ? `, signal ${signal}` : ""})`,
        { stderr: lastStderr(stderrChunks), exitCode: code },
      ),
    );
  });
  child.on("error", (err) => {
    if (settled) return;
    rejectAll(
      new ChildRunError(`cascabel child failed to start: ${err.message}`),
    );
  });

  // User aborts must surface immediately, not after the per-attempt budget.
  if (opts.signal) {
    if (opts.signal.aborted) {
      rejectAll(new ChildRunError("cascabel run aborted by user"));
    } else {
      opts.signal.addEventListener(
        "abort",
        () => {
          rejectAll(new ChildRunError("cascabel run aborted by user"));
        },
        { once: true },
      );
    }
  }

  const budgetMs = opts.timeoutMs ?? 1_800_000;
  const budget = setTimeout(() => {
    timedOut = true;
    rejectAll(
      new ChildRunError(`child exceeded its ${budgetMs}ms budget`, {
        stderr: lastStderr(stderrChunks),
      }),
    );
  }, budgetMs);

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
  killChild(child);
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

/** Kill the child and its whole process group. */
function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode) return;
  // The child runs detached (own process group) so grandchildren that inherit
  // its stdio pipes die too; otherwise `close` never fires and the run hangs.
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const enforce = setTimeout(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
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
