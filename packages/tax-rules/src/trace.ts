import type { Citation } from './sourced-value.ts';

/**
 * Per CLAUDE.md every output number carries a trace: the inputs, the rule applied, and
 * the authority for it. A function returning a bare number is a bug, so the return types
 * in this package are always result-plus-working.
 */
export type TraceStep = {
  /** Machine-readable step id, e.g. `tier1_ppr`. */
  readonly step: string;
  /** One line a finance reader can follow. */
  readonly detail: string;
  readonly outcome: 'resolved' | 'not_applicable' | 'passed_over' | 'unresolved';
  readonly inputs?: Readonly<Record<string, unknown>>;
};

export type Traced<T> = {
  readonly result: T;
  readonly trace: ReadonlyArray<TraceStep>;
  readonly citations: ReadonlyArray<Citation>;
  /** Set where the rule could not decide. A caller must surface this, not swallow it. */
  readonly unresolved?: string;
};

export const DISCLAIMER =
  'Indicative only. Requires review by a registered tax agent before you rely on it.';
