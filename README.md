# Johann

> “Bach said that all his achievements were simply the fruit of industry. But that presupposes humility and an enormous capacity for suffering.”
>
> — Ludwig Wittgenstein, *Culture and Value*

`@borgesius/johann` is a local workbench for generating software from seed briefs, evaluating the results, and iterating on the system itself.

In plain language:
- Johann runs the loop.
- OpenCode handles tool use and execution.
- OpenRouter/Qwen supplies the model.

A **seed** is the starting brief. A **generation** is a concrete artifact produced from a run of that seed. The `Version` column below means **Johann version**, not app version.

| Version | Name | Description | Model | Policy | Timing | Seed | Generation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `v0.1.0` | Becoming Site | Elaborate philosophy site about being as stabilized becoming, negatively known limit-points, and nonlinear exploratory surfaces. This is marked `v0.1.0` because the generation was produced before later repo changes. | `qwen-coder-hybrid-opencode` | `repair_focus_loop` | roughly `45 min` (manually terminated) | [philosophy-becoming-site.md](examples/briefs/philosophy-becoming-site.md) | [repo](.bench/runs/brief-philosophy-becoming-site-qwen-coder-hybrid-opencode-repair-focus-loop-2026-06-07T02-09-50-519Z-7efbee/repo) |

Johann keeps thin structural checks with each seed, but the main judgment is generic: it looks at the repo, validations, trajectory, and recent work to decide how strong the artifact really is and what should happen next.
