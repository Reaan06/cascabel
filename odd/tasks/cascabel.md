# Cascabel — task-difficulty model routing extension for Pi

Pi extension that routes ONE worker across model tiers by task difficulty, with a capped
escalation cascade. Spawns headless `pi --mode rpc` children with dynamic `--model`/`--thinking`,
reusing the user's existing worker agent instructions. No new agent definitions.

## Specs

- S1 (quote) "no quiero agentes subalternos quiero que mi worker tenga un routing de modelo en base a la tarea" → A single routed worker: the child runs the user's existing `gentle-ai-worker` agent instructions read live from `~/.pi/agent/agents/gentle-ai-worker.md`; the extension creates no agent definitions and adds no agents to the catalog.
- S2 (quote) "esos riesgos parchealos" → Risk patches from the accepted design: (a) runner divergence — routed children replicate only the documented Pi CLI/RPC surface and read the worker prompt live at each spawn; (b) false passes — every run ends in an outcome receipt, and the cascade escalates only on worker-reported failed checks, capped; (c) coupling — the extension depends only on Pi's documented CLI flags, RPC protocol and extension API; zero imports from gentle-pi internals.
- S3 (user answer) Difficulty classification comes from the explorer: "el explorer lo propone cuando explora la tarea" → the tool accepts an explicit `difficulty` (quick|build|deep) and optional `risk`; no LLM classification call inside the router.
- S4 (user answer) Escalation: "Cascada automática con cap" — quick → FAIL → build → FAIL → deep → FAIL, returning a human-facing FAIL with the diagnosis. Cap: at most one tier step up and at most one retry per tier; no retries beyond the cap.
- S5 (user answer) Tiers shipped as defaults in `routings.json`: quick `cli-proxy-api/gemini-3.8-flash-high` @ medium, build `nan/deepseek-v4-flash` @ max, deep `cli-proxy-api/gpt-5.6-sol` @ high; escalation chain quick→build→deep; the file is user-editable and authoritative.
- S6 (user answer) v0 scope: `route_run` tool, `routings.json` config, spawn over `pi --mode rpc`, outcome receipt `{tier, model, effort, tokens?, result}`, miss-distance log append (per-model outcome records that feed routing rules), and the capped cascade. Fail-closed: a task with no matching tier errors out with guidance instead of guessing.
- S7 (playbook rule adopted) "Escalate after one failed repair, not five" and "Log every miss and turn it into a rule": receipts append per attempt; the summary returned to the caller includes per-tier attempts so the parent can adjust rules.

## Tasks

- T1 (S1,S2,S6) Scaffold the package: `package.json` as `pi-package` with `pi.extensions`, vitest dev setup, .gitignore, README skeleton. Commit: `chore: scaffold cascabel package`.
- T2 (S5,S6) Routing core: load/validate `routings.json` (fail-closed), tier resolution from difficulty+risk, capped escalation policy. Unit-tested. Commit: `feat: tier resolution and capped escalation policy`.
- T3 (S2) RPC child runner: spawn `pi --mode rpc` with documented flags, LF JSONL framing, `get_state` → `prompt` → `agent_settled` → `get_last_assistant_text` → `get_session_stats`, timeout + kill. Unit-tested framing; spawn covered by smoke. Commit: `feat: rpc child runner`.
- T4 (S1) Worker identity: read `~/.pi/agent/agents/gentle-ai-worker.md` live per spawn, strip frontmatter, pass via `--append-system-prompt`; missing file is a hard, clear error. Commit: `feat: worker prompt loading`.
- T5 (S4,S6) `route_run` tool registration (task, difficulty, risk, workspace_root, label, timeout) running the capped cascade and returning the final outcome. Commit: `feat: route_run tool`.
- T6 (S6,S7) Receipt + miss log: JSONL append under `~/.pi/cascabel/logs/` (env-overridable), per-attempt entries plus attempt summary in the returned text. Commit: `feat: receipts and miss log`.
- T7 (S6) Verification: vitest suite green; linked install `pi install /home/reaan/Dev/cascabel` in global settings; one real smoke `route_run` against the child runtime if the environment permits. Commit: `test: suite and smoke`.
- T8 (S6) README full (usage from ODD: explorer reports difficulty → route_run), memory mirror sync, close.

## Log

- L1 User: "que opinas de desarrollar la herramienta de ruteo desde cero y convertirlo en una extension de gentle-shell?"
- L2 User: "si pero debe ser como lo propisimos y esos riesgos parchealos no quiero agentes subalternos quiero que mi worker tenga un routing de modelo en base a la tarea inicia crea la carpeta en Dev y llamalo como quieras un nombre creativo cualquier pregunta de arquitectura o de producto me la haces"
- L3 Product questions answered: decisor = "el explorer lo propone cuando explora la tarea"; escalation = "Cascada automática con cap"; tiers = "3 tiers con la alineación actual"; scope = "v0 completo (con logging)". S3–S6 derive from these answers; cascade (S4) folds into v0 per the escalation answer.
