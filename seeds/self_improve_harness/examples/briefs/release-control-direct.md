# Release Control Direct

Build a production-like web application for release operators managing a fictional multi-service fleet.

The product should make it easy to answer:
- what is being deployed right now
- what downstream services are affected
- which tests were selected and why
- what is blocking promotion
- whether rollback is warranted

Focus on:
- a clear operator-facing web UI with a queue, a release detail view, and an explanation surface
- a credible server-side model for services, dependency edges, release plans, and run events
- a local simulator for deploy, verify, and rollback events so the app feels alive instead of static
- concise but useful docs for development and the core domain model

Do not optimize for visual flourish. Optimize for clarity, depth, and coherence so the result feels like a serious product attempt rather than a dashboard shell.
