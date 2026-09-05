# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, backend-free webapp that **impersonates a WalletConnect v2 wallet**. It pairs with a dapp over the WalletConnect relay, then forwards each JSON-RPC request to the user's Coinbase Base Account (an ERC-4337 smart contract account) via an EIP-1193 provider. It exists so dapps that only offer WalletConnect can be used with the Base app.

It is a deliberate man-in-the-middle — that is the function, not a flaw. There is no server: no API routes, no secrets, nothing server-side to add. The only config value is `VITE_REOWN_PROJECT_ID` (a public client-side ID from dashboard.reown.com; nothing initialises without it).

## Commands

```bash
npm run dev          # Vite dev server
npm test             # full suite (vitest run)
npm run test:watch   # watch mode
npx vitest run src/bridge/router.test.ts          # single file
npx vitest run -t "responds exactly once"          # single test by name
npx tsc --noEmit     # typecheck alone
npm run build        # tsc --noEmit && vite build
```

Tests default to the `node` environment. DOM tests opt in per file with a `// @vitest-environment jsdom` docblock (only `src/ui/app.test.ts` does).

## Architecture

Two SDKs face opposite directions, with a pure core between them:

```
dapp ──relay──▶ src/wc/walletkit.ts  (DappPort)   ─┐
                                                    ├─▶ src/bridge/router.ts ──▶ src/cb/provider.ts (WalletPort) ──▶ Base app
user ◀──modal── src/ui/pending.ts    (ConfirmPort) ─┘
```

`src/bridge/**` **must never import `@reown/walletkit` or `@coinbase/wallet-sdk`.** It depends only on the three port interfaces in `src/bridge/types.ts`. `src/bridge/architecture.test.ts` enforces this and will fail the build if violated. This boundary is why ~300 tests run with no network and no SDK mocking — do not weaken it to make something convenient.

Request flow inside the router: `classify` (policy) → `buildCard` + `confirm` if needed → chain sync → forward to wallet → respond.

- `src/bridge/policy.ts` — method dispatch is an **allowlist, never a blocklist**. An unrecognised method returns `unknown`, which routes to an explicit user decision; it is never silently forwarded. `ADVERTISED_METHODS` is deliberately narrower than `PASS_METHODS + CONFIRM_METHODS`: advertising is the WalletConnect negotiation contract, policy governs whatever actually arrives (dapps send methods they never negotiated).
- `src/bridge/decode/` — one module per method family, dispatched by `index.ts`. Every method in `CONFIRM_METHODS` must have a case; `index.test.ts` iterates the list to enforce that.
- `src/chains.ts` — `SUPPORTED_CHAINS` is the **single source of truth**. It feeds both the Coinbase SDK's `appChainIds` and the WalletConnect `supportedNamespaces`. If those drift, the bridge advertises chains it cannot serve and every request on them fails after the dapp has already connected. Never hardcode a chain list elsewhere.

## Two invariants that are load-bearing

**1. Exactly one response per request id — always — except an expired request, which gets none.**

No response leaves the dapp spinning forever (no dapp-side timeout, no recovery but a page reload). Two responses, or a response to an expired id, makes WalletKit throw. `handleRequest` guarantees this with a `responded` latch and a `finally` backstop.

The latch assigns **before** its `await`, so a throwing `dapp.respondResult` cannot trigger a second send from the catch or the `finally`. Moving that assignment after the await reintroduces a double-send. The expired path claims the latch and returns, which is what suppresses the `finally` backstop — a bare `return` there would respond to an expired id. Do not "simplify" any of this.

**2. The approval card is the only place the user can see who is asking.**

When the bridge forwards a request, the wallet sees the **bridge's** origin, not the dapp's — so the wallet's own confirmation sheet structurally cannot show it. A decoder or renderer that fails to surface a danger (unlimited allowance, chain mismatch, blanket NFT approval, scam-flagged origin) is a security defect, not a cosmetic one.

Everything crossing the relay — dapp name, URL, typed-data contents, calldata — is attacker-controlled. `escapeHtml` in `src/ui/render.ts` is a security control. Card values are string-coerced (`coerceString`) and `raw` dumps go through `safeJson` (plain `JSON.stringify` throws on bigint, which would destroy the whole card).

Failures here are usually **silent omissions** rather than crashes — a missing Value row, a dropped warning. When touching a decoder, test that a danger is still surfaced, not merely that nothing threw.

## Traps that have already cost time

- **`getSdkError('USER_REJECTED')` returns code 5000, not 4001.** That is the WalletConnect protocol namespace, not EIP-1193. User rejection must always use the frozen `USER_REJECTED` constant (4001) — dapps use 4001 to distinguish "user declined" (re-enable the button) from "something broke" (permanent error state). `getSdkError` *is* correct for `disconnectSession`/`rejectSession`, which are protocol-level.
- **`@reown/walletkit` exports `WalletKit` as a value only.** `import type { WalletKit }` does not typecheck; use the exported `WalletKitInstance` from `src/wc/walletkit.ts`.
- **`vite.config.ts` must import `defineConfig` from `vitest/config`**, not `vite` — only vitest's accepts a `test` key.
- **`expiryTimestamp` is in seconds**, not milliseconds.
- **The approval modal opens via an observer**: `src/main.ts` sets `pending.onChange`. That single line is what makes the UI appear at all — deleting it silently restores a full deadlock (the queue is populated *inside* `handleRequest`, so rendering around the call renders an empty queue). See `docs/known-issues.md` #2: the wiring test asserts a *copy* of that line, not the line itself.

## Conventions worth knowing

**Break the code to check a test.** Hollow tests recurred throughout this build — tests that pass regardless of the behaviour they name. Three landed in the router alone: a "responds exactly once even when the dapp port is slow" test that never made anything slow, a "forwards params unchanged" test comparing the params object against *itself* (in-place mutation would mutate the expectation in lockstep), and an approval-card payload that no assertion touched. When adding or changing a test around a security warning or one of the invariants above, mutate the implementation, confirm the test fails, then revert. A test that has never failed has not been verified.

**Don't reach for an ABI-decoding library.** The 4-byte selector table and 32-byte word slicing in `decode/tx.ts` are deliberate. The decoded selectors all take static head-encoded arguments, so slicing is exact, and a tool whose value is being auditable keeps its dependency list short.

**Don't add a backend.** No API routes, no server-side code, no secrets. If something seems to need a server, it almost certainly needs to stay in the browser instead — the no-custody property is the point.

## Smart-account consequences

The target is a Base Account, so `personal_sign` and `eth_signTypedData_v4` return **ERC-1271/6492 contract signatures**, not ecrecover-able EOA signatures. Dapps that verify naively (many SIWE sign-in flows) will reject them. The bridge detects this and warns; it cannot fix it. `eth_signTransaction` is impossible for a smart account and is refused at negotiation time rather than mid-flow.

`wallet_sendCalls` (EIP-5792) is the native batch path for a Base Account — treat it as a primary fund-moving method, not an edge case.

## Docs

- `docs/superpowers/specs/2026-09-05-*-design.md` — the design spec; the binding authority when it and the plan disagree
- `docs/superpowers/plans/2026-09-05-*.md` — the implementation plan (historical; the code has moved past it in places)
- `docs/known-issues.md` — open items, each with reasoning for why it was left
- `docs/manual-e2e-checklist.md` — the relay and the Base app cannot be meaningfully faked, so end-to-end verification is manual. **The suite has never been validated against a real dapp or wallet.** Run this on Base Sepolia before trusting anything.
