import type { Cents, Ruleset } from '../types.ts';
import { cite, isSourced, type Citation } from '../sourced-value.ts';
import type { Traced, TraceStep } from '../trace.ts';

/**
 * Employment agency and labour hire arrangements are assessed first, on a separate path
 * from the general contractor provisions (§6.2), because they can make a payment taxable
 * regardless of whether a contractor exemption would otherwise have applied. Where the
 * arrangement is one of these, contractor exemptions are not offered as a way out.
 */

export type ArrangementClass =
  | 'employment_agency'
  | 'labour_hire'
  | 'sole_trader_contractor'
  | 'subcontract_company';

export type AgencyAssessment = {
  readonly deemedWages: Cents;
  readonly liableParty: string | null;
  /** True where the general contractor exemption path must not be offered. */
  readonly contractorExemptionsUnavailable: boolean;
};

export function assessArrangement(
  ruleset: Ruleset,
  arrangementClass: ArrangementClass,
  paymentCents: Cents,
): Traced<AgencyAssessment> {
  const trace: TraceStep[] = [];
  const citations: Citation[] = [];

  const isAgency = arrangementClass === 'employment_agency' || arrangementClass === 'labour_hire';
  if (!isAgency) {
    trace.push({
      step: 'arrangement_class',
      detail: `Arrangement is ${arrangementClass}, so it is assessed on the general contractor path.`,
      outcome: 'not_applicable',
    });
    return {
      result: { deemedWages: paymentCents, liableParty: null, contractorExemptionsUnavailable: false },
      trace,
      citations,
    };
  }

  const liable = ruleset.employment_agency.liable_party;
  const overrides = ruleset.employment_agency.overrides_contractor_exemptions;

  if (!isSourced(liable) || !isSourced(overrides)) {
    trace.push({
      step: 'employment_agency_provisions',
      detail: `Arrangement is ${arrangementClass}, which is assessed ahead of the contractor provisions. The ${ruleset.jurisdiction} employment agency rules are unsourced (${!isSourced(liable) ? `liable_party: ${liable.unsourced_reason}` : ''}${!isSourced(liable) && !isSourced(overrides) ? '; ' : ''}${!isSourced(overrides) ? `overrides_contractor_exemptions: ${overrides.unsourced_reason}` : ''}), so the payment stays fully deemed and no exemption path is offered.`,
      outcome: 'unresolved',
    });
    return {
      result: { deemedWages: paymentCents, liableParty: null, contractorExemptionsUnavailable: true },
      trace,
      citations,
      unresolved: `${ruleset.jurisdiction}: employment agency provisions are unsourced, so the liable party cannot be named.`,
    };
  }

  citations.push(cite('employment_agency.liable_party', liable), cite('employment_agency.overrides_contractor_exemptions', overrides));
  trace.push({
    step: 'employment_agency_provisions',
    detail: `Arrangement is ${arrangementClass}. Liable party in ${ruleset.jurisdiction}: ${liable.value}. Contractor exemptions ${overrides.value ? 'are overridden and not available' : 'remain available'}.`,
    outcome: 'resolved',
  });
  return {
    result: {
      deemedWages: paymentCents,
      liableParty: liable.value,
      contractorExemptionsUnavailable: overrides.value === true,
    },
    trace,
    citations,
  };
}
