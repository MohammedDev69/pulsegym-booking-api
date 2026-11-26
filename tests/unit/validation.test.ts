import { ApiError } from '../../src/errors';
import {
  asJsonObject,
  formatTimestamp,
  isUuid,
  requireCapacity,
  requireIdempotencyKey,
  requireString,
  requireTimestamp,
} from '../../src/http/validation';

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe('invalid_request');
    return;
  }
  throw new Error('expected the call to throw an invalid_request error');
}

describe('request validation', () => {
  describe('asJsonObject', () => {
    it('accepts a plain object', () => {
      expect(asJsonObject({ a: 1 })).toEqual({ a: 1 });
    });

    it.each([null, undefined, 42, 'text', [1, 2]])('rejects %p', (value) => {
      expectInvalid(() => asJsonObject(value));
    });
  });

  describe('requireString', () => {
    it('returns the provided value', () => {
      expect(requireString({ id: 'm-1' }, 'id')).toBe('m-1');
    });

    it('rejects a missing field', () => {
      expectInvalid(() => requireString({}, 'id'));
    });

    it('rejects non-string values, including numbers', () => {
      expectInvalid(() => requireString({ id: 12 }, 'id'));
    });

    it('rejects empty and whitespace-only values', () => {
      expectInvalid(() => requireString({ id: '' }, 'id'));
      expectInvalid(() => requireString({ id: '   ' }, 'id'));
    });

    it('rejects values above the length limit', () => {
      expectInvalid(() => requireString({ id: 'x'.repeat(300) }, 'id'));
    });
  });

  describe('requireTimestamp', () => {
    it('parses the contract format', () => {
      expect(requireTimestamp({ t: '2026-12-05T07:00:00Z' }, 't').toISOString()).toBe(
        '2026-12-05T07:00:00.000Z',
      );
    });

    it('parses fractional seconds and offsets', () => {
      expect(requireTimestamp({ t: '2026-12-05T07:00:00.250Z' }, 't').toISOString()).toBe(
        '2026-12-05T07:00:00.250Z',
      );
      expect(requireTimestamp({ t: '2026-12-05T09:00:00+02:00' }, 't').toISOString()).toBe(
        '2026-12-05T07:00:00.000Z',
      );
    });

    it('treats a timestamp without an offset as UTC', () => {
      expect(requireTimestamp({ t: '2026-12-05T07:00:00' }, 't').toISOString()).toBe(
        '2026-12-05T07:00:00.000Z',
      );
    });

    it.each(['', 'tomorrow', '2026-12-05', '05/12/2026', '2026-13-45T00:00:00Z'])(
      'rejects %p',
      (value) => {
        expectInvalid(() => requireTimestamp({ t: value }, 't'));
      },
    );

    it.each(['2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z', '2026-02-29T00:00:00Z'])(
      'rejects the non-existent calendar day %p instead of rolling it over',
      (value) => {
        expectInvalid(() => requireTimestamp({ t: value }, 't'));
      },
    );

    it('accepts a real leap day', () => {
      expect(requireTimestamp({ t: '2024-02-29T00:00:00Z' }, 't').toISOString()).toBe(
        '2024-02-29T00:00:00.000Z',
      );
    });
  });

  describe('requireCapacity', () => {
    it('accepts a positive integer', () => {
      expect(requireCapacity({ capacity: 20 }, 'capacity')).toBe(20);
    });

    it('accepts large values, since the spec only requires "1 or more"', () => {
      expect(requireCapacity({ capacity: 1_000_001 }, 'capacity')).toBe(1_000_001);
      expect(requireCapacity({ capacity: 2_147_483_647 }, 'capacity')).toBe(2_147_483_647);
    });

    it('rejects values the INTEGER column cannot store', () => {
      expectInvalid(() => requireCapacity({ capacity: 2_147_483_648 }, 'capacity'));
      expectInvalid(() => requireCapacity({ capacity: 1e15 }, 'capacity'));
    });

    it.each([0, -1, 1.5, '20', null, undefined, Number.NaN])('rejects %p', (value) => {
      expectInvalid(() => requireCapacity({ capacity: value }, 'capacity'));
    });
  });

  describe('requireIdempotencyKey', () => {
    it('accepts a non-empty string', () => {
      expect(requireIdempotencyKey('abc')).toBe('abc');
    });

    it('rejects missing, empty and blank keys', () => {
      expectInvalid(() => requireIdempotencyKey(undefined));
      expectInvalid(() => requireIdempotencyKey(''));
      expectInvalid(() => requireIdempotencyKey('   '));
    });

    it('rejects an oversized key', () => {
      expectInvalid(() => requireIdempotencyKey('k'.repeat(256)));
    });
  });

  describe('formatTimestamp', () => {
    it('round-trips a whole-second UTC timestamp', () => {
      const parsed = requireTimestamp({ t: '2027-01-31T23:59:59Z' }, 't');
      expect(formatTimestamp(parsed)).toBe('2027-01-31T23:59:59Z');
    });

    it('keeps sub-second precision when present', () => {
      expect(formatTimestamp(new Date('2027-01-31T23:59:59.123Z'))).toBe(
        '2027-01-31T23:59:59.123Z',
      );
    });
  });

  describe('isUuid', () => {
    it('accepts a uuid', () => {
      expect(isUuid('6f1c2f0e-0f1a-4c65-9adf-2e0f7b0e8a11')).toBe(true);
    });

    it.each(['', 'abc', '6f1c2f0e0f1a4c659adf2e0f7b0e8a11', 'not-a-uuid'])('rejects %p', (value) => {
      expect(isUuid(value)).toBe(false);
    });
  });
});
