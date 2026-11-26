/**
 * Domain errors.
 *
 * Every error that a client is allowed to see is an `ApiError`. Anything else is
 * treated as an internal failure, logged, and reported as a generic 500 so that
 * SQL text, stack traces and driver details never leak over the wire.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const invalidRequest = (message: string): ApiError =>
  new ApiError(400, 'invalid_request', message);

export const classNotFound = (classId: string): ApiError =>
  new ApiError(404, 'class_not_found', `Class ${classId} does not exist`);

export const memberNotFound = (memberId: string): ApiError =>
  new ApiError(404, 'member_not_found', `Member ${memberId} does not exist`);

export const bookingNotFound = (bookingId: string): ApiError =>
  new ApiError(404, 'booking_not_found', `Booking ${bookingId} does not exist`);

export const membershipInactive = (memberId: string): ApiError =>
  new ApiError(403, 'membership_inactive', `Membership for member ${memberId} is not active`);

export const alreadyBooked = (memberId: string, classId: string): ApiError =>
  new ApiError(
    409,
    'already_booked',
    `Member ${memberId} already has an active booking or waitlist entry in class ${classId}`,
  );

export const alreadyCancelled = (bookingId: string): ApiError =>
  new ApiError(409, 'already_cancelled', `Booking ${bookingId} is already cancelled`);

export const memberExists = (memberId: string): ApiError =>
  new ApiError(409, 'member_exists', `Member ${memberId} already exists`);

export const classExists = (classId: string): ApiError =>
  new ApiError(409, 'class_exists', `Class ${classId} already exists`);
