import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.vercel/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  // Unused imports in tests are noise, not bugs. Warn so the money-path test files stay untouched.
  { files: ['**/*.test.ts'], rules: { '@typescript-eslint/no-unused-vars': 'warn' } },
);
