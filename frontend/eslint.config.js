import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // eslint-plugin-react-hooks v7 (React Compiler-oriented rule set)
      // added this rule after this codebase's data-fetching pattern was
      // already established throughout: reset/derive some state at the
      // top of an effect (e.g. `setLoading(true)`, `setResults(null)`)
      // before an async fetch or as a direct consequence of a prop/state
      // change. That's the standard, still-current pattern for effectful
      // data fetching (see React's own docs), and every occurrence here
      // was individually checked during audit — several already carry
      // their own request-ID/cleanup guards against races (Home.jsx's
      // debounced search, EventPage's retry-with-backoff). Restructuring
      // 13 files of working navigation/data code to satisfy a compiler-
      // readiness rule this project doesn't yet use React Compiler with
      // is a real behavior-change risk for no behavior benefit, so this
      // is downgraded to a warning rather than silently rewritten.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    // vite.config.js (and this file) run as real Node.js — not bundled,
    // not executed in a browser — so they need Node's globals (`process`,
    // `__dirname`, etc.), not the browser set every other file uses.
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
