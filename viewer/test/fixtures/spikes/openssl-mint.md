# Probe — does this machine's `openssl` mint a CA and an IP-SAN leaf that node's `tls` accepts?

openssl: LibreSSL 3.3.6 (`/usr/bin`) · OpenSSL 3.6.4 25 Aug 2026 (`/opt/homebrew/bin`)
node: v24.13.1
date: 2026-09-18
verdict: mints-with-extfile
cost_usd: 0 (local key minting and one loopback TLS handshake per binary)
settles: `many-plans-one-repo` phase 1 arms O-1…O-3 — the TLS half of phase 21, and the `reach-tls` row phase 23 would have had to carry

**Why this exists.** Phase 21 mints a local CA and an IP-SAN leaf so phase 22 can open a second HTTPS
listener on this machine's LAN address. The plan's contingency said: *if O-1 is NO, phase 21 mints only with
a PATH that finds Homebrew's `openssl`, and `doctor fleet` must say so in its `reach-tls` row.* **O-1 is
YES**, so that contingency does not fire and phase 23's `reach-tls` row has one less state to carry.

| arm | binary | verdict |
|---|---|---|
| `O-1` | `/usr/bin/openssl` — LibreSSL 3.3.6, first on the fleet unit's PATH | mints-with-extfile |
| `O-2` | `/opt/homebrew/bin/openssl` — OpenSSL 3.6.4 | mints-with-extfile |
| `O-3` | node validates both leaves over the IP SAN | validates |

## The argv that works, on both binaries

Keys are minted by **node** (`crypto.generateKeyPairSync('ec', {namedCurve:'prime256v1', …})`, pkcs8, `0600`);
`openssl` only signs. All three commands exit 0 on both binaries, with identical extensions in the result:

```
openssl req  -x509 -new -key ca.key -sha256 -days 3650 -out ca.crt -config ca.cnf -extensions v3_ca
openssl req  -new -key leaf.key -out leaf.csr -config leaf.cnf
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -set_serial 2 -days 365 -sha256 \
             -extfile leaf.cnf -extensions v3_leaf -out leaf.crt
```

with `leaf.cnf` carrying

```
[v3_leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:<lan-ipv4>, IP:127.0.0.1, DNS:<hostname>
subjectKeyIdentifier = hash
```

**`-addext` exists on `req` in BOTH binaries** — including LibreSSL 3.3.6, which the plan expected might
lack it. Phase 21 should still prefer the `-extfile`/`-extensions` form: it is the one measured end to end
here, it keeps the SAN list in a file rather than in an argv that must be quoted twice, and `x509 -req` takes
`-extfile` on both while `-addext` is a `req` flag only. The two binaries differ in nothing that matters —
only in what they print (`Signature ok` / `subject=/CN=…` versus `Certificate request self-signature ok` /
`subject=CN=…`) and in the serial, which `-set_serial` pins anyway.

Resulting leaf, identical in shape from both:

```
X509v3 Subject Alternative Name: IP Address:<lan-ipv4>, IP Address:127.0.0.1, DNS:<hostname>
X509v3 Extended Key Usage:       TLS Web Server Authentication
Signature Algorithm:             ecdsa-with-SHA256
Validity:                        365 days
```

## O-3 — node accepts it, and by the IP SAN

```js
tls.createServer({ cert, key }).listen(0, '127.0.0.1');
tls.connect({ host: '127.0.0.1', port, ca });   // default checkServerIdentity, NO servername
```

| leaf minted by | `authorized` | `authorizationError` | `X509Certificate.fingerprint256` == `openssl x509 -noout -fingerprint -sha256` |
|---|---|---|---|
| LibreSSL 3.3.6 | **true** | none | **true** |
| OpenSSL 3.6.4 | **true** | none | **true** |

The identity check is the load-bearing part, so it was run **without** the escape hatch: no
`checkServerIdentity` override and no `servername`, which leaves node to match the literal address
`127.0.0.1` against `IP Address:127.0.0.1` in the SAN. It does. A first pass of this arm overrode
`checkServerIdentity` and proved only that the chain validated — recorded here because that weaker probe
looks identical in its output and is the easy mistake to repeat.

The fingerprint equality matters for phase 23's UI: the string the console shows an operator, so they can
compare it against what their phone displays, can be derived in node and will match what `openssl` prints.

**The LAN address was not bound.** `192.168.31.235` is in the SAN, but every handshake here was on
`127.0.0.1`. A non-loopback bind is the plan's one named non-git act and belongs to phases 17 and 22 under
`PHASE_CONSOLE_REACH_LAN=1`; nothing in this arm needed it, since the IP-SAN matching path is the same for
either address.

## Apple's constraints on a private CA, and whether this leaf meets them

From *"Requirements for trusted certificates in iOS 13 and macOS 10.15"* (support.apple.com/en-us/103769,
last updated 6 November 2023). The page does not distinguish publicly trusted roots from user-installed
ones, so phase 21 should treat them as applying to this CA too:

| Apple requires | this leaf | |
|---|---|---|
| validity ≤ 825 days | 365 days | ✅ |
| the name in the **SAN**; a DNS name in CommonName is no longer trusted | SAN carries both IPs and the DNS name | ✅ |
| RSA ≥ 2048 bits | EC P-256 (`prime256v1`) instead | ✅ — the RSA floor does not apply; the page states no EC curve requirement |
| a SHA-2 family hash, on the leaf **and the issuing CA** | `ecdsa-with-SHA256` on both | ✅ |
| EKU present, containing `id-kp-serverAuth` | `TLS Web Server Authentication` | ✅ |

The page states nothing about `basicConstraints` or `keyUsage`; this CA is nonetheless
`critical,CA:TRUE,pathlen:0` with `keyCertSign,cRLSign`, and the leaf `critical,CA:FALSE`.

**No phone was in the loop.** Whether iOS actually trusts this chain after the CA is installed and fully
trusted is E9's to find out; this fixture establishes only that the certificate satisfies every published
constraint and that node accepts it. The 365-day leaf with renewal 30 days early, which phase 21 specifies,
sits comfortably inside the 825-day ceiling.

## What this fixture does not establish

Renewal and reload (phase 21's 30-day-early path), custom operator-supplied PEMs, the `0600` secret layout
under `<stateHome>/fleet/reach/`, and any browser's or iOS's own verdict. Nor was the fleet unit's rendered
`PATH` read from a live unit — `/usr/bin/openssl` was invoked by absolute path, which is the stronger test
of the same claim.
