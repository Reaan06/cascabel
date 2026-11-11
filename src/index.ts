// Cascabel — the Pi extension entrypoint. Registers exactly one tool:
// route_run. Everything else in src/ is plain, independently testable code.
//
// Design constraints (odd/tasks/cascabel.md S1-S7):
// - the child IS the user's worker: instructions are live-read per spawn,
//   never cloned into a new agent definition;
// - fail-closed: unknown tiers, missing configs, missing worker prompt and
//   missing verdicts are hard errors, never silent guesses;
// - only documented Pi surfaces: CLI flags + RPC protocol + extension API.
import { Type } from "typebox";
import { resolveTier } from "./core";
import { loadRoutings } from "./config";
import { loadWorkerPrompt } from "./worker-prompt";
import { runChild } from "./child";
import { fileLogger, nullLogger } from "./log";
import { runRoute } from "./cascade";
import type { Difficulty } from "./core";

const Difficulties = Type.Union([
  Type.Literal("quick"),
  Type.Literal("build"),
  Type.Literal("deep"),
]);

export default function register(pi: {
  registerTool: (tool: unknown) => void;
}): void {
  pi.registerTool({
    name: "cascabel_route_run",
    label: "Cascabel route run",
    description:
      "Run one worker task on a difficulty-routed model tier with a capped escalation cascade. " +
      "Difficulty comes from your exploration (quick=docs/small edits, build=default behavior work, deep=high-risk). " +
      "A named risk never routes to quick. The child runs your existing worker instructions read live from " +
      "~/.pi/agent/agents/gentle-ai-worker.md and MUST end with a `cascabel_verdict: pass|fail` line after running " +
      "its own checks; a missing verdict counts as fail. On fail: one retry in the same tier, then one tier step up " +
      "(quick->build->deep), then a human-facing FAIL with the full diagnosis. Every attempt is logged to " +
      "~/.pi/cascabel/logs/attempts.jsonl. There is no default model guess: unknown difficulties are rejected.",
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        description:
          "The complete delegated task, as you would hand it to a worker subagent, including any allowed edit surfaces.",
      }),
      difficulty: Difficulties,
      risk: Type.Optional(
        Type.String({
          description:
            "Named risk marker (e.g. 'auth', 'migration'); forces the task to start at build tier or higher.",
        }),
      ),
      label: Type.Optional(
        Type.String({
          maxLength: 80,
          description: "Short human-readable label for the receipt log.",
        }),
      ),
      workspace_root: Type.Optional(
        Type.String({
          description: "Absolute directory the child works in; defaults to this session's cwd.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          minimum: 10_000,
          maximum: 7_200_000,
          description: "Per-attempt wall-clock budget in ms; default 30 minutes.",
        }),
      ),
      log: Type.Optional(
        Type.Union([Type.Literal("on"), Type.Literal("off")], {
          description: "Receipt logging; default on. 'off' only for genuinely ephemeral probes.",
        }),
      ),
    }),
    async execute(_id, params) {
      const input = params as {
        task: string;
        difficulty: Difficulty;
        risk?: string;
        label?: string;
        workspace_root?: string;
        timeout_ms?: number;
        log?: "on" | "off";
      };
      // Fail-closed pre-resolve before any child spawn (S6): config or tier
      // problems surface as a tool error, not as a wasted child run.
      const routings = loadRoutings();
      resolveTier(routings, input.difficulty, input.risk);
      const workerPrompt = loadWorkerPrompt();

      const result = await runRoute(
        {
          task: input.task,
          difficulty: input.difficulty,
          risk: input.risk,
          label: input.label,
          cwd: input.workspace_root ?? process.cwd(),
          timeoutMs: input.timeout_ms,
        },
        {
          routings,
          workerPrompt,
          logger:
            input.log === "off"
              ? nullLogger
              : fileLogger(),
          runChild,
        },
      );

      const header = [
        `Cascabel: ${result.ok ? "PASS" : "FAIL"} after ${result.attempts.length} attempt(s).`,
        ...result.attempts.map(
          (a) =>
            `- [${a.tier} #${a.attemptNo}] ${a.model}@${a.effort} → ${a.ok ? "pass" : "fail"} (${a.durationMs}ms)${a.reason ? ` — ${a.reason}` : ""}`,
        ),
      ].join("\n");

      return `${header}\n\n${result.text}`;
    },
  });
}
