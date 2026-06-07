# Release Control Seed

Seed repo for a dependency-aware release orchestration product.

## Development

- `npm start` launches the local server on `PORT` or `4173`
- `npm test` runs the built-in smoke tests

## System Model

- `src/domain/` holds service graph and promotion policy models
- `src/sim/` holds the fictional fleet and environment state
- `src/server/` serves APIs and the operator web shell
- `src/web/` contains the operator console assets
