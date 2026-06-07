# Stateful Notes, Stage 1

Build the first version of a small internal notes service that will need to survive later iterations.

This is not meant to be flashy. The important thing is making early decisions that another engineer can extend without hating you later.

The repo should feel like a real foundation:
- one simple note capture and list workflow
- a conventional `src/` layout with a clear server entry
- a separate storage layer instead of burying everything in one file
- basic health and readable diagnostics
- enough test and docs shape that stage 2 can build on it
- a root `README.md` that explains development and architecture

Favor boring clarity over cleverness.
