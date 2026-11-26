import { memberExists, memberNotFound, invalidRequest } from '../errors';
import { formatTimestamp } from '../http/validation';
import { query } from '../db/pool';

export interface MemberRow {
  id: string;
  name: string;
  membership_expires_at: Date;
}

export interface MemberResponse {
  id: string;
  name: string;
  membership_expires_at: string;
}

function toMember(row: MemberRow): MemberResponse {
  return {
    id: row.id,
    name: row.name,
    membership_expires_at: formatTimestamp(row.membership_expires_at),
  };
}

const RETURNING = 'id, name, membership_expires_at';

export async function createMember(input: {
  id: string;
  name: string;
  membershipExpiresAt: Date;
}): Promise<MemberResponse> {
  const { rows } = await query<MemberRow>(
    `INSERT INTO members (id, name, membership_expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING
     RETURNING ${RETURNING}`,
    [input.id, input.name, input.membershipExpiresAt],
  );

  const row = rows[0];
  if (row === undefined) throw memberExists(input.id);
  return toMember(row);
}

/**
 * Updates the membership end date (and optionally the name). The tests use this
 * to expire a member, so it must be a single atomic statement.
 */
export async function updateMember(
  id: string,
  patch: { membershipExpiresAt?: Date; name?: string },
): Promise<MemberResponse> {
  if (patch.membershipExpiresAt === undefined && patch.name === undefined) {
    throw invalidRequest('At least one of "membership_expires_at" or "name" must be provided');
  }

  const { rows } = await query<MemberRow>(
    `UPDATE members
        SET membership_expires_at = COALESCE($2, membership_expires_at),
            name                  = COALESCE($3, name)
      WHERE id = $1
      RETURNING ${RETURNING}`,
    [id, patch.membershipExpiresAt ?? null, patch.name ?? null],
  );

  const row = rows[0];
  if (row === undefined) throw memberNotFound(id);
  return toMember(row);
}
