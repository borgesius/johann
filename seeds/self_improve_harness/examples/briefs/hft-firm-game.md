# HFT Firm Management Sim Brief

Build a high-quality TypeScript/Electron desktop management game about running a small high-frequency trading firm and scaling it into something dangerous, weird, and fragile.

This should feel like a rich simulation with a strong vertical slice, not a contentless shell and not an infinite-scope dream pitch. Favor coherent systems, readable UX, and interesting interactions over asset polish.

## Core Fantasy

The player is not writing code. They are managing people, projects, office operations, network reach, trading systems, and the consequences of those choices.

The game should support stories like:
- a brilliant but chaotic developer shipping a fast node with hidden risk
- tension between staff personalities affecting delivery quality
- a cutthroat culture of performance monitoring, ranking, and political survival distorting decisions
- operational upgrades opening new market opportunities
- latency and engine design interacting in non-obvious ways
- incidents or fiascos that emerge from management decisions rather than random punishment

The best version should feel like a management sim where the player can eventually create their own "how did we let that happen?" moments.

## Required Player Loops

The playable slice should make these loops clear:

1. Run the firm day to day.
   - review staff, projects, market conditions, cash, and current strategy
   - assign people to work, reshuffle priorities, and decide when to push or stabilize

2. Expand physical/network reach.
   - build out high-speed wiring or colocation access through a map-based path or route system
   - buying better routes or reaching new exchanges/markets should change latency and available opportunities

3. Build the trading engine.
   - development teams should create algorithm/system parts as tasks
   - completed parts should be placed onto a 2D grid or node board
   - adjacency, composition, and slotting should matter
   - part quality should vary based on who made it and how the project was managed

4. Trade and react.
   - the combination of market access, latency, and engine composition should affect which opportunities appear and how profitable or risky they are
   - the player should be able to make money without being a genius, but clever composition should create visible advantages

## Required Simulation Systems

### People and Organization

Model employees as people with strengths, weaknesses, quirks, and relationships. Good candidates include:
- speed
- reliability
- performance visibility or political exposure
- political friction
- focus
- creativity
- operational discipline
- risk appetite
- burnout or fatigue pressure

The firm culture should feel sharp-edged and competitive. Performance monitoring, internal status games, pressure from management, and surveillance-like metrics should all shape how people behave and what kinds of failure emerge.

Project outcomes should clearly reflect who worked on them, under what constraints, and with what team dynamics.

### Wiring and Market Reach

Represent market expansion as a map or route network.
- latency should be a first-class stat
- new routes should expose new local markets or better versions of existing opportunities
- some engine pieces should become better or worse depending on where the firm has access and what latency it can achieve

### Trading Engine Grid

Represent the trading engine as parts or nodes arranged on a 2D board.
- parts should have roles and stats
- some parts should modify or amplify others
- quality and defect risk should vary
- latency should matter for at least some node types in a special way
- project management decisions should affect output quality, overhead, or hidden risk

### Market and Failure Simulation

The game should not just be "number go up."
- markets should have changing conditions or local quirks
- bad management should create plausible incidents, not just arbitrary punishments
- the player should be able to recover from mistakes sometimes, but not always cheaply

## UX and Aesthetic Direction

Keep visuals simple, sharp, and readable.
- no need for rich art or animation
- prefer panels, tables, terminals, maps, menus, and compact dashboards
- use a 90s office / computer terminal aesthetic
- make the early game digestible and progressively reveal complexity

The player should not be overwhelmed in minute one.

## Delivery Expectations

Ship a production-like Electron repo with:
- `main`, `preload`, and `renderer` structure
- a readable simulation/game architecture
- a root `README.md` with development and core-systems guidance
- a `docs/game-design.md` or equivalent design note
- at least one smoke test or basic automated test path

Aim for a genuinely playable management-game prototype with believable interlocking systems, not just mocked menus.
