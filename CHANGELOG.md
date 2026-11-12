# Changelog

All notable changes to Cascabel are documented here (Keep a Changelog 1.1,
SemVer 2.0.0).

## [0.2.0] - 2026-11-12

### Added
- Public proposal (`PROPOSAL.md` + `docs/proposal.pdf`), LICENSE (MIT),
  CONTRIBUTING, and pinned-actions CI (unit suite + secret scan).
- `resolveNanProviderExtension`: routed children load the installed gentle-pi
  nan-provider extension via the documented `-e` flag so `nan/*` models
  (GLM, DeepSeek) resolve headless; graceful degradation with
  `CASCABEL_NAN_PROVIDER_EXT` / `CASCABEL_NO_NAN_PROVIDER=1`.
- Child session isolation: `--session-dir` under `~/.pi/cascabel/sessions`
  (env `CASCABEL_SESSION_DIR`), lazily created.
- Fail-fast on child `exit`/`error` before settlement (previously masked by the
  request timer).

### Changed
- Default tier ladder (user decision, spec S5 rev. L10): easiest work →
  `cli-proxy-api/gemini-3.8-flash-high` @ medium; mid work →
  `nan/deepseek-v4-flash` @ high; hardest/most important → `nan/glm5.3` @ max.
  GPT-family models excluded by design.

### Fixed
- `cascabel_route_run` now returns the `AgentToolResult` shape
  (`{content:[{type:"text"}],details}`); a bare string reached the parent
  model as "(no tool output)".

## [0.1.0] - 2026-11-11

### Added
- `cascabel_route_run` tool: difficulty-based tier routing for one worker with
  a capped escalation cascade (`quick → build → deep`, one retry per tier,
  one step up), live-read worker identity, fail-closed `routings.json`
  (`~/.pi/cascabel/routings.json`), `cascabel_verdict: pass|fail` verification
  contract, and per-attempt JSONL receipts under `~/.pi/cascabel/logs/`.
- RPC child runner over documented Pi CLI/RPC surface only (`pi --mode rpc`,
  LF-strict JSONL framing, `get_state → prompt → agent_settled`).
- 69-test unit suite; gated real-child smoke (`npm run smoke`).
