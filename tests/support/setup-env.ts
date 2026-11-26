/**
 * Test environment defaults. Runs before any test module is imported, so the
 * logger and the pool pick these up.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.DATABASE_URL =
  process.env.DATABASE_URL?.trim() || 'postgres://pulse:pulse@localhost:5432/pulsegym';
