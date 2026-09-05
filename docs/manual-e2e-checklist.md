# Manual end-to-end checklist

The WalletConnect relay and the Base app cannot be meaningfully faked, so these
steps are manual. Run them against any dapp whose connect modal offers
WalletConnect (Reown's public AppKit demo works well).

Setup: copy `.env.example` to `.env`, add a project ID from
https://dashboard.reown.com, then `npm run dev`.

- [ ] Connect the Coinbase wallet; the address appears.
- [ ] The smart-account banner appears (expected for a Base Account).
- [ ] Open a dapp, choose WalletConnect, click "Copy to clipboard" in its modal,
      paste into the bridge, click Pair. The dapp shows as connected.
- [ ] The dapp displays the correct address and chain.
- [ ] Trigger `personal_sign`. The approval card shows the dapp's origin and the
      decoded message. Approve; the Base app prompts; the dapp receives the signature.
- [ ] Trigger a SIWE sign-in. The ERC-1271 warning appears. (The sign-in may
      legitimately fail on the dapp's side — that is the documented limitation.)
- [ ] Trigger typed-data signing. Domain, primary type and contract are shown.
- [ ] Send a small transaction on Base. The card shows recipient, value, and the
      decoded function. Approve; it lands onchain.
- [ ] Trigger an ERC-20 approval. Verify an unlimited allowance is flagged in red.
- [ ] Reject a request in the bridge. The dapp reports a user rejection and
      re-enables its button (it must NOT hang or show a fatal error).
- [ ] Reject a request in the Base app instead. Same outcome.
- [ ] Switch chains from the dapp. The bridge follows and the dapp stays in sync.
- [ ] Try pairing with the same URI twice. The second attempt shows the
      "single-use and expire" message rather than a raw SDK error.
- [ ] Reload the bridge tab. Active sessions are restored in the session list.
- [ ] Close the tab with a live session. The browser warns first.
- [ ] Disconnect from the bridge. The dapp shows as disconnected.
- [ ] Switch to a different account in the Base app while a session is live.
      The stale-account banner appears.
