# Cascabel

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
   quick  gemini-3.8-flash-high @ medium             │ FAIL: 1 retry in tier,
   build  gemini-3.8-flash-high @ high                │ then one step up
   deep   gpt-5.6-sol           @ high               │
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
pi install /home/reaan/Dev/cascabel   # linked live package
```

Requires `pi` on PATH. The tool appears in new sessions as `cascabel_route_run`.

## Configuration — `~/.pi/cascabel/routings.json`

Ship-none defaults match the agreed alignment (S5); every field is optional and merges
over defaults. To override, create the file:

```json
{
  "tiers": {
    "quick": { "model": "cli-proxy-api/gemini-3.8-flash-high", "effort": "medium" },
    "build": { "model": "cli-proxy-api/gemini-3.8-flash-high", "effort": "high" },
    "deep":  { "model": "cli-proxy-api/gpt-5.6-sol", "effort": "high" }
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
 "attempt":1,"model":"cli-proxy-api/gemini-3.8-flash-high","effort":"medium","ok":false,
 "reason":"tests red: expect(foo).toBe(bar)","durationMs":51234,"sessionId":"...","cwd":"..."}
```

This is the raw material for the playbook rule "log every miss and turn it into a rule":
periodically read the log, and adjust `routings.json` (tiers, plan, retries) from evidence —
cost per solved task, not cost per token.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CASCABEL_ROUTINGS` | path to your `routings.json` (default `~/.pi/cascabel/routings.json`) |
| `CASCABEL_PI` | pi executable for children (default `pi`) |
| `CASCABEL_WORKER_AGENT` | worker agent file (default `~/.pi/agent/agents/gentle-ai-worker.md`) |
| `CASCABEL_LOG_DIR` | receipts directory (default `~/.pi/cascabel/logs`) |
| `CASCABEL_LOG_DISABLE=1` | disable all receipt writes (tests only) |

Individual `route_run` calls accept `log: "off"` for genuinely ephemeral probes.

## Development

```sh
npm install
npm test              # unit suite (64 tests)
npm run smoke         # real end-to-end child run (cheapest tier, ~6s)
```

Source layout: `src/core.ts` (pure routing policy), `src/config.ts` (fail-closed loader),
`src/child.ts` (RPC runner), `src/worker-prompt.ts` (live identity), `src/cascade.ts`
(cap policy + verdicts), `src/log.ts` (receipts), `src/index.ts` (tool registration).

Design constraints and specs with user quotes: `odd/tasks/cascabel.md`.
