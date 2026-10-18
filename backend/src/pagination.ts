export interface PageQuery {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * Normalise a raw `limit` query value into a bounded page size.
 * Returns `null` when the value is present but invalid (non-numeric or > MAX_PAGE_LIMIT).
 */
export function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_PAGE_LIMIT;
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    return null;
  }
  return value;
}

/**
 * Horizon cursors are opaque paging tokens: pass them through untouched.
 * We only guard against obviously malformed values (non-string / empty).
 */
export function parseCursor(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  return raw;
}

/**
 * Build a standard `Page<T>` from a source result.
 * `nextCursor` is `null` when there is no further page.
 */
export function paginate<T>(
  items: T[],
  nextCursor: string | null | undefined,
  hasMore?: boolean
): Page<T> {
  const more = hasMore ?? Boolean(nextCursor);
  return {
    items,
    nextCursor: more && nextCursor ? nextCursor : null,
  };
}
