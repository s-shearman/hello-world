import type { Cents, Jurisdiction, Ruleset } from '../types.ts';
import { cite, type Citation } from '../sourced-value.ts';
import type { Traced, TraceStep } from '../trace.ts';
import { isSourced } from '../sourced-value.ts';

/**
 * PTA039 — Payroll Tax Nexus Provisions. Harmonised across all eight jurisdictions and
 * amended with effect from 1 July 2009.
 *
 * Confirmed word-for-word against the primary rulings on 2026-08-31 (see §4.1 of
 * docs/schema-proposal.md for the source table). NSW ss 11, 11A, 11B, 11C; WA ss 6A, 6B,
 * 6C, 6D; Tasmania identical to NSW.
 *
 * Two things the ordering makes counter-intuitive, and which this module therefore gets
 * asked about a lot:
 *
 *   - Tier 1 is residence, not where the work happened. A NSW-resident technician who
 *     spends a week in Darwin resolves to NSW, and the enquiry never reaches tier 4.
 *   - A whole calendar month away does move it, because step 1 is then satisfied for the
 *     other jurisdiction. The boundary is the calendar month, not the trip.
 */

/** Where a determination landed, or that it landed nowhere in Australia. */
export type NexusOutcome = {
  /** Null means: not taxable in any Australian jurisdiction. */
  readonly jurisdiction: Jurisdiction | null;
  readonly ruleApplied: NexusRule;
  readonly ruleRef: string;
};

export type NexusRule =
  | 'step1_wholly_performed_in_one_jurisdiction'
  | 'tier1_employee_ppr'
  | 'tier1_corporate_deemed_employee_abn_address'
  | 'tier1_corporate_deemed_employee_ppb'
  | 'tier2_employer_abn_address'
  | 'tier2_employer_ppb'
  | 'tier3_wages_paid'
  | 'tier4_services_mainly_performed'
  | 'wholly_outside_australia_wages_paid'
  | 'exempt_overseas_more_than_six_months'
  | 'not_taxable_in_any_australian_jurisdiction';

/**
 * The facts a month's determination is decided on. Everything here is per employee per
 * calendar month, because that is the unit PTA039 works in.
 */
export type NexusFacts = {
  /** `YYYY-MM`. Present so the trace can name the period it decided. */
  readonly month: string;
  /** Australian jurisdictions in which services were performed during the month. */
  readonly servicesPerformedIn: ReadonlyArray<Jurisdiction>;
  /** True where some or all services were performed outside every Australian jurisdiction. */
  readonly servicesPerformedOutsideAustralia: boolean;
  /**
   * Where services were performed wholly in another country, the number of continuous
   * months of that assignment so far. Drives the more-than-six-months exemption.
   */
  readonly continuousMonthsWhollyInAnotherCountry?: number;
  /**
   * The employee's principal place of residence, already resolved to the last day of the
   * month where they had more than one during it.
   */
  readonly employeePpr: Jurisdiction | null;
  readonly employerAbnAddress: Jurisdiction | null;
  readonly employerPpb: Jurisdiction | null;
  /** Wages paid or payable in the month, by jurisdiction, in integer cents. */
  readonly wagesPaidBy: Readonly<Partial<Record<Jurisdiction, Cents>>>;
  /** Actual time worked in the month by jurisdiction, in the same unit throughout. */
  readonly timeWorkedBy: Readonly<Partial<Record<Jurisdiction, number>>>;
  /**
   * Set where the deemed employee is a corporation — engaged under the contractor or the
   * employment agency provisions. Its PPR is its ABN address, falling back to its PPB.
   */
  readonly corporateDeemedEmployee?: {
    readonly abnAddress: Jurisdiction | null;
    /** True where it has two or more ABN addresses in the jurisdiction. */
    readonly hasMultipleAbnAddressesInJurisdiction?: boolean;
    readonly ppb: Jurisdiction | null;
  };
  /** True where the employer has two or more ABN addresses in different jurisdictions. */
  readonly employerHasMultipleAbnAddressesInDifferentJurisdictions?: boolean;
};

function largestProportion(
  wages: Readonly<Partial<Record<Jurisdiction, Cents>>>,
): { jurisdiction: Jurisdiction | null; total: Cents; tied: boolean } {
  const entries = Object.entries(wages).filter(([, v]) => v !== undefined && v > 0n) as Array<[Jurisdiction, Cents]>;
  let total = 0n;
  for (const [, v] of entries) total += v;
  if (entries.length === 0) return { jurisdiction: null, total: 0n, tied: false };
  let best: [Jurisdiction, Cents] = entries[0]!;
  let tied = false;
  for (const e of entries.slice(1)) {
    if (e[1] > best[1]) {
      best = e;
      tied = false;
    } else if (e[1] === best[1]) {
      tied = true;
    }
  }
  return { jurisdiction: best[0], total, tied };
}

function mainlyPerformed(
  time: Readonly<Partial<Record<Jurisdiction, number>>>,
): { jurisdiction: Jurisdiction | null; share: number } {
  const entries = Object.entries(time).filter(([, v]) => typeof v === 'number' && v > 0) as Array<[Jurisdiction, number]>;
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (total <= 0) return { jurisdiction: null, share: 0 };
  for (const [j, v] of entries) {
    // "mainly performed" means actual time worked exceeds 50 per cent of the month.
    if (v / total > 0.5) return { jurisdiction: j, share: v / total };
  }
  return { jurisdiction: null, share: 0 };
}

/**
 * Resolve one employee-month to exactly one jurisdiction, with the working shown.
 *
 * Wages for a month are never split across states for the same employee — that is
 * structural in PTA039, not a simplification here.
 */
export function resolveNexus(facts: NexusFacts, ruleset: Ruleset): Traced<NexusOutcome> {
  const trace: TraceStep[] = [];
  const citations: Citation[] = [];

  if (isSourced(ruleset.nexus.ruling_code)) {
    citations.push(cite('nexus.ruling_code', ruleset.nexus.ruling_code));
  }
  if (isSourced(ruleset.nexus.provisions)) {
    citations.push(cite('nexus.provisions', ruleset.nexus.provisions));
  }

  const inAu = [...new Set(facts.servicesPerformedIn)];
  const ref = isSourced(ruleset.nexus.provisions)
    ? ruleset.nexus.provisions.value
    : `${ruleset.jurisdiction} nexus provisions (section numbering unsourced)`;

  const done = (outcome: NexusOutcome, unresolved?: string): Traced<NexusOutcome> =>
    unresolved === undefined
      ? { result: outcome, trace, citations }
      : { result: outcome, trace, citations, unresolved };

  /* ---- services performed wholly outside every Australian jurisdiction ----------- */
  if (inAu.length === 0 && facts.servicesPerformedOutsideAustralia) {
    const months = facts.continuousMonthsWhollyInAnotherCountry;
    if (months === undefined) {
      trace.push({
        step: 'wholly_outside_australia',
        detail:
          'Services were performed wholly outside every Australian jurisdiction, but the length of the assignment was not supplied. Offshore work (an oil rig) is taxable where the wages are paid regardless of duration; work wholly in another country for more than six continuous months is exempt. These lead to opposite answers, so this month cannot be decided.',
        outcome: 'unresolved',
        inputs: { month: facts.month },
      });
      return done(
        { jurisdiction: null, ruleApplied: 'not_taxable_in_any_australian_jurisdiction', ruleRef: ref },
        'Services wholly outside Australia: supply continuousMonthsWhollyInAnotherCountry, or flag the work as offshore rather than in another country.',
      );
    }
    if (months > 6) {
      trace.push({
        step: 'exempt_overseas_more_than_six_months',
        detail: `Services performed wholly in another country for ${months} continuous months, which exceeds six. Wages are exempt, including the wages paid for the first six months.`,
        outcome: 'resolved',
        inputs: { continuousMonths: months },
      });
      return done({ jurisdiction: null, ruleApplied: 'exempt_overseas_more_than_six_months', ruleRef: ref });
    }
    const paid = largestProportion(facts.wagesPaidBy);
    trace.push({
      step: 'wholly_outside_australia_wages_paid',
      detail: `Assignment of ${months} continuous months does not exceed six, so wages are taxable where they are paid${paid.tied ? '' : ` — ${paid.jurisdiction ?? 'nowhere in Australia'}`}.`,
      outcome: paid.jurisdiction === null || paid.tied ? 'unresolved' : 'resolved',
      inputs: { wagesPaidBy: facts.wagesPaidBy },
    });
    if (paid.tied) {
      return done(
        { jurisdiction: null, ruleApplied: 'wholly_outside_australia_wages_paid', ruleRef: ref },
        'Two or more jurisdictions carry an equal largest proportion of wages. PTA039 does not break the tie.',
      );
    }
    return done({
      jurisdiction: paid.jurisdiction,
      ruleApplied: paid.jurisdiction === null ? 'not_taxable_in_any_australian_jurisdiction' : 'wholly_outside_australia_wages_paid',
      ruleRef: ref,
    });
  }

  /* ---- step 1: the wholly-performed test ---------------------------------------- */
  if (inAu.length === 1 && !facts.servicesPerformedOutsideAustralia) {
    const j = inAu[0]!;
    trace.push({
      step: 'step1_wholly_performed_in_one_jurisdiction',
      detail: `Services in ${facts.month} were performed wholly in ${j}, so the wages are taxable there and the enquiry stops. This holds even where ${j} is not where the employee usually performs services.`,
      outcome: 'resolved',
      inputs: { servicesPerformedIn: inAu },
    });
    return done({ jurisdiction: j, ruleApplied: 'step1_wholly_performed_in_one_jurisdiction', ruleRef: ref });
  }

  trace.push({
    step: 'step1_wholly_performed_in_one_jurisdiction',
    detail:
      inAu.length === 0
        ? 'No Australian jurisdiction recorded for services in the month.'
        : `Services in ${facts.month} were performed in ${inAu.join(', ')}${facts.servicesPerformedOutsideAustralia ? ' and outside all Australian jurisdictions' : ''}, so the four tiered tests run in sequence.`,
    outcome: 'passed_over',
    inputs: { servicesPerformedIn: inAu, outsideAustralia: facts.servicesPerformedOutsideAustralia },
  });

  /* ---- tier 1: principal place of residence -------------------------------------- */
  const corp = facts.corporateDeemedEmployee;
  if (corp) {
    const abnUsable = corp.abnAddress !== null && corp.hasMultipleAbnAddressesInJurisdiction !== true;
    if (abnUsable) {
      trace.push({
        step: 'tier1_corporate_deemed_employee_abn_address',
        detail: `The deemed employee is a corporation, so its principal place of residence is taken to be the jurisdiction of its ABN address: ${corp.abnAddress}.`,
        outcome: 'resolved',
        inputs: { abnAddress: corp.abnAddress },
      });
      return done({ jurisdiction: corp.abnAddress, ruleApplied: 'tier1_corporate_deemed_employee_abn_address', ruleRef: ref });
    }
    if (corp.ppb !== null) {
      trace.push({
        step: 'tier1_corporate_deemed_employee_ppb',
        detail: `The corporate deemed employee has ${corp.abnAddress === null ? 'no ABN address' : 'two or more ABN addresses in the jurisdiction'}, so its principal place of business is used: ${corp.ppb}. Where it changed mid-month, this is the address on the last day of the month.`,
        outcome: 'resolved',
        inputs: { abnAddress: corp.abnAddress, ppb: corp.ppb },
      });
      return done({ jurisdiction: corp.ppb, ruleApplied: 'tier1_corporate_deemed_employee_ppb', ruleRef: ref });
    }
    trace.push({
      step: 'tier1_corporate_deemed_employee_ppb',
      detail: 'The corporate deemed employee has neither a usable ABN address nor a principal place of business in an Australian jurisdiction.',
      outcome: 'passed_over',
    });
  } else if (facts.employeePpr !== null) {
    trace.push({
      step: 'tier1_employee_ppr',
      detail: `Tier 1 resolves: the employee's principal place of residence in ${facts.month} is ${facts.employeePpr}. Residence outranks where the work happened, so the remaining tiers are not reached.`,
      outcome: 'resolved',
      inputs: { employeePpr: facts.employeePpr },
    });
    return done({ jurisdiction: facts.employeePpr, ruleApplied: 'tier1_employee_ppr', ruleRef: ref });
  } else {
    trace.push({
      step: 'tier1_employee_ppr',
      detail: 'The employee has no principal place of residence in any Australian jurisdiction.',
      outcome: 'passed_over',
    });
  }

  /* ---- tier 2: employer ABN address, then principal place of business ------------ */
  const abnUsable =
    facts.employerAbnAddress !== null &&
    facts.employerHasMultipleAbnAddressesInDifferentJurisdictions !== true;
  if (abnUsable) {
    trace.push({
      step: 'tier2_employer_abn_address',
      detail: `Tier 2 resolves on the employer's registered ABN address: ${facts.employerAbnAddress}.`,
      outcome: 'resolved',
      inputs: { employerAbnAddress: facts.employerAbnAddress },
    });
    return done({ jurisdiction: facts.employerAbnAddress, ruleApplied: 'tier2_employer_abn_address', ruleRef: ref });
  }
  if (facts.employerPpb !== null) {
    trace.push({
      step: 'tier2_employer_ppb',
      detail: `The employer has ${facts.employerAbnAddress === null ? 'no ABN address' : 'two or more ABN addresses in different jurisdictions'}, so tier 2 resolves on its principal place of business: ${facts.employerPpb}.`,
      outcome: 'resolved',
      inputs: { employerAbnAddress: facts.employerAbnAddress, employerPpb: facts.employerPpb },
    });
    return done({ jurisdiction: facts.employerPpb, ruleApplied: 'tier2_employer_ppb', ruleRef: ref });
  }
  trace.push({
    step: 'tier2_employer_abn_address',
    detail: 'The employer has neither an ABN address nor a principal place of business in an Australian jurisdiction.',
    outcome: 'passed_over',
  });

  /* ---- tier 3: where the wages are paid or payable ------------------------------- */
  const paid = largestProportion(facts.wagesPaidBy);
  if (paid.jurisdiction !== null && !paid.tied) {
    trace.push({
      step: 'tier3_wages_paid',
      detail: `Tier 3 resolves on where the wages are paid. Wages across more than one jurisdiction are aggregated and taxed where the largest proportion is paid: ${paid.jurisdiction}, on an aggregate of ${paid.total} cents.`,
      outcome: 'resolved',
      inputs: { wagesPaidBy: facts.wagesPaidBy, aggregateCents: paid.total.toString() },
    });
    return done({ jurisdiction: paid.jurisdiction, ruleApplied: 'tier3_wages_paid', ruleRef: ref });
  }
  if (paid.tied) {
    trace.push({
      step: 'tier3_wages_paid',
      detail: 'Two or more jurisdictions carry an equal largest proportion of wages.',
      outcome: 'unresolved',
      inputs: { wagesPaidBy: facts.wagesPaidBy },
    });
    return done(
      { jurisdiction: null, ruleApplied: 'tier3_wages_paid', ruleRef: ref },
      'Tier 3 is tied between two or more jurisdictions and PTA039 does not break the tie. Refer to the accountant rather than picking one.',
    );
  }
  trace.push({
    step: 'tier3_wages_paid',
    detail: 'No wages were paid or payable in any Australian jurisdiction.',
    outcome: 'passed_over',
  });

  /* ---- tier 4: services mainly performed ---------------------------------------- */
  const mainly = mainlyPerformed(facts.timeWorkedBy);
  if (mainly.jurisdiction !== null) {
    trace.push({
      step: 'tier4_services_mainly_performed',
      detail: `Tier 4 resolves: actual time worked in ${mainly.jurisdiction} was ${(mainly.share * 100).toFixed(1)}% of the month, which exceeds 50%.`,
      outcome: 'resolved',
      inputs: { timeWorkedBy: facts.timeWorkedBy },
    });
    return done({ jurisdiction: mainly.jurisdiction, ruleApplied: 'tier4_services_mainly_performed', ruleRef: ref });
  }
  trace.push({
    step: 'tier4_services_mainly_performed',
    detail: 'No Australian jurisdiction accounts for more than 50% of actual time worked in the month.',
    outcome: 'resolved',
  });
  return done({ jurisdiction: null, ruleApplied: 'not_taxable_in_any_australian_jurisdiction', ruleRef: ref });
}
