import type { Maybe, SourcedValue } from './sourced-value.ts';

export const JURISDICTIONS = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

/** `FY2026-27`, per CLAUDE.md conventions. */
export type FinancialYearLabel = `FY${number}-${number}`;

/**
 * Money is integer cents as `bigint`, never a float. $1,200,000 is 120_000_000n cents.
 */
export type Cents = bigint;

/**
 * A tax rate as integer parts per million of the wage, so no rate needs a float.
 * 5.45% is 54_500 ppm; 1.2125% (regional Victoria) is 12_125 ppm — both exact integers,
 * which a percentage-as-float representation cannot promise.
 */
export type Ppm = bigint;

/** An exact rational, for tapers that are genuinely fractions (WA's 2/13). */
export type Rational = { readonly numerator: bigint; readonly denominator: bigint };

/* ------------------------------------------------------------------ rate models */

/** One rate on all taxable wages in the jurisdiction. */
export type FlatRate = {
  readonly kind: 'flat';
  readonly rate_ppm: SourcedValue<Ppm>;
  /** Where a jurisdiction publishes a separate regional rate (Victoria). */
  readonly regional_rate_ppm?: Maybe<Ppm>;
};

/**
 * Rate depends on which band of Australia-wide wages the employer falls in (Tasmania:
 * 4.0% between $1.25m and $2.0m, 6.1% above $2.0m).
 */
export type TieredRate = {
  readonly kind: 'tiered_by_au_wages';
  readonly bands: ReadonlyArray<{
    /** Inclusive lower bound of Australia-wide wages for this band. */
    readonly from_au_wages: SourcedValue<Cents>;
    /** Exclusive upper bound; null means unbounded. */
    readonly to_au_wages: Maybe<Cents> | null;
    readonly rate_ppm: SourcedValue<Ppm>;
  }>;
};

export type RateModel = FlatRate | TieredRate;

/* ------------------------------------------------- deduction (threshold) models */

/** The full threshold applies, subject only to apportionment. */
export type FixedDeduction = {
  readonly kind: 'fixed';
  readonly annual: SourcedValue<Cents>;
};

/**
 * Victoria: full deduction up to `phase_out_from`; between that and `phase_out_to` the
 * deduction is reduced by `phase_out_rate_ppm` of the excess; nil at or above the upper
 * bound.
 */
export type PhaseOutDeduction = {
  readonly kind: 'phase_out';
  readonly annual: SourcedValue<Cents>;
  readonly phase_out_from: SourcedValue<Cents>;
  readonly phase_out_to: SourcedValue<Cents>;
  readonly phase_out_rate_ppm: SourcedValue<Ppm>;
};

/**
 * Western Australia's diminishing threshold: deduction = AT − (wages − AT) × TV, nil at
 * or above the upper threshold. TV is a true rational (2/13), not a decimal.
 */
export type DiminishingDeduction = {
  readonly kind: 'diminishing';
  readonly annual: SourcedValue<Cents>;
  readonly upper: SourcedValue<Cents>;
  readonly tapering_value: SourcedValue<Rational>;
};

export type DeductionModel = FixedDeduction | PhaseOutDeduction | DiminishingDeduction;

/* ------------------------------------------------------------------- the ruleset */

export type ApportionmentBasis = {
  /** Apportion the threshold by days employed in the jurisdiction over days in the year. */
  readonly by_days_employed: Maybe<boolean>;
  /** Apportion by the jurisdiction's share of Australia-wide wages. */
  readonly by_share_of_au_wages: Maybe<boolean>;
  readonly note?: string;
};

export type Surcharge = {
  readonly code: string;
  readonly label: string;
  readonly applies_above_au_wide_wages: Maybe<Cents>;
  readonly rate_ppm: Maybe<Ppm>;
  /** True where the surcharge hits only wages above the tier, not all wages. */
  readonly on_excess_only: Maybe<boolean>;
};

export type ContractorExemption = {
  readonly code: string;
  readonly label: string;
  readonly test_type: 'days' | 'percentage' | 'character_of_service' | null;
  readonly parameter: Maybe<number>;
  readonly evidence_required: string;
  readonly source_url: string;
};

export type Ruleset = {
  readonly jurisdiction: Jurisdiction;
  readonly financial_year: FinancialYearLabel;
  /** Bumped whenever any value in the file changes; pinned per §8.2 to a calc run. */
  readonly ruleset_version: string;
  readonly rate: RateModel;
  readonly deduction: DeductionModel;
  /**
   * The monthly threshold is derived, not a separate constant: NSW and Tasmania both
   * publish it as the annual threshold times days in the month over days in the year.
   * `published_examples` carries the revenue office's own printed figures so the
   * derivation is regression-tested against them rather than trusted.
   */
  readonly monthly_threshold: {
    readonly basis: Maybe<string>;
    /**
     * Where a jurisdiction publishes a flat monthly figure instead of deriving one from
     * days in the month, that figure lives here. Null means the jurisdiction derives it.
     */
    readonly flat_monthly_amount: Maybe<Cents> | null;
    readonly published_examples: ReadonlyArray<{
      readonly days_in_month: number;
      readonly days_in_year: number;
      readonly amount: SourcedValue<Cents>;
    }>;
  };
  readonly apportionment: ApportionmentBasis;
  /**
   * Wrapped in `Maybe` deliberately. An empty array would claim "this jurisdiction has
   * no surcharges", which is itself a sourced assertion — distinct from "we have not
   * looked". Only the former is an empty array; the latter is null with a reason.
   */
  readonly surcharges: Maybe<ReadonlyArray<Surcharge>>;
  readonly contractor_exemptions: Maybe<ReadonlyArray<ContractorExemption>>;
  readonly employment_agency: {
    readonly liable_party: Maybe<string>;
    readonly overrides_contractor_exemptions: Maybe<boolean>;
  };
  readonly wage_inclusions: {
    readonly superannuation: Maybe<string>;
  };
  readonly rounding: {
    readonly monthly_threshold: Maybe<string>;
    /**
     * How the deduction is rounded once apportioned or tapered. Sourced from the revenue
     * offices' own worked examples, which is the only place several of them state it:
     * NSW prints $201,643.84 and Victoria $27,777.67, so those keep cents, while
     * RevenueWA prints $969,231, so that one rounds to whole dollars.
     */
    readonly deductible_amount: Maybe<string>;
    readonly tax_payable: Maybe<string>;
  };
  /**
   * The harmonised nexus ruling as it applies in this jurisdiction. The ordering is
   * common to all eight (§4.1); what differs is the citation and section numbering.
   */
  readonly nexus: {
    readonly ruling_code: SourcedValue<string>;
    readonly provisions: Maybe<string>;
    readonly tier_order_verified: Maybe<boolean>;
  };
};
