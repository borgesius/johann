# HFT Firm Game Stage 1: Foundation

Build the foundation for a high-quality TypeScript/Electron desktop management game about running a high-frequency trading firm.

If a prior repo already exists, preserve it and improve it. If not, bootstrap the project cleanly from scratch.

This stage is about creating a strong playable shell and coherent architecture, not shipping the entire dream in one pass.

## Goal

Ship a polished vertical-slice foundation with:
- Electron `main`, `preload`, and `renderer` structure
- a 90s office / terminal-inspired management interface
- a digestible top-level dashboard
- clear navigation into the future core systems:
  - staff and organization
  - markets and latency reach
  - trading engine / node board
  - projects and task flow
- a readable architecture that can support later stages

## Required Slice

The player should already be able to open the app and understand:
- what kind of firm they are running
- what resources matter
- where staff, markets, projects, and engine systems will live
- how the game will gradually reveal complexity

The shell should already hint at a harsh internal culture: performance dashboards, delivery pressure, scrutiny, and politically loaded management signals should feel native to the firm's identity even before later systems deepen them.

Use seed data and lightweight simulation if needed, but make the shell feel intentional rather than fake.

## UX Direction

- simple but strong presentation
- dense dashboards, terminals, tables, panels, and maps over art-heavy scenes
- onboarding should be calm and readable
- avoid overwhelming the player in minute one

## Delivery Expectations

Ship a repo with:
- shallow Electron entrypoints such as `src/main.ts` (or `src/main.js`) and `src/preload.ts` (or `src/preload.js`)
- renderer files under `src/renderer/`, ideally including `index.html`, `index.ts` or `index.js`, and `styles.css`
- a strong top-level UI shell
- simulation/state model files under `src/` with names that clearly reference `state`, `model`, or `sim`
- `README.md`
- `docs/game-design.md`
- `docs/architecture.md`
- at least one smoke test or automated test path

Avoid nesting Electron entrypoints under extra directories unless you also keep the shallow root entry files above. This stage should leave behind a repo shape that later stages can extend without having to move the desktop boot files around.
