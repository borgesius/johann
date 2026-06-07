# Dotcom Idle Game

Build a high-quality TypeScript web game in the incremental/idle tradition of things like Kittens Game, A Dark Room, Universal Paperclips, and Trimps.

This should start in a digestible clicker-ish or lightly active form, then unfold into a deeper resource-management and strategic simulation over many hours and many days of play.

The tone should be satirical and affectionate toward tech/finance culture: think dotcom bubble mania, growth-at-all-costs nonsense, dashboards, valuation theater, founder delusion, and increasingly absurd forms of optimization. The look should feel late-90s / early-2000s web-portal, startup-console, market-bubble, and investor-deck adjacent rather than generic fantasy or sci-fi.

Do not build a shallow idle clone with lots of disconnected systems. Build one genuinely rich game with a strong spine that keeps deepening.

## Core Goal

The game should feel like a serious contender in the genre:
- compelling in the first 5 minutes
- interesting over the first few hours
- still strategically alive after multiple days of intermittent play
- replayable because later mechanics change earlier assumptions, not because there are random extra features glued on

The player should feel like they are bootstrapping, scaling, financializing, automating, and destabilizing some absurd dotcom-era machine.

## Product Shape

Make it a web application, not just a design document or a mock menu.

Ship a production-like repo with:
- TypeScript throughout the main product code
- a real playable loop
- game state, progression, and balance systems that are readable in code
- docs for development and for game design / balance
- at least one meaningful automated test or simulation path

## Required Design Direction

The game should begin simply and become legible before it becomes dense.

Early phase:
- one or two active verbs
- a handful of resources
- fast feedback
- the player can make meaningful progress in a short session

Mid phase:
- automation opens up
- resource conversion chains appear
- strategic allocation becomes important
- the player starts deciding how much to play actively vs passively

Late phase:
- the game introduces richer system interactions, bottlenecks, prestige/replay structure, or mutually shaping subsystems
- previous assumptions about optimal play should evolve
- replayability should come from changed leverage and new routes, not arbitrary content piles

## Required Systems

### 1. Core Resource and Progression Loop

There must be a strong central loop around producing, converting, allocating, and reinvesting resources.

The early loop can begin in something familiar and active, but it must not stay there.

The game should include:
- primary resources
- derived resources
- upgrades or infrastructure that alter production logic
- meaningful bottlenecks
- visible compounding

### 2. Active vs Passive Play Design

Treat active play and passive play as first-class design problems.

The game should explicitly think through:
- what active players can do that is interesting rather than just spammy
- what passive/returning players gain over time
- how session length changes optimal choices
- what a “check in every few minutes” player experiences versus a “one longer evening session” player

This should be reflected both in the game design and in the docs.

### 3. Progression Forecasting and Balance Thinking

The repo should include a balance/progression note that estimates:
- expected time to early milestones
- expected time to mid-game milestones
- expected time to replay/prestige or deeper unlock milestones
- rough assumptions for different play patterns

For example:
- short frequent play
- occasional medium sessions
- mostly passive check-ins

This does not need to be perfect, but it should be thoughtful and testable rather than vibes-only.

### 4. Replayability / Reset / Epoch Shift

Some form of replayability, reset, epoch shift, prestige, or changed-run structure should exist or be strongly scaffolded.

The important thing is that later runs feel different in strategic texture, not merely faster.

### 5. Theme and Satire

The satire should come through mechanics, UI writing, and progression framing.

Good source areas:
- vanity metrics
- growth hacking
- ad spend nonsense
- investor confidence as a resource
- market euphoria and panic
- corporate restructuring
- the gap between “real value” and valuation theater
- increasingly automated exploitation or absurd finance-engineering

But the game should still be fun first, satire second.

## UX / Aesthetic Direction

Use a deliberately designed web interface with:
- compact dashboards
- satisfying number readability
- good information hierarchy
- strong affordances for idle/incremental play
- a dotcom bubble / portal / terminal / investor console aesthetic

Avoid:
- generic Tailwind dashboard slop
- fantasy idle-game defaults
- feature sprawl with too many equal-weight panels

The interface should help the player understand what matters now, what is bottlenecking them, and what unlock is looming.

## Architectural Expectations

The game should have a clear shared system spine, such as:
- simulation state
- resource model
- production rules
- automation logic
- progression milestones
- reset/replay structure

Multiple UI surfaces should depend on that same system rather than each panel inventing its own world.

## Deliverables

Leave behind:
- a runnable game
- `README.md` with development instructions
- `docs/game-design.md`
- `docs/balance.md` or equivalent
- at least one automated test or simulation path that proves part of the progression/balance logic

Aim for a truly rich incremental game prototype that feels like the beginning of a genre-worthy obsession, not a polished fake.
