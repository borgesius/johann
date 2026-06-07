# Eval Findings (June 6, 2026)

These notes summarize the strongest current signals from the local OpenRouter/Qwen runs in this repo after tightening the loop mechanics and adding efficiency tracking.

## Current Read

- `tiny_smoke` is still a calibration benchmark, not a ranking benchmark.
- `eval_loop` still validates the repair path, but it is no longer hard enough to separate strong policies.
- `microsaas_obs` is the best benchmark for ranking policy quality because it exposes both workflow quality and run-to-run variance.
- `electron_spec` is now good for comparing efficiency frontiers because several policies can reach respectable scores there with meaningfully different token costs.

## Workflow Findings

- The expensive orchestration phases were mostly `pm_intake` and `pm_reprioritization`, not raw execution.
- Skipping redundant `pm_intake` after cycle 1 and skipping PM/TL reprioritization on terminal cycles produced a large efficiency win without hurting the best `electron_spec` score.
- A more aggressive simplification, `lean_handoff_loop`, did not pay off. Removing the PM/TL reprioritization hop made the workflow lighter on paper, but it reduced quality enough that the overall efficiency frontier got worse.

## Highest-Signal Frontier

### Electron Spec

- `qwen-coder-flash + single_pass`: `70`, `11.4k` tokens
- `qwen-coder-flash + gated_role_loop`: `90`, `11.2k` tokens
- `qwen-coder-flash + branch_rank_revise`: `90`, about `14.8k` tokens
- `qwen-coder-flash + lean_handoff_loop`: `85`, `22.8k` tokens

Interpretation:
- the tightened `gated_role_loop` is the current frontier on this benchmark
- it beats `single_pass` on quality while staying almost equally cheap in total tokens
- `branch_rank_revise` is competitive but currently not more efficient than the optimized gated loop
- `lean_handoff_loop` is currently dominated

### MicrosaaS Observability

- `qwen-coder-flash + single_pass`: `14`, `12.4k` tokens
- `qwen-coder-flash + gated_role_loop`: `80`, `30.2k` tokens on the latest replicate
- `qwen-coder-flash + lean_handoff_loop`: `74`, `29.2k` tokens
- `qwen-coder-flash + branch_rank_revise`: `100`, `34.5k` tokens

Interpretation:
- this benchmark still separates policies hard
- `single_pass` is too weak here
- `lean_handoff_loop` helps more than `single_pass`, but still leaves important required gaps
- `branch_rank_revise` is still the strongest current result, but the planner often chooses **not** to branch, so the win is probably a mix of policy shape, prompt shape, and model variance rather than the branch itself
- the spread between recent flash runs means we should treat `microsaas_obs` as a replicated benchmark, not a one-shot benchmark

## Important Efficiency Result

- `electron_spec + gated_role_loop` improved from roughly `37.4k` tokens for score `90` to `11.2k` tokens for the same score `90` after:
  - skipping redundant `pm_intake` after the first cycle
  - skipping PM/TL reprioritization on terminal cycles
  - preserving the stronger handoff structure instead of collapsing the workflow entirely

This is the clearest current example of macro-level orchestration efficiency beating raw prompt minimization.

## What The Data Suggests About Agent Handoffs

- Full collapse is bad. Removing too many role transitions hurts quality.
- Blind repetition is also bad. Re-running PM/TL intake after every cycle burns tokens without adding much.
- The useful pattern is:
  - keep strong role specialization for `planning -> execution -> review -> judge`
  - keep PM/TL guidance early
  - keep PM/TL reprioritization only when another cycle will actually use it
  - avoid paying for orchestration turns after the judge has already effectively ended the run

## What Still Needs Work

- `eval_loop` should get harder if we want it to remain a ranking benchmark.
- `microsaas_obs` should be run with replication when comparing policies, because the variance is now clearly visible.
- `electron_spec` still has a reachable final gap around renderer completeness and smoke coverage; the best current score is `90`, not `100`.
- `branch_rank_revise` needs a benchmark where the branch hinge is genuinely valuable, not just available.

## Recommended Next Moves

- Treat `gated_role_loop` as the default policy for general work unless a benchmark proves otherwise.
- Treat `branch_rank_revise` as the best current option for harder product/backend tasks like `microsaas_obs`, but verify with replicated runs.
- Keep `single_pass` only for cheap calibration or very easy briefs.
- Keep `lean_handoff_loop` as a useful ablation, not a default.
- Add a replicated frontier command or reporting mode so policy comparisons on `microsaas_obs` are based on multiple runs instead of one sample.

## Stateful Eval Rig Updates

The stateful notes chain exposed several harness problems that were not obvious in the earlier one-shot benchmarks.

- OpenRouter usage accounting was undercounting phase cost because we were only keeping the final completion usage per phase. The harness now aggregates usage across every model turn inside a phase.
- Run reports now break usage down by phase, plus execution vs coordination totals, and estimated OpenRouter cost.
- `chain` now carries forward the repo, architecture directives, condensed handoff notes, and unresolved priority items instead of only the repo and a short note list.
- Judge failure details now flow into later-cycle prompts and reprioritized backlog items, which makes repair cycles far more actionable.
- The stateful benchmark itself had a fairness bug around colocated tests. Stage 1 now accepts both `test/**` and standard `src/*.test.*` or `src/*.spec.*` layouts.
- The CLI now exposes `--seed` and `--handoff-ledger`, so we can rerun a benchmark from a prior repo/ledger state without writing ad hoc scripts.

## Stateful Benchmark Findings

### Stage 1

- `qwen-coder-flash + repair_focus_loop` now reached `100` twice on `stateful_notes_stage1`.
- The strongest chained stage-1 repair run landed at `100` with `115.1k` tokens and about `$0.0171` estimated cost.
- That same run split spend almost evenly: `57.6k` execution tokens vs `57.5k` coordination tokens.
- A fresh standalone validation run after the latest prompt tweaks also reached `100`, which makes the stage-1 result feel repeatable rather than lucky.

### Stage 1 Workflow Comparison

- `qwen-coder-flash + gated_role_loop` on the chained stage-1 run only reached `84`, with `147.6k` tokens and about `$0.0226` estimated cost.
- On that run, `gated_role_loop` spent more, produced lower quality, and carried unresolved stage-1 debt into stage 2.
- The largest observed difference was not raw coding ability. It was whether the policy forced later stages to keep repairing earlier-stage mistakes.

### Stage 2 Partial Read

- `qwen-coder-flash + repair_focus_loop` reached `84` on `stateful_notes_stage2` in two cycles.
- By the end of that run, every substantive stage-2 requirement was green except one docs requirement: the `README` still missed the `## Operations` section.
- `qwen-coder-flash + gated_role_loop` entered stage 2 already carrying stage-1 debt, then only reached `47.9` after cycle 1 because it was still fighting broken tests and missing carryover fixes.
- The carryover mechanism is now doing something real: the clean stage-1 path entered stage 2 with architecture memory and almost no debt, while the weaker path entered stage 2 with explicit unresolved priorities.
- A targeted rerun of `stateful_notes_stage2` from the clean stage-1 repair ledger with **3 cycles** still finished at `84`.
- That extra-cycle result strongly suggests the remaining stage-2 miss is not just a cycle-budget issue. The current repair workflow is still under-prioritizing the final cross-docs update to `README.md`.

### Full Three-Stage Chain

- `qwen-coder-flash + repair_focus_loop` completed the `stateful_notes_stage1 -> stage2 -> stage3` chain with stage scores of `100 / 84 / 100`.
- That chain used about `392.3k` tokens for roughly `$0.0602` estimated OpenRouter cost and finished with an average stage score of `94.7`.
- `qwen-coder-flash + gated_role_loop` on the same chain only reached `84 / 47.9 / 70`.
- That weaker chain still spent more: about `519.2k` tokens and `$0.0775`, with an average stage score of only `67.3`.
- The repair-focused chain therefore won on both quality and macro efficiency. It spent roughly `126.9k` fewer tokens and about `$0.0173` less while producing much stronger repos.

### Stage 3 Read

- `repair_focus_loop` reached `100` on `stateful_notes_stage3` in two cycles, starting from a stage-2 repo that still had one carried docs gap.
- `gated_role_loop` only reached `70` on stage 3 and was still failing tests plus the `README` requirement.
- The strongest difference was that the repair-focused path kept earlier quality intact, while the gated path kept dragging unresolved test failures forward.

### What This Changes

- For stateful chained work, `repair_focus_loop` currently looks stronger than `gated_role_loop`.
- The earlier recommendation of “default to gated” still holds for the older one-shot product benchmarks, but the stateful chain is telling a different story.
- The likely reason is that richer judge-detail handoffs plus less repeated orchestration seem to help more once the repo already has momentum.
- The current best split is:
  - use `repair_focus_loop` for chained stateful work where each stage inherits a real repo
  - keep `gated_role_loop` as a strong option for one-shot benchmark cells like `electron_spec`

## June 6 Recovery Pass

The long HFT bootstrap probe exposed a different class of failure from the earlier quality/cost work: coordination quality was improving, but the harness still let some phases fail in bad ways.

- PM/TL intake and planning were still capable of hitting action limits and collapsing into low-signal fallback state on larger empty-repo benchmarks.
- Execution could also fake progress by returning a confident `finish` payload without having actually written files.
- Manual interruption left the run artifacts mostly inspectable, but the shutdown path was not deliberate enough.

### Harness Fixes

- Planning-style phases now get much larger read-only budgets and recover by forcing a structured `finish` instead of dropping to an empty fallback.
- Bootstrap repos now trigger a stronger rule: after one or two confirmation steps, PM/TL and planning are pushed to synthesize the handoff instead of wasting more reads.
- Forced-finish recovery now preserves backlog, work breakdown, architecture directives, and test strategy using contextual fallback synthesis.
- Execution now records actual file and command activity from tool traces instead of trusting self-reported `filesTouched` or `commandsRun`.
- Bootstrap execution can no longer finish successfully without real repo progress.
- `SIGINT` and `SIGTERM` now persist active run/chain state before exit.

### Validation

- A new runner-level test now covers planning limit recovery, forced-finish fallback, and the “execution claimed work without actual writes” case.
- `tiny_smoke + qwen-coder-flash + gated_role_loop` still completes cleanly after the recovery changes and reached `100` in one cycle at about `47.9k` total tokens.
- `hft_firm_stage1_foundation + qwen-coder-flash + repair_focus_loop` improved from the earlier misleading bootstrap behavior to an honest `50` in one cycle. The important part is not just the score bump from `30 -> 50`; it is that the execution phase now shows real traced writes and the judge is scoring the repo that actually exists.
- `hft_firm_stage1_foundation + qwen-coder-next + repair_focus_loop` still looks less stable on this benchmark shape. One fresh pass recovered PM/TL intake after repeated invalid model actions, which is better than dying, but it reinforces that the harness should treat `qwen-coder-next` as powerful but not automatically more reliable under large coordination prompts.

### Practical Read

- The planning-limit failure mode should now be rare rather than common.
- The more important win is honesty: the harness now distinguishes between “the model planned well,” “the model actually edited the repo,” and “the model only said it edited the repo.”
- For stage-1 HFT-style bootstrap work, `qwen-coder-flash` currently looks like the safer calibration worker because it will actually move the repo forward, even if the first pass is still incomplete.
