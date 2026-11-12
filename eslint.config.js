import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // api/sim.js is generated (npm run build:api) from server/sim.ts.
  { ignores: ['dist/', 'node_modules/', '.vercel/', 'api/sim.js', 'scripts/.sim-suite.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  // Unused imports in tests are noise, not bugs. Warn so the money-path test files stay untouched.
  { files: ['**/*.test.ts'], rules: { '@typescript-eslint/no-unused-vars': 'warn' } },
);
