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

  it('omits the badge entirely when asked, keeping the origin', () => {
    // For session rows with no verify context: a permanently amber badge on
    // every row desensitises the user to the badge the approval card relies on.
    const html = renderDappHeader(dapp({ validation: 'UNKNOWN' }), false);
    expect(html).not.toMatch(/badge/);
    expect(html).not.toMatch(/Unverified/);
    expect(html).toContain('https://dapp.example');
    expect(html).toContain('Test Dapp');
  });

  it('still shows the badge by default, which is what the approval card needs', () => {
    expect(renderDappHeader(dapp())).toMatch(/badge/);
  });
});

describe('renderCard', () => {
  const card: RequestCard = {
    method: 'eth_sendTransaction',
    title: 'Transaction request',
    fields: [{ label: 'To', value: '0xabc', mono: true }],
    warnings: [{ severity: 'danger', text: 'UNLIMITED allowance' }],
    raw: '[{"to":"0xabc"}]',
    disposition: { kind: 'confirm' },
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
