# Shadow Compact 0.4.14

This release records the runtime requirement for the October 2026
eMudhra/emSign intermediate CA compromise. The plugin has no TLS client and no
bundled CA store. Its Node.js runtime and the host `claude` CLI provide trust.

## Changes

- Require Node.js `^22.23.4 || ^24.22.1 || ^26.12.1`. These releases include
  NSS 3.131.1 and a blocklist for the eight compromised eMudhra intermediates
  (nodejs/node PR #66871).
- Document the runtime requirement in the README. Earlier Node.js releases may
  trust the compromised intermediates.
- Keep dependencies, workers, and runtime behavior unchanged. `dist/` is unchanged.

## Validation

- Node.js 24.19.0 connected with HTTP 200 to all six direct-chain eMudhra test
  hosts. Node.js 24.22.1 rejected all 12 direct and AAA test hosts with
  `CERT_REVOKED`.
- Claude Code 2.1.306 rejected both tested chains with `certificate rejected`.
  The control URL returned `invalid zip data`.
- `npm run check` passed: 105 tests passed and two host-fixture tests were skipped.
- `npm run typecheck:core` passed.
- `npm audit` and `npm audit --omit=dev` reported zero vulnerabilities.
- `npm ci --dry-run --ignore-scripts` reported the lockfile up to date.

Node.js 22.23.4 and 26.12.1 were not executed separately. Their expected behavior
rests on the release notes and nodejs/node PR #66871. Re-run the 12-host probe on
each deployed Node.js line.
