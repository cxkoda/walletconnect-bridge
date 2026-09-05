# cb-walletconnect-bridge

Use WalletConnect-only dapps with the wallet in the Base app.

Some dapps offer WalletConnect as their only connection method. The Base app's wallet doesn't present itself over WalletConnect, so those dapps are simply unusable with it. This bridge closes that gap: it **impersonates a WalletConnect wallet**, pairs with the dapp, and forwards every request to your real Base Account.

```
  dapp  ──── WalletConnect relay ────▶  bridge (this app)  ────▶  Base app
        ◀──── signature / tx hash ─────                    ◀────  you approve
```

It's a static page. No backend, no server, no database — nothing ever sees a key or a signature except your browser and your wallet.

## Setup

```bash
npm install
cp .env.example .env      # then add a project ID
npm run dev
```

The one config value is `VITE_REOWN_PROJECT_ID`, a free client-side ID from [dashboard.reown.com](https://dashboard.reown.com). Nothing initialises without it. It's public, not a secret.

## Using it

1. Connect your Coinbase wallet in the bridge (once per browser).
2. In the dapp, choose WalletConnect and hit **Copy to clipboard** in its modal.
3. Paste the `wc:…` URI into the bridge and pair.
4. Approve requests as they arrive. Signing requests show a card first — dapp origin, decoded payload, warnings — then your Base app prompts.

Read-only calls pass through silently. Anything that signs or spends stops for confirmation.

**The tab must stay open.** The WalletConnect session lives in the page; close it and the dapp's connection dies until you reopen and re-pair. Nothing short of a server holding your signing authority fixes that, which is explicitly not wanted here.

## What won't work

Your Base Account is a **smart contract account**, so signatures come back as ERC-1271/6492 contract signatures rather than the ecrecover-able kind. Dapps that verify naively — a lot of "Sign in with Ethereum" flows, some orderbook DEXes — will reject them. The bridge detects this and warns you before you sign, but it cannot fix it. That's a property of smart accounts, not of this bridge.

`eth_signTransaction` is impossible for a smart account and is refused during session negotiation rather than failing halfway through a checkout.

## Security model

The bridge is a **man-in-the-middle by construction**. That's its function. Worth understanding what that does and doesn't protect:

When the bridge forwards a request, your wallet sees the *bridge's* origin, not the dapp's. So the Base app's confirmation sheet structurally cannot tell you who actually asked. **The bridge's approval card is the only place that information exists** — which is why it decodes payloads rather than showing raw hex, flags unlimited allowances and chain mismatches, and shows the WalletConnect Verify badge for the origin.

Practical guidance:

- **Run it locally.** A public deploy widens the supply-chain surface considerably; the card is rendered by the same code that forwards the request, so a compromised dependency can show you one thing and sign another.
- **Don't host it for other people.** A page asking strangers to route signatures through your code is phishing-shaped regardless of intent.
- **Use an account funded with what a session is worth**, not your main one.
- **Absence of a warning isn't proof of safety.** Expand "Raw request" for anything that matters. See `docs/known-issues.md`.

## Status

Working, and **not yet validated against a real dapp or wallet.** ~300 automated tests cover the decoders, policy, router and rendering, but the WalletConnect relay and the Base app can't be meaningfully faked. `docs/manual-e2e-checklist.md` is the manual pass — run it on Base Sepolia before trusting anything with real value.

`docs/known-issues.md` lists what's open. Item #1 is a two-line fix worth doing before you point this at dapps you don't already trust.

## Development

```bash
npm test              # full suite
npm run test:watch
npx tsc --noEmit
npm run build
```

`CLAUDE.md` covers the architecture, the two load-bearing invariants, and the traps that have already cost time. `docs/superpowers/specs/` holds the design spec.

## Stack

Vite + TypeScript, no UI framework. [`@reown/walletkit`](https://docs.reown.com/walletkit/overview) faces the dapp; [`@coinbase/wallet-sdk`](https://github.com/coinbase/coinbase-wallet-sdk) faces the wallet. The core logic between them imports neither — it depends on three port interfaces, which is why the suite runs with no network and no SDK mocking.
