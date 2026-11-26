import { invalidRequest } from '../errors';

export const MAX_ID_LENGTH = 255;
export const MAX_TEXT_LENGTH = 1000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Upper bound for `capacity` is the storage domain, not a product rule: the
 * column is a PostgreSQL INTEGER, and the specification only requires
 * "1 or more". 2_147_483_647 is the largest value that column can hold, so
 * anything above it is rejected as invalid input rather than surfacing a
 * database overflow as a 500.
 */
export const MAX_CAPACITY = 2_147_483_647;

/** Accepts ISO-8601 date-times with an explicit offset, or naive ones (assumed UTC). */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asJsonObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** A required, non-empty string field. Surrounding whitespace is not stripped. */
export function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLength = MAX_ID_LENGTH,
): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw invalidRequest(`Field "${field}" is required and must be a string`);
  }
  if (value.trim() === '') {
    throw invalidRequest(`Field "${field}" must not be empty`);
  }
  if (value.length > maxLength) {
    throw invalidRequest(`Field "${field}" must be at most ${maxLength} characters`);
  }
  return value;
}

export function requireTimestamp(body: Record<string, unknown>, field: string): Date {
  const value = requireString(body, field, 64);
  if (!ISO_TIMESTAMP.test(value)) {
    throw invalidRequest(`Field "${field}" must be an ISO 8601 timestamp, received "${value}"`);
  }

  // `new Date` silently rolls impossible days over (2026-02-30 becomes
  // 2026-03-02), so the calendar day is validated explicitly instead of trusting
  // the parser.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw invalidRequest(`Field "${field}" is not a valid date: "${value}"`);
  }
  const calendarProbe = new Date(0);
  calendarProbe.setUTCFullYear(year, month - 1, day);
  const isRealDay =
    calendarProbe.getUTCFullYear() === year &&
    calendarProbe.getUTCMonth() === month - 1 &&
    calendarProbe.getUTCDate() === day;
  if (!isRealDay) {
    throw invalidRequest(`Field "${field}" is not a valid date: "${value}"`);
  }

  // A timestamp without an explicit zone is treated as UTC, per the API contract.
  const normalised = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) {
    throw invalidRequest(`Field "${field}" is not a valid date-time: "${value}"`);
  }
  return parsed;
}

export function requireCapacity(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidRequest(`Field "${field}" is required and must be an integer`);
  }
  if (value < 1) {
    throw invalidRequest(`Field "${field}" must be 1 or more`);
  }
  if (value > MAX_CAPACITY) {
    throw invalidRequest(`Field "${field}" must be at most ${MAX_CAPACITY}`);
  }
  return value;
}

export function requireIdempotencyKey(headerValue: unknown): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw invalidRequest('The "Idempotency-Key" header is required');
  }
  if (raw.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw invalidRequest(
      `The "Idempotency-Key" header must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  return raw;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Serialises a timestamp as ISO-8601 UTC, dropping a zero millisecond component
 * so that `2026-12-05T07:00:00Z` round-trips byte-for-byte.
 */
export function formatTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace(/\.000Z$/, 'Z');
}
