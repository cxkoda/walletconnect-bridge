# Coinbase ↔ WalletConnect Bridge — Design

- **Date:** 2026-09-05
- **Status:** Approved, ready for implementation planning
- **Scope:** v1, single-user personal tool

## Problem

Some dapps offer WalletConnect as their only connection method. The Base app's
wallet (a Base Account) does not present itself over WalletConnect, so those
dapps cannot be used with it.

This project is a webapp that **impersonates a WalletConnect wallet**. It pairs
with the dapp over the WalletConnect relay, forwards each JSON-RPC request to
the real Base Account via an EIP-1193 provider, and relays the result back.

It is a deliberate man-in-the-middle. That is the entire function, and it is why
the approval card (below) is a security surface rather than decoration.

## Goals

1. Pair with any WalletConnect v2 dapp by pasting a `wc:` URI.
2. Forward signing and transaction requests to a Base Account and return results.
3. Show, before each signing request, **which dapp asked** and **what it asked
   for**, decoded.
4. Never leave a dapp hanging: exactly one response per request id, always.
5. No backend. No server ever sees a key, a signature, or a request.

## Non-goals (v1)

- Mobile QR camera scanner (desktop paste only).
- Multiple wallets / wallet switching.
- Transaction simulation or fork-based preview.
- Persisted request history.
- Cross-tab session synchronisation.
- Keeping sessions alive while the tab is closed (see Known Limitations).

## Constraints and assumptions

- **Account type is a Base Account** — an ERC-4337 smart contract account.
  Consequences that shape the design:
  - `personal_sign` / `eth_signTypedData_v4` return **ERC-1271/6492 contract
    signatures**, not ecrecover-able EOA signatures. Dapps that verify naively
    will reject them. The bridge cannot fix this; it detects and warns.
  - `eth_signTransaction` is impossible and must be refused at namespace
    negotiation time rather than mid-flow.
- **Deployment target:** static site. Vite build output; runs on `localhost` or
  any static host (Vercel static is fine). There is no server-side code.
- **Credential:** a Reown project ID (`VITE_REOWN_PROJECT_ID`). Public,
  client-side, not a secret. WalletKit will not initialise without it.
- Runtime is a desktop browser tab held open alongside the dapp.

## Architecture

```
src/
  cb/provider.ts      wallet-facing  — Coinbase SDK, EIP-1193 provider, chain sync
  wc/walletkit.ts     dapp-facing    — WalletKit init, pairing, session lifecycle
  bridge/policy.ts    pure           — method → PASS | CONFIRM | REJECT | UNKNOWN
  bridge/decode.ts    pure           — request params → human-readable card model
  bridge/errors.ts    pure           — thrown error → JSON-RPC error
  bridge/router.ts    the bridge     — depends on ports only, never on an SDK
  chains.ts                          — single source of truth for supported chains
  ui/                                — pair box, session list, approval modal
```

`router.ts` imports neither SDK. It depends on three ports, which is what makes
the interesting logic testable with fakes and no network:

```ts
interface WalletPort {
  request<T>(args: { method: string; params?: unknown[] }): Promise<T>;
  getChainId(): Promise<number>;
  switchChain(chainId: number): Promise<void>;
}

interface DappPort {
  respond(topic: string, response: JsonRpcResponse): Promise<void>;
}

interface ConfirmPort {
  // resolves true to approve, false to reject; rejects on expiry
  confirm(card: RequestCard): Promise<boolean>;
}
```

### Supported chains — one constant

`chains.ts` exports a single `SUPPORTED_CHAINS` array. It is passed to the
Coinbase SDK as `appChainIds` **and** used to build the WalletConnect
`supportedNamespaces`. Deriving both from one constant is deliberate: if they
drift, the bridge advertises chains it cannot serve and every request on those
chains fails after the dapp is already connected.

v1 set: Base (8453), Base Sepolia (84532), Ethereum (1), Optimism (10),
Arbitrum One (42161), Zora (7777777).

## Flows

### Flow A — connect the wallet (once per browser)

```
createCoinbaseWalletSDK({ appName, appLogoUrl, appChainIds: SUPPORTED_CHAINS })
  → getProvider()
  → eth_requestAccounts           → address
  → eth_getCode(address) !== '0x' → smart account → show signature caveat banner
  → subscribe: accountsChanged, chainChanged, disconnect
```

### Flow B — pair with a dapp

```
paste wc:…  → walletkit.pair({ uri })
            → 'session_proposal'
            → buildApprovedNamespaces({ proposal, supportedNamespaces })
            → approveSession  |  rejectSession(readable reason)
```

`buildApprovedNamespaces` from `@walletconnect/utils` performs the
required-vs-optional merge. It **throws** when the proposal requires a chain or
method outside `supportedNamespaces`. That throw is the desired behaviour:
catch it and reject the proposal with a human reason ("this dapp requires
Arbitrum, which this account doesn't support") rather than approving a session
that will fail on first use.

**Advertised methods:** `eth_sendTransaction`, `personal_sign`,
`eth_signTypedData`, `eth_signTypedData_v3`, `eth_signTypedData_v4`,
`wallet_switchEthereumChain`, `eth_accounts`, `eth_chainId`.

Note that the policy table below is deliberately **broader** than this advertised
set. Advertising is the negotiation contract — what the bridge promises during
`session_proposal`. Policy governs whatever actually arrives at runtime, and
dapps do send methods they never negotiated. The two are not required to match.

**Advertised events:** `accountsChanged`, `chainChanged`.

Deliberately excluded: `eth_sign` (deprecated; its params are reversed relative
to `personal_sign`, a known footgun, and there is no upside) and
`eth_signTransaction` (a smart account cannot produce one).

### Flow C — handle a request

```
'session_request' { topic, id, chainId: 'eip155:8453', request: { method, params } }
   │
   ├─ policy.classify(method)
   │     REJECT  → respond 4200, done
   │     UNKNOWN → escape-hatch card (Forward once / Reject)
   │     PASS    → forward immediately
   │     CONFIRM → decode → queue → approval card → await user
   │
   ├─ chain sync: provider chain ≠ request chain → switchChain first
   ├─ forward:    wallet.request({ method, params })
   └─ respond:    formatJsonRpcResult | formatJsonRpcError   ← guaranteed, in finally
```

## Method policy

Classification is an **allowlist, not a blocklist**. An unrecognised method must
never be blind-forwarded to the wallet.

| Disposition | Methods |
|---|---|
| **PASS** (silent) | `eth_accounts`, `eth_chainId`, `eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_getCode`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getTransactionCount`, `eth_blockNumber`, `eth_gasPrice`, `eth_feeHistory`, `eth_maxPriorityFeePerGas`, `wallet_switchEthereumChain`, `wallet_getCapabilities` |
| **CONFIRM** | `personal_sign`, `eth_signTypedData`, `eth_signTypedData_v3`, `eth_signTypedData_v4`, `eth_sendTransaction`, `eth_sendRawTransaction`, `wallet_sendCalls`, `wallet_addEthereumChain`, `wallet_watchAsset` |
| **REJECT** (4200) | `eth_sign`, `eth_signTransaction` |
| **UNKNOWN** | anything else → escape-hatch card |

The UNKNOWN escape hatch shows "this dapp asked for `<method>`, which is not in
the allowlist" with *Forward once* and *Reject*. Strict deny-by-default would
silently break dapps using a niche method; the escape hatch keeps the user
unblocked while making the gap visible so it can be added to the allowlist
deliberately.

```ts
type Disposition =
  | { kind: 'pass' }
  | { kind: 'confirm' }
  | { kind: 'reject'; code: number; message: string }
  | { kind: 'unknown' };
```

## Decoding — the approval card

**Header, always:** dapp name, icon, **origin URL** from session peer metadata,
and the WalletKit Verify badge — `VALID`, `UNKNOWN` (amber), `INVALID` or
`isScam` (red).

This header is the reason the card exists. When the bridge forwards a request,
the Base app sees *the bridge's* origin, not the dapp's, so its confirmation
sheet structurally cannot tell the user who is really asking. The card is the
only place that information exists.

### `personal_sign` — params `[hexMessage, address]`

- Hex-decode to UTF-8; fall back to raw hex when it is not valid text.
- Detect SIWE (EIP-4361) and pretty-print domain, uri, nonce, chain.
- **Warn when it is SIWE.** This is exactly the case where a smart-account
  signature commonly fails: most sign-in backends call `ecrecover` and never
  implement ERC-1271. Better known before signing than after a silent login
  failure.

### `eth_signTypedData_v4` — params `[address, jsonString]`

- Parse; show `domain.name`, `domain.chainId`, `domain.verifyingContract`,
  `primaryType`, and the message tree.
- **Warn when `domain.chainId` ≠ the session chain** — a classic replay/phish
  signal.
- Special-case `Permit`, `PermitSingle`, `PermitBatch`: surface spender, amount,
  deadline; flag an amount of `2^256 - 1` as unlimited.

### `eth_sendTransaction` — params `[{ to, value, data, … }]`

- `to`, and warn when it is null (contract creation).
- `value` rendered in ETH.
- `data`: 4-byte selector matched against a small local table — `approve`,
  `transfer`, `transferFrom`, `setApprovalForAll`, `permit`, `multicall`,
  `execute`. Decode args for `approve` and `setApprovalForAll`; highlight
  unlimited amounts and `approved = true`.
- Unrecognised selector: show selector plus calldata byte length, raw hex
  collapsed.

Permit and approve decoding is roughly thirty lines and covers the cases where
value is actually lost, so it is in v1 rather than deferred.

## Error handling

**Cardinal rule: always respond.** The router body sits inside `try/finally`
guaranteeing exactly one response per request id. A missing response leaves the
dapp spinning with no timeout and no recovery short of a page reload.

| Condition | Response to dapp |
|---|---|
| User rejects (in bridge or in Base app) | **`4001` verbatim** |
| Standard EIP-1193 error from provider | pass through (`4100`, `4200`, `4900`, `4902`) |
| Non-1193 exception | `5000`, message attached |
| Wallet does not answer within ~3 min | `5000` "timed out waiting for wallet"; card marked expired |
| `session_request_expire` fires | **no response at all**; drop the card |
| Wallet disconnected while request in flight | `4900` |

`4001` surviving as `4001` is load-bearing: dapps use it to re-enable their
button. Collapsing it into a generic error leaves the dapp in a permanent
failure state.

Pairing errors get their own message rather than a raw SDK throw. WalletConnect
URIs are single-use and expire within minutes, and "I pasted it twice" is the
most common confusion — the UI says "already used or expired, refresh the dapp's
QR" in words.

Relay disconnects are handled by WalletKit's own reconnection; connection state
is surfaced in the UI so a dead relay is visible rather than silent.

## Session lifecycle

- **On load:** `getActiveSessions()` → render session cards.
- **`session_delete`** from the dapp → drop the card.
- **Manual disconnect** → `disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') })`.
- **`beforeunload`** warns while any session is live.
- **`accountsChanged` / `chainChanged`** from the provider fan out to
  `emitSessionEvent` across all active sessions. Forgetting this leaves dapps
  displaying a stale address indefinitely.
- **Account outside the approved set:** WalletConnect sessions have a fixed
  approved account list. Emitting `accountsChanged` for an account the session
  never approved is protocol-sketchy, so the bridge emits only within the
  approved set and otherwise shows "your wallet switched to an account this dapp
  didn't approve" with a disconnect button.

## Security considerations

- The bridge is a MITM by construction. Its mitigation is visibility: the origin
  and Verify badge on every signing card.
- Allowlist over blocklist for method dispatch.
- No secrets in the codebase. `VITE_REOWN_PROJECT_ID` is a public client ID.
- No backend means no server-side attack surface and no custody.
- Read-only methods pass silently by design; they cannot move value.

## Known limitations

- **The session lives in the tab.** Closing it kills the dapp's connection until
  the user reopens and re-pairs. Nothing short of a server holding signing
  authority fixes this, which is explicitly not wanted. Mitigations are session
  restore from local storage and a `beforeunload` warning.
- **Smart-account signatures fail on naive verifiers.** Detected and warned
  about, not fixable here.

## Testing strategy

Every bug-prone component is a pure function, so the majority is unit-testable.

**TDD with vitest:**

- `policy.classify` — table-driven over all four dispositions, including
  unknown-method fallthrough.
- `decode` — fixtures: a SIWE message, typed data with a chainId mismatch, a
  Permit with `2^256-1`, `approve` calldata, a plain transfer, `to: null`,
  non-UTF-8 `personal_sign` payload.
- `errors` — each row of the error table.
- **Namespace building** from recorded proposal fixtures: required-only,
  optional-only, and a required chain outside `SUPPORTED_CHAINS` asserting the
  reject path.

**Router against fakes** (all three deps are ports):

- PASS forwards without prompting.
- CONFIRM waits for the user, then forwards.
- REJECT never touches the wallet.
- Provider throws `4001` → responds `4001`.
- Provider throws a bare `Error` → **still responds** (the always-respond guarantee).
- Chain mismatch triggers `switchChain` before forwarding.
- Expired request → no response call at all.

**Not automatable:** the relay and the Base app. A manual checklist against
Reown's public test dapp covers pair, `personal_sign`, typed data, a small Base
transaction, chain switch, rejection, and tab-reopen restore.

## Stack

- Vite + TypeScript, no UI framework required.
- `@reown/walletkit`, `@walletconnect/core`, `@walletconnect/utils`
- `@coinbase/wallet-sdk` — the wallet-facing provider. `@base-org/account` is
  its successor and exposes an equivalent EIP-1193 provider; either satisfies
  `WalletPort`, so this choice is confined to `cb/provider.ts` and reversible.
- `vitest` for unit tests
