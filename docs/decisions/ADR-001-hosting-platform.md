# ADR-001: Hosting platform

Status:   Proposed
Date:     2026-08-30
Decider:  —
Advisors: cto, devops, cfo

## Context

`docs/schema-proposal.md` §2 settles the stack — Postgres 16, Drizzle, Fastify,
React/Vite, with the calculation engine as a pure package — but deliberately
leaves hosting open. The choice is not urgent for design work and is urgent
before any infrastructure work begins, so it is recorded here rather than
decided by whoever writes the first pipeline.

Two facts constrain it. The database holds salary data for the whole business
across four offices, so access control, encryption at rest and audited access
are day-one requirements rather than later hardening. And a payroll tax
position must be reconstructable at assessment time, which makes restorable,
test-restored backups a selection criterion, not an operational detail.

## Decision

Not yet made. This ADR exists to hold the question open and visible.

## Consequences

Until it is settled, `devops` assumes no cloud provider and no provider-specific
services. Anything written against a specific platform before this ADR is
accepted is rework.

## Alternatives considered

To be recorded when the decision is taken.

## What would change this

Not applicable until decided. Settle it before the first deployment pipeline is
written.

---

*Indicative only. Requires review by a registered tax agent.*
