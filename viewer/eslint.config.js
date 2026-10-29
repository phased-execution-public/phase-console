// ESLint for the client and the shared modules — flat config, ESLint 10.
//
// Scope is deliberate: `client/src` (the React app + its Vitest suite) and
// `shared/` (the dependency-free ESM both the client and the node suite
// import). The server is plain Node TypeScript run without a build and is
// covered by its own `node --test` suite; it is not linted here.
//
// typescript-eslint parses through the TypeScript *JS* compiler API, which is
// why `package.json` pins `typescript` to the 6.x line (the native 7.x package
// ships `tsc` only). Type-aware rules are off on purpose: the suite runs in
// seconds and a type-checked lint over 150 files would not, and `tsc` already
// runs in CI (`typecheck:client`).
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/* ------------------------------------------------------------------ *
 * The rules of the client's tree (quiet-console §Architecture 4).
 *
 * One navigation door (no hand-written `#/…` address outside
 * `shell/routes.ts`), one data door (`useQuery`/`useMutation` imported only
 * inside `data/`), one status renderer (`DotWord` imported only inside
 * `ui/status/**`), one stream (an `EventSource` opened only by `data/live.ts`
 * and the Logs tail) and one table engine (TanStack Table reached only through
 * `ui/grid/engine.ts`, by `import()`). Each holds over the whole of
 * `client/src`; the blocks after the first carve out exactly the one file or
 * folder that IS the door. Flat config replaces a rule's options wholesale per
 * matching block, so each block below spells its whole option set through the
 * two builders.
 * ------------------------------------------------------------------ */
const DOT_WORD_MESSAGE =
  'Draw a status through the typed family (@/ui/status) — DotWord is its renderer, imported only inside ui/status/**.';
const DATA_DOOR_MESSAGE =
  'One data door: useQuery/useMutation are imported only inside client/src/data/ — reach a domain through its data/<domain>.ts hooks.';
const ADDRESS_MESSAGE =
  'One navigation door: no hand-written `#/…` address outside shell/routes.ts — build it with the routes module.';
const ENGINE_MESSAGE =
  'Only ui/grid/engine.ts imports the table engine — reach the grid through @/ui/grid/grid.';
const ENGINE_DOOR_MESSAGE =
  'The table engine is reached only through import() (ui/grid/grid.tsx): a static import puts TanStack Table on the path of ' +
  'every page that draws a table, and check-dist fails that build. A type import is erased — write `import type`.';
const ONE_CLOCK_MESSAGE =
  'One page clock: read the time through @/ui/clock (usePageNow, useNow, useWindowLeft) — lib/clock was folded into it ' +
  '(measured-console phase 32), and a second clock is two figures that disagree by a tick.';
const ONE_CARD_MESSAGE =
  "One human-step card: cards/item-card.tsx draws every person's step — human-step-card was folded into it " +
  '(measured-console phase 32).';
/** A module whose last segment is `engine` — the table engine's file, by any path. */
const ENGINE_SOURCE = String.raw`/(^|\/)engine$/`;
const EVENT_SOURCE_MESSAGE =
  "One stream: data/live.ts opens the console's one EventSource and shares it across tabs. The one named exception is " +
  'the Logs tail (screens/logs/tail.ts), a per-query stream its reader turns on and off — subscribe through data/live.ts.';
/** The two files that may open an `EventSource`: the console's one stream, and the Logs tail. */
const EVENT_SOURCE_DOORS = ['client/src/data/live.ts', 'client/src/screens/logs/tail.ts'];

/** The whole `no-restricted-imports` option set for a block of the client. */
function restrictedImports({ dotWord = true, dataDoor = true, engine = true } = {}) {
  return [
    'error',
    {
      paths: [
        ...(engine
          ? [
              { name: '@tanstack/react-table', message: ENGINE_MESSAGE },
              { name: '@tanstack/table-core', message: ENGINE_MESSAGE },
            ]
          : []),
        ...(dataDoor
          ? [
              {
                name: '@tanstack/react-query',
                importNames: [
                  'useQuery',
                  'useQueries',
                  'useInfiniteQuery',
                  'useSuspenseQuery',
                  'useMutation',
                ],
                message: DATA_DOOR_MESSAGE,
              },
            ]
          : []),
      ],
      patterns: [
        ...(engine
          ? [{ group: ['@tanstack/react-table/*', '@tanstack/table-core/*'], message: ENGINE_MESSAGE }]
          : []),
        ...(dotWord ? [{ group: ['**/dot-word'], message: DOT_WORD_MESSAGE }] : []),
        // The two folded modules: neither path may come back, from anywhere.
        { group: ['**/lib/clock', '**/lib/clock.ts'], message: ONE_CLOCK_MESSAGE },
        {
          group: [
            '**/cards/human-step-card',
            '**/cards/human-step-card.tsx',
            './human-step-card',
            './human-step-card.tsx',
          ],
          message: ONE_CARD_MESSAGE,
        },
      ],
    },
  ];
}

/** The whole `no-restricted-syntax` option set: the client's bans, plus the address door. */
function restrictedSyntax({ addresses = true, eventSource = true } = {}) {
  return [
    'error',
    // The colour system: a literal colour in a component is invisible in
    // one of the two themes. Tokens only (`var(--status-*)`, `text-done`…).
    {
      selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
      message: 'No literal colours in the client — use a token (`var(--…)`, a `text-*`/`bg-*` utility).',
    },
    // `scrollIntoView` scrolls every ancestor — including the page — and
    // made the run page crawl under SSE renders. Move `scrollLeft`/`Top`.
    {
      selector: "CallExpression[callee.property.name='scrollIntoView']",
      message:
        'scrollIntoView scrolls every ancestor; move scrollLeft/scrollTop on the one scroller instead.',
    },
    // The table engine's door is `import()`: a static VALUE import or a
    // re-export of it, from anywhere, is the engine on some page's first load.
    {
      selector: `ImportDeclaration[importKind='value'][source.value=${ENGINE_SOURCE}]`,
      message: ENGINE_DOOR_MESSAGE,
    },
    { selector: `ExportAllDeclaration[source.value=${ENGINE_SOURCE}]`, message: ENGINE_DOOR_MESSAGE },
    {
      selector: `ExportNamedDeclaration[exportKind='value'][source.value=${ENGINE_SOURCE}]`,
      message: ENGINE_DOOR_MESSAGE,
    },
    // One stream (quiet-console §Architecture 4): a second `EventSource` is a
    // second connection per tab, and the server sends `run:stream` only to the
    // listener that asked for it — `data/live.ts` is that listener.
    ...(eventSource
      ? [{ selector: "NewExpression[callee.name='EventSource']", message: EVENT_SOURCE_MESSAGE }]
      : []),
    ...(addresses
      ? [
          { selector: 'TemplateLiteral[quasis.0.value.raw=/^#\\//]', message: ADDRESS_MESSAGE },
          { selector: 'Literal[value=/^#\\//]', message: ADDRESS_MESSAGE },
        ]
      : []),
  ];
}

export default tseslint.config(
  {
    ignores: [
      'client/dist/**',
      'client/.dist-verify/**',
      'client/dev-dist/**',
      'node_modules/**',
      // The service worker is a WebWorker program typechecked on its own
      // (tsconfig.sw.json); its globals are not the app's.
      'client/src/sw.ts',
      'e2e/.results/**',
      'e2e/.shots/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['client/src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The two hook rules that hold regardless of compiler: a hook called
      // conditionally is a bug, and an effect that lies about its inputs is
      // the classic stale-closure bug.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // The rest of `eslint-plugin-react-hooks` 7's recommended set are the
      // React Compiler's rules (set-state-in-effect, refs, purity, static-
      // components, incompatible-library, …). The compiler is not enabled in
      // this app, and those rules flag patterns here that are deliberate — a
      // clock that re-reads on activation, a pane that keeps its status in
      // state beside a ref — so they stay off until a phase turns the
      // compiler on and pays for them all at once.
      // `tsc` already enforces unused locals/params; ESLint's own rule with
      // the `_` convention covers the destructure-to-drop pattern it accepts.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Type-only imports are erased by `verbatimModuleSyntax`; asking for
      // them keeps the runtime graph one-directional (vocab → nothing).
      '@typescript-eslint/consistent-type-imports': [
        'error',
        // `disallowTypeAnnotations: false`: `importOriginal<typeof import('@/data/api')>()`
        // is Vitest's own documented mock idiom, and the annotation is erased anyway.
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // The `{}` object type reads as "any non-null value" — rarely what was meant.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
      // A `// @ts-expect-error` without a reason is a rule nobody can revisit.
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      // The doors of the tree — see the block above the config.
      'no-restricted-imports': restrictedImports(),
      'no-restricted-syntax': restrictedSyntax(),
    },
  },
  {
    // The data layer is the one place the query hooks live.
    files: ['client/src/data/**'],
    rules: { 'no-restricted-imports': restrictedImports({ dataDoor: false }) },
  },
  {
    // The status renderer's one family: `DotWord` is imported only here.
    files: ['client/src/ui/status/**'],
    rules: { 'no-restricted-imports': restrictedImports({ dotWord: false }) },
  },
  {
    // The one navigation door: the only file that spells `#/`.
    files: ['client/src/shell/routes.ts'],
    rules: { 'no-restricted-syntax': restrictedSyntax({ addresses: false }) },
  },
  {
    // The one stream and its one named exception — see `restrictedSyntax`.
    files: EVENT_SOURCE_DOORS,
    rules: { 'no-restricted-syntax': restrictedSyntax({ eventSource: false }) },
  },
  {
    // The table engine's one door. The data door and the status renderer's
    // family hold here as everywhere.
    files: ['client/src/ui/grid/engine.ts'],
    rules: { 'no-restricted-imports': restrictedImports({ engine: false }) },
  },
  {
    // The one file where literal colours are CORRECT: the sixteen ANSI slots
    // of the terminal palette are an addressing scheme, not a design decision
    // (its own header says why). Everything that IS a design decision there is
    // still read from the live stylesheet.
    files: ['client/src/screens/sessions/palette.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // The Vitest suite: globals on, and a test may name a thing a rule bans.
    files: ['client/src/**/*.test.{ts,tsx}', 'client/src/test/**/*.ts', 'client/src/test-setup.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.vitest } },
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The real-browser harness: Node (the fixture, the specs) and the page (the
    // probes Playwright ships into it) in one tree. `({}, info) =>` is how a
    // Playwright hook asks for its test info, hence no-empty-pattern.
    files: ['e2e/**/*.{ts,mjs}', 'playwright.config.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-console': 'off',
      'no-empty-pattern': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The node suite (measured-console phase 15): `viewer/test`, linted by
    // `npm run lint:test`, never by `lint:client`. Node globals; a fake or a
    // probe is allowed what a test double needs (`any`, a non-null assertion,
    // an empty function, a `require` of a CommonJS fixture). What stays on is
    // what finds real defects: unused names, unreachable code, duplicate keys,
    // a misspelt global.
    files: ['test/**/*.{ts,mts,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-empty-pattern': 'off',
      'no-control-regex': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Two idioms of a test, not defects: a runner declared with `let` before
      // the closures that will read it are built, and a `let text = ''` a
      // `try` overwrites when the file is there.
      'prefer-const': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    // The shared modules and the build scripts: plain ESM for node AND the browser.
    files: [
      'shared/**/*.{js,mjs}',
      'scripts/**/*.mjs',
      'vite.config.ts',
      'eslint.config.js',
      'stryker.config.mjs',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-console': 'off' },
  },
);
