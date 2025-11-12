import { fixupConfigRules, includeIgnoreFile } from '@eslint/compat';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});
const gitignorePath = path.resolve(__dirname, '.gitignore');

export default [
  includeIgnoreFile(gitignorePath),
  {
    ignores: [
      '**/node_modules/',
      '**/build/',
      './husky.js',
      'devel.js',
      'seeds/',
      'src/apollo/types.generated.ts',
      'eslint.config.js',
      'knexfile.ts',
      'jest.config.js',
      '*.graphql',
      '**/*.test.ts',
    ],
  },
  ...fixupConfigRules(compat.extends('prettier', 'plugin:import/recommended', 'plugin:import/typescript')),

  {
    files: ['src/**/*.ts'],

    plugins: {
      '@typescript-eslint': typescriptEslint,
      // import: importPlugin,
    },

    languageOptions: {
      globals: {
        ...globals.commonjs,
        ...globals.node,
        Atomics: 'readonly',
        SharedArrayBuffer: 'readonly',
      },

      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: 'module',

      parserOptions: {
        project: './tsconfig.json',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },

    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },

    rules: {
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': ['error', {}],

      'import/extensions': [
        'error',
        'ignorePackages',
        {
          js: 'always',
          jsx: 'never',
          ts: 'never',
          tsx: 'never',
        },
      ],

      'class-methods-use-this': [1],
      'no-underscore-dangle': [0],
      'import/no-unresolved': [0],
      'no-unused-vars': 'off',

      '@typescript-eslint/no-unused-vars': [
        2,
        {
          args: 'all',
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],

      camelcase: 2,
      'arrow-body-style': 0,
      'no-mixed-spaces-and-tabs': 2,

      'max-len': [
        2,
        {
          code: 120,
          tabWidth: 2,
          ignoreUrls: true,
        },
      ],
    },
  },
];
