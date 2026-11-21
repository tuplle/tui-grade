// Transformer choice: Node's native `stripTypeScriptTypes` (see scripts/jest-transform.mjs).
// No @swc/jest fallback is needed; sources are erasable TypeScript only.
export default {
  extensionsToTreatAsEsm: ['.ts'],
  transform: { '\\.ts$': '<rootDir>/scripts/jest-transform.mjs' },
  testMatch: ['**/tests/**/*.test.ts'],
  // The standalone bundle (scripts/make-bundle.mjs) contains a second package.json named like ours.
  modulePathIgnorePatterns: ['<rootDir>/bundle/'],
};
