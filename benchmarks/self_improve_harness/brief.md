# Self-Improving Harness

Take this benchmark harness repo as the seed and make it meaningfully better at improving itself over long-running product loops.

This is not a request for cosmetic churn or a giant speculative rewrite. The target is a stronger version of the same system:
- better at evaluating its own product quality and technical quality
- better at deciding what to do next on broad product tasks
- better at proposing, tracking, and executing medium-horizon changes
- better at monitoring and explaining live state during long runs
- better at reasoning about larger architectural work such as dependency chains, concurrent or staged work, and loop design changes

Treat this as a serious product and systems task, not a benchmark box-checking exercise.

## Core Goals

The improved harness should make it easier to:

1. Seed a big open-ended product brief.
2. Let the system decompose the work into initiatives, delivery slices, and explorations.
3. Observe what it is doing and why while it runs.
4. Judge whether the resulting product is actually becoming stronger rather than merely more check-complete.
5. Iterate on the harness itself with explicit proposals, experiments, and follow-through.

## What To Improve

At minimum, push in several of these directions:

- richer self-improvement planning
  - the harness should be able to propose concrete changes to itself, track them, and evaluate whether they helped
- dependency-aware work
  - allow larger changes to be expressed as dependency-linked work rather than a flat queue
  - if you introduce sequencing or concurrency ideas, make them inspectable and testable
- stronger monitoring and operator visibility
  - the watcher and run artifacts should make it easier to understand current initiative, active slice, recent actions, risks, and next likely moves
- stronger product-level judgment
  - improve the system’s ability to say “this technically passes but is still weak”
- experimental loop design
  - create space for the harness to propose and compare core-loop improvements instead of only following a fixed workflow

## Constraints

- preserve the existing harness shape rather than replacing it with a totally different product
- keep the repo readable and testable
- prefer incremental architecture that can survive future self-improvement passes
- avoid fake complexity; every added subsystem should have a clear reason to exist
- if you introduce concurrency or dependency-chain logic, keep it deterministic and easy to inspect

## Strong Outcomes

A strong result will usually include:
- new domain or control-plane modules for self-improvement planning, dependency-aware work, or experiment tracking
- better watcher/reporting surfaces
- clearer docs explaining the new self-improvement model
- tests proving the new behavior

## Weak Outcomes

Avoid outcomes like:
- only tweaking copy in the watcher
- adding placeholder files with impressive names but no integration
- shallow feature sprawl without proof that the harness is becoming more capable
- giant rewrites that leave the system harder to run or reason about

## Product Bar

The finished repo should feel like a stronger, more self-aware orchestration harness that could realistically take more initiative on long-running product work, including changes to its own workflow and architecture.
