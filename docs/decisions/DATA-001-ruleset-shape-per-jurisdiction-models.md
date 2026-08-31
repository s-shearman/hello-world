# DATA-001: Ruleset shape carries a deduction model and a rate model per jurisdiction

Status:   Proposed
Date:     2026-08-31
Decider:  Simon Shearman
Advisors: —

## Context

§8.1 sketches the ruleset file with a single `threshold.annual` and a single `rate`. That
shape holds for NSW and Tasmania. It does not survive contact with the other two
jurisdictions whose values we were able to source:

- **Victoria** has one rate but a deduction that phases out: full below $3,000,000 of
  Australia-wide wages, reduced at 50% of the excess between $3,000,000 and $5,000,000,
  nil above. One `annual` figure cannot express that.
- **Western Australia** has one rate but a *diminishing* deduction: `AT − (wages − AT) ×
  2/13`, nil at or above an upper threshold of $7,500,000. A different mechanism again.
- **Tasmania** has one deduction but *two rates*, banded on Australia-wide wages: 4.0%
  between $1,250,000 and $2,000,000, and 6.1% above.

Encoding these as a single number plus special cases in the calculation would put the
rules back into code, which §8.1 exists to prevent. Rate churn every July would then mean
editing branches rather than editing data.

## Decision

The ruleset carries a tagged `rate` model and a tagged `deduction` model, and the rule
functions dispatch on the tag:

- `rate.kind`: `flat` (with an optional published regional rate) or `tiered_by_au_wages`.
- `deduction.kind`: `fixed`, `phase_out` or `diminishing`.

Three further fields were added for the same reason — the sources publish them, and
without somewhere to put them they would have become constants in code:

- `monthly_threshold` holds a `basis` plus either a `flat_monthly_amount` (Victoria and WA
  publish a flat figure) or the day-count derivation (NSW and Tasmania publish
  `annual × days in month / days in year`), together with the revenue office's own
  published monthly figures as `published_examples` for regression.
- `rounding.deductible_amount`, because the offices state their rounding only through
  worked examples and they disagree: NSW prints $201,643.84 and Victoria $27,777.67, so
  those keep cents, while RevenueWA prints $969,231 for an exact $969,230.77.
- `surcharges` and `contractor_exemptions` are wrapped in `Maybe`, so an empty array can
  assert "this jurisdiction has none" — itself a sourced claim — distinctly from null,
  meaning "we have not looked".

Money stays integer cents as `bigint`. Rates become integer parts per million, because
1.2125% is not representable as an exact number of basis points. Tapers that are genuinely
fractions stay rational: WA's is `{numerator: 2n, denominator: 13n}`.

## Consequences

Adding a jurisdiction whose mechanism is new means adding a variant and a `switch` arm,
which the compiler will find for us, rather than discovering it as a wrong number in a
report. Four mechanisms across four jurisdictions suggests QLD, SA, ACT and NT will
contribute at least one more when they can be reached.

The cost is that a ruleset file is no longer uniform across jurisdictions, so it cannot be
diffed field-for-field between states. Diffing the same jurisdiction across financial
years — the comparison that actually matters every July — is unaffected.

`packages/calc` must not learn the tags. It asks `deductibleAmount`, `rateFor` and
`taxPayable` for a `Traced<Cents>` and stays ignorant of which mechanism produced it.

## Alternatives considered

**One flat shape with nullable extras.** Every jurisdiction gets every field, with the
irrelevant ones null. Rejected because null then means two different things — "does not
apply here" and "not sourced" — and the sourcing gate cannot tell them apart. That
distinction is the whole point of the gate.

**A formula string or small expression language per jurisdiction, evaluated at runtime.**
Maximum flexibility, and it would absorb any future mechanism without a schema change.
Rejected because it is untraceable in the way this tool specifically needs: an output has
to name the rule it applied to a state manager who will dispute it, and "evaluated the
expression in the WA file" is not an answer. It also puts arithmetic beyond the reach of
the type checker.

## What would change this

A fifth mechanism appearing among QLD, SA, ACT and NT that is not expressible as a tagged
variant — a deduction that depends on something other than Australia-wide wages, say, or
a rate that depends on industry. At that point reconsider the expression language, with
the traceability problem solved first rather than deferred.
