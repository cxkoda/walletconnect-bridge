# Coinbase ↔ WalletConnect Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static, backend-free webapp that impersonates a WalletConnect v2 wallet and forwards JSON-RPC requests to a Coinbase Base Account via EIP-1193, so WalletConnect-only dapps can be used with the Base app.

**Architecture:** Two SDKs face opposite directions — `@reown/walletkit` talks to the dapp over the WalletConnect relay, `@coinbase/wallet-sdk` talks to the user's Base Account. Between them sits a pure `router` module that depends only on three narrow ports (`WalletPort`, `DappPort`, `ConfirmPort`) and imports neither SDK, which makes all interesting logic unit-testable with fakes and no network. Everything runs client-side; there is no server.

**Tech Stack:** Vite 8, TypeScript 7, vitest 5, `@reown/walletkit`, `@walletconnect/core`, `@walletconnect/utils`, `@walletconnect/jsonrpc-utils`, `@coinbase/wallet-sdk`. No UI framework.

**Spec:** `docs/superpowers/specs/2026-09-05-cb-walletconnect-bridge-design.md`

## Global Constraints

- **Exact dependency versions:** `@reown/walletkit@1.5.6`, `@walletconnect/core@2.24.0`, `@walletconnect/utils@2.24.0`, `@coinbase/wallet-sdk@4.3.7`. Dev: `vite@8.2.2`, `vitest@5.0.0`, `typescript@7.0.2`.
- **No backend.** No server-side code, no API routes, no secrets in the repo. The only config value is `VITE_REOWN_PROJECT_ID`, a public client-side ID.
- **`router.ts` must never import `@reown/walletkit` or `@coinbase/wallet-sdk`.** It depends on the port interfaces in `src/bridge/types.ts` only. This is enforced by an architecture test in Task 14.
- **User rejection is always JSON-RPC code `4001`,** hand-written. Do **not** use `getSdkError('USER_REJECTED')` — verified to return code `5000`, which dapps do not recognise as a rejection. Reserve `getSdkError` for protocol-level use (`disconnectSession`, `rejectSession`).
- **Exactly one response per request id, always** — except an expired request, which gets none.
- **Method dispatch is an allowlist,** never a blocklist.
- **`SUPPORTED_CHAINS` in `src/chains.ts` is the single source of truth.** Both the Coinbase SDK's `appChainIds` and the WalletConnect `supportedNamespaces` derive from it. Never hardcode a chain list anywhere else.
- **TDD throughout:** write the failing test, watch it fail, implement minimally, watch it pass, commit.
- TypeScript `strict: true`. No `any` in `src/bridge/**` except where an SDK type forces it.

## File Structure

| File | Responsibility |
|---|---|
| `src/chains.ts` | Supported chain table + CAIP-2 conversion helpers |
| `src/bridge/types.ts` | All shared types and the three port interfaces |
| `src/bridge/format.ts` | Hex/UTF-8/wei/bigint formatting helpers shared by the decoders |
| `src/bridge/policy.ts` | `classify(method)` → `Disposition` |
| `src/bridge/errors.ts` | Thrown value → `JsonRpcErrorPayload` |
| `src/bridge/decode/sign.ts` | `personal_sign` + SIWE decoding |
| `src/bridge/decode/typed.ts` | `eth_signTypedData_v4` + Permit decoding |
| `src/bridge/decode/tx.ts` | `eth_sendTransaction` + selector table |
| `src/bridge/decode/index.ts` | `buildCard(req)` dispatcher |
| `src/bridge/namespaces.ts` | `supportedNamespaces` builder + proposal approve/reject decision |
| `src/bridge/router.ts` | The bridge: classify → confirm → chain-sync → forward → respond |
| `src/cb/provider.ts` | `WalletPort` over Coinbase Wallet SDK; smart-account detection |
| `src/wc/walletkit.ts` | `DappPort` + WalletKit init, pairing, session lifecycle |
| `src/ui/*.ts` | Pair box, session list, approval modal (`ConfirmPort`) |
| `src/main.ts` | Composition root: wires ports together, event fan-out |

**Execution order.** Tasks 1 and 2 are the foundation and must land first, in
that order. After them:

| Wave | Tasks | Notes |
|---|---|---|
| A | **3, 4, 5, 6, 7, 11, 12, 13** | Fully independent of each other — safe to run in parallel |
| B | **8** (needs 5, 6, 7), **9** (needs 3) | |
| C | **10** (needs 3, 4, 8) | The router |
| D | **14** (needs everything) | Wiring and end-to-end verification |

---

### Task 1: Project scaffold + chain table

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`, `.env.example`
- Create: `src/chains.ts`
- Test: `src/chains.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SUPPORTED_CHAINS: ChainInfo[]`, `SUPPORTED_CHAIN_IDS: number[]`, `SUPPORTED_CAIP_CHAINS: string[]`, `parseCaipChainId(caip: string): number`, `toCaipChainId(id: number): string`, `chainName(id: number): string`, and `interface ChainInfo { id: number; name: string; nativeSymbol: string }`.

- [ ] **Step 1: Create the project files**

`package.json`:
```json
{
  "name": "cb-walletconnect-bridge",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@coinbase/wallet-sdk": "4.3.7",
    "@reown/walletkit": "1.5.6",
    "@walletconnect/core": "2.24.0",
    "@walletconnect/jsonrpc-utils": "1.0.8",
    "@walletconnect/utils": "2.24.0"
  },
  "devDependencies": {
    "typescript": "7.0.2",
    "vite": "8.2.2",
    "vitest": "5.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CB ↔ WalletConnect Bridge</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`.gitignore`:
```
node_modules
dist
.env
.env.local
```

`.env.example`:
```
# Free public client ID from https://dashboard.reown.com — not a secret
VITE_REOWN_PROJECT_ID=
```

Create `src/main.ts` with a single line so Vite has an entry point: `export {};`

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: completes without peer-dependency errors.

- [ ] **Step 3: Write the failing test**

`src/chains.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_CHAINS,
  SUPPORTED_CHAIN_IDS,
  SUPPORTED_CAIP_CHAINS,
  parseCaipChainId,
  toCaipChainId,
  chainName,
} from './chains';

describe('chains', () => {
  it('includes Base mainnet', () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(8453);
  });

  it('derives ids and CAIP ids from the same table', () => {
    expect(SUPPORTED_CHAIN_IDS).toEqual(SUPPORTED_CHAINS.map((c) => c.id));
    expect(SUPPORTED_CAIP_CHAINS).toEqual(SUPPORTED_CHAINS.map((c) => `eip155:${c.id}`));
  });

  it('has no duplicate chain ids', () => {
    expect(new Set(SUPPORTED_CHAIN_IDS).size).toBe(SUPPORTED_CHAIN_IDS.length);
  });

  it('round-trips CAIP-2 chain ids', () => {
    expect(toCaipChainId(8453)).toBe('eip155:8453');
    expect(parseCaipChainId('eip155:8453')).toBe(8453);
  });

  it('rejects a non-eip155 CAIP id', () => {
    expect(() => parseCaipChainId('solana:mainnet')).toThrow(/eip155/);
  });

  it('rejects a malformed CAIP id', () => {
    expect(() => parseCaipChainId('eip155:abc')).toThrow();
  });

  it('names known chains and falls back for unknown ones', () => {
    expect(chainName(8453)).toBe('Base');
    expect(chainName(999999)).toBe('Chain 999999');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/chains.test.ts`
Expected: FAIL — cannot resolve `./chains`.

- [ ] **Step 5: Implement `src/chains.ts`**

```ts
export interface ChainInfo {
  id: number;
  name: string;
  nativeSymbol: string;
}

/**
 * Single source of truth for supported chains.
 *
 * Feeds BOTH the Coinbase SDK's `appChainIds` and the WalletConnect
 * `supportedNamespaces`. If those two ever drift, the bridge advertises chains
 * it cannot serve and every request on them fails after the dapp has already
 * connected. Never hardcode a chain list anywhere else.
 */
export const SUPPORTED_CHAINS: ChainInfo[] = [
  { id: 8453, name: 'Base', nativeSymbol: 'ETH' },
  { id: 84532, name: 'Base Sepolia', nativeSymbol: 'ETH' },
  { id: 1, name: 'Ethereum', nativeSymbol: 'ETH' },
  { id: 10, name: 'Optimism', nativeSymbol: 'ETH' },
  { id: 42161, name: 'Arbitrum One', nativeSymbol: 'ETH' },
  { id: 7777777, name: 'Zora', nativeSymbol: 'ETH' },
];

export const SUPPORTED_CHAIN_IDS: number[] = SUPPORTED_CHAINS.map((c) => c.id);

export const SUPPORTED_CAIP_CHAINS: string[] = SUPPORTED_CHAINS.map(
  (c) => `eip155:${c.id}`,
);

export function toCaipChainId(id: number): string {
  return `eip155:${id}`;
}

export function parseCaipChainId(caip: string): number {
  const [namespace, reference] = caip.split(':');
  if (namespace !== 'eip155') {
    throw new Error(`Unsupported CAIP namespace "${namespace}", expected eip155`);
  }
  if (!/^\d+$/.test(reference ?? '')) {
    throw new Error(`Malformed CAIP chain id "${caip}"`);
  }
  return Number(reference);
}

export function chainName(id: number): string {
  return SUPPORTED_CHAINS.find((c) => c.id === id)?.name ?? `Chain ${id}`;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/chains.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold Vite+TS+vitest project and chain table"
```

---

### Task 2: Shared types, ports, and formatting helpers

**Files:**
- Create: `src/bridge/types.ts`, `src/bridge/format.ts`
- Test: `src/bridge/types.test.ts`, `src/bridge/format.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`types.ts`): every type the rest of the plan references — `Disposition`, `JsonRpcErrorPayload`, `Severity`, `CardWarning`, `CardField`, `RequestCard`, `DappIdentity`, `IncomingRequest`, `DecodeContext`, `WalletPort`, `DappPort`, `ConfirmPort`, `RequestExpiredError`, and the constant `USER_REJECTED`.
- Produces (`format.ts`): `hexToUtf8(hex: string): string | null`, `toBigInt(v: unknown): bigint | null`, `isUnlimitedAmount(v: bigint): boolean`, `formatEther(wei: string | bigint): string`, `shortAddress(a: string): string`, `MAX_UINT256`, `MAX_UINT160`.

This is the foundation every later task imports, which is why it lands before the parallel wave.

This task is mostly type declarations, so the test is a compile-and-shape check rather than behaviour. `RequestExpiredError` and `USER_REJECTED` are real runtime values and are tested.

- [ ] **Step 1: Write the failing test**

`src/bridge/types.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { RequestExpiredError, USER_REJECTED } from './types';

describe('types', () => {
  it('USER_REJECTED uses EIP-1193 code 4001, not the WC SDK 5000', () => {
    // Load-bearing: dapps look for 4001 to re-enable their connect button.
    // getSdkError('USER_REJECTED') returns 5000 and must never be used here.
    expect(USER_REJECTED.code).toBe(4001);
    expect(USER_REJECTED.message).toMatch(/reject/i);
  });

  it('RequestExpiredError is identifiable via instanceof', () => {
    const err = new RequestExpiredError(42);
    expect(err).toBeInstanceOf(RequestExpiredError);
    expect(err).toBeInstanceOf(Error);
    expect(err.requestId).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bridge/types.test.ts`
Expected: FAIL — cannot resolve `./types`.

- [ ] **Step 3: Implement `src/bridge/types.ts`**

```ts
/** A JSON-RPC error as sent back to the dapp. */
export interface JsonRpcErrorPayload {
  code: number;
  message: string;
}

/**
 * EIP-1193 user-rejection. Hand-written on purpose.
 *
 * `getSdkError('USER_REJECTED')` from @walletconnect/utils returns code 5000,
 * which lives in the WalletConnect protocol error namespace, NOT EIP-1193.
 * Dapps check for 4001 to distinguish "user said no" (re-enable the button)
 * from "something broke" (show an error state). Sending 5000 leaves dapps
 * stuck in a permanent failure state.
 */
export const USER_REJECTED: JsonRpcErrorPayload = {
  code: 4001,
  message: 'User rejected the request.',
};

/** How the bridge should treat an incoming method. */
export type Disposition =
  | { kind: 'pass' }
  | { kind: 'confirm' }
  | { kind: 'reject'; code: number; message: string }
  | { kind: 'unknown' };

export type Severity = 'info' | 'warn' | 'danger';

export interface CardWarning {
  severity: Severity;
  text: string;
}

export interface CardField {
  label: string;
  value: string;
  /** Render in a monospace font (addresses, hex, calldata). */
  mono?: boolean;
}

/** The human-readable model rendered in the approval modal. */
export interface RequestCard {
  method: string;
  title: string;
  fields: CardField[];
  warnings: CardWarning[];
  /** Pretty-printed original params, shown collapsed. */
  raw: string;
}

/** Who is asking, per session metadata + WalletKit Verify. */
export interface DappIdentity {
  name: string;
  url: string;
  iconUrl?: string;
  validation: 'VALID' | 'INVALID' | 'UNKNOWN';
  isScam: boolean;
}

/** A session_request, normalised away from WalletKit's shape. */
export interface IncomingRequest {
  id: number;
  topic: string;
  /** Parsed from the CAIP-2 `eip155:8453` the session request carries. */
  chainId: number;
  method: string;
  params: unknown;
  expiryTimestamp?: number;
  dapp: DappIdentity;
}

/** Thrown when a request expires while awaiting confirmation. */
export class RequestExpiredError extends Error {
  constructor(public readonly requestId: number) {
    super(`Request ${requestId} expired`);
    this.name = 'RequestExpiredError';
  }
}

/** Context the decoders need beyond the request itself. */
export interface DecodeContext {
  /** The session's chain, for detecting typed-data domain mismatch. */
  chainId: number;
  /** True when the connected account has contract code (a Base Account). */
  isSmartAccount: boolean;
}

/** Wallet-facing port. Implemented by src/cb/provider.ts. */
export interface WalletPort {
  request<T = unknown>(args: { method: string; params?: unknown }): Promise<T>;
  getChainId(): Promise<number>;
  switchChain(chainId: number): Promise<void>;
}

/** Dapp-facing port. Implemented by src/wc/walletkit.ts. */
export interface DappPort {
  respondResult(topic: string, id: number, result: unknown): Promise<void>;
  respondError(topic: string, id: number, error: JsonRpcErrorPayload): Promise<void>;
}

/** UI port. Implemented by src/ui/approval.ts. Rejects with RequestExpiredError. */
export interface ConfirmPort {
  confirm(req: IncomingRequest, card: RequestCard): Promise<boolean>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bridge/types.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing test for the formatting helpers**

`src/bridge/format.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  hexToUtf8,
  toBigInt,
  isUnlimitedAmount,
  formatEther,
  shortAddress,
  MAX_UINT256,
  MAX_UINT160,
} from './format';

describe('hexToUtf8', () => {
  it('decodes valid UTF-8 hex', () => {
    expect(hexToUtf8('0x68656c6c6f')).toBe('hello');
  });

  it('decodes multi-byte characters', () => {
    expect(hexToUtf8('0xc3a9')).toBe('\u00e9');
  });

  it('returns null for bytes that are not valid UTF-8', () => {
    expect(hexToUtf8('0xfffefd')).toBeNull();
  });

  it('returns null for malformed hex', () => {
    expect(hexToUtf8('0xzz')).toBeNull();
    expect(hexToUtf8('0x123')).toBeNull();
    expect(hexToUtf8('')).toBeNull();
  });
});

describe('toBigInt', () => {
  it('parses decimal strings, hex strings, numbers and bigints', () => {
    expect(toBigInt('100')).toBe(100n);
    expect(toBigInt('0x64')).toBe(100n);
    expect(toBigInt(100)).toBe(100n);
    expect(toBigInt(100n)).toBe(100n);
  });

  it('returns null for junk', () => {
    expect(toBigInt('abc')).toBeNull();
    expect(toBigInt(null)).toBeNull();
    expect(toBigInt({})).toBeNull();
  });
});

describe('isUnlimitedAmount', () => {
  it('flags the ERC-20 max-uint256 sentinel', () => {
    expect(isUnlimitedAmount(MAX_UINT256)).toBe(true);
  });

  it('flags the Permit2 max-uint160 sentinel', () => {
    expect(isUnlimitedAmount(MAX_UINT160)).toBe(true);
  });

  it('does not flag ordinary amounts', () => {
    expect(isUnlimitedAmount(0n)).toBe(false);
    expect(isUnlimitedAmount(10n ** 24n)).toBe(false);
  });
});

describe('formatEther', () => {
  it('formats whole ether from a hex wei string', () => {
    expect(formatEther('0xde0b6b3a7640000')).toBe('1');
  });

  it('formats a fraction and trims trailing zeros', () => {
    expect(formatEther(10n ** 17n)).toBe('0.1');
    expect(formatEther(1500000000000000000n)).toBe('1.5');
  });

  it('formats zero as "0"', () => {
    expect(formatEther('0x0')).toBe('0');
    expect(formatEther(0n)).toBe('0');
  });

  it('returns "0" for unparseable input rather than throwing', () => {
    expect(formatEther('nonsense')).toBe('0');
  });
});

describe('shortAddress', () => {
  it('abbreviates the middle', () => {
    expect(shortAddress('0x1111111111111111111111111111111111111111')).toBe('0x1111…1111');
  });

  it('leaves short strings alone', () => {
    expect(shortAddress('0xabc')).toBe('0xabc');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/bridge/format.test.ts`
Expected: FAIL — cannot resolve `./format`.

- [ ] **Step 7: Implement `src/bridge/format.ts`**

```ts
export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;

/**
 * Decode hex to text, or null when the bytes are not valid UTF-8.
 *
 * Null is a meaningful result, not a failure: the caller shows raw hex and warns
 * the user that they are being asked to sign opaque bytes.
 */
export function hexToUtf8(hex: string): string | null {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    return null;
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function toBigInt(v: unknown): bigint | null {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(v);
    if (typeof v === 'string' && v.trim() !== '') return BigInt(v);
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether an allowance is unlimited in practice.
 *
 * Covers the two sentinels in the wild (ERC-20 max-uint256, Permit2 max-uint160)
 * plus anything above 2^159, which is unlimited for any real token: 2^159 units
 * of an 18-decimal token is roughly 7e29 tokens.
 */
export function isUnlimitedAmount(v: bigint): boolean {
  return v === MAX_UINT256 || v === MAX_UINT160 || v >= 1n << 159n;
}

export function formatEther(wei: string | bigint): string {
  const value = toBigInt(wei);
  if (value === null) return '0';
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}\u2026${a.slice(-4)}` : a;
}
```

Note: the two `\u`-prefixed escapes above are written here to survive this
document — in the real files write the actual characters (`'é'` in the test,
`'…'` in `shortAddress`) or keep the escapes; both work.

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/bridge/format.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 9: Commit**

```bash
git add src/bridge/types.ts src/bridge/types.test.ts src/bridge/format.ts src/bridge/format.test.ts
git commit -m "feat: add shared bridge types, ports and formatting helpers"
```

---

### Task 3: Method policy

**Files:**
- Create: `src/bridge/policy.ts`
- Test: `src/bridge/policy.test.ts`

**Interfaces:**
- Consumes: `Disposition` from `src/bridge/types.ts`.
- Produces: `classify(method: string): Disposition`, `PASS_METHODS: readonly string[]`, `CONFIRM_METHODS: readonly string[]`, `ADVERTISED_METHODS: readonly string[]`.

Note `ADVERTISED_METHODS` is deliberately narrower than the union of PASS and CONFIRM. Advertising is the negotiation contract offered during `session_proposal`; policy governs whatever actually arrives at runtime, and dapps do send methods they never negotiated.

- [ ] **Step 1: Write the failing test**

`src/bridge/policy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { classify, ADVERTISED_METHODS } from './policy';

describe('classify', () => {
  it.each([
    'eth_accounts',
    'eth_chainId',
    'eth_call',
    'eth_estimateGas',
    'eth_getBalance',
    'eth_getCode',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
    'eth_getTransactionCount',
    'eth_blockNumber',
    'eth_gasPrice',
    'eth_feeHistory',
    'eth_maxPriorityFeePerGas',
    'wallet_switchEthereumChain',
    'wallet_getCapabilities',
  ])('passes %s silently', (m) => {
    expect(classify(m)).toEqual({ kind: 'pass' });
  });

  it.each([
    'personal_sign',
    'eth_signTypedData',
    'eth_signTypedData_v3',
    'eth_signTypedData_v4',
    'eth_sendTransaction',
    'eth_sendRawTransaction',
    'wallet_sendCalls',
    'wallet_addEthereumChain',
    'wallet_watchAsset',
  ])('confirms %s', (m) => {
    expect(classify(m)).toEqual({ kind: 'confirm' });
  });

  it('rejects eth_sign with 4200', () => {
    const d = classify('eth_sign');
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') {
      expect(d.code).toBe(4200);
      expect(d.message).toMatch(/personal_sign/);
    }
  });

  it('rejects eth_signTransaction with 4200 and explains why', () => {
    const d = classify('eth_signTransaction');
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') {
      expect(d.code).toBe(4200);
      expect(d.message).toMatch(/smart account/i);
    }
  });

  it('treats an unrecognised method as unknown, never as pass', () => {
    expect(classify('eth_someFutureThing')).toEqual({ kind: 'unknown' });
    expect(classify('')).toEqual({ kind: 'unknown' });
  });

  it('is an allowlist: a dangerous-looking unknown method is not passed', () => {
    // The failure mode this guards against is blind-forwarding to the wallet.
    expect(classify('wallet_signAndSendEverything')).toEqual({ kind: 'unknown' });
  });

  it('advertises only methods it will actually serve', () => {
    for (const m of ADVERTISED_METHODS) {
      expect(classify(m).kind).not.toBe('reject');
      expect(classify(m).kind).not.toBe('unknown');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bridge/policy.test.ts`
Expected: FAIL — cannot resolve `./policy`.

- [ ] **Step 3: Implement `src/bridge/policy.ts`**

```ts
import type { Disposition } from './types';

/** Read-only and housekeeping methods. Cannot move value; forwarded silently. */
export const PASS_METHODS = [
  'eth_accounts',
  'eth_chainId',
  'eth_call',
  'eth_estimateGas',
  'eth_getBalance',
  'eth_getCode',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'wallet_switchEthereumChain',
  'wallet_getCapabilities',
] as const;

/** Anything that signs, spends, or changes wallet configuration. */
export const CONFIRM_METHODS = [
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'wallet_sendCalls',
  'wallet_addEthereumChain',
  'wallet_watchAsset',
] as const;

const REJECTED: Record<string, string> = {
  eth_sign:
    'eth_sign is deprecated and unsupported by this bridge. Use personal_sign instead.',
  eth_signTransaction:
    'eth_signTransaction is not possible for a smart account, which cannot produce a standalone signed transaction. Use eth_sendTransaction.',
};

/**
 * What the bridge promises during session negotiation.
 *
 * Deliberately narrower than PASS_METHODS + CONFIRM_METHODS: advertising is the
 * contract, policy is runtime handling. Dapps routinely send methods they never
 * negotiated, and those still need a disposition.
 */
export const ADVERTISED_METHODS = [
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'eth_accounts',
  'eth_chainId',
] as const;

const passSet: ReadonlySet<string> = new Set(PASS_METHODS);
const confirmSet: ReadonlySet<string> = new Set(CONFIRM_METHODS);

/**
 * Allowlist, not blocklist. An unrecognised method returns `unknown`, which the
 * router turns into an explicit user decision — it is never forwarded blindly.
 */
export function classify(method: string): Disposition {
  const rejection = REJECTED[method];
  if (rejection) return { kind: 'reject', code: 4200, message: rejection };
  if (passSet.has(method)) return { kind: 'pass' };
  if (confirmSet.has(method)) return { kind: 'confirm' };
  return { kind: 'unknown' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bridge/policy.test.ts`
Expected: PASS, 31 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/policy.ts src/bridge/policy.test.ts
git commit -m "feat: add allowlist-based method policy"
```

---

### Task 4: Error mapping

**Files:**
- Create: `src/bridge/errors.ts`
- Test: `src/bridge/errors.test.ts`

**Interfaces:**
- Consumes: `JsonRpcErrorPayload`, `USER_REJECTED` from `src/bridge/types.ts`.
- Produces: `toJsonRpcError(err: unknown): JsonRpcErrorPayload`, `withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T>`, `TimeoutError`.

- [ ] **Step 1: Write the failing test**

`src/bridge/errors.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { toJsonRpcError, withTimeout, TimeoutError } from './errors';

describe('toJsonRpcError', () => {
  it('preserves 4001 so dapps see a real user rejection', () => {
    const err = Object.assign(new Error('User denied'), { code: 4001 });
    expect(toJsonRpcError(err)).toEqual({ code: 4001, message: 'User denied' });
  });

  it.each([4100, 4200, 4900, 4901, 4902])(
    'passes standard EIP-1193 code %i through',
    (code) => {
      const err = Object.assign(new Error('nope'), { code });
      expect(toJsonRpcError(err).code).toBe(code);
    },
  );

  it('maps a bare Error to 5000 keeping the message', () => {
    expect(toJsonRpcError(new Error('boom'))).toEqual({
      code: 5000,
      message: 'boom',
    });
  });

  it('maps a thrown string to 5000', () => {
    expect(toJsonRpcError('kaboom')).toEqual({ code: 5000, message: 'kaboom' });
  });

  it('maps a thrown null/undefined to 5000 with a placeholder message', () => {
    expect(toJsonRpcError(null).code).toBe(5000);
    expect(toJsonRpcError(null).message).toMatch(/unknown/i);
    expect(toJsonRpcError(undefined).code).toBe(5000);
  });

  it('ignores a non-numeric code property', () => {
    const err = Object.assign(new Error('weird'), { code: 'ENOENT' });
    expect(toJsonRpcError(err).code).toBe(5000);
  });

  it('does not pass through a non-EIP-1193 numeric code', () => {
    // A random numeric code (e.g. an HTTP status leaking through) must not be
    // presented to the dapp as if it were a 1193 error.
    const err = Object.assign(new Error('http'), { code: 503 });
    expect(toJsonRpcError(err).code).toBe(5000);
  });

  it('maps a TimeoutError to 5000 mentioning the wallet', () => {
    const r = toJsonRpcError(new TimeoutError('timed out waiting for wallet'));
    expect(r.code).toBe(5000);
    expect(r.message).toMatch(/wallet/i);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'nope')).resolves.toBe(7);
  });

  it('rejects with TimeoutError when time wins', async () => {
    vi.useFakeTimers();
    const pending = new Promise(() => {});
    const p = withTimeout(pending, 1000, 'timed out waiting for wallet');
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });

  it('propagates the original rejection unchanged', async () => {
    const err = Object.assign(new Error('denied'), { code: 4001 });
    await expect(withTimeout(Promise.reject(err), 1000, 'x')).rejects.toBe(err);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bridge/errors.test.ts`
Expected: FAIL — cannot resolve `./errors`.

- [ ] **Step 3: Implement `src/bridge/errors.ts`**

```ts
import type { JsonRpcErrorPayload } from './types';

/** Standard EIP-1193 provider error codes worth relaying verbatim. */
const EIP1193_CODES = new Set([4001, 4100, 4200, 4900, 4901, 4902]);

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return 'Unknown bridge error';
}

/**
 * Map anything thrown while handling a request onto a JSON-RPC error.
 *
 * 4001 surviving as 4001 is load-bearing: dapps use it to tell "user said no"
 * from "something broke". Only genuine EIP-1193 codes pass through — a stray
 * numeric `code` (an HTTP status, an errno) must not masquerade as one.
 */
export function toJsonRpcError(err: unknown): JsonRpcErrorPayload {
  const message = messageOf(err);
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'number' && EIP1193_CODES.has(code)) {
      return { code, message };
    }
  }
  return { code: 5000, message };
}

/** Reject with TimeoutError if `p` has not settled within `ms`. */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bridge/errors.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/errors.ts src/bridge/errors.test.ts
git commit -m "feat: add error mapping preserving EIP-1193 4001"
```

---

### Task 5: Decode `personal_sign` and SIWE

**Files:**
- Create: `src/bridge/decode/sign.ts`
- Test: `src/bridge/decode/sign.test.ts`

**Interfaces:**
- Consumes: `RequestCard`, `CardField`, `CardWarning`, `DecodeContext` from `src/bridge/types.ts`; `hexToUtf8` from `src/bridge/format.ts`.
- Produces: `decodePersonalSign(params: unknown, ctx: DecodeContext): RequestCard`, `parseSiwe(text: string): SiweMessage | null`, `interface SiweMessage { domain: string; address: string; statement?: string; uri?: string; version?: string; chainId?: number; nonce?: string; issuedAt?: string }`.

`personal_sign` params are `[message, address]` — message first. (`eth_sign` reverses them, which is one of the reasons the bridge refuses it outright.)

- [ ] **Step 1: Write the failing test**

`src/bridge/decode/sign.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { decodePersonalSign, parseSiwe } from './sign';
import type { DecodeContext } from '../types';

const eoa: DecodeContext = { chainId: 8453, isSmartAccount: false };
const smart: DecodeContext = { chainId: 8453, isSmartAccount: true };

const hex = (s: string) =>
  '0x' + Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const SIWE = `example.com wants you to sign in with your Ethereum account:
0x1111111111111111111111111111111111111111

Sign in to Example.

URI: https://example.com
Version: 1
Chain ID: 8453
Nonce: abc123
Issued At: 2026-09-05T12:00:00Z`;

describe('parseSiwe', () => {
  it('parses a well-formed SIWE message', () => {
    const m = parseSiwe(SIWE);
    expect(m).not.toBeNull();
    expect(m!.domain).toBe('example.com');
    expect(m!.address).toBe('0x1111111111111111111111111111111111111111');
    expect(m!.uri).toBe('https://example.com');
    expect(m!.chainId).toBe(8453);
    expect(m!.nonce).toBe('abc123');
    expect(m!.statement).toBe('Sign in to Example.');
  });

  it('returns null for ordinary text', () => {
    expect(parseSiwe('hello world')).toBeNull();
  });
});

describe('decodePersonalSign', () => {
  it('decodes a plain UTF-8 message', () => {
    const card = decodePersonalSign([hex('hello world'), '0xabc'], eoa);
    expect(card.method).toBe('personal_sign');
    expect(card.fields).toContainEqual({ label: 'Message', value: 'hello world' });
    expect(card.warnings).toHaveLength(0);
  });

  it('falls back to raw hex for non-UTF-8 payloads and warns', () => {
    const card = decodePersonalSign(['0xfffefd', '0xabc'], eoa);
    expect(card.fields[0].label).toMatch(/raw hex/i);
    expect(card.warnings.some((w) => /utf-8/i.test(w.text))).toBe(true);
  });

  it('surfaces SIWE fields', () => {
    const card = decodePersonalSign([hex(SIWE), '0xabc'], eoa);
    expect(card.title).toMatch(/sign-in/i);
    expect(card.fields).toContainEqual({ label: 'Sign-in domain', value: 'example.com' });
  });

  it('warns that a smart account signature may fail SIWE verification', () => {
    const card = decodePersonalSign([hex(SIWE), '0xabc'], smart);
    expect(card.warnings.some((w) => /1271/i.test(w.text))).toBe(true);
  });

  it('does not raise the 1271 warning for an EOA', () => {
    const card = decodePersonalSign([hex(SIWE), '0xabc'], eoa);
    expect(card.warnings.some((w) => /1271/i.test(w.text))).toBe(false);
  });

  it('flags a SIWE chain id that disagrees with the session chain', () => {
    const other = SIWE.replace('Chain ID: 8453', 'Chain ID: 1');
    const card = decodePersonalSign([hex(other), '0xabc'], eoa);
    expect(card.warnings.some((w) => w.severity === 'danger' && /chain/i.test(w.text))).toBe(true);
  });

  it('tolerates malformed params without throwing', () => {
    expect(() => decodePersonalSign(null, eoa)).not.toThrow();
    expect(() => decodePersonalSign([], eoa)).not.toThrow();
    expect(decodePersonalSign([], eoa).method).toBe('personal_sign');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bridge/decode/sign.test.ts`
Expected: FAIL — cannot resolve `./sign`.

- [ ] **Step 3: Implement `src/bridge/decode/sign.ts`**

```ts
import type { CardField, CardWarning, DecodeContext, RequestCard } from '../types';
import { hexToUtf8 } from '../format';

export interface SiweMessage {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: number;
  nonce?: string;
  issuedAt?: string;
}

const SIWE_HEADER = /^([^\n]+?) wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})/;

/** Parse an EIP-4361 Sign-In With Ethereum message. Returns null if it isn't one. */
export function parseSiwe(text: string): SiweMessage | null {
  const header = SIWE_HEADER.exec(text);
  if (!header) return null;

  const field = (name: string): string | undefined =>
    new RegExp(`^${name}: (.+)$`, 'm').exec(text)?.[1]?.trim();

  const rest = text.slice(header[0].length).split('\n');
  const statement = rest.find((l) => l.trim() !== '' && !/^[A-Z][\w ]*:/.test(l.trim()))?.trim();
  const chainIdRaw = field('Chain ID');

  return {
    domain: header[1].trim(),
    address: header[2],
    statement,
    uri: field('URI'),
    version: field('Version'),
    chainId: chainIdRaw !== undefined ? Number(chainIdRaw) : undefined,
    nonce: field('Nonce'),
    issuedAt: field('Issued At'),
  };
}

export function decodePersonalSign(params: unknown, ctx: DecodeContext): RequestCard {
  const arr = Array.isArray(params) ? params : [];
  // personal_sign is [message, address]. eth_sign reverses them — which is one
  // reason the bridge refuses eth_sign rather than trying to disambiguate.
  const raw = typeof arr[0] === 'string' ? (arr[0] as string) : '';
  const fields: CardField[] = [];
  const warnings: CardWarning[] = [];

  const text = hexToUtf8(raw);
  if (text === null) {
    fields.push({ label: 'Message (raw hex)', value: raw || '(empty)', mono: true });
    warnings.push({
      severity: 'warn',
      text: 'Message is not valid UTF-8 text; showing raw hex. Be cautious signing opaque bytes.',
    });
  } else {
    fields.push({ label: 'Message', value: text });
  }

  const siwe = text ? parseSiwe(text) : null;
  if (siwe) {
    fields.push({ label: 'Sign-in domain', value: siwe.domain });
    if (siwe.uri) fields.push({ label: 'URI', value: siwe.uri });
    if (siwe.nonce) fields.push({ label: 'Nonce', value: siwe.nonce, mono: true });

    if (siwe.chainId !== undefined && siwe.chainId !== ctx.chainId) {
      warnings.push({
        severity: 'danger',
        text: `Sign-in message declares chain ${siwe.chainId} but this session is on chain ${ctx.chainId}.`,
      });
    }
    if (ctx.isSmartAccount) {
      warnings.push({
        severity: 'warn',
        text:
          'This is a Sign-In With Ethereum request and you are using a smart account. ' +
          'The signature will be an ERC-1271 contract signature; sites that verify with ' +
          'ecrecover will reject it and the login will appear to fail silently.',
      });
    }
  }

  return {
    method: 'personal_sign',
    title: siwe ? 'Sign-in request' : 'Signature request',
    fields,
    warnings,
    raw: JSON.stringify(params, null, 2),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bridge/decode/sign.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/decode/sign.ts src/bridge/decode/sign.test.ts
git commit -m "feat: decode personal_sign and SIWE messages"
```

---

### Task 6: Decode typed data and Permit

**Files:**
- Create: `src/bridge/decode/typed.ts`
- Test: `src/bridge/decode/typed.test.ts`

**Interfaces:**
- Consumes: `RequestCard`, `CardField`, `CardWarning`, `DecodeContext` from `src/bridge/types.ts`; `isUnlimitedAmount`, `toBigInt` from `src/bridge/format.ts`.
- Produces: `decodeTypedData(method: string, params: unknown, ctx: DecodeContext): RequestCard`.

Params are `[address, jsonStringOrObject]` — the second element may already be an object depending on the dapp, so handle both.

- [ ] **Step 1: Write the failing test**

`src/bridge/decode/typed.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { decodeTypedData } from './typed';
import type { DecodeContext } from '../types';

const ctx: DecodeContext = { chainId: 8453, isSmartAccount: false };
const smart: DecodeContext = { chainId: 8453, isSmartAccount: true };
const MAX = (2n ** 256n - 1n).toString();

const permit = (value: string, chainId = 8453) => ({
  domain: { name: 'USD Coin', chainId, verifyingContract: '0xA0b8' },
  primaryType: 'Permit',
  message: { owner: '0x1', spender: '0xdeadbeef', value, nonce: '0', deadline: '99999' },
  types: { Permit: [] },
});

describe('decodeTypedData', () => {
  it('surfaces domain, primary type and verifying contract', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100'))], ctx);
    expect(card.fields).toContainEqual({ label: 'Type', value: 'Permit' });
    expect(card.fields).toContainEqual({ label: 'Domain', value: 'USD Coin' });
    expect(card.fields).toContainEqual({ label: 'Contract', value: '0xA0b8', mono: true });
  });

  it('accepts an already-parsed object as well as a JSON string', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', permit('100')], ctx);
    expect(card.fields).toContainEqual({ label: 'Type', value: 'Permit' });
  });

  it('flags a domain chainId that disagrees with the session', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100', 1))], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /chain/i.test(w.text))).toBe(true);
  });

  it('does not flag a matching chainId', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100'))], ctx);
    expect(card.warnings.some((w) => /chain/i.test(w.text))).toBe(false);
  });

  it('surfaces Permit spender and amount', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('100'))], ctx);
    expect(card.fields).toContainEqual({ label: 'Spender', value: '0xdeadbeef', mono: true });
    expect(card.fields.some((f) => f.label === 'Amount' && f.value === '100')).toBe(true);
  });

  it('shouts about an unlimited Permit amount', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit(MAX))], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /unlimited/i.test(w.text))).toBe(true);
  });

  it('handles PermitSingle (Permit2) shape', () => {
    const p2 = {
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      primaryType: 'PermitSingle',
      message: {
        details: { token: '0xtok', amount: MAX, expiration: '1999999999' },
        spender: '0xrouter',
      },
      types: {},
    };
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(p2)], ctx);
    expect(card.fields).toContainEqual({ label: 'Spender', value: '0xrouter', mono: true });
    expect(card.warnings.some((w) => /unlimited/i.test(w.text))).toBe(true);
  });

  it('notes ERC-1271 for smart accounts', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', JSON.stringify(permit('1'))], smart);
    expect(card.warnings.some((w) => /1271/i.test(w.text))).toBe(true);
  });

  it('does not throw on unparseable JSON', () => {
    const card = decodeTypedData('eth_signTypedData_v4', ['0xabc', 'not json'], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger')).toBe(true);
    expect(card.method).toBe('eth_signTypedData_v4');
  });

  it('does not throw on missing params', () => {
    expect(() => decodeTypedData('eth_signTypedData_v4', null, ctx)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bridge/decode/typed.test.ts`
Expected: FAIL — cannot resolve `./typed`.

- [ ] **Step 3: Implement `src/bridge/decode/typed.ts`**

```ts
import type { CardField, CardWarning, DecodeContext, RequestCard } from '../types';
import { isUnlimitedAmount, toBigInt } from '../format';

interface TypedData {
  domain?: { name?: string; chainId?: number | string; verifyingContract?: string };
  primaryType?: string;
  message?: Record<string, unknown>;
}

const PERMIT_TYPES = new Set(['Permit', 'PermitSingle', 'PermitBatch']);

function parse(raw: unknown): TypedData | null {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as TypedData;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && raw !== null) return raw as TypedData;
  return null;
}

export function decodeTypedData(
  method: string,
  params: unknown,
  ctx: DecodeContext,
): RequestCard {
  const arr = Array.isArray(params) ? params : [];
  const data = parse(arr[1]);
  const fields: CardField[] = [];
  const warnings: CardWarning[] = [];

  if (!data) {
    warnings.push({
      severity: 'danger',
      text: 'Could not parse the typed data payload. Do not approve unless you know what this is.',
    });
    return {
      method,
      title: 'Typed data signature',
      fields,
      warnings,
      raw: JSON.stringify(params, null, 2),
    };
  }

  const primaryType = data.primaryType ?? '(unknown)';
  fields.push({ label: 'Type', value: primaryType });
  if (data.domain?.name) fields.push({ label: 'Domain', value: data.domain.name });
  if (data.domain?.verifyingContract) {
    fields.push({ label: 'Contract', value: data.domain.verifyingContract, mono: true });
  }

  const domainChain =
    data.domain?.chainId !== undefined ? Number(data.domain.chainId) : undefined;
  if (domainChain !== undefined && domainChain !== ctx.chainId) {
    warnings.push({
      severity: 'danger',
      text: `Typed data is scoped to chain ${domainChain} but this session is on chain ${ctx.chainId}. This mismatch is a common phishing and replay signal.`,
    });
  }

  if (PERMIT_TYPES.has(primaryType)) {
    const msg = (data.message ?? {}) as Record<string, unknown>;
    const details = (msg.details ?? {}) as Record<string, unknown>;
    const spender = (msg.spender ?? details.spender) as string | undefined;
    const amountRaw = msg.value ?? details.amount;

    if (spender) fields.push({ label: 'Spender', value: spender, mono: true });
    if (details.token) fields.push({ label: 'Token', value: String(details.token), mono: true });

    if (amountRaw !== undefined && amountRaw !== null) {
      const amount = toBigInt(amountRaw);
      const unlimited = amount !== null && isUnlimitedAmount(amount);
      fields.push({ label: 'Amount', value: unlimited ? 'UNLIMITED' : String(amountRaw) });
      if (unlimited) {
        warnings.push({
          severity: 'danger',
          text: `This grants ${spender ?? 'the spender'} an UNLIMITED token allowance. It can move that token from your account at any time until revoked.`,
        });
      }
    }
    const deadline = msg.deadline ?? details.expiration;
    if (deadline !== undefined) fields.push({ label: 'Expires', value: String(deadline) });
  }

  if (ctx.isSmartAccount) {
    warnings.push({
      severity: 'warn',
      text:
        'You are signing with a smart account, so this produces an ERC-1271 contract signature. ' +
        'Dapps that verify with ecrecover will reject it.',
    });
  }

  return {
    method,
    title: 'Typed data signature',
    fields,
    warnings,
    raw: JSON.stringify(data, null, 2),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bridge/decode/typed.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/decode/typed.ts src/bridge/decode/typed.test.ts
git commit -m "feat: decode typed data with Permit and chain-mismatch warnings"
```

---

### Task 7: Decode transactions and calldata selectors

**Files:**
- Create: `src/bridge/decode/tx.ts`
- Test: `src/bridge/decode/tx.test.ts`

**Interfaces:**
- Consumes: `RequestCard`, `CardField`, `CardWarning`, `DecodeContext` from `src/bridge/types.ts`; `formatEther`, `isUnlimitedAmount` from `src/bridge/format.ts`; `chainName` from `src/chains.ts`.
- Produces: `decodeTransaction(params: unknown, ctx: DecodeContext): RequestCard`, `SELECTORS: Record<string, string>`.

ABI decoding here is deliberate hand-slicing of 32-byte words rather than a library: the seven selectors below all take static head-encoded arguments, so slicing is exact, and it keeps a heavyweight ABI dependency out of a tool whose whole value is being auditable.

- [ ] **Step 1: Write the failing test**

`src/bridge/decode/tx.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { decodeTransaction } from './tx';
import type { DecodeContext } from '../types';

const ctx: DecodeContext = { chainId: 8453, isSmartAccount: true };
const pad = (s: string) => s.replace(/^0x/, '').padStart(64, '0');
const MAX = 'f'.repeat(64);

describe('decodeTransaction', () => {
  it('shows recipient and value in ETH', () => {
    const card = decodeTransaction(
      [{ to: '0x1111111111111111111111111111111111111111', value: '0xde0b6b3a7640000' }],
      ctx,
    );
    expect(card.fields).toContainEqual({
      label: 'To',
      value: '0x1111111111111111111111111111111111111111',
      mono: true,
    });
    expect(card.fields.some((f) => f.label === 'Value' && f.value === '1 ETH')).toBe(true);
  });

  it('treats a missing `to` as contract creation and warns', () => {
    const card = decodeTransaction([{ data: '0x6060' }], ctx);
    expect(card.warnings.some((w) => w.severity === 'danger' && /contract creation/i.test(w.text))).toBe(true);
  });

  it('names a known selector', () => {
    const card = decodeTransaction(
      [{ to: '0xtok', data: '0xa9059cbb' + pad('0x22') + pad('0x64') }],
      ctx,
    );
    expect(card.fields.some((f) => f.label === 'Function' && /transfer/.test(f.value))).toBe(true);
  });

  it('decodes approve args and shouts about unlimited allowance', () => {
    const card = decodeTransaction(
      [{ to: '0xtok', data: '0x095ea7b3' + pad('0xbeef') + MAX }],
      ctx,
    );
    expect(card.fields.some((f) => f.label === 'Spender')).toBe(true);
    expect(card.fields.some((f) => f.label === 'Allowance' && f.value === 'UNLIMITED')).toBe(true);
    expect(card.warnings.some((w) => w.severity === 'danger' && /unlimited/i.test(w.text))).toBe(true);
  });

  it('reports a finite approve amount without the unlimited warning', () => {
    const card = decodeTransaction(
      [{ to: '0xtok', data: '0x095ea7b3' + pad('0xbeef') + pad('0x64') }],
      ctx,
    );
    expect(card.fields.some((f) => f.label === 'Allowance' && f.value === '100')).toBe(true);
    expect(card.warnings.some((w) => /unlimited/i.test(w.text))).toBe(false);
  });

  it('warns when setApprovalForAll grants approval', () => {
    const card = decodeTransaction(
      [{ to: '0xnft', data: '0xa22cb465' + pad('0xbeef') + pad('0x1') }],
      ctx,
    );
    expect(card.warnings.some((w) => w.severity === 'danger' && /every/i.test(w.text))).toBe(true);
  });

  it('does not warn when setApprovalForAll revokes approval', () => {
    const card = decodeTransaction(
      [{ to: '0xnft', data: '0xa22cb465' + pad('0xbeef') + pad('0x0') }],
      ctx,
    );
    expect(card.warnings.some((w) => /every/i.test(w.text))).toBe(false);
  });

  it('falls back to selector plus calldata size for unknown functions', () => {
    const card = decodeTransaction([{ to: '0xc', data: '0xdeadbeef' + pad('0x1') }], ctx);
    expect(card.fields.some((f) => f.label === 'Function' && f.value.includes('0xdeadbeef'))).toBe(true);
    expect(card.fields.some((f) => /bytes/.test(f.value))).toBe(true);
  });

  it('handles a plain value transfer with no data', () => {
    const card = decodeTransaction([{ to: '0xabc', value: '0x0' }], ctx);
    expect(card.fields.some((f) => f.label === 'Function')).toBe(false);
  });

  it('does not throw on malformed params', () => {
    expect(() => decodeTransaction(null, ctx)).not.toThrow();
    expect(() => decodeTransaction([], ctx)).not.toThrow();
    expect(() => decodeTransaction([{ to: '0xa', data: '0x09' }], ctx)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bridge/decode/tx.test.ts`
Expected: FAIL — cannot resolve `./tx`.

- [ ] **Step 3: Implement `src/bridge/decode/tx.ts`**

```ts
import type { CardField, CardWarning, DecodeContext, RequestCard } from '../types';
import { formatEther, isUnlimitedAmount } from '../format';
import { chainName } from '../../chains';

/** Well-known 4-byte selectors worth naming on the approval card. */
export const SELECTORS: Record<string, string> = {
  '0x095ea7b3': 'approve(address,uint256)',
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',
  '0xd505accf': 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  '0xac9650d8': 'multicall(bytes[])',
  '0xb61d27f6': 'execute(address,uint256,bytes)',
};

/** Read the nth 32-byte ABI word from calldata (after the 4-byte selector). */
function word(data: string, n: number): string | null {
  const start = 10 + n * 64;
  const w = data.slice(start, start + 64);
  return w.length === 64 ? w : null;
}

const wordToAddress = (w: string) => '0x' + w.slice(24);
const wordToBigInt = (w: string) => BigInt('0x' + w);

export function decodeTransaction(params: unknown, ctx: DecodeContext): RequestCard {
  const arr = Array.isArray(params) ? params : [];
  const tx = (typeof arr[0] === 'object' && arr[0] !== null ? arr[0] : {}) as Record<string, unknown>;
  const fields: CardField[] = [];
  const warnings: CardWarning[] = [];

  const to = typeof tx.to === 'string' ? tx.to : null;
  if (to) {
    fields.push({ label: 'To', value: to, mono: true });
  } else {
    warnings.push({
      severity: 'danger',
      text: 'This transaction has no recipient — it is a contract creation. Only approve this if you meant to deploy a contract.',
    });
  }

  fields.push({ label: 'Network', value: chainName(ctx.chainId) });

  const value = typeof tx.value === 'string' ? tx.value : '0x0';
  const eth = formatEther(value);
  if (eth !== '0') fields.push({ label: 'Value', value: `${eth} ETH` });

  const data = typeof tx.data === 'string' ? tx.data : '';
  if (data.length >= 10) {
    const selector = data.slice(0, 10).toLowerCase();
    const known = SELECTORS[selector];
    const byteLen = Math.max(0, (data.length - 2) / 2);
    fields.push({
      label: 'Function',
      value: known ? `${known}  ${selector}` : `unknown  ${selector}  (${byteLen} bytes calldata)`,
      mono: !known,
    });
    if (!known) {
      fields.push({ label: 'Calldata', value: `${byteLen} bytes`, mono: true });
    }

    if (selector === '0x095ea7b3') {
      const spender = word(data, 0);
      const amount = word(data, 1);
      if (spender) fields.push({ label: 'Spender', value: wordToAddress(spender), mono: true });
      if (amount) {
        const v = wordToBigInt(amount);
        const unlimited = isUnlimitedAmount(v);
        fields.push({ label: 'Allowance', value: unlimited ? 'UNLIMITED' : v.toString() });
        if (unlimited) {
          warnings.push({
            severity: 'danger',
            text: 'This approves an UNLIMITED token allowance. The spender can move this token from your account at any time until you revoke it.',
          });
        }
      }
    }

    if (selector === '0xa22cb465') {
      const operator = word(data, 0);
      const approved = word(data, 1);
      if (operator) fields.push({ label: 'Operator', value: wordToAddress(operator), mono: true });
      if (approved && wordToBigInt(approved) !== 0n) {
        warnings.push({
          severity: 'danger',
          text: 'This grants control over every NFT you own in this collection, including ones you buy later.',
        });
      }
    }
  }

  return {
    method: 'eth_sendTransaction',
    title: 'Transaction request',
    fields,
    warnings,
    raw: JSON.stringify(params, null, 2),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bridge/decode/tx.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/decode/tx.ts src/bridge/decode/tx.test.ts
git commit -m "feat: decode transactions with selector table and approval warnings"
```

---

### Task 8: Card dispatcher

**Files:**
- Create: `src/bridge/decode/index.ts`
- Test: `src/bridge/decode/index.test.ts`

**Interfaces:**
- Consumes: `decodePersonalSign` (Task 5), `decodeTypedData` (Task 6), `decodeTransaction` (Task 7), `IncomingRequest`, `RequestCard`, `DecodeContext` from `src/bridge/types.ts`.
- Produces: `buildCard(req: IncomingRequest, ctx: DecodeContext): RequestCard`.

- [ ] **Step 1: Write the failing test**

`src/bridge/decode/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildCard } from './index';
import type { DecodeContext, IncomingRequest } from '../types';

const ctx: DecodeContext = { chainId: 8453, isSmartAccount: true };

const req = (method: string, params: unknown): IncomingRequest => ({
  id: 1,
  topic: 't',
  chainId: 8453,
  method,
  params,
  dapp: { name: 'Test', url: 'https://t.example', validation: 'VALID', isScam: false },
});

describe('buildCard', () => {
  it('routes personal_sign', () => {
    expect(buildCard(req('personal_sign', ['0x68690a', '0xabc']), ctx).title).toMatch(/signature/i);
  });

  it.each(['eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4'])(
    'routes %s',
    (m) => {
      expect(buildCard(req(m, ['0xabc', '{}']), ctx).title).toMatch(/typed data/i);
    },
  );

  it('routes eth_sendTransaction', () => {
    expect(buildCard(req('eth_sendTransaction', [{ to: '0xabc' }]), ctx).title).toMatch(/transaction/i);
  });

  it('produces a generic card for an unrecognised method', () => {
    const card = buildCard(req('wallet_weirdThing', [1, 2]), ctx);
    expect(card.method).toBe('wallet_weirdThing');
    expect(card.warnings.some((w) => /not in the allowlist/i.test(w.text))).toBe(true);
    expect(card.raw).toContain('1');
  });

  it('always includes the raw params', () => {
    expect(buildCard(req('eth_sendTransaction', [{ to: '0xabc' }]), ctx).raw).toContain('0xabc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bridge/decode/index.test.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Implement `src/bridge/decode/index.ts`**

```ts
import type { DecodeContext, IncomingRequest, RequestCard } from '../types';
import { decodePersonalSign } from './sign';
import { decodeTypedData } from './typed';
import { decodeTransaction } from './tx';

export function buildCard(req: IncomingRequest, ctx: DecodeContext): RequestCard {
  switch (req.method) {
    case 'personal_sign':
      return decodePersonalSign(req.params, ctx);
    case 'eth_signTypedData':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4':
      return decodeTypedData(req.method, req.params, ctx);
    case 'eth_sendTransaction':
      return decodeTransaction(req.params, ctx);
    default:
      return {
        method: req.method,
        title: `Unrecognised request: ${req.method}`,
        fields: [{ label: 'Method', value: req.method, mono: true }],
        warnings: [
          {
            severity: 'warn',
            text: `This dapp asked for "${req.method}", which is not in the allowlist. Forward it only if you understand what it does.`,
          },
        ],
        raw: JSON.stringify(req.params, null, 2),
      };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bridge/decode/index.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/decode/index.ts src/bridge/decode/index.test.ts
git commit -m "feat: add approval card dispatcher"
```

---

### Task 9: Namespace negotiation

**Files:**
- Create: `src/bridge/namespaces.ts`
- Test: `src/bridge/namespaces.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_CAIP_CHAINS`, `toCaipChainId` from `src/chains.ts`; `ADVERTISED_METHODS` from `src/bridge/policy.ts`.
- Produces: `ADVERTISED_EVENTS: readonly string[]`, `buildSupportedNamespaces(address: string): Record<string, { chains: string[]; methods: string[]; events: string[]; accounts: string[] }>`, `decideProposal(proposal, address): ProposalDecision`, `type ProposalDecision = { ok: true; namespaces: SessionTypes.Namespaces } | { ok: false; reason: string }`.

`buildApprovedNamespaces` from `@walletconnect/utils` performs the required-vs-optional merge and **throws** when the proposal demands something outside `supportedNamespaces`. That throw is the feature: it means the bridge rejects at negotiation time rather than approving a session that fails on first use.

- [ ] **Step 1: Write the failing test**

`src/bridge/namespaces.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildSupportedNamespaces, decideProposal } from './namespaces';

const ADDR = '0x1111111111111111111111111111111111111111';

const proposal = (required: unknown, optional: unknown = {}) =>
  ({
    id: 1,
    expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
    relays: [{ protocol: 'irn' }],
    proposer: { publicKey: 'pk', metadata: { name: 'D', description: '', url: 'https://d', icons: [] } },
    requiredNamespaces: required,
    optionalNamespaces: optional,
    pairingTopic: 'topic',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('buildSupportedNamespaces', () => {
  it('lists one account per supported chain', () => {
    const ns = buildSupportedNamespaces(ADDR);
    expect(ns.eip155.accounts).toContain(`eip155:8453:${ADDR}`);
    expect(ns.eip155.accounts).toHaveLength(ns.eip155.chains.length);
  });

  it('advertises accountsChanged and chainChanged', () => {
    expect(buildSupportedNamespaces(ADDR).eip155.events).toEqual(
      expect.arrayContaining(['accountsChanged', 'chainChanged']),
    );
  });

  it('never advertises eth_sign or eth_signTransaction', () => {
    const methods = buildSupportedNamespaces(ADDR).eip155.methods;
    expect(methods).not.toContain('eth_sign');
    expect(methods).not.toContain('eth_signTransaction');
  });
});

describe('decideProposal', () => {
  it('approves a proposal requiring only Base', () => {
    const d = decideProposal(
      proposal({
        eip155: { chains: ['eip155:8453'], methods: ['eth_sendTransaction', 'personal_sign'], events: ['chainChanged'] },
      }),
      ADDR,
    );
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.namespaces.eip155.accounts).toContain(`eip155:8453:${ADDR}`);
  });

  it('approves an optional-only proposal', () => {
    const d = decideProposal(
      proposal({}, { eip155: { chains: ['eip155:8453', 'eip155:1'], methods: ['personal_sign'], events: [] } }),
      ADDR,
    );
    expect(d.ok).toBe(true);
  });

  it('rejects when a required chain is unsupported, naming the chain', () => {
    const d = decideProposal(
      proposal({ eip155: { chains: ['eip155:43114'], methods: ['personal_sign'], events: [] } }),
      ADDR,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/43114|chain/i);
  });

  it('rejects when a required method is unsupported', () => {
    const d = decideProposal(
      proposal({ eip155: { chains: ['eip155:8453'], methods: ['eth_signTransaction'], events: [] } }),
      ADDR,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/eth_signTransaction|method/i);
  });

  it('rejects a non-eip155 required namespace', () => {
    const d = decideProposal(
      proposal({ solana: { chains: ['solana:mainnet'], methods: ['signMessage'], events: [] } }),
      ADDR,
    );
    expect(d.ok).toBe(false);
  });

  it('never throws — always returns a decision', () => {
    expect(() => decideProposal(proposal(undefined), ADDR)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bridge/namespaces.test.ts`
Expected: FAIL — cannot resolve `./namespaces`.

- [ ] **Step 3: Implement `src/bridge/namespaces.ts`**

```ts
import { buildApprovedNamespaces } from '@walletconnect/utils';
import type { ProposalTypes, SessionTypes } from '@walletconnect/types';
import { SUPPORTED_CAIP_CHAINS, SUPPORTED_CHAINS, toCaipChainId } from '../chains';
import { ADVERTISED_METHODS } from './policy';

export const ADVERTISED_EVENTS = ['accountsChanged', 'chainChanged'] as const;

export type ProposalDecision =
  | { ok: true; namespaces: SessionTypes.Namespaces }
  | { ok: false; reason: string };

export function buildSupportedNamespaces(address: string) {
  return {
    eip155: {
      chains: [...SUPPORTED_CAIP_CHAINS],
      methods: [...ADVERTISED_METHODS],
      events: [...ADVERTISED_EVENTS],
      accounts: SUPPORTED_CHAINS.map((c) => `${toCaipChainId(c.id)}:${address}`),
    },
  };
}

/**
 * Decide whether we can serve a session proposal.
 *
 * buildApprovedNamespaces throws when the proposal requires a chain or method
 * outside what we support. Rejecting here is deliberately better than approving
 * a session that will fail on the dapp's first real request.
 */
export function decideProposal(
  proposal: ProposalTypes.Struct,
  address: string,
): ProposalDecision {
  try {
    const namespaces = buildApprovedNamespaces({
      proposal,
      supportedNamespaces: buildSupportedNamespaces(address),
    });
    return { ok: true, namespaces };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `This dapp requires something this account can't provide: ${detail}`,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bridge/namespaces.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/namespaces.ts src/bridge/namespaces.test.ts
git commit -m "feat: negotiate WalletConnect namespaces from supported chains"
```

---

### Task 10: The router

**Files:**
- Create: `src/bridge/router.ts`
- Test: `src/bridge/router.test.ts`

**Interfaces:**
- Consumes: all port types and `USER_REJECTED`, `RequestExpiredError` from `src/bridge/types.ts`; `classify` from `./policy`; `toJsonRpcError`, `withTimeout`, `TimeoutError` from `./errors`; `buildCard` from `./decode`.
- Produces: `WALLET_TIMEOUT_MS: number`, `interface RouterDeps { wallet: WalletPort; dapp: DappPort; confirm: ConfirmPort; isSmartAccount: () => boolean; timeoutMs?: number }`, `handleRequest(req: IncomingRequest, deps: RouterDeps): Promise<void>`.

This is the heart of the system. The invariant under test is **exactly one response per request id — except an expired request, which gets none.**

- [ ] **Step 1: Write the failing test**

`src/bridge/router.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { handleRequest } from './router';
import { RequestExpiredError } from './types';
import type { IncomingRequest, JsonRpcErrorPayload } from './types';
import type { RouterDeps } from './router';

const req = (method: string, params: unknown = [], chainId = 8453): IncomingRequest => ({
  id: 7,
  topic: 'topic-1',
  chainId,
  method,
  params,
  dapp: { name: 'Test Dapp', url: 'https://t.example', validation: 'VALID', isScam: false },
});

function makeDeps(over: Partial<{
  request: (a: { method: string; params?: unknown }) => Promise<unknown>;
  chainId: number;
  confirm: (…a: unknown[]) => Promise<boolean>;
}> = {}) {
  const results: unknown[] = [];
  const errors: JsonRpcErrorPayload[] = [];
  const switched: number[] = [];
  const requested: { method: string; params?: unknown }[] = [];

  const deps = {
    wallet: {
      request: vi.fn(async (a: { method: string; params?: unknown }) => {
        requested.push(a);
        return over.request ? over.request(a) : 'ok';
      }),
      getChainId: vi.fn(async () => over.chainId ?? 8453),
      switchChain: vi.fn(async (id: number) => {
        switched.push(id);
      }),
    },
    dapp: {
      respondResult: vi.fn(async (_t: string, _i: number, r: unknown) => {
        results.push(r);
      }),
      respondError: vi.fn(async (_t: string, _i: number, e: JsonRpcErrorPayload) => {
        errors.push(e);
      }),
    },
    confirm: {
      confirm: vi.fn(async () => (over.confirm ? over.confirm() : true)),
    },
    isSmartAccount: () => true,
    timeoutMs: 50,
  } as unknown as RouterDeps;

  return { deps, results, errors, switched, requested };
}

const totalResponses = (h: ReturnType<typeof makeDeps>) => h.results.length + h.errors.length;

describe('handleRequest', () => {
  it('forwards a PASS method without prompting', async () => {
    const h = makeDeps();
    await handleRequest(req('eth_chainId'), h.deps);
    expect(h.deps.confirm.confirm).not.toHaveBeenCalled();
    expect(h.results).toEqual(['ok']);
  });

  it('prompts then forwards a CONFIRM method', async () => {
    const h = makeDeps();
    await handleRequest(req('personal_sign', ['0x68', '0xabc']), h.deps);
    expect(h.deps.confirm.confirm).toHaveBeenCalledOnce();
    expect(h.results).toEqual(['ok']);
  });

  it('responds 4001 and never touches the wallet when the user rejects', async () => {
    const h = makeDeps({ confirm: async () => false });
    await handleRequest(req('eth_sendTransaction', [{ to: '0xabc' }]), h.deps);
    expect(h.deps.wallet.request).not.toHaveBeenCalled();
    expect(h.errors).toEqual([{ code: 4001, message: expect.stringMatching(/reject/i) }]);
  });

  it('rejects a REJECT method with 4200 and never touches the wallet', async () => {
    const h = makeDeps();
    await handleRequest(req('eth_signTransaction'), h.deps);
    expect(h.deps.wallet.request).not.toHaveBeenCalled();
    expect(h.errors[0].code).toBe(4200);
  });

  it('prompts for an unknown method rather than forwarding it blindly', async () => {
    const h = makeDeps();
    await handleRequest(req('eth_futureThing'), h.deps);
    expect(h.deps.confirm.confirm).toHaveBeenCalledOnce();
    expect(h.results).toEqual(['ok']);
  });

  it('preserves a 4001 thrown by the wallet', async () => {
    const h = makeDeps({
      request: async () => {
        throw Object.assign(new Error('User denied'), { code: 4001 });
      },
    });
    await handleRequest(req('personal_sign'), h.deps);
    expect(h.errors[0].code).toBe(4001);
  });

  it('still responds when the wallet throws a bare Error', async () => {
    const h = makeDeps({
      request: async () => {
        throw new Error('kaboom');
      },
    });
    await handleRequest(req('personal_sign'), h.deps);
    expect(totalResponses(h)).toBe(1);
    expect(h.errors[0]).toEqual({ code: 5000, message: 'kaboom' });
  });

  it('still responds when the wallet throws a non-Error', async () => {
    const h = makeDeps({
      request: async () => {
        throw 'string throw';
      },
    });
    await handleRequest(req('personal_sign'), h.deps);
    expect(totalResponses(h)).toBe(1);
  });

  it('switches chain before forwarding when the session chain differs', async () => {
    const h = makeDeps({ chainId: 1 });
    await handleRequest(req('eth_sendTransaction', [{ to: '0xa' }], 8453), h.deps);
    expect(h.switched).toEqual([8453]);
    expect(h.deps.wallet.switchChain).toHaveBeenCalledBefore(h.deps.wallet.request as never);
  });

  it('does not switch chain when already on the session chain', async () => {
    const h = makeDeps({ chainId: 8453 });
    await handleRequest(req('eth_chainId', [], 8453), h.deps);
    expect(h.switched).toEqual([]);
  });

  it('responds with an error when the chain switch fails', async () => {
    const h = makeDeps({ chainId: 1 });
    (h.deps.wallet.switchChain as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('unrecognised chain'), { code: 4902 }),
    );
    await handleRequest(req('eth_sendTransaction', [{ to: '0xa' }], 8453), h.deps);
    expect(h.errors[0].code).toBe(4902);
    expect(totalResponses(h)).toBe(1);
  });

  it('times out a wallet that never answers', async () => {
    const h = makeDeps({ request: () => new Promise(() => {}) });
    await handleRequest(req('personal_sign'), h.deps);
    expect(h.errors[0].code).toBe(5000);
    expect(h.errors[0].message).toMatch(/wallet/i);
  });

  it('sends NO response at all for an expired request', async () => {
    const h = makeDeps();
    (h.deps.confirm.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(
      new RequestExpiredError(7),
    );
    await handleRequest(req('personal_sign'), h.deps);
    expect(totalResponses(h)).toBe(0);
  });

  it('responds exactly once even when the dapp port itself is slow', async () => {
    const h = makeDeps();
    await handleRequest(req('eth_chainId'), h.deps);
    expect(totalResponses(h)).toBe(1);
  });

  it('forwards the original method and params unchanged', async () => {
    const h = makeDeps();
    const params = [{ to: '0xabc', value: '0x1' }];
    await handleRequest(req('eth_sendTransaction', params), h.deps);
    expect(h.requested).toEqual([{ method: 'eth_sendTransaction', params }]);
  });
});
```

Note: the `…a: unknown[]` in the helper signature is an ellipsis character in this document only — write it as `...a: unknown[]` in the real file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/bridge/router.test.ts`
Expected: FAIL — cannot resolve `./router`.

- [ ] **Step 3: Implement `src/bridge/router.ts`**

```ts
import type {
  ConfirmPort,
  DappPort,
  IncomingRequest,
  JsonRpcErrorPayload,
  WalletPort,
} from './types';
import { RequestExpiredError, USER_REJECTED } from './types';
import { classify } from './policy';
import { toJsonRpcError, withTimeout } from './errors';
import { buildCard } from './decode';

export const WALLET_TIMEOUT_MS = 3 * 60 * 1000;

export interface RouterDeps {
  wallet: WalletPort;
  dapp: DappPort;
  confirm: ConfirmPort;
  isSmartAccount: () => boolean;
  timeoutMs?: number;
}

/**
 * Handle one session_request end to end.
 *
 * Invariant: exactly one response per request id — except an expired request,
 * which gets none (responding to an expired id throws inside WalletKit).
 * A missing response leaves the dapp spinning forever with no recovery short of
 * a page reload, so the response is guaranteed by the `finally` block.
 */
export async function handleRequest(
  req: IncomingRequest,
  deps: RouterDeps,
): Promise<void> {
  const { wallet, dapp, confirm } = deps;
  let responded = false;

  const respondResult = async (result: unknown) => {
    if (responded) return;
    responded = true;
    await dapp.respondResult(req.topic, req.id, result);
  };
  const respondError = async (error: JsonRpcErrorPayload) => {
    if (responded) return;
    responded = true;
    await dapp.respondError(req.topic, req.id, error);
  };

  try {
    const disposition = classify(req.method);

    if (disposition.kind === 'reject') {
      await respondError({ code: disposition.code, message: disposition.message });
      return;
    }

    if (disposition.kind === 'confirm' || disposition.kind === 'unknown') {
      const card = buildCard(req, {
        chainId: req.chainId,
        isSmartAccount: deps.isSmartAccount(),
      });
      const approved = await confirm.confirm(req, card);
      if (!approved) {
        await respondError(USER_REJECTED);
        return;
      }
    }

    const currentChain = await wallet.getChainId();
    if (currentChain !== req.chainId) {
      await wallet.switchChain(req.chainId);
    }

    const result = await withTimeout(
      wallet.request({ method: req.method, params: req.params }),
      deps.timeoutMs ?? WALLET_TIMEOUT_MS,
      'Timed out waiting for the wallet to respond.',
    );
    await respondResult(result);
  } catch (err) {
    if (err instanceof RequestExpiredError) {
      // Suppress the finally-block fallback: an expired id must get no response.
      responded = true;
      return;
    }
    await respondError(toJsonRpcError(err));
  } finally {
    if (!responded) {
      responded = true;
      await dapp.respondError(req.topic, req.id, {
        code: 5000,
        message: 'Bridge failed to produce a response.',
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/bridge/router.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/router.ts src/bridge/router.test.ts
git commit -m "feat: add request router with always-respond guarantee"
```

---

### Task 11: Coinbase wallet adapter

**Files:**
- Create: `src/cb/provider.ts`
- Test: `src/cb/provider.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_CHAIN_IDS` from `src/chains.ts`; `WalletPort` from `src/bridge/types.ts`.
- Produces: `createWalletPort(provider: ProviderInterface): WalletPort`, `detectSmartAccount(provider: ProviderInterface, address: string): Promise<boolean>`, `connectWallet(): Promise<WalletConnection>`, `interface WalletConnection { provider: ProviderInterface; address: string; isSmartAccount: boolean; port: WalletPort }`.

`createWalletPort` and `detectSmartAccount` are testable against a fake provider object; only `connectWallet` touches the real SDK.

- [ ] **Step 1: Write the failing test**

`src/cb/provider.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { createWalletPort, detectSmartAccount } from './provider';
import type { ProviderInterface } from '@coinbase/wallet-sdk';

function fakeProvider(handler: (m: string, p?: unknown) => unknown): ProviderInterface {
  return {
    request: vi.fn(async (a: { method: string; params?: unknown }) => handler(a.method, a.params)),
  } as unknown as ProviderInterface;
}

describe('createWalletPort', () => {
  it('parses a hex chain id into a number', async () => {
    const port = createWalletPort(fakeProvider(() => '0x2105'));
    expect(await port.getChainId()).toBe(8453);
  });

  it('sends wallet_switchEthereumChain with a hex chain id', async () => {
    const seen: unknown[] = [];
    const port = createWalletPort(
      fakeProvider((m, p) => {
        seen.push({ m, p });
        return null;
      }),
    );
    await port.switchChain(8453);
    expect(seen).toEqual([
      { m: 'wallet_switchEthereumChain', p: [{ chainId: '0x2105' }] },
    ]);
  });

  it('passes arbitrary requests through unchanged', async () => {
    const seen: unknown[] = [];
    const port = createWalletPort(
      fakeProvider((m, p) => {
        seen.push({ m, p });
        return 'sig';
      }),
    );
    const params = ['0x68', '0xabc'];
    expect(await port.request({ method: 'personal_sign', params })).toBe('sig');
    expect(seen).toEqual([{ m: 'personal_sign', p: params }]);
  });

  it('lets provider errors propagate so the router can map them', async () => {
    const port = createWalletPort(
      fakeProvider(() => {
        throw Object.assign(new Error('denied'), { code: 4001 });
      }),
    );
    await expect(port.request({ method: 'personal_sign' })).rejects.toMatchObject({ code: 4001 });
  });
});

describe('detectSmartAccount', () => {
  it('is true when the address has contract code', async () => {
    const p = fakeProvider(() => '0x60806040');
    expect(await detectSmartAccount(p, '0xabc')).toBe(true);
  });

  it('is false for an EOA (code is 0x)', async () => {
    expect(await detectSmartAccount(fakeProvider(() => '0x'), '0xabc')).toBe(false);
  });

  it('is false when the code call fails, rather than throwing', async () => {
    const p = fakeProvider(() => {
      throw new Error('rpc down');
    });
    await expect(detectSmartAccount(p, '0xabc')).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cb/provider.test.ts`
Expected: FAIL — cannot resolve `./provider`.

- [ ] **Step 3: Implement `src/cb/provider.ts`**

```ts
import { createCoinbaseWalletSDK } from '@coinbase/wallet-sdk';
import type { ProviderInterface } from '@coinbase/wallet-sdk';
import { SUPPORTED_CHAIN_IDS } from '../chains';
import type { WalletPort } from '../bridge/types';

export interface WalletConnection {
  provider: ProviderInterface;
  address: string;
  isSmartAccount: boolean;
  port: WalletPort;
}

export function createWalletPort(provider: ProviderInterface): WalletPort {
  return {
    request: <T,>(args: { method: string; params?: unknown }) =>
      provider.request(args as never) as Promise<T>,

    async getChainId() {
      const hex = (await provider.request({ method: 'eth_chainId' })) as string;
      return Number(hex);
    },

    async switchChain(chainId: number) {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      });
    },
  };
}

/**
 * A Base Account is a contract account, so its address has code. This drives
 * the ERC-1271 warnings on signature cards. A failure here must not block the
 * connection — we just lose the warning.
 */
export async function detectSmartAccount(
  provider: ProviderInterface,
  address: string,
): Promise<boolean> {
  try {
    const code = (await provider.request({
      method: 'eth_getCode',
      params: [address, 'latest'],
    })) as string;
    return typeof code === 'string' && code !== '0x' && code.length > 2;
  } catch {
    return false;
  }
}

export async function connectWallet(): Promise<WalletConnection> {
  const sdk = createCoinbaseWalletSDK({
    appName: 'CB ↔ WalletConnect Bridge',
    appLogoUrl: null,
    appChainIds: SUPPORTED_CHAIN_IDS,
  });
  const provider = sdk.getProvider();

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0];
  if (!address) throw new Error('Coinbase Wallet returned no accounts.');

  return {
    provider,
    address,
    isSmartAccount: await detectSmartAccount(provider, address),
    port: createWalletPort(provider),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cb/provider.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cb/provider.ts src/cb/provider.test.ts
git commit -m "feat: add Coinbase Wallet adapter implementing WalletPort"
```

---

### Task 12: WalletKit adapter

**Files:**
- Create: `src/wc/walletkit.ts`
- Test: `src/wc/walletkit.test.ts`

**Interfaces:**
- Consumes: `DappPort`, `DappIdentity`, `IncomingRequest`, `JsonRpcErrorPayload` from `src/bridge/types.ts`; `parseCaipChainId` from `src/chains.ts`.
- Produces: `toDappIdentity(metadata, verifyContext): DappIdentity`, `toIncomingRequest(event, metadata): IncomingRequest`, `createWalletKit(projectId: string): Promise<WalletKit>`, `createDappPort(kit: WalletKit): DappPort`.

The two `to*` functions are pure normalisation and carry the tests; `createWalletKit` and `createDappPort` are thin SDK wrappers.

- [ ] **Step 1: Write the failing test**

`src/wc/walletkit.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { toDappIdentity, toIncomingRequest } from './walletkit';

const metadata = {
  name: 'Test Dapp',
  description: 'd',
  url: 'https://dapp.example',
  icons: ['https://dapp.example/icon.png'],
};

const verify = (validation: 'VALID' | 'INVALID' | 'UNKNOWN', isScam?: boolean) => ({
  verified: { origin: 'https://dapp.example', validation, verifyUrl: '', isScam },
});

describe('toDappIdentity', () => {
  it('carries name, url and first icon', () => {
    const d = toDappIdentity(metadata, verify('VALID'));
    expect(d).toMatchObject({
      name: 'Test Dapp',
      url: 'https://dapp.example',
      iconUrl: 'https://dapp.example/icon.png',
      validation: 'VALID',
      isScam: false,
    });
  });

  it('defaults isScam to false when absent', () => {
    expect(toDappIdentity(metadata, verify('UNKNOWN')).isScam).toBe(false);
  });

  it('propagates isScam when set', () => {
    expect(toDappIdentity(metadata, verify('INVALID', true)).isScam).toBe(true);
  });

  it('falls back to UNKNOWN when verifyContext is missing', () => {
    expect(toDappIdentity(metadata, undefined).validation).toBe('UNKNOWN');
  });

  it('survives metadata with no icons', () => {
    const d = toDappIdentity({ ...metadata, icons: [] }, verify('VALID'));
    expect(d.iconUrl).toBeUndefined();
  });
});

describe('toIncomingRequest', () => {
  const event = {
    id: 99,
    topic: 'abc',
    params: {
      request: { method: 'personal_sign', params: ['0x68', '0xa'], expiryTimestamp: 1234 },
      chainId: 'eip155:8453',
    },
    verifyContext: verify('VALID'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('normalises the WalletKit event shape', () => {
    const r = toIncomingRequest(event, metadata);
    expect(r).toMatchObject({
      id: 99,
      topic: 'abc',
      chainId: 8453,
      method: 'personal_sign',
      params: ['0x68', '0xa'],
      expiryTimestamp: 1234,
    });
    expect(r.dapp.name).toBe('Test Dapp');
  });

  it('throws on a non-eip155 chain id rather than guessing', () => {
    const bad = { ...event, params: { ...event.params, chainId: 'solana:x' } };
    expect(() => toIncomingRequest(bad, metadata)).toThrow(/eip155/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/wc/walletkit.test.ts`
Expected: FAIL — cannot resolve `./walletkit`.

- [ ] **Step 3: Implement `src/wc/walletkit.ts`**

```ts
import { Core } from '@walletconnect/core';
import { WalletKit, type WalletKitTypes } from '@reown/walletkit';
import { formatJsonRpcError, formatJsonRpcResult } from '@walletconnect/jsonrpc-utils';
import type { CoreTypes, Verify } from '@walletconnect/types';
import { parseCaipChainId } from '../chains';
import type { DappIdentity, DappPort, IncomingRequest, JsonRpcErrorPayload } from '../bridge/types';

export function toDappIdentity(
  metadata: CoreTypes.Metadata,
  verifyContext: Verify.Context | undefined,
): DappIdentity {
  return {
    name: metadata.name,
    url: metadata.url,
    iconUrl: metadata.icons?.[0],
    validation: verifyContext?.verified.validation ?? 'UNKNOWN',
    isScam: verifyContext?.verified.isScam ?? false,
  };
}

export function toIncomingRequest(
  event: WalletKitTypes.SessionRequest,
  metadata: CoreTypes.Metadata,
): IncomingRequest {
  return {
    id: event.id,
    topic: event.topic,
    chainId: parseCaipChainId(event.params.chainId),
    method: event.params.request.method,
    params: event.params.request.params,
    expiryTimestamp: event.params.request.expiryTimestamp,
    dapp: toDappIdentity(metadata, event.verifyContext),
  };
}

export async function createWalletKit(projectId: string): Promise<WalletKit> {
  if (!projectId) {
    throw new Error(
      'VITE_REOWN_PROJECT_ID is not set. Get a free project ID at https://dashboard.reown.com and copy .env.example to .env.',
    );
  }
  return WalletKit.init({
    core: new Core({ projectId }),
    metadata: {
      name: 'CB ↔ WalletConnect Bridge',
      description: 'Bridges WalletConnect dapps to a Coinbase Base Account',
      url: window.location.origin,
      icons: [],
    },
  });
}

export function createDappPort(kit: WalletKit): DappPort {
  return {
    async respondResult(topic: string, id: number, result: unknown) {
      await kit.respondSessionRequest({ topic, response: formatJsonRpcResult(id, result) });
    },
    async respondError(topic: string, id: number, error: JsonRpcErrorPayload) {
      await kit.respondSessionRequest({
        topic,
        response: formatJsonRpcError(id, { code: error.code, message: error.message }),
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/wc/walletkit.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/wc/walletkit.ts src/wc/walletkit.test.ts
git commit -m "feat: add WalletKit adapter implementing DappPort"
```

---

### Task 13: Confirmation registry and HTML rendering

**Files:**
- Create: `src/ui/pending.ts`, `src/ui/render.ts`
- Test: `src/ui/pending.test.ts`, `src/ui/render.test.ts`

**Interfaces:**
- Consumes: `ConfirmPort`, `IncomingRequest`, `RequestCard`, `DappIdentity`, `RequestExpiredError` from `src/bridge/types.ts`.
- Produces: `class PendingConfirmations` with `confirm(req, card): Promise<boolean>`, `approve(id): void`, `reject(id): void`, `expire(id): void`, `list(): PendingEntry[]`, `interface PendingEntry { req: IncomingRequest; card: RequestCard }`; and `escapeHtml(s: string): string`, `renderDappHeader(dapp: DappIdentity): string`, `renderCard(card: RequestCard): string`.

`PendingConfirmations` implements `ConfirmPort` without touching the DOM, so the expiry semantics the router depends on are unit-testable.

Escaping is a real security requirement, not hygiene: dapp names, URLs, and typed-data contents are attacker-controlled strings arriving over the relay and rendered into the page.

- [ ] **Step 1: Write the failing tests**

`src/ui/pending.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PendingConfirmations } from './pending';
import { RequestExpiredError } from '../bridge/types';
import type { IncomingRequest, RequestCard } from '../bridge/types';

const req = (id: number): IncomingRequest => ({
  id,
  topic: 't',
  chainId: 8453,
  method: 'personal_sign',
  params: [],
  dapp: { name: 'D', url: 'https://d', validation: 'VALID', isScam: false },
});
const card: RequestCard = { method: 'personal_sign', title: 'T', fields: [], warnings: [], raw: '[]' };

describe('PendingConfirmations', () => {
  it('resolves true when approved', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    p.approve(1);
    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when rejected', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    p.reject(1);
    await expect(promise).resolves.toBe(false);
  });

  it('rejects with RequestExpiredError when expired', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    p.expire(1);
    await expect(promise).rejects.toBeInstanceOf(RequestExpiredError);
  });

  it('removes the entry once settled', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    expect(p.list()).toHaveLength(1);
    p.approve(1);
    await promise;
    expect(p.list()).toHaveLength(0);
  });

  it('ignores settle calls for unknown ids', () => {
    const p = new PendingConfirmations();
    expect(() => p.approve(404)).not.toThrow();
    expect(() => p.expire(404)).not.toThrow();
  });

  it('ignores a second settle for the same id', async () => {
    const p = new PendingConfirmations();
    const promise = p.confirm(req(1), card);
    p.approve(1);
    p.reject(1);
    await expect(promise).resolves.toBe(true);
  });

  it('tracks several pending requests independently', async () => {
    const p = new PendingConfirmations();
    const a = p.confirm(req(1), card);
    const b = p.confirm(req(2), card);
    expect(p.list().map((e) => e.req.id)).toEqual([1, 2]);
    p.approve(1);
    p.reject(2);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(false);
  });
});
```

`src/ui/render.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { escapeHtml, renderCard, renderDappHeader } from './render';
import type { DappIdentity, RequestCard } from '../bridge/types';

describe('escapeHtml', () => {
  it('escapes the characters that break out of markup', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's & that")).toBe('it&#39;s &amp; that');
  });
});

describe('renderDappHeader', () => {
  const dapp = (over: Partial<DappIdentity> = {}): DappIdentity => ({
    name: 'Test Dapp',
    url: 'https://dapp.example',
    validation: 'VALID',
    isScam: false,
    ...over,
  });

  it('shows the origin, which the wallet sheet cannot', () => {
    expect(renderDappHeader(dapp())).toContain('https://dapp.example');
  });

  it('escapes a hostile dapp name', () => {
    const html = renderDappHeader(dapp({ name: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('marks an INVALID origin as dangerous', () => {
    expect(renderDappHeader(dapp({ validation: 'INVALID' }))).toMatch(/danger/);
  });

  it('marks a scam flag as dangerous', () => {
    expect(renderDappHeader(dapp({ isScam: true }))).toMatch(/danger/);
  });

  it('marks UNKNOWN as a warning, not a danger', () => {
    const html = renderDappHeader(dapp({ validation: 'UNKNOWN' }));
    expect(html).toMatch(/warn/);
    expect(html).not.toMatch(/danger/);
  });
});

describe('renderCard', () => {
  const card: RequestCard = {
    method: 'eth_sendTransaction',
    title: 'Transaction request',
    fields: [{ label: 'To', value: '0xabc', mono: true }],
    warnings: [{ severity: 'danger', text: 'UNLIMITED allowance' }],
    raw: '[{"to":"0xabc"}]',
  };

  it('renders title, fields and warnings', () => {
    const html = renderCard(card);
    expect(html).toContain('Transaction request');
    expect(html).toContain('0xabc');
    expect(html).toContain('UNLIMITED allowance');
    expect(html).toMatch(/danger/);
  });

  it('escapes hostile field values', () => {
    const html = renderCard({ ...card, fields: [{ label: 'To', value: '<b>x</b>' }] });
    expect(html).not.toContain('<b>x</b>');
  });

  it('escapes hostile raw params', () => {
    const html = renderCard({ ...card, raw: '<script>x</script>' });
    expect(html).not.toContain('<script>x</script>');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui`
Expected: FAIL — cannot resolve `./pending` and `./render`.

- [ ] **Step 3: Implement `src/ui/pending.ts`**

```ts
import { RequestExpiredError } from '../bridge/types';
import type { ConfirmPort, IncomingRequest, RequestCard } from '../bridge/types';

export interface PendingEntry {
  req: IncomingRequest;
  card: RequestCard;
}

interface Slot extends PendingEntry {
  resolve: (approved: boolean) => void;
  reject: (err: unknown) => void;
}

/**
 * Holds requests awaiting a decision. Implements ConfirmPort without touching
 * the DOM, so the expiry semantics the router depends on stay unit-testable.
 */
export class PendingConfirmations implements ConfirmPort {
  private slots = new Map<number, Slot>();

  confirm(req: IncomingRequest, card: RequestCard): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.slots.set(req.id, { req, card, resolve, reject });
    });
  }

  approve(id: number): void {
    this.settle(id, (s) => s.resolve(true));
  }

  reject(id: number): void {
    this.settle(id, (s) => s.resolve(false));
  }

  /** The request's own TTL elapsed. The router must send no response at all. */
  expire(id: number): void {
    this.settle(id, (s) => s.reject(new RequestExpiredError(id)));
  }

  list(): PendingEntry[] {
    return [...this.slots.values()].map(({ req, card }) => ({ req, card }));
  }

  private settle(id: number, act: (slot: Slot) => void): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    act(slot);
  }
}
```

- [ ] **Step 4: Implement `src/ui/render.ts`**

```ts
import type { CardWarning, DappIdentity, RequestCard } from '../bridge/types';

/**
 * Everything rendered here — dapp names, URLs, typed-data contents — arrives
 * from a remote peer over the relay. Escaping is a security control.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function badge(dapp: DappIdentity): { cls: string; label: string } {
  if (dapp.isScam || dapp.validation === 'INVALID') {
    return { cls: 'danger', label: dapp.isScam ? 'Flagged as a scam' : 'Origin does not match' };
  }
  if (dapp.validation === 'UNKNOWN') return { cls: 'warn', label: 'Unverified origin' };
  return { cls: 'ok', label: 'Verified' };
}

export function renderDappHeader(dapp: DappIdentity): string {
  const b = badge(dapp);
  const icon = dapp.iconUrl
    ? `<img class="dapp-icon" src="${escapeHtml(dapp.iconUrl)}" alt="" />`
    : '';
  return `
    <div class="dapp-header">
      ${icon}
      <div>
        <div class="dapp-name">${escapeHtml(dapp.name)}</div>
        <div class="dapp-url">${escapeHtml(dapp.url)}</div>
      </div>
      <span class="badge ${b.cls}">${escapeHtml(b.label)}</span>
    </div>`;
}

function renderWarning(w: CardWarning): string {
  return `<li class="warning ${w.severity}">${escapeHtml(w.text)}</li>`;
}

export function renderCard(card: RequestCard): string {
  const fields = card.fields
    .map(
      (f) =>
        `<div class="field"><span class="label">${escapeHtml(f.label)}</span>` +
        `<span class="value${f.mono ? ' mono' : ''}">${escapeHtml(f.value)}</span></div>`,
    )
    .join('');
  const warnings = card.warnings.length
    ? `<ul class="warnings">${card.warnings.map(renderWarning).join('')}</ul>`
    : '';
  return `
    <div class="card">
      <h3>${escapeHtml(card.title)}</h3>
      ${warnings}
      <div class="fields">${fields}</div>
      <details><summary>Raw request</summary><pre>${escapeHtml(card.raw)}</pre></details>
    </div>`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/ui`
Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add src/ui
git commit -m "feat: add confirmation registry and escaped HTML rendering"
```

---

### Task 14: App shell, composition root, and end-to-end verification

**Files:**
- Create: `src/ui/app.ts`, `src/ui/styles.css`
- Create: `src/bridge/architecture.test.ts`
- Create: `docs/manual-e2e-checklist.md`
- Modify: `src/main.ts` (replace the `export {};` placeholder from Task 1)
- Modify: `index.html` (add the stylesheet link)

**Interfaces:**
- Consumes: everything produced by Tasks 1–13.
- Produces: the running application. No exports other tasks depend on.

- [ ] **Step 1: Write the failing architecture test**

`src/bridge/architecture.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BANNED = ['@reown/walletkit', '@coinbase/wallet-sdk'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('bridge layer isolation', () => {
  it('never imports a wallet or dapp SDK client', () => {
    // The bridge depends on ports only. If this fails, the core logic has
    // become untestable without a network and the port abstraction is dead.
    const offenders = walk(join(process.cwd(), 'src/bridge'))
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => BANNED.some((pkg) => readFileSync(f, 'utf8').includes(pkg)));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npx vitest run src/bridge/architecture.test.ts`
Expected: PASS. (This test guards an invariant that already holds; if it fails now, a previous task imported an SDK into `src/bridge` and that must be fixed before continuing.)

- [ ] **Step 3: Create `src/ui/styles.css`**

```css
:root {
  --bg: #0f1115; --panel: #181b22; --line: #262b36;
  --fg: #e6e8ee; --muted: #98a0b3;
  --ok: #3fb950; --warn: #d29922; --danger: #f85149; --accent: #4f8cff;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
#app { max-width: 720px; margin: 0 auto; padding: 24px; }
h1 { font-size: 18px; }
section { background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 16px; margin-bottom: 16px; }
button { background: var(--accent); color: #fff; border: 0; border-radius: 8px;
  padding: 9px 14px; font-size: 14px; cursor: pointer; }
button.secondary { background: transparent; border: 1px solid var(--line); color: var(--fg); }
button.danger { background: var(--danger); }
button:disabled { opacity: .5; cursor: not-allowed; }
input { width: 100%; padding: 9px 12px; border-radius: 8px;
  border: 1px solid var(--line); background: #0b0d12; color: var(--fg); font-family: inherit; }
.mono, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.muted { color: var(--muted); }
.row { display: flex; gap: 8px; align-items: center; }
.dapp-header { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.dapp-icon { width: 32px; height: 32px; border-radius: 8px; }
.dapp-name { font-weight: 600; }
.dapp-url { color: var(--muted); font-size: 12px; }
.badge { margin-left: auto; padding: 3px 8px; border-radius: 999px; font-size: 11px; }
.badge.ok { background: rgba(63,185,80,.15); color: var(--ok); }
.badge.warn { background: rgba(210,153,34,.15); color: var(--warn); }
.badge.danger { background: rgba(248,81,73,.15); color: var(--danger); }
.warnings { list-style: none; padding: 0; margin: 0 0 12px; }
.warning { border-radius: 8px; padding: 9px 12px; margin-bottom: 6px; }
.warning.info { background: rgba(79,140,255,.12); }
.warning.warn { background: rgba(210,153,34,.12); color: #f0c674; }
.warning.danger { background: rgba(248,81,73,.14); color: #ff9b93; }
.field { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.field .label { color: var(--muted); min-width: 110px; }
.field .value { word-break: break-all; }
pre { white-space: pre-wrap; word-break: break-all; background: #0b0d12;
  padding: 10px; border-radius: 8px; }
dialog { background: var(--panel); color: var(--fg); border: 1px solid var(--line);
  border-radius: 12px; max-width: 560px; width: 92%; }
dialog::backdrop { background: rgba(0,0,0,.6); }
.banner { border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.banner.warn { background: rgba(210,153,34,.12); color: #f0c674; }
```

- [ ] **Step 4: Add the stylesheet to `index.html`**

Insert inside `<head>`, after the `<title>` line:
```html
    <link rel="stylesheet" href="/src/ui/styles.css" />
```

- [ ] **Step 5: Implement `src/ui/app.ts`**

```ts
import { renderCard, renderDappHeader } from './render';
import type { PendingConfirmations } from './pending';
import type { DappIdentity } from '../bridge/types';

export interface AppCallbacks {
  onConnect: () => void;
  onPair: (uri: string) => void;
  onDisconnect: (topic: string) => void;
}

export interface SessionRow {
  topic: string;
  dapp: DappIdentity;
}

export class AppUI {
  private root: HTMLElement;
  private dialog: HTMLDialogElement;

  constructor(private cb: AppCallbacks) {
    this.root = document.getElementById('app')!;
    this.root.innerHTML = `
      <h1>Coinbase ↔ WalletConnect Bridge</h1>
      <section id="wallet">
        <div class="row">
          <button id="connect">Connect Coinbase Wallet</button>
          <span id="wallet-status" class="muted">Not connected</span>
        </div>
        <div id="wallet-note"></div>
      </section>
      <section id="pair">
        <div class="row">
          <input id="uri" placeholder="Paste the dapp's wc:… URI here" disabled />
          <button id="pair-btn" disabled>Pair</button>
        </div>
        <p class="muted" id="pair-status">Connect your wallet first.</p>
      </section>
      <section id="sessions"><p class="muted">No active sessions.</p></section>
      <dialog id="approval"></dialog>`;

    this.dialog = this.root.querySelector('#approval') as HTMLDialogElement;
    this.root.querySelector('#connect')!.addEventListener('click', () => this.cb.onConnect());
    this.root.querySelector('#pair-btn')!.addEventListener('click', () => {
      const input = this.root.querySelector('#uri') as HTMLInputElement;
      const uri = input.value.trim();
      if (uri) {
        input.value = '';
        this.cb.onPair(uri);
      }
    });
  }

  setWallet(address: string, isSmartAccount: boolean): void {
    (this.root.querySelector('#wallet-status') as HTMLElement).textContent = address;
    (this.root.querySelector('#connect') as HTMLButtonElement).disabled = true;
    (this.root.querySelector('#uri') as HTMLInputElement).disabled = false;
    (this.root.querySelector('#pair-btn') as HTMLButtonElement).disabled = false;
    this.setPairStatus('');
    if (isSmartAccount) {
      (this.root.querySelector('#wallet-note') as HTMLElement).innerHTML =
        `<div class="banner warn">This is a smart account. Signatures are ERC-1271 contract
         signatures — dapps that verify with ecrecover (many sign-in flows) will reject them.</div>`;
    }
  }

  /** Persistent wallet-level notice (stale account, disconnected wallet). */
  setWalletWarning(text: string): void {
    (this.root.querySelector('#wallet-note') as HTMLElement).innerHTML = text
      ? `<div class="banner warn">${text}</div>`
      : '';
  }

  setPairStatus(text: string, isError = false): void {
    const el = this.root.querySelector('#pair-status') as HTMLElement;
    el.textContent = text;
    el.className = isError ? 'warning danger' : 'muted';
  }

  setSessions(rows: SessionRow[]): void {
    const el = this.root.querySelector('#sessions') as HTMLElement;
    if (rows.length === 0) {
      el.innerHTML = '<p class="muted">No active sessions.</p>';
      return;
    }
    el.innerHTML = rows
      .map(
        (r) =>
          `<div class="row" style="margin-bottom:8px">${renderDappHeader(r.dapp)}
           <button class="secondary" data-topic="${r.topic}">Disconnect</button></div>`,
      )
      .join('');
    el.querySelectorAll<HTMLButtonElement>('button[data-topic]').forEach((b) =>
      b.addEventListener('click', () => this.cb.onDisconnect(b.dataset.topic!)),
    );
  }

  /** Render the topmost pending request, or close the modal when the queue empties. */
  renderPending(pending: PendingConfirmations): void {
    const [entry] = pending.list();
    if (!entry) {
      if (this.dialog.open) this.dialog.close();
      return;
    }
    const unknown = entry.card.title.startsWith('Unrecognised');
    this.dialog.innerHTML = `
      ${renderDappHeader(entry.req.dapp)}
      ${renderCard(entry.card)}
      <div class="row" style="margin-top:16px; justify-content:flex-end">
        <button class="secondary" id="reject">Reject</button>
        <button id="approve">${unknown ? 'Forward once' : 'Approve'}</button>
      </div>`;
    this.dialog.querySelector('#approve')!.addEventListener('click', () => {
      pending.approve(entry.req.id);
      this.renderPending(pending);
    });
    this.dialog.querySelector('#reject')!.addEventListener('click', () => {
      pending.reject(entry.req.id);
      this.renderPending(pending);
    });
    if (!this.dialog.open) this.dialog.showModal();
  }
}
```

- [ ] **Step 6: Implement `src/main.ts`**

```ts
import './ui/styles.css';
import { AppUI, type SessionRow } from './ui/app';
import { PendingConfirmations } from './ui/pending';
import { connectWallet, type WalletConnection } from './cb/provider';
import { createDappPort, createWalletKit, toDappIdentity, toIncomingRequest } from './wc/walletkit';
import { decideProposal } from './bridge/namespaces';
import { handleRequest } from './bridge/router';
import { toCaipChainId } from './chains';
import { getSdkError } from '@walletconnect/utils';
import type { WalletKit } from '@reown/walletkit';

const pending = new PendingConfirmations();
let wallet: WalletConnection | null = null;
let kit: WalletKit | null = null;

const ui = new AppUI({
  onConnect: async () => {
    try {
      wallet = await connectWallet();
      ui.setWallet(wallet.address, wallet.isSmartAccount);
      kit = await start(wallet);
    } catch (err) {
      ui.setPairStatus(err instanceof Error ? err.message : String(err), true);
    }
  },
  onPair: async (uri) => {
    if (!kit) return;
    try {
      ui.setPairStatus('Pairing…');
      await kit.pair({ uri });
    } catch {
      ui.setPairStatus(
        'Could not pair with that URI. WalletConnect URIs are single-use and expire after a few minutes — refresh the dapp’s QR code and copy a fresh one.',
        true,
      );
    }
  },
  onDisconnect: async (topic) => {
    await kit?.disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') });
    refreshSessions();
  },
});

function refreshSessions(): void {
  if (!kit) return;
  const rows: SessionRow[] = Object.values(kit.getActiveSessions()).map((s) => ({
    topic: s.topic,
    dapp: toDappIdentity(s.peer.metadata, undefined),
  }));
  ui.setSessions(rows);
}

async function start(w: WalletConnection): Promise<WalletKit> {
  const instance = await createWalletKit(import.meta.env.VITE_REOWN_PROJECT_ID);
  const dapp = createDappPort(instance);

  instance.on('session_proposal', async (proposal) => {
    const decision = decideProposal(proposal.params, w.address);
    if (!decision.ok) {
      await instance.rejectSession({ id: proposal.id, reason: { code: 5000, message: decision.reason } });
      ui.setPairStatus(decision.reason, true);
      return;
    }
    await instance.approveSession({ id: proposal.id, namespaces: decision.namespaces });
    ui.setPairStatus('Connected.');
    refreshSessions();
  });

  instance.on('session_request', async (event) => {
    const session = instance.getActiveSessions()[event.topic];
    const req = toIncomingRequest(event, session.peer.metadata);
    ui.renderPending(pending);
    await handleRequest(req, {
      wallet: w.port,
      dapp,
      confirm: pending,
      isSmartAccount: () => w.isSmartAccount,
    });
    ui.renderPending(pending);
  });

  instance.on('session_request_expire', ({ id }) => {
    pending.expire(id);
    ui.renderPending(pending);
  });

  instance.on('session_delete', refreshSessions);

  // Fan wallet state changes out to every live session. Without this, dapps
  // keep displaying a stale address indefinitely.
  w.provider.on('accountsChanged', (accounts: string[]) => {
    const next = accounts[0];
    if (!next || !kit) return;
    let stale = false;
    for (const session of Object.values(kit.getActiveSessions())) {
      const approved = session.namespaces.eip155?.accounts ?? [];
      const isApproved = approved.some((a) => a.toLowerCase().endsWith(next.toLowerCase()));
      if (!isApproved) {
        // Emitting accountsChanged for an account the session never approved is
        // protocol-sketchy, so tell the user instead of lying to the dapp.
        stale = true;
        continue;
      }
      void kit.emitSessionEvent({
        topic: session.topic,
        event: { name: 'accountsChanged', data: [next] },
        chainId: approved[0].split(':').slice(0, 2).join(':'),
      });
    }
    ui.setWalletWarning(
      stale
        ? 'Your wallet switched to an account one or more connected dapps never approved. Disconnect and reconnect those dapps to use the new account.'
        : '',
    );
  });

  // A disconnected wallet makes in-flight requests throw; the router maps the
  // provider's 4900 through to the dapp. The banner is for the user.
  w.provider.on('disconnect', () => {
    ui.setWalletWarning('Coinbase Wallet disconnected. Reload the page to reconnect.');
  });

  w.provider.on('chainChanged', (hexChainId: string) => {
    if (!kit) return;
    const chainId = toCaipChainId(Number(hexChainId));
    for (const session of Object.values(kit.getActiveSessions())) {
      void kit.emitSessionEvent({
        topic: session.topic,
        event: { name: 'chainChanged', data: Number(hexChainId) },
        chainId,
      });
    }
  });

  refreshSessions();
  return instance;
}

window.addEventListener('beforeunload', (e) => {
  if (kit && Object.keys(kit.getActiveSessions()).length > 0) {
    e.preventDefault();
  }
});
```

- [ ] **Step 7: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: all tests PASS, no type errors, build succeeds.

Fix any type errors surfaced by the SDK types here rather than loosening `strict`.

- [ ] **Step 8: Write the manual verification checklist**

`docs/manual-e2e-checklist.md`:
```markdown
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
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: wire the app shell and composition root"
```

---

## Notes for the executor

- **Run `npm test` before every commit,** not just the task's own test file. A pure module is cheap to break from a neighbouring task.
- **The `finally` block in `router.ts` is not defensive clutter.** It is the only thing standing between a thrown exception and a dapp that spins forever. Do not "simplify" it away.
- **Do not add an ABI-decoding library** for Task 7. The seven selectors take static head-encoded arguments, so word slicing is exact, and keeping dependencies minimal is part of the point of an auditable bridge.
- **If a task's test count differs from the plan,** that is fine — the counts are guidance, not assertions. The listed behaviours all being covered is what matters.
