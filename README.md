# Johann

`@borgesius/johann` is the root repo for Johann apps, seeds, and tagged generations.

This repo is intentionally simple at `v0.2.0`: no showcase webapp yet, just the source tree, the run/eval machinery, and a release index that makes it easy to point people at specific versions and generations.

## Tagged Versions

| Version | Tag | Notes |
| --- | --- | --- |
| `v0.1.0` | local-only | Earlier local Johann cut before the public GitHub setup. |
| `v0.2.0` | [`v0.2.0`](https://github.com/borgesius/johann/releases/tag/v0.2.0) | First public Johann repo release: repo structure, generation index, seeds, and local runner/eval tooling. |

## Tagged Generations

| Version | Name | Description | Seed | Generation |
| --- | --- | --- | --- | --- |
| `v0.2.0` | Johann Core | Public Johann root release with the base repo structure, release ledger, and local generation/eval tooling. | `repo/bootstrap` | [`g0-core`](https://github.com/borgesius/johann/tree/g0-core) |
| `v0.2.0` | Becoming Site | Elaborate philosophy site about being as stabilized becoming, negatively known limit-points, and nonlinear exploratory surfaces. | [`examples/briefs/philosophy-becoming-site.md`](examples/briefs/philosophy-becoming-site.md) | [`g0-becoming-site`](https://github.com/borgesius/johann/tree/g0-becoming-site) |
| `v0.2.0` | HFT Firm Game | TypeScript/Electron management sim seed about building and surviving inside a cutthroat high-frequency trading firm. | [`examples/briefs/hft-firm-game.md`](examples/briefs/hft-firm-game.md) | [`g0-hft-firm-game`](https://github.com/borgesius/johann/tree/g0-hft-firm-game) |
| `v0.2.0` | Release Control | Dependency-aware release orchestration and promotion software seed for multi-service deploy/test/rollback workflows. | [`examples/briefs/release-control-direct.md`](examples/briefs/release-control-direct.md) | [`g0-release-control`](https://github.com/borgesius/johann/tree/g0-release-control) |

## Repo Shape

- `examples/briefs/`: direct seeds for Johann app generations
- `src/`: local runner, judging, reporting, and orchestration code
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
- `g0-*` labels are the first indexed generations under the Johann name.
- Future tags can either stay repo-level (`v0.1.1`, `v0.2.0`) or add generation-specific tags if we want to freeze standout outputs separately.
