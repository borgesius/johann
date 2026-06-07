# Stateful Notes, Stage 2

The repo already has a first pass of the notes service. Extend it without making it more chaotic.

Add a lightweight audit/history capability and make the storage layer feel more intentional. The repo should still be easy to hand off cold.

Keep earlier behavior working while adding:
- a history or audit surface
- the existing `src/` layout instead of scattering new files at the repo root
- clearer operations guidance
- stronger tests around the evolving workflow

Treat this as the moment where earlier design decisions either start paying off or start hurting.
