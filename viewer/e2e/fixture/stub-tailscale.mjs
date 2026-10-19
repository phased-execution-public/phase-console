#!/usr/bin/env node
// A `tailscale` that is not the machine's tailnet — the fixture console's
// `PHASE_CONSOLE_TAILSCALE_BIN`, so Settings ▸ This instance and every Reach
// card draw the same seeded tailnet on every machine and no picture carries an
// operator's login or devices (#329). `status --json` answers a running daemon
// on an example tailnet with one peer online and one asleep; `serve status
// --json` answers an empty table. Anything else is an unknown command.
'use strict';

const argv = process.argv.slice(2);
const json = (o) => process.stdout.write(`${JSON.stringify(o)}\n`, () => process.exit(0));
const device = (name, ip, os, online, lastSeen) => ({
  HostName: name,
  DNSName: `${name}.example-tailnet.ts.net.`,
  TailscaleIPs: [ip],
  OS: os,
  Online: online,
  ...(lastSeen ? { LastSeen: lastSeen } : {}),
});

if (argv[0] === 'status' && argv.includes('--json')) {
  json({
    BackendState: 'Running',
    MagicDNSSuffix: 'example-tailnet.ts.net',
    CurrentTailnet: { Name: 'example-tailnet', MagicDNSEnabled: true },
    Self: device('e2e-mac', '100.64.0.1', 'macOS', true),
    Peer: {
      phone: device('e2e-phone', '100.64.0.2', 'iOS', true),
      laptop: device('e2e-laptop', '100.64.0.3', 'linux', false, '2026-01-01T00:00:00Z'),
    },
  });
} else if (argv[0] === 'serve' && argv[1] === 'status' && argv.includes('--json')) {
  json({});
} else if (argv[0] === 'version') {
  process.stdout.write('1.80.0\n', () => process.exit(0));
} else {
  process.stderr.write(`tailscale (e2e stub): unknown command ${argv.join(' ')}\n`, () => process.exit(1));
}
