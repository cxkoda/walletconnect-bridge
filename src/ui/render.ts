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
