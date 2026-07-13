import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // Build output, deps, and packaging artifacts are not linted. The public/
    // ort folder holds onnxruntime-web's prebuilt (minified) wasm loader glue,
    // copied from node_modules by scripts/setup-native.mjs — never our source.
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'resources/**', 'src/renderer/public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // React components live in .tsx. Scoped to tsx so non-React helpers in
    // .ts (e.g. a `useCanvas()` xterm fallback) aren't flagged by the
    // hook-naming heuristic.
    files: ['src/renderer/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // Pragmatic defaults for this codebase: warn (don't fail) on unused/any
      // so lint stays advisory alongside the typecheck gate. Allow _-prefixed
      // unused args, which the IPC/handler signatures use intentionally.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // This is a terminal emulator: regexes intentionally match ANSI/VT
      // control characters (ESC, BEL, etc.).
      'no-control-regex': 'off',
    },
  },
  // Must be last: turns off rules that conflict with Prettier formatting.
  prettier
)
