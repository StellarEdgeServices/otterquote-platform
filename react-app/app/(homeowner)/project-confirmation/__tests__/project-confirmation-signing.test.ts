/**
 * Unit tests for signing-utils.ts — D-211 Phase 26, PR 2/2.
 *
 * Covers: envelope request shape (no signer), return URL format/encoding,
 * formatCurrency, extractDepreciation, disclosure/banner text helpers,
 * resolveShingleManufacturerOption, and isStatusAllowed.
 */

import { describe, it, expect } from 'vitest';
import {
  PROJECT_CONFIRMATION_DOC_TYPE,
  STATUS_ALLOWED,
  isStatusAllowed,
  buildProjectConfirmationReturnUrl,
  buildProjectConfirmationEnvelopeRequest,
  formatCurrency,
  extractDepreciation,
  depreciationDisclosureAmountText,
  depreciationBannerText,
  deckingRateAckText,
  deckingRateBannerText,
  resolveShingleManufacturerOption,
} from '../signing-utils';

// ── buildProjectConfirmationEnvelopeRequest ────────────────────────────────────

describe('buildProjectConfirmationEnvelopeRequest', () => {
  const req = buildProjectConfirmationEnvelopeRequest({
    claimId: 'claim-123',
    contractorId: 'ctr-456',
    origin: 'https://app.otterquote.com',
  });

  it('has the correct document_type', () => {
    expect(req.document_type).toBe('project_confirmation');
    expect(req.document_type).toBe(PROJECT_CONFIRMATION_DOC_TYPE);
  });

  it('has NO signer field (D-220: EF derives signer server-side)', () => {
    expect(req).not.toHaveProperty('signer');
  });

  it('has the correct claim_id and contractor_id', () => {
    expect(req.claim_id).toBe('claim-123');
    expect(req.contractor_id).toBe('ctr-456');
  });

  it('includes return_url targeting the React project-confirmation route', () => {
    expect(req.return_url).toBe(
      'https://app.otterquote.com/project-confirmation?claim_id=claim-123&signed=true',
    );
  });
});

// ── buildProjectConfirmationReturnUrl ─────────────────────────────────────────

describe('buildProjectConfirmationReturnUrl', () => {
  it('builds the correct URL format', () => {
    expect(
      buildProjectConfirmationReturnUrl('https://app.otterquote.com', 'abc123'),
    ).toBe('https://app.otterquote.com/project-confirmation?claim_id=abc123&signed=true');
  });

  it('encodes special characters in claimId', () => {
    const url = buildProjectConfirmationReturnUrl('https://app.example.com', 'id with spaces');
    expect(url).toContain('claim_id=id%20with%20spaces');
  });

  it('does not double-encode a normal UUID', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const url = buildProjectConfirmationReturnUrl('http://localhost:3000', id);
    expect(url).toBe(`http://localhost:3000/project-confirmation?claim_id=${id}&signed=true`);
  });
});

// ── formatCurrency ─────────────────────────────────────────────────────────────

describe('formatCurrency', () => {
  it('null → "—"', () => expect(formatCurrency(null)).toBe('—'));
  it('undefined → "—"', () => expect(formatCurrency(undefined)).toBe('—'));
  it('"" → "—"', () => expect(formatCurrency('')).toBe('—'));
  it('NaN string → "—"', () => expect(formatCurrency('abc')).toBe('—'));

  it('formats 1234.5 → "$1,234.50"', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('formats 0 → "$0.00"', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('formats a large number with commas', () => {
    expect(formatCurrency(10000)).toBe('$10,000.00');
  });

  it('formats a string number', () => {
    expect(formatCurrency('500')).toBe('$500.00');
  });

  it('2 decimal places on exact integers', () => {
    expect(formatCurrency(42)).toBe('$42.00');
  });
});

// ── extractDepreciation ───────────────────────────────────────────────────────

describe('extractDepreciation', () => {
  it('returns null for null input', () => {
    expect(extractDepreciation(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(extractDepreciation(undefined)).toBeNull();
  });

  it('reads from summary.depreciation first', () => {
    expect(extractDepreciation({ summary: { depreciation: '1500.00' } })).toBe(1500);
  });

  it('falls back to top-level depreciation', () => {
    expect(extractDepreciation({ depreciation: 250 })).toBe(250);
  });

  it('summary.depreciation takes priority over top-level', () => {
    expect(extractDepreciation({ summary: { depreciation: 100 }, depreciation: 999 })).toBe(100);
  });

  it('returns null for NaN depreciation value', () => {
    expect(extractDepreciation({ summary: { depreciation: 'not-a-number' } })).toBeNull();
  });

  it('returns null when depreciation is null at both levels', () => {
    expect(extractDepreciation({ summary: {}, other: 'data' })).toBeNull();
  });

  it('parses string numbers correctly', () => {
    expect(extractDepreciation({ depreciation: '750.50' })).toBe(750.5);
  });

  // PARITY (static `||` chain, project-confirmation.html:2218-2220): a falsy value falls
  // through. A lone 0 → null (rendered as 'None / N/A' / '$___'); a 0 at summary level
  // falls through to a truthy top-level value.
  it('PARITY: a lone 0 depreciation resolves to null (|| chain, not ??)', () => {
    expect(extractDepreciation({ summary: { depreciation: 0 } })).toBeNull();
    expect(extractDepreciation({ depreciation: 0 })).toBeNull();
  });

  it('PARITY: 0 at summary level falls through to a truthy top-level depreciation', () => {
    expect(extractDepreciation({ summary: { depreciation: 0 }, depreciation: 999 })).toBe(999);
  });
});

// ── depreciationDisclosureAmountText ──────────────────────────────────────────

describe('depreciationDisclosureAmountText', () => {
  it('null → "$___" (copy.ts depreciationAmountDefault)', () => {
    expect(depreciationDisclosureAmountText(null)).toBe('$___');
  });

  it('number → formatted currency', () => {
    expect(depreciationDisclosureAmountText(1500)).toBe('$1,500.00');
  });

  it('0 → "$0.00" (not $___)', () => {
    expect(depreciationDisclosureAmountText(0)).toBe('$0.00');
  });
});

// ── depreciationBannerText ────────────────────────────────────────────────────

describe('depreciationBannerText', () => {
  it('null → "None / N/A" (different default vs disclosure)', () => {
    expect(depreciationBannerText(null)).toBe('None / N/A');
  });

  it('number → formatted currency', () => {
    expect(depreciationBannerText(2000)).toBe('$2,000.00');
  });
});

// ── deckingRateAckText ────────────────────────────────────────────────────────

describe('deckingRateAckText', () => {
  it('null → "per contractor quote" (default)', () => {
    expect(deckingRateAckText(null)).toBe('per contractor quote');
  });

  it('number → "$X.XX per sheet"', () => {
    expect(deckingRateAckText(75)).toBe('$75.00 per sheet');
  });

  it('decimal → formatted with " per sheet"', () => {
    expect(deckingRateAckText(87.5)).toBe('$87.50 per sheet');
  });
});

// ── deckingRateBannerText ─────────────────────────────────────────────────────

describe('deckingRateBannerText', () => {
  it('null → "—"', () => {
    expect(deckingRateBannerText(null)).toBe('—');
  });

  it('number → "$X.XX / sheet"', () => {
    expect(deckingRateBannerText(75)).toBe('$75.00 / sheet');
  });
});

// ── resolveShingleManufacturerOption ─────────────────────────────────────────

describe('resolveShingleManufacturerOption', () => {
  const OPTIONS = ['Owens Corning', 'GAF', 'CertainTeed', 'TAMKO', 'Atlas', 'IKO', 'Malarkey', 'Other'];

  it('exact match returns the canonical option value', () => {
    expect(resolveShingleManufacturerOption('GAF', OPTIONS)).toBe('GAF');
  });

  it('case-insensitive match — lowercase input', () => {
    expect(resolveShingleManufacturerOption('gaf', OPTIONS)).toBe('GAF');
  });

  it('case-insensitive match — mixed case', () => {
    expect(resolveShingleManufacturerOption('owens corning', OPTIONS)).toBe('Owens Corning');
  });

  it('case-insensitive match — all caps', () => {
    expect(resolveShingleManufacturerOption('CERTAINTEED', OPTIONS)).toBe('CertainTeed');
  });

  it('no match returns null', () => {
    expect(resolveShingleManufacturerOption('Unknown Brand', OPTIONS)).toBeNull();
  });

  it('null input returns null', () => {
    expect(resolveShingleManufacturerOption(null, OPTIONS)).toBeNull();
  });

  it('undefined input returns null', () => {
    expect(resolveShingleManufacturerOption(undefined, OPTIONS)).toBeNull();
  });

  it('empty string returns null', () => {
    expect(resolveShingleManufacturerOption('', OPTIONS)).toBeNull();
  });
});

// ── isStatusAllowed ───────────────────────────────────────────────────────────

describe('isStatusAllowed', () => {
  it('true for all allowed statuses', () => {
    for (const s of STATUS_ALLOWED) {
      expect(isStatusAllowed(s)).toBe(true);
    }
  });

  it('false for a non-allowed status', () => {
    expect(isStatusAllowed('pending')).toBe(false);
    expect(isStatusAllowed('open')).toBe(false);
  });

  it('false for null/undefined/empty', () => {
    expect(isStatusAllowed(null)).toBe(false);
    expect(isStatusAllowed(undefined)).toBe(false);
    expect(isStatusAllowed('')).toBe(false);
  });
});
