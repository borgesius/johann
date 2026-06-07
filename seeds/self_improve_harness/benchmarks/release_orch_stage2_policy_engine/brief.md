# Release Orchestration Stage 2: Policy Engine

Extend the clean-room foundation into a real planning engine.

The system should be able to take a release request, inspect the service graph and policy model, choose downstream and cross-service checks, and explain why that plan was selected.

## Goal

Ship a planner that can answer:
- what services are impacted
- what tests should run
- what environments and approvals apply
- why the chosen plan is safe enough to promote

Keep all integrations simulated and productized. The planner should feel like the brain of the product, not a pile of pipeline YAML.
