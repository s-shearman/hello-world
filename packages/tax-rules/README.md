# `@wf/tax-rules`

Versioned payroll tax rulesets, one file per jurisdiction per financial year, plus the
rule functions that read them. Rules are data, not code — they change every July, and a
new ruleset version lands rather than a patch to a calculation.

## Sourcing state, FY2026-27

Every value carries the URL it came from and the date it was read. Nothing here was
filled in from memory.

| Jurisdiction | Rate | Threshold | Base tax computable | Primary source |
|---|---|---|---|---|
| NSW | 5.45% | $1,200,000 fixed | **Yes** | [Revenue NSW rates and thresholds](https://www.revenue.nsw.gov.au/taxes-duties-levies-royalties/payroll-tax/rates-and-thresholds) |
| VIC | 4.85% metro / 1.2125% regional | $1,000,000, phasing out $3m–$5m at 50% | No — days apportionment unsourced | [SRO Victoria current rates](https://www.sro.vic.gov.au/payroll-tax-current-rates) |
| WA | 5.5% | $1,000,000 diminishing by 2/13 to $7.5m | No — interstate share basis and threshold rounding unsourced | [RevenueWA calculation guide](https://www.wa.gov.au/government/multi-step-guides/payroll-tax-employer-guide/calculation-payroll-tax-employer-guide) |
| TAS | 4.0% $1.25m–$2m, 6.1% above | $1,250,000 fixed | **Yes** | [SRO Tasmania rates and thresholds](https://www.sro.tas.gov.au/payroll-tax/rates-thresholds) |
| QLD | — | — | No — unreachable | Egress policy refuses `qro.qld.gov.au` |
| SA | — | — | No — unreachable | Cloudflare bot challenge on `revenuesa.sa.gov.au` |
| ACT | — | — | No — unreachable | Cloudflare bot challenge on `revenue.act.gov.au` |
| NT | — | — | No — unreachable | Egress policy refuses `treasury.nt.gov.au` |

`sourcingReport('FY2026-27')` returns this live rather than from this table. Trust the
function, not the README.

Not sourced for **any** jurisdiction yet, so the corresponding capability is refused
everywhere: the contractor exemption catalogue, the employment agency provisions,
superannuation treatment in the wage base, and the rounding of tax payable.

## The four gates

The sourcing gate is scoped by capability rather than applied whole. A missing contractor
exemption catalogue must stop us assessing a contractor payment; it should not stop us
reporting exposure on ordinary wages, or the tool refuses everything forever and gets
switched off.

- `assertCanComputeBaseTax` — rate, deduction, apportionment, surcharges, monthly
  threshold, threshold rounding.
- `assertCanAssessContractor` — the exemption catalogue and the employment agency rules.
- `assertCanBuildWageBase` — what belongs in taxable wages.
- `assertNexusVerified` — the nexus citation for this jurisdiction.

Each throws `UnsourcedRulesetError`, whose message names every offending field path and
the reason recorded against it. `assertFullySourced` is the strict all-fields variant.

## Nexus

`resolveNexus` implements PTA039, confirmed word-for-word against the NSW, WA and TAS
ruling texts and the Victorian restatement on 2026-08-31. See §4.1 of
`docs/schema-proposal.md` for the source table and for the two consequences that catch
people out. The function resolves one employee-month to exactly one jurisdiction, or flags
that it cannot — it never guesses, because guessing quietly moves wages between
thresholds.

## Conventions

- Money is `bigint` integer cents. No float goes near a dollar figure.
- Rates are integer parts per million, so 5.45% is `54_500n` and 1.2125% is `12_125n` —
  both exact, which a percentage-as-float cannot promise.
- Tapers that are genuinely fractions stay rational: WA's is `{2n, 13n}`, not `0.153846`.
- Every function returns `Traced<T>` — result plus the inputs, the rule applied, and the
  citations. A function returning a bare number is a bug.

## Running the tests

No install needed for the test suite — Node 22.6+ strips the type annotations itself:

```
node --experimental-strip-types --test test/*.test.ts     # 44 tests
```

The typecheck does need dependencies:

```
npm install -D typescript @types/node
npm run typecheck                                          # tsc --noEmit
```

`@types/node` is not optional. Without it `src/load.ts` cannot resolve `node:fs`,
`node:url` or `node:path`, `import.meta.url` has no type, and every `node:test` import in
the suite fails — which also suppresses the narrowing that the tests depend on, producing
a second wave of errors that are really the first one in disguise.

**A deviation to be aware of.** §2.2 settles Vitest as the test runner, and these tests
are written against `node:test` instead. The npm registry is refused by the environment
this package was built in, so the choice was between tests that run and tests that merely
exist. The assertions port to Vitest almost one-for-one (`describe`/`test` are already
the same shape; only the imports change) and should be ported when convenient.

**Typecheck status.** The first `tsc` run found 18 errors, all in the test suite and the
toolchain configuration — none in the rule logic. They are fixed. What that run could
*not* establish is a clean `src/`: `load.ts`'s imports failed to resolve, so the compiler
never checked the file properly. Until `npm run typecheck` passes end to end on a machine
with `@types/node` installed, treat the non-negotiable that a bare number will not compile
as supported by the design but not yet proven.
