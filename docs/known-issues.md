# Known issues

Open items at the end of the initial build. Each was found by review, judged
non-blocking, and deliberately left. None blocks running the bridge against a
real dapp; the first is worth closing before you point it at dapps you don't
trust.

## 1. Typed-data payload parsing is under-validated

`src/bridge/decode/typed.ts:27-37` returns whatever `JSON.parse` produced
without checking it is an object, and `:168` prefers `params[1]`.

A dapp sending `params = [<real EIP-712 payload>, "1"]` gets a card reading
`Type: (unknown)` with no domain, no chain, no message and no warnings — and
because `:318` dumps `safeJson(data)` rather than `safeJson(params)`, the raw
fallback shows `1` as well. That is total suppression of the approval card for
a signature request.

Practical risk is currently low: the exploit needs the wallet to honour legacy
`eth_signTypedData` v1, and Coinbase Smart Wallet generally serves only `_v4`,
so a suppressed card most likely accompanies a wallet-side error rather than a
real signature. But the card going blank is exactly the failure this project
exists to prevent.

**Fix (two lines):** have `parse` return `null` unless the parsed value is a
non-null object, and dump `safeJson(params)` at `:318`.

## 2. One load-bearing line is untested

`src/main.ts:75` — `pending.onChange = () => ui.renderPending(pending)`.

This single statement is what makes the approval modal appear at all. Deleting
it restores the deadlock that blocked the first release, and no test would
fail: `src/ui/app.test.ts` reproduces main.ts's wiring in its own `mount()`
helper rather than importing it, so it asserts a *copy* of that line.

**Fix:** export the wiring from `main.ts` (or a small `wire()` function) and
have the test import the real thing.

## 3. An expiry lapsing after approval is silent

If a session request's TTL lapses while the Base app is showing its
confirmation sheet, the router correctly sends no response — but the user gets
no feedback at all. The modal closes and nothing happens.

A system clock running fast by more than the request TTL turns *every*
confirmation into that silent no-op, which would be baffling to diagnose.

**Fix:** surface a "request expired before the wallet responded" notice in the
UI when `abortIfExpired` fires post-approval.

## 4. Smaller decoder gaps

- `wallet_sendCalls` ignores the bundle's own `params[0].chainId`, labelling
  Network from the session chain instead (`decode/calls.ts:50`). If they
  disagree the card names the wrong network with no mismatch warning — unlike
  typed data, which does check. Most wallets reject a mismatched bundle.
- A non-numeric `expiryTimestamp` off the wire degrades badly
  (`router.ts:75`): `null` reads as already-expired (no response ever), a
  string yields `NaN` and fires a spurious timeout. Types say `number |
  undefined`, but this is wire data. One-line guard.
- `value: '0x'` — a benign zero some dapp libraries emit — trips the
  "could not be decoded" danger warning (`tx.ts:116`). Over-warning, but it is
  warning fatigue on a common shape.
- The Permit2 `details[]` loop (`typed.ts:234-253`) is uncapped, while the
  message-tree flattener ten lines below caps at 40 fields. A hostile
  `PermitBatch` can emit thousands of rows.
- Valid calldata shorter than 4 bytes (`0x12`) renders no Function and no
  Calldata row, so it is invisible on the card (`tx.ts:100`).
- `setWalletWarning` writes an SDK error message into `innerHTML` unescaped
  (`ui/app.ts:88`).
- `eth_sendRawTransaction` is honestly labelled but not decoded;
  `wallet_addEthereumChain`'s collision warning keys on chain id only;
  `wallet_sendCalls` renders at most 20 calls of a batch (announced on the card).

## 5. Deferred by earlier review rounds

Judged spec-sanctioned or cosmetic, listed so they are not lost:

- `chainChanged` fan-out does not check the session's approved chains, though
  `accountsChanged` carefully checks approved accounts.
- `eth_accounts` (a PASS method) can answer with an account the session never
  approved.
- `transfer` / `transferFrom` / `permit` / `execute` are named on the card but
  their arguments are not decoded — so the recipient and amount of the most
  common transaction a user signs never reach the card. The spec scopes
  argument decoding to `approve` and `setApprovalForAll`, so this is
  sanctioned, but it is ~8 lines reusing existing helpers.
- The ERC-1271 warning fires only for SIWE messages in `decode/sign.ts` but
  unconditionally in `decode/typed.ts`. A non-SIWE `personal_sign` verified
  off-chain by `ecrecover` fails identically.
- `as unknown as RouterDeps` in `router.test.ts` erases port type-checking on
  the mocks.
- `beforeunload` sets only `preventDefault()` without `e.returnValue = ''`
  (correct for evergreen browsers).
- Dead code: `shortAddress` is exported and tested but unused;
  `siwe.statement` is parsed and tested but never rendered.
