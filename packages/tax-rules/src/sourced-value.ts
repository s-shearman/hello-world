/**
 * Sourcing is the load-bearing constraint of this package.
 *
 * Per CLAUDE.md: no rate or threshold from memory. Every tax value carries the URL it
 * came from and the date it was retrieved, and a bare number must not compile. The type
 * below is that mechanism — the rule functions accept `SourcedValue<T>`, never `T`, so
 * there is no signature anywhere in this package that a loose number will satisfy.
 */

/** A value we retrieved from a named source, with the URL and the date we read it. */
export type SourcedValue<T> = {
  readonly value: T;
  readonly source_name: string;
  readonly source_url: string;
  /** ISO date, `YYYY-MM-DD`, on which the source was read. */
  readonly retrieved_date: string;
  readonly note?: string;
};

/**
 * A value we could not verify from source. `value` is always null — this is the shape
 * that keeps a guess out of the ruleset. `unsourced_reason` is required: an unsourced
 * value must say why it is unsourced, so the gap is legible rather than mysterious.
 */
export type Unsourced = {
  readonly value: null;
  readonly unsourced_reason: string;
  /** Where the value would come from, when we can reach it. */
  readonly source_name?: string;
  readonly source_url?: string;
  readonly retrieved_date?: string;
  readonly note?: string;
};

/** What a ruleset field holds before the sourcing gate has run over it. */
export type Maybe<T> = SourcedValue<T> | Unsourced;

export function isSourced<T>(v: Maybe<T>): v is SourcedValue<T> {
  return v.value !== null && v.value !== undefined;
}

export function isUnsourced<T>(v: Maybe<T>): v is Unsourced {
  return !isSourced(v);
}

/** Construct a sourced value. Present mainly so tests read cleanly. */
export function sourced<T>(
  value: T,
  source_name: string,
  source_url: string,
  retrieved_date: string,
  note?: string,
): SourcedValue<T> {
  return note === undefined
    ? { value, source_name, source_url, retrieved_date }
    : { value, source_name, source_url, retrieved_date, note };
}

export function unsourced(reason: string, hint?: Partial<Omit<Unsourced, 'value' | 'unsourced_reason'>>): Unsourced {
  return { value: null, unsourced_reason: reason, ...hint };
}

/** A citation, carried through calculations so every output number can name its authority. */
export type Citation = {
  readonly field: string;
  readonly source_name: string;
  readonly source_url: string;
  readonly retrieved_date: string;
};

export function cite<T>(field: string, v: SourcedValue<T>): Citation {
  return {
    field,
    source_name: v.source_name,
    source_url: v.source_url,
    retrieved_date: v.retrieved_date,
  };
}
