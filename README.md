# Johann

`@borgesius/johann` is the root repo for Johann: a local generation harness, seed corpus, and evaluation workbench for building Johann apps.

At the root, Johann is not a single finished app. It is the system that:
- stores seeds and briefs for Johann app lines
- runs and evaluates medium-to-long autonomous generations
- preserves benchmarks, prompts, policies, and tooling for improving the generator itself

This repo is intentionally simple at `v0.2.0`: no showcase webapp yet, just the source tree, the run/eval machinery, and a release index that makes it easy to point people at specific versions and generation lines.

## Tagged Versions

| Version | Tag | Notes |
| --- | --- | --- |
| `v0.1.0` | local-only | Earlier local Johann cut before the public GitHub setup. |
| `v0.2.0` | [`v0.2.0`](https://github.com/borgesius/johann/releases/tag/v0.2.0) | First public Johann repo release: repo structure, generation index, seeds, and local runner/eval tooling. |

## Tagged Generations

These are currently **indexed generation lines**, not separate frozen artifact snapshots. Right now the `g0-*` tags all point at the same public root release commit and act as navigational labels for the first Johann generation families. When we want to preserve a specific standout output, we should cut a dedicated artifact tag for that exact generated repo state.

| Version | Name | Description | Seed | Generation |
| --- | --- | --- | --- | --- |
| `v0.2.0` | Johann Core | Public Johann root release with the base repo structure, release ledger, and local generation/eval tooling. | `repo/bootstrap` | [`g0-core`](https://github.com/borgesius/johann/tree/g0-core) |
| `v0.2.0` | Becoming Site | Elaborate philosophy site about being as stabilized becoming, negatively known limit-points, and nonlinear exploratory surfaces. | [`examples/briefs/philosophy-becoming-site.md`](examples/briefs/philosophy-becoming-site.md) | [`g0-becoming-site`](https://github.com/borgesius/johann/tree/g0-becoming-site) |
| `v0.2.0` | HFT Firm Game | TypeScript/Electron management sim seed about building and surviving inside a cutthroat high-frequency trading firm. | [`examples/briefs/hft-firm-game.md`](examples/briefs/hft-firm-game.md) | [`g0-hft-firm-game`](https://github.com/borgesius/johann/tree/g0-hft-firm-game) |
| `v0.2.0` | Release Control | Dependency-aware release orchestration and promotion software seed for multi-service deploy/test/rollback workflows. | [`examples/briefs/release-control-direct.md`](examples/briefs/release-control-direct.md) | [`g0-release-control`](https://github.com/borgesius/johann/tree/g0-release-control) |

## Repo Shape

- root: Johann itself as harness/workbench, not one generated app
- `examples/briefs/`: direct seeds for Johann app generations
- `benchmarks/`: reusable benchmark specs and staged tasks
- `src/`: local runner, judging, reporting, and orchestration code
- `test/`: regression coverage for evaluator, loop, prompts, and runners
- `seeds/`: seed repos and stage scaffolds used by benchmark/generation runs
- `scripts/`: repeatable run/watch helpers
- `.bench/`: local generated runs and artifacts

## Local Use

```bash
npm install
npm run dev -- list
```

Run a generation from a seed:

```bash
npm run dev -- loop --brief-file examples/briefs/philosophy-becoming-site.md --worker qwen-coder-hybrid-opencode --policy repair_focus_loop --budget 480 --max-cycles 16 --disable-plateau
```

Watch a generation:

```bash
npm run dev -- watch --latest --benchmark brief-philosophy-becoming-site --worker qwen-coder-hybrid-opencode --policy repair_focus_loop
```

## Versioning Notes

- `v0.1.0` was a local-only Johann cut and is intentionally left unlinked.
- `v0.2.0` is the first public Johann repo cut.
- `g0-*` labels are the first indexed generation lines under the Johann name, not separate frozen artifact commits yet.
- Future tags can either stay repo-level (`v0.1.1`, `v0.2.0`) or add generation-specific tags if we want to freeze standout outputs separately.
