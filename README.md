# Cascabel

[![ci](https://github.com/Reaan06/cascabel/actions/workflows/ci.yml/badge.svg)](https://github.com/Reaan06/cascabel/actions/workflows/ci.yml)

Task-difficulty model routing for Pi coding agents. **One worker, dynamically routed
model + thinking effort per task, with a capped escalation cascade and full receipts.**

Cascabel is a Pi extension (`pi-package`). It registers a single tool, `cascabel_route_run`,
that runs a delegated task on a headless `pi --mode rpc` child pinned to a model tier chosen
by task difficulty. The child is *your* worker: its instructions are live-read at every spawn
from `~/.pi/agent/agents/gentle-ai-worker.md` — no agent definitions are created, nothing is
cloned ("no quiero agentes subalternos", spec S1).

## How routing works

```
explorer reports difficulty ──►  route_run(task, difficulty, risk?)
                                     │
                                     ▼
                        routings.json tier map (fail-closed)
                                     │
            ┌────────────────────────┴───────────────┐
            ▼                                        │
   quick  gemini-flash-high @ medium            │ FAIL: 1 retry in tier,
   build  deepseek-v4-flash @ high              │ then one step up
   deep   glm5.3           @ max                │
            └────────────────────────────────────────┘
                                     │  cap reached
                                     ▼
                     human-facing FAIL with full diagnosis
```

- **Who classifies**: your explorer proposes `difficulty` when it explores the task (S3).
  Cascabel never calls an LLM to classify; no rating, no guess.
- **Fail-closed (S6)**: unknown difficulty, missing tier, missing `routings.json` entry,
  missing worker prompt, missing verification verdict — all are hard errors. Cascabel
  never invents a model or claims success without an executed check.
- **Capped cascade (S4)**: on a failed check → one retry within the tier
  (`retriesPerTier`, default 1), then exactly one step up (`quick→build→deep`).
  When the cap is exhausted you get a FAIL summary listing every attempt.
- **Named risk never routes cheap (S3)**: passing `risk: "auth"` (any non-empty value)
  starts the task at `build` even if `quick` was requested.

## Install

```sh
pi install git:github.com/Reaan06/cascabel   # from the hub (recommended)
pi install /home/reaan/Dev/cascabel          # linked live checkout for development
```

Requires `pi` on PATH. The tool appears in new sessions as `cascabel_route_run`,
and the command as `/cascabel:tiers`. See [Compatibility](#compatibility) for
plain `pi` vs gentle-shell / gentle-ai.

## Configuration — `~/.pi/cascabel/routings.json`

Ship-none defaults match the agreed alignment (S5); every field is optional and merges
over defaults. To override, create the file:

```json
{
  "tiers": {
    "quick": { "model": "cli-proxy-api/gemini-3.8-flash-high", "effort": "medium" },
    "build": { "model": "nan/deepseek-v4-flash", "effort": "high" },
    "deep":  { "model": "nan/glm5.3", "effort": "max" }
  },
  "escalation": ["quick", "build", "deep"],
  "retriesPerTier": 1,
  "plan": ["quick", "build", "deep"]
}
```

- `tiers.<tier>.approval`: `"auto"` (default; RPC children cannot answer approval prompts)
  or `"reject"` (read-only probe tier).
- `escalation`: the step-up chain; tiers not on it are unreachable.
- `plan`: optional hard ceiling for what a task may ever try; a requested tier outside the
  plan is rejected.
- Invalid entries fail closed at load with a `file: field` message.

## ODD integration

In the delegation flow:

1. Your explorer visits the task and reports a difficulty line (`quick | build | deep`)
   in its findings.
2. The orchestrator calls `cascabel_route_run` with the full task text (including allowed
   edit surfaces), the difficulty, and any named risk.
3. The child runs your worker contract, executes its own checks, and **must** end its final
   message with `cascabel_verdict: pass` (or `fail`). A missing verdict counts as fail (S4).
4. The tool replies with a PASS (winning output) or the capped-FAIL diagnostic, and every
   attempt is receipted.

## Receipts and miss logs (S6, S7)

Per attempt, one JSON line is appended to `~/.pi/cascabel/logs/attempts.jsonl`:

```json
{"timestamp":"...","label":"map footer","difficulty":"quick","risk":null,"tier":"quick",
 "attempt":1,"model":"nan/glm5.3-flash","effort":"medium","ok":false,
 "reason":"tests red: expect(foo).toBe(bar)","durationMs":51234,"sessionId":"...","cwd":"..."}
```

This is the raw material for the playbook rule "log every miss and turn it into a rule":
periodically read the log, and adjust `routings.json` (tiers, plan, retries) from evidence —
cost per solved task, not cost per token.

## Cost telemetry

Every attempt carries the child session's own usage numbers when the runtime reports
them (`get_session_stats`). Nothing is estimated and nothing is zero-filled: a missing
or unreadable value stays absent from both the receipt and the tool result.

Receipt fields (optional, additive):

```json
{"timestamp":"...","tier":"build","attempt":1,"model":"nan/deepseek-v4-flash","effort":"high",
 "ok":true,"durationMs":24500,
 "tokens":{"input":10200,"output":2100,"cacheRead":0,"cacheWrite":0,"total":12300},
 "cost":{"total":0.0042,"currency":"USD"}}
```

- `tokens`: `input`, `output`, `cacheRead`, `cacheWrite`, `total` — only the fields the child reported.
- `cost`: `total` plus `currency` when the provider states one.

The parent model sees the same numbers in the result header, plus a run total when any
attempt reported cost:

```text
Cascabel: PASS after 1 attempt(s).
- [build #1] nan/deepseek-v4-flash@high → pass (24.5s, 12.3k tok, $0.0042)
Total: 1 attempt(s), 12.3k tok, $0.0042
```

The tool result `details` gains `tokensTotal` and `costTotal` under the same rule — present
only when known. A FAIL summary keeps every attempt line with its cost/token diagnostics,
so a capped cascade is auditable per tier.

## `/cascabel:tiers`

Manage the ladder without hand-editing JSON. The command works in a TUI and headless;
the args mode never touches the UI.

```text
/cascabel:tiers                      interactive picker (when a TUI is available)
/cascabel:tiers show                 ladder + routings path + per-tier receipt stats (default)
/cascabel:tiers stats                receipt stats table only
/cascabel:tiers set <tier> <provider/model> <effort>
                                     rewrite one tier, re-validate, revert on error
```

Examples:

```sh
# switch mid-tier work to DeepSeek at high effort
/cascabel:tiers set build nan/deepseek-v4-flash high

# cheapest tier for docs work
/cascabel:tiers set quick cli-proxy-api/gemini-3.8-flash-high medium

# see measured behavior per tier
/cascabel:tiers stats
```

`show` prints each tier as `model@effort` with its description, the `routings.json` file
actually in effect (honouring `CASCABEL_ROUTINGS`), and a table of attempts, pass rate,
average cost per attempt, and escalations (attempts that ran above the requested
difficulty). Missing or empty receipts print `(no receipts yet)`; malformed log lines are
skipped rather than crashing the command.

A `set` rewrites the raw file (2-space JSON, other tiers and unknown keys preserved),
creates `~/.pi/cascabel/` when needed, then re-validates through the normal fail-closed
loader. An invalid effort or model is reverted: the previous bytes are restored and the
command prints the loader's exact `file: field` error. Interactive mode asks for the
model, then the effort, and persists through that same validated path; if the host has no
TUI the command falls back to the args-mode help instead of throwing.

Both modes print the three routing rules inline: difficulty comes from exploration, a
named risk never routes below build, and the cap is the feature.

## Compatibility

Cascabel is a standard `pi-package`. It imports only Pi's documented CLI/RPC surface and
extension API — never harness internals — so the same package runs in both hosts:

- **plain `pi`**: `/cascabel:tiers` and `cascabel_route_run` are available in every mode.
  Args mode of the command is headless-safe; interactive mode requires the TUI.
- **gentle-shell / gentle-ai**: install the same package; Cascabel complements the
  harness's delegation discipline and stays out of its agent catalog.

```sh
pi install git:github.com/Reaan06/cascabel
```

The `nan/*` tiers load gentle-pi's published nan-provider extension through the documented
`-e` flag when it is installed (see the environment table). The gentle-pi `/gentle:profiles`
panel is upstream-owned and session-frozen — integrating there is an upstream request, not
something a third-party package can embed. `/cascabel:tiers` is the equivalent built-in
manager for Cascabel's ladder; the upstream proposal remains open.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CASCABEL_ROUTINGS` | path to your `routings.json` (default `~/.pi/cascabel/routings.json`) |
| `CASCABEL_PI` | pi executable for children (default `pi`) |
| `CASCABEL_WORKER_AGENT` | worker agent file (default `~/.pi/agent/agents/gentle-ai-worker.md`) |
| `CASCABEL_LOG_DIR` | receipts directory (default `~/.pi/cascabel/logs`) |
| `CASCABEL_LOG_DISABLE=1` | disable all receipt writes (tests only) |
| `CASCABEL_SESSION_DIR` | child session store (default `~/.pi/cascabel/sessions`) |
| `CASCABEL_NAN_PROVIDER_EXT` | explicit nan-provider extension path for child `-e` |
| `CASCABEL_NO_NAN_PROVIDER=1` | never load the nan-provider extension |

Individual `route_run` calls accept `log: "off"` for genuinely ephemeral probes.

## Development

```sh
npm install
npm test              # unit suite (101 tests)
npm run smoke         # real end-to-end child run (cheapest tier, ~6s)
```

Source layout: `src/core.ts` (pure routing policy), `src/config.ts` (fail-closed loader),
`src/child.ts` (RPC runner), `src/worker-prompt.ts` (live identity), `src/cascade.ts`
(cap policy + verdicts + telemetry), `src/log.ts` (receipts + usage extraction),
`src/tiers-command.ts` (`/cascabel:tiers`), `src/index.ts` (tool + command registration).

Design constraints and specs with user quotes: `odd/tasks/cascabel.md`.
