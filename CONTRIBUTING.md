# Contributing to Cascabel

Thanks for looking at Cascabel. Short version: the routing rules are
deliberately simple and fail-closed — keep them that way.

## Ground rules

1. **Fail-closed is the contract.** Any new code path that could "guess" a
   model, tier, effort or verdict must instead fail with an actionable error.
   Tests must prove the failure mode, not just the happy path.
2. **Documented surfaces only.** Children are spawned with Pi's documented CLI
   flags and RPC protocol. No imports from other packages' internal modules.
3. **The child is the user's worker.** Never snapshot, clone or embed worker
   instructions; they are live-read at spawn time.
4. **The cap is the feature.** Do not loosen the escalation cap (one retry per
   tier, one step up) without a measured argument from real receipts.

## Development

```sh
npm install
npm test        # unit suite — must stay green
npm run smoke   # real end-to-end child run (talks to real models; keep tasks tiny)
```

## Conventions

- Commits follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`,
  `chore:`) with the covered spec references in the body.
- Specs live in `odd/tasks/cascabel.md`; behavior changes must update the
  relevant `S#` and append a dated `Log` line.
- Keep the receipts schema backward compatible: downstream tooling reads
  `attempts.jsonl` as a stream.

## Reporting issues

Include the failing scenario with: the `routings.json` in effect, the receipt
lines from `attempts.jsonl`, and the tool output (the attempts header is
designed to be copy-pasted).
