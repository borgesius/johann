# Stateful Notes, Stage 3

The notes repo has already grown. Add one more layer without losing control of it.

Extend it with import/export style behavior and lightweight observability guidance. The goal is not maximal features. The goal is showing that the repo can keep evolving without becoming a mess.

Keep the codebase feeling intentional while adding:
- an import or replay flow
- an export or snapshot flow
- observability documentation
- tests that prove the later-stage workflow still works
- the existing modular `src/` shape instead of flattening the repo as it grows

Assume a tired engineer will open this repo after you and judge whether the accumulated decisions still make sense.
