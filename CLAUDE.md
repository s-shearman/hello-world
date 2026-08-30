# CLAUDE.md

Project instructions for Claude Code. Read this before doing anything in this
repository.

## What this is

A workforce cost, capacity and payroll tax model for an AV integration business
operating across NSW, VIC, QLD and WA, with one office in each. A single legal
entity employs staff and also engages subcontract labour — labour hire firms
supplying workers, sole trader subbies engaged directly, and subcontract
companies delivering an outcome. Crews cross state lines.

The tool answers four questions:

1. What is our payroll tax exposure per state, including deemed wages from
   contractor and labour hire arrangements?
2. What is the real margin on each role at our current sell rate card?
3. Do we have enough effective capacity to deliver the hours we have sold?
4. Where is the breakeven between hiring someone full-time and subcontracting
   the same capacity, adjusted for the fact that they are not equally
   productive?

The full design is in `docs/schema-proposal.md`. Read it before proposing any
schema or calculation change; it carries the reasoning, not just the shape.

## Scope boundary

**This tool models supply.** What capacity we have, what it costs, what payroll
tax it triggers, and what we recover.

**It does not forecast demand.** Hours sold arrive as an input — entered,
imported from CSV, or posted to `/api/v1/demand/hours-sold` by a separate
demand application. Where that source sends probability-weighted pipeline, this
tool uses the weighting as supplied and never re-weights it.

Proposals that pull demand forecasting into this repository should be refused
and the reason stated.

## Who the outputs are for

Three audiences with genuinely different needs. Conflating them produces
something that serves none of them.

| Audience | Wants | Shape |
|---|---|---|
| Delivery leads | Capacity against hours sold, by state and period, and the week we run out | Dense, daily use, high information density is fine |
| Finance | Exposure, threshold headroom, recovery position, with the working shown | Traceable, defensible to an accountant |
| State managers | Their office's position | Will dispute anything they cannot trace to its inputs |
| ELT and board | A position and a decision | Three numbers, not a dashboard |

The ELT view is deliberately not the operator view with fewer columns. It leads
with the position and the decision; detail is available on request, never on
arrival.

## Non-negotiables

These are settled. Changing one needs an ADR, not a commit.

- **No rate or threshold from memory.** Every tax value is a `SourcedValue<T>`
  carrying its source URL and retrieval date. A bare number must not compile.
  The application refuses to produce a figure for a jurisdiction whose ruleset
  has unsourced values, and names which.
- **Rules are data, not code.** `packages/tax-rules` holds versioned rulesets
  per financial year per jurisdiction. Rules change every July.
- **Every output number carries a trace.** Result plus working: the inputs, the
  rule applied, and which efficiency rating was used. A function returning a
  bare number is a bug.
- **Money is integer cents.** No floating point anywhere near a dollar figure.
- **Effective-dated, never destructive.** Salaries, assignments, efficiency
  ratings, sell rates and thresholds are superseded, not updated in place.
  Part-year apportionment is only correct if history survives.
- **Fully loaded cost, never base wages.** On-costs add 25-40%. A figure built
  on salary understates permanently and invisibly.
- **Payroll tax at the marginal rate** for any hire decision, not the average.
- **Overhead recovered exactly once.** If the project admin charge covers
  non-billable staff, the sell rate must not also carry it.
- **The disclaimer stands on every output.** Indicative only; requires review by
  a registered tax agent. This informs a conversation with our accountant. It
  does not replace one.

## Stack

Settled per `docs/schema-proposal.md`:

- Postgres 16, Drizzle ORM, migrations as reviewable SQL
- Fastify + TypeScript, OpenAPI generated (the demand app needs a contract)
- `packages/calc` — pure TypeScript, zero I/O, runs server-side and in-browser
- `packages/tax-rules` — versioned JSON rulesets + rule functions
- React 18, Vite, TanStack Query and Router
- Vitest, with golden-file tests built from revenue office worked examples

Open: hosting platform. Recorded as ADR-001; settle it before infrastructure
work begins.

## Workflow

Four phase gates. Each has a command. Do not skip forward.

| Phase | Command | Produces |
|---|---|---|
| 0 Strategy | `/csuite` | ADR in `docs/decisions/` |
| 1 Design | `/design-feature` | ADR, UX spec in `docs/ux/`, schema note if needed |
| 2 Plan | `/plan` | Implementation plan in `docs/plans/` |
| 3 Build | `/build-feature` | Code, tests, verified |
| — Validate | `/validate-domain` | Domain SME PASS/FAIL |

Phase 0 triggers: pricing and the admin charge, payroll tax treatment,
allocation methodology, what an output is allowed to claim, and anything
touching access to salary data.

Discipline skills are vendored in `.claude/skills/` and apply by default:
`brainstorming` before design, `writing-plans` and `executing-plans` for
orchestration, `test-driven-development` per implementation agent, and
`verification-before-completion` before any claim that something is done.

## ADR format

`docs/decisions/ADR-NNN-<topic>.md`, numbered sequentially, never renumbered.

```markdown
# ADR-NNN: <title>

Status:   Proposed | Accepted | Superseded by ADR-MMM
Date:     YYYY-MM-DD
Decider:  <who made the call>
Advisors: <who was consulted>

## Context
The situation and what forced a decision. Include the numbers if there are any.

## Decision
What we are doing. Stated in the active voice.

## Consequences
What this makes easier, what it makes harder, and what we accepted.

## Alternatives considered
What else was on the table and why it lost. One paragraph each.

## What would change this
The observation or number that should make us revisit.
```

Schema decisions use the same format as `DATA-NNN-<topic>.md`.
UX specs are `docs/ux/UX-NNN-<topic>.md` and state which audience they serve.

## Using /csuite to frame ELT expectations

`/csuite` exists mainly to answer *what should this calculator produce, and for
whom* — before more is built on assumptions about it.

Good questions for it:

- What are the three numbers the ELT should see first, and what decision does
  each support?
- Should the admin charge target full recovery of non-billable cost, or
  recovery plus a margin? At target revenue, or a conservative figure?
- Which allocation driver becomes the reporting default, given that none is
  objectively correct and the choice changes which state looks profitable?
- What is this tool allowed to assert, and where must it defer to the
  accountant?
- Who may see individual remuneration, and who may see only role averages?

Bad questions for it: anything with a factual answer, anything already settled
in Non-negotiables, and anything that is really an implementation choice.

The CEO frames in under 100 words, each advisor returns three points in under
150, the CEO decides, and the decision is written to an ADR. Advisors reference
existing documents by path rather than restating them.

## Conventions

- Australian English in all prose and identifiers (`utilisation`, `apportioned`).
- All monetary values AUD, ex-GST. Never assume a source file's GST basis; ask.
- Financial years as `FY2026-27`. Jurisdictions as `NSW`, `VIC`, `QLD`, `WA`.
- Raw and effective hours are always reported together and never collapsed.
- State the basis beside any figure: budget, actual or blended; at target or at
  conservative revenue.
- Report the worst state beside any national figure.
- No commit claims work is complete without the verification actually having
  been run.
