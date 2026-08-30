# ADR-002: The three numbers on the ELT view

Status:   Accepted
Date:     2026-08-30
Decider:  CEO
Advisors: CTO, CPO, CFO

## Context

`docs/schema-proposal.md` §11 defines six outputs. `CLAUDE.md` commits the ELT
view to a position and a decision — three numbers, not a dashboard — so the
choice is zero-sum. Whichever three win become what the board asks about
monthly, and therefore what the business optimises.

The candidates answer to different owners and imply different next decisions:
coverage of shared cost (finance, move the admin charge), capacity against
hours sold (delivery, hire or subcontract), and margin at the current rate card
(commercial, reprice).

Three constraints shaped the call:

- **Only capacity is computable today.** It touches no ruleset. Every rate and
  threshold in §8.1 is still `null`, so both other numbers are blocked until
  the four jurisdictions are sourced.
- **Rate card margin currently points the wrong way.** Until the §L5.7
  double-count question is settled — whether sell rates already carry overhead
  that the admin charge also recovers — the margin figure misstates in an
  unknown direction.
- **No ELT member reprices a role from a board pack.** That decision sits with
  commercial and state managers, who need the per-role, per-state detail the
  ELT view deliberately excludes.

## Decision

The ELT view carries three numbers, in this screen order:

1. **Coverage position** — deficit or surplus in dollars and coverage percent,
   at conservative revenue, with the basis stated. Triggers moving the admin
   charge, or trimming or adding non-billable heads, before the next quote
   round. **CFO acts.**
2. **The week we run out**, per state, raw and effective hours together.
   Triggers pulling forward a hire or booking subcontract capacity before a job
   is short-staffed. **COO with the state manager acts.**
3. **Payroll tax headroom to the next threshold**, worst state beside the
   national total. Triggers provisioning cash, and referring grouping and
   deeming questions to the accountant. **CFO acts.**

Rate card margin is **not** an ELT number. It remains a first-class output
(§11.4) for commercial and state managers.

Exposure ships as **headroom, not a total**. A total is a number we look at;
headroom is a distance to where behaviour must change.

Build order differs from screen order. Capacity is built first, being the only
candidate computable now, and its blocker is judgement we can start resolving
immediately — efficiency ratings written down, attributed and effective-dated.
Ruleset sourcing runs in parallel from day one. Headroom second, coverage third,
since coverage needs the marginal rate on a fully loaded pool. `Traced<T>` goes
into all three from the first function; retrofitting means rewriting
`packages/calc`. The view ships when all three are live.

## Consequences

The ELT loses sight of profitability by role. Repricing pressure now comes up
through commercial rather than down from the board, and §L5.7's double-count
question loses the forcing function a board-level margin number would have given
it. That question must be closed deliberately instead.

The first number on the screen rests on the softest inputs. Coverage depends on
efficiency ratings that are currently delivery judgement, and on a conservative
revenue figure that is itself a choice. Both must carry their basis and their
review date visibly, per §7 and §L5.6.

Making exposure a headroom figure rather than a total means the board sees
distance-to-consequence rather than a liability. This is the intent, but it will
read as understating exposure to anyone expecting a provision figure, and should
be explained the first time it is presented.

## Alternatives considered

**Rate card margin as the third number.** Rejected because no ELT member
reprices from a summary. They would ask for the detail view, making the headline
decorative — and until §L5.7 is settled it would be decorative *and* wrong.

**Payroll tax exposure as a total, and first.** The CFO argued exposure gates
the other two and carries immediate legal and cash consequence. Accepted in
substance but changed in form: shipped as headroom, and placed third, because
exposure describes risk while coverage and capacity each trigger an action this
quarter. Promoting it is explicitly contemplated below.

**Waiting for the rulesets before shipping anything.** Rejected. Capacity is
useful on its own, and its dependency — writing down and attributing efficiency
ratings — is work that must happen regardless and takes calendar time to do
honestly.

## What would change this

Worst-state headroom falling below roughly one FTE of annual wages, or a
grouping or deeming determination moving deemed wages materially. Either
promotes exposure to the first position.

Separately, coverage holding within ±2% for three consecutive quarters means it
has stopped triggering a decision. Demote it, and reconsider rate card margin
once §L5.7 is closed.

---

*Indicative only. Requires review by a registered tax agent.*
