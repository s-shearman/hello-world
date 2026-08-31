import type { Cents, Ruleset } from '../types.ts';
import { cite, isSourced, type Citation } from '../sourced-value.ts';
import type { Traced, TraceStep } from '../trace.ts';

/**
 * Contractor payments are deemed wages by default (§6.2). Nothing is excluded silently,
 * an exemption applies only when it is both claimed and evidenced, and the applied
 * exemption code and its source appear in every output that excludes a payment.
 */

export type ExemptionClaim = {
  readonly exemptionCode: string;
  readonly claimed: boolean;
  readonly evidenced: boolean;
  readonly evidenceRef?: string;
};

export type ContractorAssessment = {
  readonly deemedWages: Cents;
  /** Amount an exemption would remove if it were evidenced but is not. */
  readonly atRisk: Cents;
  readonly exemptionApplied: string | null;
};

export function assessContractorPayment(
  ruleset: Ruleset,
  paymentCents: Cents,
  claim: ExemptionClaim | null,
): Traced<ContractorAssessment> {
  const trace: TraceStep[] = [];
  const citations: Citation[] = [];

  trace.push({
    step: 'contractor_deemed_by_default',
    detail: `A payment of ${paymentCents} cents to a contractor is deemed wages in ${ruleset.jurisdiction} unless an exemption is both claimed and evidenced.`,
    outcome: 'resolved',
  });

  if (claim === null) {
    return {
      result: { deemedWages: paymentCents, atRisk: 0n, exemptionApplied: null },
      trace,
      citations,
    };
  }

  const catalogue = ruleset.contractor_exemptions;
  if (!isSourced(catalogue)) {
    trace.push({
      step: 'contractor_exemption_catalogue',
      detail: `The ${ruleset.jurisdiction} exemption catalogue is unsourced, so exemption code ${claim.exemptionCode} cannot be validated: ${catalogue.unsourced_reason}`,
      outcome: 'unresolved',
    });
    return {
      result: { deemedWages: paymentCents, atRisk: paymentCents, exemptionApplied: null },
      trace,
      citations,
      unresolved: `${ruleset.jurisdiction}: contractor exemption catalogue is unsourced. The payment stays deemed and the full amount is shown at risk rather than excluded on an unverified code.`,
    };
  }
  citations.push(cite('contractor_exemptions', catalogue));

  const known = catalogue.value.find((e) => e.code === claim.exemptionCode);
  if (known === undefined) {
    trace.push({
      step: 'contractor_exemption_unknown',
      detail: `Exemption code ${claim.exemptionCode} is not in the ${ruleset.jurisdiction} catalogue for ${ruleset.financial_year}.`,
      outcome: 'unresolved',
    });
    return {
      result: { deemedWages: paymentCents, atRisk: paymentCents, exemptionApplied: null },
      trace,
      citations,
      unresolved: `Unknown exemption code ${claim.exemptionCode}.`,
    };
  }

  if (claim.claimed && claim.evidenced) {
    trace.push({
      step: 'contractor_exemption_applied',
      detail: `Exemption ${known.code} (${known.label}) is claimed and evidenced${claim.evidenceRef === undefined ? '' : ` by ${claim.evidenceRef}`}, so the payment is excluded. Evidence required: ${known.evidence_required}. Source: ${known.source_url}`,
      outcome: 'resolved',
    });
    return { result: { deemedWages: 0n, atRisk: 0n, exemptionApplied: known.code }, trace, citations };
  }

  trace.push({
    step: 'contractor_exemption_not_evidenced',
    detail: `Exemption ${known.code} is ${claim.claimed ? 'claimed but not evidenced' : 'not claimed'}, so the payment stays deemed wages and ${paymentCents} cents is shown at risk.`,
    outcome: 'resolved',
  });
  return {
    result: { deemedWages: paymentCents, atRisk: paymentCents, exemptionApplied: null },
    trace,
    citations,
  };
}
