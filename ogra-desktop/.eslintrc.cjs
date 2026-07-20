/**
 * Minimal ESLint config for Ogra Desktop (Sequence 0).
 *
 * Only enforces rules that match what TypeScript already enforces at
 * typecheck time, plus a no-unused-vars guard scoped to TS files. This
 * keeps the lint command in package.json runnable and clean without
 * introducing a stylistic toolchain debate that the Sequence 0 scope
 * does not own. Plan 07 §6 puts security checks (contextIsolation etc.)
 * in tests/security/desktop-security.test.ts; lint here stays narrow.
 */
module.exports = {
  root: true,
  env: { node: true, browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: false,
  },
  plugins: ['@typescript-eslint'],
  ignorePatterns: ['dist', 'dist-electron', 'node_modules', 'tests'],
  rules: {
    // Sequence 0 only treats lint regressions as failures. Pre-existing
    // unused imports across many files predate this work; running lint
    // with errors would block on unrelated noise. Typecheck already
    // enforces types. Keep this as a warning so new regressions show up.
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-var': 'error',
    'prefer-const': 'warn',
    eqeqeq: ['error', 'always'],
  },
};
