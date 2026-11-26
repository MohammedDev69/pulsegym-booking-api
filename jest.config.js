/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/support/setup-env.ts'],
  // Every suite talks to the same PostgreSQL database, so they must not overlap.
  maxWorkers: 1,
  testTimeout: 120000,
  verbose: true,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { rootDir: '.', types: ['node', 'jest'] } }],
  },
};
