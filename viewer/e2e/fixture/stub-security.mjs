#!/usr/bin/env node
// A `security` that is not the macOS keychain — first on the fixture console's
// PATH, so the tour never reads the operator's own Claude login (#297).
//
// The console finds the machine login's OAuth blob with
// `security find-generic-password -s 'Claude Code-credentials' -w`; this
// answers that one lookup with a canned blob whose token means nothing
// anywhere, and the usage endpoint the fixture points the console at
// (`PHASE_CONSOLE_USAGE_BASE`, `console.ts`) answers it with a seeded reading.
// Every other lookup is the keychain's own "not found" (exit 44), and nothing
// is ever written: the console's writes are refused before they get here
// (`PHASE_CONSOLE_KEYCHAIN=0`).
'use strict';

const argv = process.argv.slice(2);
const service = argv[argv.indexOf('-s') + 1];

if (argv[0] === 'find-generic-password' && argv.indexOf('-s') >= 0 && service === 'Claude Code-credentials') {
  const blob = {
    claudeAiOauth: {
      accessToken: 'e2e-fixture-access',
      refreshToken: 'e2e-fixture-refresh',
      // A year out: the console never tries to renew a login that is the tour's.
      expiresAt: Date.now() + 365 * 86_400_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  };
  process.stdout.write(`${JSON.stringify(blob)}\n`, () => process.exit(0));
} else {
  process.stderr.write(
    'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
    () => process.exit(44),
  );
}
