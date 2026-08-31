import type { Cents, Jurisdiction, Ppm, Ruleset } from '../types.ts';
import { cite, isSourced, type Citation, type Maybe, type SourcedValue } from '../sourced-value.ts';
import type { Traced, TraceStep } from '../trace.ts';
import { UnsourcedRulesetError } from '../load.ts';
import { applyPpm, applyRational, divRoundHalfUp, maxCents, roundToWholeDollars, centsToDollars } from '../money.ts';

/**
 * Threshold, deduction and tax payable.
 *
 * Every function here gates on exactly the fields it reads, and names them if they are
 * unsourced. That is deliberately finer-grained than the capability gates in load.ts: a
 * caller asking for the WA taper should be told that the WA taper is sourced even while
 * WA's rounding rule is not, rather than being refused wholesale with no detail.
 */

function need<T>(ruleset: Ruleset, path: string, v: Maybe<T>): SourcedValue<T> {
  if (!isSourced(v)) {
    throw new UnsourcedRulesetError([
      { jurisdiction: ruleset.jurisdiction, path, reason: v.unsourced_reason },
    ]);
  }
  return v;
}

function roundDeduction(ruleset: Ruleset, exact: Cents, trace: TraceStep[], citations: Citation[]): Cents {
  const rule = ruleset.rounding.deductible_amount;
  if (!isSourced(rule)) {
    trace.push({
      step: 'deduction_rounding',
      detail: `No sourced rounding rule for the deductible amount in ${ruleset.jurisdiction}, so the exact value is carried in cents and nothing is rounded here. Reason on file: ${rule.unsourced_reason}`,
      outcome: 'not_applicable',
    });
    return exact;
  }
  citations.push(cite('rounding.deductible_amount', rule));
  if (rule.value === 'nearest_whole_dollar') {
    const rounded = roundToWholeDollars(exact);
    trace.push({
      step: 'deduction_rounding',
      detail: `Deduction rounded to the nearest whole dollar per ${ruleset.jurisdiction} practice: $${centsToDollars(exact)} becomes $${centsToDollars(rounded)}.`,
      outcome: 'resolved',
    });
    return rounded;
  }
  trace.push({
    step: 'deduction_rounding',
    detail: `${ruleset.jurisdiction} retains cents in the deductible amount, so $${centsToDollars(exact)} is carried as-is.`,
    outcome: 'resolved',
  });
  return exact;
}

/**
 * The deduction (tax-free threshold) available before apportionment, given the employer's
 * Australia-wide taxable wages for the year. This is where the three deduction models
 * genuinely differ between jurisdictions.
 */
export function deductibleAmount(ruleset: Ruleset, auWideWages: Cents): Traced<Cents> {
  const trace: TraceStep[] = [];
  const citations: Citation[] = [];
  const d = ruleset.deduction;

  switch (d.kind) {
    case 'fixed': {
      const annual = need(ruleset, '.deduction.annual', d.annual);
      citations.push(cite('deduction.annual', annual));
      trace.push({
        step: 'deduction_fixed',
        detail: `${ruleset.jurisdiction} applies a fixed annual threshold of $${centsToDollars(annual.value)}, subject to apportionment.`,
        outcome: 'resolved',
        inputs: { auWideWagesCents: auWideWages.toString() },
      });
      return { result: annual.value, trace, citations };
    }

    case 'phase_out': {
      const annual = need(ruleset, '.deduction.annual', d.annual);
      const from = need(ruleset, '.deduction.phase_out_from', d.phase_out_from);
      const to = need(ruleset, '.deduction.phase_out_to', d.phase_out_to);
      const rate = need(ruleset, '.deduction.phase_out_rate_ppm', d.phase_out_rate_ppm);
      citations.push(
        cite('deduction.annual', annual),
        cite('deduction.phase_out_from', from),
        cite('deduction.phase_out_to', to),
        cite('deduction.phase_out_rate_ppm', rate),
      );
      if (auWideWages >= to.value) {
        trace.push({
          step: 'deduction_phase_out',
          detail: `Australia-wide wages of $${centsToDollars(auWideWages)} are at or above $${centsToDollars(to.value)}, so no deduction is available.`,
          outcome: 'resolved',
        });
        return { result: 0n, trace, citations };
      }
      if (auWideWages <= from.value) {
        trace.push({
          step: 'deduction_phase_out',
          detail: `Australia-wide wages of $${centsToDollars(auWideWages)} are at or below $${centsToDollars(from.value)}, so the full deduction of $${centsToDollars(annual.value)} applies.`,
          outcome: 'resolved',
        });
        return { result: annual.value, trace, citations };
      }
      const excess = auWideWages - from.value;
      const reduction = applyPpm(excess, rate.value);
      const exact = maxCents(0n, annual.value - reduction);
      trace.push({
        step: 'deduction_phase_out',
        detail: `Wages of $${centsToDollars(auWideWages)} exceed $${centsToDollars(from.value)} by $${centsToDollars(excess)}. At a phase-out rate of ${Number(rate.value) / 10000}% the deduction falls by $${centsToDollars(reduction)}, from $${centsToDollars(annual.value)} to $${centsToDollars(exact)}.`,
        outcome: 'resolved',
      });
      return { result: roundDeduction(ruleset, exact, trace, citations), trace, citations };
    }

    case 'diminishing': {
      const annual = need(ruleset, '.deduction.annual', d.annual);
      const upper = need(ruleset, '.deduction.upper', d.upper);
      const tv = need(ruleset, '.deduction.tapering_value', d.tapering_value);
      citations.push(cite('deduction.annual', annual), cite('deduction.upper', upper), cite('deduction.tapering_value', tv));
      if (auWideWages >= upper.value) {
        trace.push({
          step: 'deduction_diminishing',
          detail: `Australia-wide wages of $${centsToDollars(auWideWages)} are at or above the upper threshold of $${centsToDollars(upper.value)}, so no deduction applies and tax is charged on all taxable wages.`,
          outcome: 'resolved',
        });
        return { result: 0n, trace, citations };
      }
      if (auWideWages <= annual.value) {
        trace.push({
          step: 'deduction_diminishing',
          detail: `Australia-wide wages of $${centsToDollars(auWideWages)} do not exceed the annual threshold of $${centsToDollars(annual.value)}, so the full deduction applies.`,
          outcome: 'resolved',
        });
        return { result: annual.value, trace, citations };
      }
      const excess = auWideWages - annual.value;
      const reduction = applyRational(excess, tv.value);
      const exact = maxCents(0n, annual.value - reduction);
      trace.push({
        step: 'deduction_diminishing',
        detail: `Deductable amount = AT - [(Wages - AT) x TV] = $${centsToDollars(annual.value)} - [$${centsToDollars(excess)} x ${tv.value.numerator}/${tv.value.denominator}] = $${centsToDollars(exact)} before rounding.`,
        outcome: 'resolved',
      });
      return { result: roundDeduction(ruleset, exact, trace, citations), trace, citations };
    }
  }
}

/** Apportionment inputs. Days come from `person_assignment` history, never a stored field. */
export type ApportionmentFacts = {
  readonly daysEmployedInJurisdiction: number;
  readonly daysInFinancialYear: number;
  readonly jurisdictionWages: Cents;
  readonly auWideWages: Cents;
};

/**
 * Apportion the deduction. NSW applies both bases together — its own worked examples show
 * the interstate share first, then the part-year days — and its second example shows the
 * days step dropping out where the employer employed elsewhere for the whole year. That
 * subtlety is the caller's to supply through `daysEmployedInJurisdiction`.
 */
export function apportionedDeduction(
  ruleset: Ruleset,
  auWideWages: Cents,
  facts: ApportionmentFacts,
): Traced<Cents> {
  const base = deductibleAmount(ruleset, auWideWages);
  const trace: TraceStep[] = [...base.trace];
  const citations: Citation[] = [...base.citations];
  let amount = base.result;

  const byShare = ruleset.apportionment.by_share_of_au_wages;
  if (isSourced(byShare) && byShare.value === true) {
    citations.push(cite('apportionment.by_share_of_au_wages', byShare));
    if (facts.auWideWages <= 0n) {
      trace.push({
        step: 'apportion_by_au_wage_share',
        detail: 'Australia-wide wages are zero, so the interstate share cannot be computed.',
        outcome: 'unresolved',
      });
      return { result: 0n, trace, citations, unresolved: 'Australia-wide wages are zero.' };
    }
    const before = amount;
    amount = divRoundHalfUp(amount * facts.jurisdictionWages, facts.auWideWages);
    trace.push({
      step: 'apportion_by_au_wage_share',
      detail: `Threshold x (${ruleset.jurisdiction} wages / total Australian wages) = $${centsToDollars(before)} x ($${centsToDollars(facts.jurisdictionWages)} / $${centsToDollars(facts.auWideWages)}) = $${centsToDollars(amount)}.`,
      outcome: 'resolved',
    });
  } else if (!isSourced(byShare)) {
    trace.push({
      step: 'apportion_by_au_wage_share',
      detail: `Whether ${ruleset.jurisdiction} apportions the threshold by share of Australia-wide wages is unsourced: ${byShare.unsourced_reason}`,
      outcome: 'unresolved',
    });
    return {
      result: amount,
      trace,
      citations,
      unresolved: `${ruleset.jurisdiction}: apportionment.by_share_of_au_wages is unsourced, so an apportioned threshold cannot be asserted.`,
    };
  }

  const byDays = ruleset.apportionment.by_days_employed;
  if (isSourced(byDays) && byDays.value === true) {
    citations.push(cite('apportionment.by_days_employed', byDays));
    if (facts.daysEmployedInJurisdiction < facts.daysInFinancialYear) {
      const before = amount;
      amount = divRoundHalfUp(
        amount * BigInt(facts.daysEmployedInJurisdiction),
        BigInt(facts.daysInFinancialYear),
      );
      trace.push({
        step: 'apportion_by_days_employed',
        detail: `Further apportioned to ${facts.daysEmployedInJurisdiction} of ${facts.daysInFinancialYear} days: $${centsToDollars(before)} x (${facts.daysEmployedInJurisdiction}/${facts.daysInFinancialYear}) = $${centsToDollars(amount)}.`,
        outcome: 'resolved',
      });
    } else {
      trace.push({
        step: 'apportion_by_days_employed',
        detail: `Employed for the whole ${facts.daysInFinancialYear}-day year, so no part-year apportionment applies.`,
        outcome: 'not_applicable',
      });
    }
  } else if (!isSourced(byDays)) {
    // Silently skipping this would produce a figure that claims more certainty than we
    // have: if the jurisdiction does apportion by days and we did not, the threshold is
    // overstated and the tax understated.
    trace.push({
      step: 'apportion_by_days_employed',
      detail: `Whether ${ruleset.jurisdiction} apportions the threshold by days employed is unsourced: ${byDays.unsourced_reason}`,
      outcome: 'unresolved',
    });
    return {
      result: amount,
      trace,
      citations,
      unresolved: `${ruleset.jurisdiction}: apportionment.by_days_employed is unsourced, so a part-year threshold cannot be asserted.`,
    };
  }

  return { result: roundDeduction(ruleset, amount, trace, citations), trace, citations };
}

/** The monthly threshold, derived rather than stored. */
export function monthlyThreshold(
  ruleset: Ruleset,
  daysInMonth: number,
  daysInYear: number,
): Traced<Cents> {
  const trace: TraceStep[] = [];
  const citations: Citation[] = [];
  const basis = need(ruleset, '.monthly_threshold.basis', ruleset.monthly_threshold.basis);
  citations.push(cite('monthly_threshold.basis', basis));

  const d = ruleset.deduction;
  const annual = need(ruleset, '.deduction.annual', d.annual);
  citations.push(cite('deduction.annual', annual));

  if (basis.value !== 'annual_x_days_in_month_over_days_in_year') {
    const flat = ruleset.monthly_threshold.flat_monthly_amount;
    if (flat === null) {
      return {
        result: 0n,
        trace,
        citations,
        unresolved: `${ruleset.jurisdiction} declares basis '${basis.value}' but publishes no flat monthly amount.`,
      };
    }
    const v = need(ruleset, '.monthly_threshold.flat_monthly_amount', flat);
    citations.push(cite('monthly_threshold.flat_monthly_amount', v));
    trace.push({
      step: 'monthly_threshold',
      detail: `${ruleset.jurisdiction} publishes a flat monthly figure of $${centsToDollars(v.value)} (${basis.value}), so the day counts supplied here are not used.`,
      outcome: 'resolved',
      inputs: { daysInMonth, daysInYear },
    });
    return { result: v.value, trace, citations };
  }

  const exact = divRoundHalfUp(annual.value * BigInt(daysInMonth), BigInt(daysInYear));
  const rounding = ruleset.rounding.monthly_threshold;
  let amount = exact;
  if (isSourced(rounding) && rounding.value === 'nearest_whole_dollar') {
    citations.push(cite('rounding.monthly_threshold', rounding));
    amount = roundToWholeDollars(exact);
  }
  trace.push({
    step: 'monthly_threshold',
    detail: `$${centsToDollars(annual.value)} x (${daysInMonth}/${daysInYear}) = $${centsToDollars(exact)}${amount === exact ? '' : `, rounded to $${centsToDollars(amount)}`}.`,
    outcome: 'resolved',
    inputs: { daysInMonth, daysInYear },
  });
  return { result: amount, trace, citations };
}

/** The rate that applies at a given level of Australia-wide wages. */
export function rateFor(ruleset: Ruleset, auWideWages: Cents, regional = false): Traced<Ppm> {
  const trace: TraceStep[] = [];
  const citations: Citation[] = [];
  const r = ruleset.rate;

  if (r.kind === 'flat') {
    if (regional) {
      const reg = r.regional_rate_ppm;
      if (reg === undefined) {
        trace.push({
          step: 'rate_regional',
          detail: `${ruleset.jurisdiction} publishes no separate regional rate.`,
          outcome: 'not_applicable',
        });
      } else {
        const v = need(ruleset, '.rate.regional_rate_ppm', reg);
        citations.push(cite('rate.regional_rate_ppm', v));
        trace.push({
          step: 'rate_regional',
          detail: `Regional ${ruleset.jurisdiction} rate of ${Number(v.value) / 10000}% applies.`,
          outcome: 'resolved',
        });
        return { result: v.value, trace, citations };
      }
    }
    const v = need(ruleset, '.rate.rate_ppm', r.rate_ppm);
    citations.push(cite('rate.rate_ppm', v));
    trace.push({
      step: 'rate_flat',
      detail: `${ruleset.jurisdiction} rate of ${Number(v.value) / 10000}% applies to taxable wages.`,
      outcome: 'resolved',
    });
    return { result: v.value, trace, citations };
  }

  for (const [i, band] of r.bands.entries()) {
    const from = need(ruleset, `.rate.bands[${i}].from_au_wages`, band.from_au_wages);
    const to = band.to_au_wages === null ? null : need(ruleset, `.rate.bands[${i}].to_au_wages`, band.to_au_wages);
    const inBand = auWideWages > from.value && (to === null || auWideWages <= to.value);
    if (inBand) {
      const rate = need(ruleset, `.rate.bands[${i}].rate_ppm`, band.rate_ppm);
      citations.push(cite(`rate.bands[${i}].rate_ppm`, rate), cite(`rate.bands[${i}].from_au_wages`, from));
      trace.push({
        step: 'rate_tiered',
        detail: `Australia-wide wages of $${centsToDollars(auWideWages)} fall in the band above $${centsToDollars(from.value)}${to === null ? '' : ` up to $${centsToDollars(to.value)}`}, so the rate is ${Number(rate.value) / 10000}%.`,
        outcome: 'resolved',
      });
      return { result: rate.value, trace, citations };
    }
  }

  trace.push({
    step: 'rate_tiered',
    detail: `Australia-wide wages of $${centsToDollars(auWideWages)} fall below the lowest published band, so no rate applies.`,
    outcome: 'resolved',
  });
  return { result: 0n, trace, citations };
}

export type TaxPayableFacts = ApportionmentFacts & {
  /** True where the employer qualifies for a published regional rate. */
  readonly regional?: boolean;
};

/**
 * Payroll tax payable in one jurisdiction for the year. Returns result plus working; a
 * bare number would be a bug.
 */
export function taxPayable(ruleset: Ruleset, facts: TaxPayableFacts): Traced<Cents> {
  const ded = apportionedDeduction(ruleset, facts.auWideWages, facts);
  const rate = rateFor(ruleset, facts.auWideWages, facts.regional ?? false);
  const trace: TraceStep[] = [...ded.trace, ...rate.trace];
  const citations: Citation[] = [...ded.citations, ...rate.citations];

  const taxable = maxCents(0n, facts.jurisdictionWages - ded.result);
  const tax = applyPpm(taxable, rate.result);

  trace.push({
    step: 'tax_payable',
    detail: `($${centsToDollars(facts.jurisdictionWages)} - $${centsToDollars(ded.result)}) x ${Number(rate.result) / 10000}% = $${centsToDollars(tax)}.`,
    outcome: 'resolved',
    inputs: { taxableAfterDeductionCents: taxable.toString() },
  });

  const surcharge = surchargeOn(ruleset, facts);
  trace.push(...surcharge.trace);
  citations.push(...surcharge.citations);

  const total = tax + surcharge.result;
  if (surcharge.result > 0n) {
    trace.push({
      step: 'tax_payable_with_surcharge',
      detail: `Payroll tax $${centsToDollars(tax)} plus surcharge $${centsToDollars(surcharge.result)} = $${centsToDollars(total)}.`,
      outcome: 'resolved',
    });
  }

  const unresolved = ded.unresolved ?? rate.unresolved ?? surcharge.unresolved;
  return unresolved === undefined
    ? { result: total, trace, citations }
    : { result: total, trace, citations, unresolved };
}

/** Surcharges, applied to the jurisdiction's share of wages above each tier. */
export function surchargeOn(ruleset: Ruleset, facts: ApportionmentFacts): Traced<Cents> {
  const trace: TraceStep[] = [];
  const citations: Citation[] = [];
  const list = ruleset.surcharges;

  if (!isSourced(list)) {
    trace.push({
      step: 'surcharge',
      detail: `Surcharges for ${ruleset.jurisdiction} are unsourced: ${list.unsourced_reason}`,
      outcome: 'unresolved',
    });
    return {
      result: 0n,
      trace,
      citations,
      unresolved: `${ruleset.jurisdiction}: surcharges are unsourced, so a total liability cannot be asserted.`,
    };
  }
  citations.push(cite('surcharges', list));
  if (list.value.length === 0) {
    trace.push({
      step: 'surcharge',
      detail: `No surcharge applies in ${ruleset.jurisdiction} for ${ruleset.financial_year}.`,
      outcome: 'not_applicable',
    });
    return { result: 0n, trace, citations };
  }

  let total = 0n;
  // Tiers are cumulative bands on Australia-wide wages; each charges only its own slice,
  // so the highest applicable tier does not retrospectively re-rate the wages below it.
  const tiers = list.value
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => isSourced(s.applies_above_au_wide_wages) && isSourced(s.rate_ppm))
    .sort((a, b) => {
      const av = (a.s.applies_above_au_wide_wages as SourcedValue<Cents>).value;
      const bv = (b.s.applies_above_au_wide_wages as SourcedValue<Cents>).value;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });

  for (const [k, { s, i }] of tiers.entries()) {
    const threshold = s.applies_above_au_wide_wages as SourcedValue<Cents>;
    const rate = s.rate_ppm as SourcedValue<Ppm>;
    if (facts.auWideWages <= threshold.value) continue;

    const nextTier = tiers[k + 1];
    const upper = nextTier === undefined
      ? facts.auWideWages
      : (() => {
          const nv = (nextTier.s.applies_above_au_wide_wages as SourcedValue<Cents>).value;
          return facts.auWideWages < nv ? facts.auWideWages : nv;
        })();

    const slice = upper - threshold.value;
    if (slice <= 0n) continue;

    // Only the jurisdiction's share of the slice is charged here.
    const jurisdictionSlice = facts.auWideWages > 0n
      ? divRoundHalfUp(slice * facts.jurisdictionWages, facts.auWideWages)
      : 0n;
    const amount = applyPpm(jurisdictionSlice, rate.value);
    total += amount;

    citations.push(cite(`surcharges[${i}].rate_ppm`, rate), cite(`surcharges[${i}].applies_above_au_wide_wages`, threshold));
    trace.push({
      step: `surcharge_${s.code}`,
      detail: `${s.label}: Australia-wide wages of $${centsToDollars(facts.auWideWages)} exceed $${centsToDollars(threshold.value)}. The slice of $${centsToDollars(slice)} apportioned to ${ruleset.jurisdiction} is $${centsToDollars(jurisdictionSlice)}, charged at ${Number(rate.value) / 10000}% = $${centsToDollars(amount)}.`,
      outcome: 'resolved',
    });
  }

  if (total === 0n) {
    trace.push({
      step: 'surcharge',
      detail: `Australia-wide wages of $${centsToDollars(facts.auWideWages)} are below every published surcharge threshold in ${ruleset.jurisdiction}.`,
      outcome: 'not_applicable',
    });
  }
  return { result: total, trace, citations };
}
