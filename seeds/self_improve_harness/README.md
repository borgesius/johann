# Medium-Run Loop Eval Rig

Local benchmark harness for medium-running coding jobs that behave more like a tech lead loop than a single giant prompt.

The rig is built around:
- a working repo per run
- a structured ledger per run
- role-based phases: `pm_intake`, `planning`, `execution`, `review`, `judging`, `pm_reprioritization`
- persistent architecture directives so long-term structure survives across cycles
- deterministic judges and reports
- efficiency-aware sequencing so later cycles can reuse earlier PM/TL work instead of redoing it
- chain-friendly continuity so later benchmarks inherit repo state, architecture directives, and carryover priorities from earlier stages
- hierarchical work breakdowns so PM/TL and planning can split large work into smaller leaves, then split it again if needed
- durable initiative queues so medium-horizon product arcs survive across cycles instead of collapsing into only immediate checklist work
- runtime branch hinges so planning can compare concrete approaches even when the benchmark did not predeclare the exact fork

## What It Supports

- `single_pass`: one PM/TL-to-judge cycle
- `gated_role_loop`: PM/TL reprioritization plus additional cycles until success, plateau, or budget stop
- `lean_handoff_loop`: same role loop, but uses judge and review artifacts for deterministic reprioritization instead of a separate PM/TL reprioritization turn
- `repair_focus_loop`: keep the initial PM/TL and planning passes, then spend later cycles mostly on judge-informed repair work
- `branch_rank_revise`: manifest-defined branching on approved hinges, ranking, then revision

Built-in benchmarks:
- `tiny_smoke`: cheap calibration benchmark for real-worker validation
- `electron_spec`
- `microsaas_obs`
- `eval_loop`
- `hft_firm_game`
- `hft_firm_stage1_foundation`
- `hft_firm_stage2_people_projects`
- `hft_firm_stage3_markets_engine`
- `hft_firm_stage4_incidents_polish`
- `release_orch_stage1_foundation`
- `release_orch_stage2_policy_engine`
- `release_orch_stage3_runtime_ledger`
- `release_orch_stage4_operator_console`
- `release_orch_stage5_incident_actions`
- `release_orch_stage6_adapters_observability`
- `self_improve_harness`
- `stateful_notes_stage1`
- `stateful_notes_stage2`
- `stateful_notes_stage3`

Built-in workers:
- `stub`
- `qwen-coder-hybrid`
- `qwen-coder-next`
- `qwen-coder-flash`

The real worker path is OpenRouter-only and currently tuned for the Qwen family.

## Quick Start

Install dependencies:

```bash
npm install
```

List workers and benchmarks:

```bash
npm run dev -- list
```

Run one calibration cell:

```bash
npm run dev -- run --benchmark tiny_smoke --worker qwen-coder-flash --policy single_pass --budget 10
```

Run an iterative loop:

```bash
npm run dev -- loop --benchmark tiny_smoke --worker qwen-coder-flash --policy gated_role_loop --budget 10 --max-cycles 2
```

Run directly from a brief file instead of a preauthored benchmark:

```bash
npm run dev -- loop --brief-file examples/briefs/release-control-direct.md --worker qwen-coder-hybrid --policy repair_focus_loop --budget 120 --max-cycles 12
```

Refresh the self-improve benchmark seed from the current repo:

```bash
npm run self:improve:refresh-seed
```

Run the built-in self-improve benchmark against the refreshed harness snapshot:

```bash
npm run self:improve:run
```

Custom brief runs automatically:
- generate a brief-backed benchmark under `.bench/generated/briefs/`
- turn on `continue-after-success`
- use a looser plateau window so the run can keep deepening the product after the first passing scaffold

Resume a loop from a previous run ledger:

```bash
npm run dev -- loop --benchmark stateful_notes_stage2 --worker qwen-coder-flash --policy repair_focus_loop --budget 30 --max-cycles 3 --handoff-ledger /absolute/path/to/ledger.json
```

Run a chained stateful sequence:

```bash
npm run dev -- chain --benchmarks stateful_notes_stage1,stateful_notes_stage2,stateful_notes_stage3 --worker qwen-coder-flash --policy repair_focus_loop --budget 25 --max-cycles 2
```

Run the staged HFT game long-run preset:

```bash
npm run hft:dream:run
```

Run the staged release-control long-run preset:

```bash
npm run release:control:run
```

Run the shorter staged release-control smoke preset:

```bash
npm run release:control:smoke
```

Watch the latest matching run while it executes:

```bash
npm run dev -- watch --latest --benchmark stateful_notes_stage2 --worker qwen-coder-flash --policy repair_focus_loop
```

Watch a specific run or ledger once you know it:

```bash
npm run dev -- watch --run stateful-notes-stage3-qwen-coder-flash-repair-focus-loop-2026-06-06T06-02-02-728Z-49028b
npm run dev -- watch --ledger /absolute/path/to/ledger.json
```

Watch the latest staged HFT chain:

```bash
npm run hft:dream:watch
```

Watch the latest staged release-control chain:

```bash
npm run release:control:watch
```

Watch the latest self-improve run:

```bash
npm run self:improve:watch
```

Watch a specific chain or the latest chain by label:

```bash
npm run dev -- watch --chain hft-dream-qwen-coder-next-repair-focus-loop-2026-06-06T00-00-00-000Z-abc123
npm run dev -- watch --chain-latest --label hft-dream
```

Run a comparison matrix:

```bash
npm run dev -- matrix --benchmarks microsaas_obs --workers qwen-coder-flash,qwen-coder-next --policies single_pass,gated_role_loop --budget 20 --max-cycles 2
```

Score an existing repo:

```bash
npm run dev -- judge --benchmark eval_loop --repo /absolute/path/to/repo
```

Score an existing repo against a direct brief:

```bash
npm run dev -- judge --brief-file examples/briefs/release-control-direct.md --repo /absolute/path/to/repo
```

Aggregate reports:

```bash
npm run dev -- report
```

## Run Artifacts

Each run lands under `.bench/runs/<run-id>/` with:
- `repo/` for the working copy
- `ledger.json` for the full loop state
- `artifacts/baseline-judge.json` for the starting score
- `phases/` for prompts and model outputs
- `artifacts/ARCHITECTURE_DIRECTIVES.md` for long-term structure guidance
- `reports/run-report.md` for a human-readable summary including phase-by-phase token usage, execution vs coordination spend, estimated OpenRouter cost, and tokens-per-score-delta

Each chain lands under `.bench/chains/<chain-run-id>.json` and records:
- current stage and active run
- completed stage scores and stop reasons
- chain-level summary totals

## Notes

- The harness uses deterministic hidden checks for scoring.
- Judging is now hybrid by default: deterministic hidden checks provide the structural floor, and an OpenRouter/Qwen product-quality judge scores whether the repo feels like a serious product attempt or just a checklist pass.
- Custom brief runs now treat "spec passed but product still shallow" as an unfinished state: the loop will keep iterating when product quality, technical quality, or validation are still materially behind checklist progress.
- The OpenRouter worker is a local tool loop, not just a chat completion wrapper.
- `qwen-coder-hybrid` is the long-run default for release-control tasks: it uses `qwen-coder-flash` for coordination-heavy phases and `qwen-coder-next` for execution, with a flash fallback if the primary call fails.
- The harness now supports real browser smoke checks in benchmark judging and worker execution/review via Playwright Core plus a detected local browser. Set `BENCH_BROWSER_EXECUTABLE` if auto-detection does not find Chrome/Brave/Edge.
- `self_improve_harness` uses a refreshable seed snapshot of the current repo, so `npm run self:improve:refresh-seed` is the clean way to roll the baseline forward before a new self-improvement run.
- The PM role is treated as a PM/TL, and planning/reprioritization can update persistent architecture directives.
- PM/TL and planning now emit a hierarchical `workBreakdown` tree with size buckets tuned to LLM-loop reality: `tiny`, `small`, `medium`, `large`, `oversized`.
- Work breakdowns can now carry both `delivery` and `exploration` tracks, and exploration opportunities are promoted into later backlogs instead of staying as passive notes.
- PM/TL, planning, review, and reprioritization can now emit durable `initiatives`, and the loop promotes strong opportunities and large program slices into that initiative queue automatically.
- Execution and review now receive explicit active work leaves plus deferred work leaves, so long-run tasks stay closer to the current slice instead of sprawling across the whole product at once.
- `repair_focus_loop` and `branch_rank_revise` can now branch on runtime-proposed hinges with concrete candidates, not only manifest-defined branch templates.
- The judge now runs lightweight automatic validations from package scripts (`test`, `build`, `typecheck`, `lint` when present) and feeds those results back into scoring, PM/TL reprioritization, and report output.
- Direct brief runs are the best path for long-horizon product work when you do not want to pre-break the task into benchmark stages first.
- Planning-type phases now get larger read-only budgets, force a structured finish instead of falling back to empty handoffs, and preserve useful backlog/architecture state when the model gets stuck.
- Execution now records actual file and command activity from tool traces, and bootstrap execution cannot finish successfully without real repo progress.
- Non-single-pass policies now skip redundant `pm_intake` after the first cycle and skip PM/TL reprioritization on terminal cycles.
- `chain` reuses the prior stage repo and now carries forward architecture directives, condensed handoff notes, and unresolved priority items into the next benchmark.
- `run`, `loop`, `matrix`, and `chain` now accept stop-rule overrides such as `--success-threshold`, `--plateau-window`, `--plateau-threshold`, and `--disable-plateau`.
- `run` and `loop` also accept `--seed` and `--handoff-ledger` so you can do targeted reruns from a previous repo or ledger state.
- `watch` can follow a specific run, the latest matching run, a specific chain, or the latest chain by label.
- `watch` now surfaces richer live state, including judge subscores, top priorities/opportunities, current work slice, recent files/commands, and in-progress action traces while a phase is still running.
- `SIGINT` and `SIGTERM` now persist the active run or chain state before exit so interrupted jobs remain inspectable and resumable.
- The tiny calibration benchmark is intentionally boring; it exists to validate worker and policy mechanics quickly before running heavier benchmarks.
- Current evaluation notes live in [docs/eval-findings-2026-06-06.md](/Users/danadzik/Documents/New project/docs/eval-findings-2026-06-06.md).
