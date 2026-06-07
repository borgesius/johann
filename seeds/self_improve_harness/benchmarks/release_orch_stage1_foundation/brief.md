# Release Orchestration Stage 1: Foundation

Build the clean-room foundation for a dependency-aware release orchestration product.

This product should feel like a real internal platform for operators and release engineers, but every provider integration is simulated locally. Do not model this on any employer-specific system or naming. Keep it generic and productized.

## Goal

Ship a solid repo foundation for:
- a local control-plane server
- a simple operator web shell
- a service dependency graph
- a simulated fleet and environment model
- initial promotion policy and impact-analysis surfaces

## Required Slice

By the end of this stage, the repo should already feel like a release-control product rather than a toy:
- a fictional fleet with service dependencies
- a release queue and service graph visible in the web shell
- policy language for approvals, downstream testing, verification, and rollback
- docs that explain the system model in clean-room product terms

The webapp and server should exist from the start, but a deep operator UX can come later.
