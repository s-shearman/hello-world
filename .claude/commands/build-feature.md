# .claude/commands/build-feature.md
Phase 3 implementation gate. Requires Phase 1 design + Phase 2 plan to exist.

Pre-flight: confirm ADR (`docs/decisions/`), UX spec (`docs/ux/`), and plan (`docs/plans/`). If any missing, stop and run `/design-feature` or `/plan` first.

Discipline: `superpowers:executing-plans` for orchestration, `superpowers:test-driven-development` per agent, `superpowers:verification-before-completion` before any "done" claim.

Spawn: Lead=product-owner,
       + backend-dev, frontend-dev (or mobile-dev),
       + integrations-dev if external API,
       + ai-engineer if Claude API,
       + qa-tester.
Task: Implement $ARGUMENTS

Sequence: backend → frontend/mobile → qa.
Each agent runs `npm run typecheck && npm test` before reporting done.
