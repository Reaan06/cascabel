# Changelog

All notable changes to Cascabel are documented here (Keep a Changelog 1.1,
SemVer 2.0.0).

## [0.3.0] - 2026-11-12

### Added
- **Cost telemetry (S8).** Every attempt receipt carries optional
  `tokens` (`input`, `output`, `cacheRead`, `cacheWrite`, `total`) and `cost`
  (`total`, `currency`) extracted defensively from the child session's
  `get_session_stats`. Fields are best-effort: missing or garbage values stay
  absent, never zero-filled. Attempt headers, FAIL summaries and the tool
  result `details` (`tokensTotal`, `costTotal`) surface the same numbers, and a
  `Total:` line is added when any attempt reported cost.
- **`/cascabel:tiers` command (S9).** Shows the ladder, the `routings.json` path
  in effect, and per-tier receipt statistics (attempts, pass rate, average cost,
  escalation count). `set <tier> <provider/model> <effort>` rewrites the file and
  re-validates fail-closed, restoring the previous bytes on error. Interactive
  TUI mode edits through the same validated path; headless hosts fall back to
  the args-mode help. Both modes print the three routing rules.
- README sections for cost telemetry, `/cascabel:tiers`, and compatibility with
  plain `pi` and gentle-shell / gentle-ai (install from the GitHub hub; the
  gentle-pi `/gentle:profiles` panel is upstream-owned and session-frozen).

### Changed
- `npm test` suite grows to 102 tests (101 passing + 1 gated smoke).

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
