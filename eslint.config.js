import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'data/', 'probe/out/'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**', 'src/main.ts', 'src/cli/**'],
    rules: { 'no-console': 'off' },
  },
  // Owner-run recon scripts: plain Node ESM, not part of the TypeScript project.
  { files: ['probe/**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  {
    files: ['probe/**/*.mjs'],
    languageOptions: {
      parserOptions: { projectService: false },
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
