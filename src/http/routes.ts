import { Router } from 'express';
import { bookingNotFound, invalidRequest } from '../errors';
import { withTransaction } from '../db/transaction';
import { getPool } from '../db/pool';
import { getClassDetail, createClass } from '../services/classes';
import { createMember, updateMember } from '../services/members';
import { cancelBooking, createBooking, getBooking } from '../services/bookings';
import { resetAll } from '../services/admin';
import { handle } from './error-middleware';
import {
  asJsonObject,
  isUuid,
  MAX_TEXT_LENGTH,
  requireCapacity,
  requireIdempotencyKey,
  requireString,
  requireTimestamp,
} from './validation';

/**
 * Reads a path parameter as a string. Express 5 types params as
 * `string | string[] | undefined`, so this narrows once instead of everywhere.
 */
function pathParam(req: { params: Record<string, unknown> }, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value === '') {
    throw invalidRequest(`Path parameter "${name}" is required`);
  }
  return value;
}

/** Races a promise against a timer without leaving the timer pending. */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The complete public surface of the service. Nothing else is mounted: an extra
 * endpoint could interfere with the official checker, so the router matches the
 * specification one-to-one.
 */
export function buildRouter(): Router {
  const router = Router();

  router.get(
    '/health',
    handle(async (_req, res) => {
      // The readiness endpoint reflects the whole service, not just the process:
      // until the database answers, the API cannot serve a single meaningful
      // request, and Docker/CI should keep waiting.
      try {
        await withTimeout(getPool().query('SELECT 1'), 2000);
        res.status(200).json({ status: 'ok' });
      } catch {
        res.status(503).json({ status: 'unavailable' });
      }
    }),
  );

  router.post(
    '/admin/reset',
    handle(async (_req, res) => {
      await resetAll();
      res.status(204).end();
    }),
  );

  router.post(
    '/members',
    handle(async (req, res) => {
      const body = asJsonObject(req.body);
      const member = await createMember({
        id: requireString(body, 'id'),
        name: requireString(body, 'name', MAX_TEXT_LENGTH),
        membershipExpiresAt: requireTimestamp(body, 'membership_expires_at'),
      });
      res.status(201).json(member);
    }),
  );

  router.patch(
    '/members/:memberId',
    handle(async (req, res) => {
      const body = asJsonObject(req.body);
      const patch: { membershipExpiresAt?: Date; name?: string } = {};
      if ('membership_expires_at' in body) {
        patch.membershipExpiresAt = requireTimestamp(body, 'membership_expires_at');
      }
      if ('name' in body) {
        patch.name = requireString(body, 'name', MAX_TEXT_LENGTH);
      }
      const member = await updateMember(pathParam(req, 'memberId'), patch);
      res.status(200).json(member);
    }),
  );

  router.post(
    '/classes',
    handle(async (req, res) => {
      const body = asJsonObject(req.body);
      const created = await createClass({
        id: requireString(body, 'id'),
        name: requireString(body, 'name', MAX_TEXT_LENGTH),
        capacity: requireCapacity(body, 'capacity'),
        startsAt: requireTimestamp(body, 'starts_at'),
      });
      res.status(201).json(created);
    }),
  );

  router.get(
    '/classes/:classId',
    handle(async (req, res) => {
      const detail = await withTransaction((client) => getClassDetail(client, pathParam(req, 'classId')), {
        readOnly: true,
        isolation: 'repeatable read',
      });
      res.status(200).json(detail);
    }),
  );

  router.post(
    '/classes/:classId/bookings',
    handle(async (req, res) => {
      // Header first: a missing key is a 400 even if the body is fine.
      const idempotencyKey = requireIdempotencyKey(req.header('idempotency-key'));
      const body = asJsonObject(req.body);
      const memberId = requireString(body, 'member_id');

      const result = await createBooking({
        classId: pathParam(req, 'classId'),
        memberId,
        idempotencyKey,
      });
      res.status(result.statusCode).json(result.body);
    }),
  );

  router.delete(
    '/bookings/:bookingId',
    handle(async (req, res) => {
      const bookingId = pathParam(req, 'bookingId');
      // Booking ids are UUIDs; anything else cannot exist, so it is a 404 rather
      // than a database cast error.
      if (!isUuid(bookingId)) throw bookingNotFound(bookingId);

      const result = await cancelBooking(bookingId);
      res.status(result.statusCode).json(result.body);
    }),
  );

  router.get(
    '/bookings/:bookingId',
    handle(async (req, res) => {
      const bookingId = pathParam(req, 'bookingId');
      if (!isUuid(bookingId)) throw bookingNotFound(bookingId);

      const booking = await withTransaction((client) => getBooking(client, bookingId), {
        readOnly: true,
      });
      res.status(200).json(booking);
    }),
  );

  return router;
}
