import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import { builtinModules } from 'node:module'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const typedFiles = ['packages/*/src/**/*.ts']
const nonTypedTsFiles = [
  '**/*.test.ts',
  '**/*.spec.ts',
  'examples/**/*.ts',
  'vitest.config.ts',
]
const nonTypedJsFiles = ['**/*.{js,mjs,cjs}']
const focusGuardOptions = [
  {
    object: 'describe',
    property: 'only',
    message: 'Focused tests must not be committed.',
  },
  {
    object: 'it',
    property: 'only',
    message: 'Focused tests must not be committed.',
  },
  {
    object: 'test',
    property: 'only',
    message: 'Focused tests must not be committed.',
  },
]
const focusGuards = ['error', ...focusGuardOptions]

// The packages below run unchanged on runtimes with no Node built-ins (browsers, edge
// workers, Deno, Bun): their source must not reach for `node:*`, `Buffer` or `process`.
// `packages/testing`, the CLI runners and the build/test tooling are Node-only by design.
const runtimeAgnosticSources = [
  'core',
  'google',
  'xai',
  'quota',
  'drizzle',
  'any-llm',
].map((name) => `packages/${name}/src/**/*.ts`)
const runtimeAgnosticIgnores = ['**/*.test.ts', '**/*.spec.ts']
const nodeBuiltinNames = builtinModules.filter((name) => !name.startsWith('_'))
const nodeOnlyMessage =
  'This package runs on runtimes without Node built-ins; use a web-standard API.'
const nodeOnlyGlobals = ['Buffer', 'process', '__dirname', '__filename', 'require'].map(
  (name) => ({ name, message: `\`${name}\` is Node-only. ${nodeOnlyMessage}` }),
)
const nodeBuiltinSource = `/^(node:.*|${nodeBuiltinNames
  .map((name) => name.replace(/[/.]/g, '\\$&'))
  .join('|')})$/`

function scopeTypedConfigs(configs) {
  return configs.map((config) => ({
    ...config,
    files: typedFiles,
    ignores: nonTypedTsFiles,
  }))
}

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.craftsman/**',
      '.remember/**',
      '.claude/**',
      '.private/**',
      '.recapture/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: nonTypedJsFiles,
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  ...scopeTypedConfigs(tseslint.configs.recommendedTypeChecked),
  {
    files: nonTypedJsFiles,
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          fixStyle: 'separate-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/unbound-method': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-restricted-properties': focusGuards,
    },
  },
  {
    files: nonTypedTsFiles,
    extends: [tseslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: false,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-restricted-properties': focusGuards,
    },
  },
  {
    files: runtimeAgnosticSources,
    ignores: runtimeAgnosticIgnores,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinNames.map((name) => ({ name, message: nodeOnlyMessage })),
          patterns: [{ group: ['node:*'], message: nodeOnlyMessage }],
        },
      ],
      'no-restricted-globals': ['error', ...nodeOnlyGlobals],
      'no-restricted-properties': [
        'error',
        ...focusGuardOptions,
        ...['Buffer', 'process', 'require'].map((property) => ({
          object: 'globalThis',
          property,
          message: `\`globalThis.${property}\` is Node-only. ${nodeOnlyMessage}`,
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `ImportExpression[source.value=${nodeBuiltinSource}]`,
          message: nodeOnlyMessage,
        },
      ],
    },
  },
  {
    files: ['packages/testing/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
    },
  },
)
