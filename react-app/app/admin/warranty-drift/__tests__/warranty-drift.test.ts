/**
 * Unit + parity tests for Admin Warranty Manifest Drift pure logic (D-211 Phase 10).
 *
 * Pins DRIFT_FILTERS, changeTypeBadgeClass, changeTypeLabel, statusBadgeClass,
 * statusLabel, formatDate, lastRunLabel, runStatusColor, runIdShort,
 * itemsDetectedLabel, isSafeHttpUrl, buildDiff, isRejectReasonValid,
 * isApproveEditSkip, buildProposedValue, approvePayload, approveWithChangesPayload,
 * rejectPayload, and skipPayload against admin-warranty-drift.html @ main behavior.
 *
 * No network / supabase calls — all helpers are side-effect-free.
 */

import { describe, it, expect } from 'vitest';
import {
  type DriftRow,
  type CronMetadata,
  DRIFT_FILTERS,
  changeTypeBadgeClass,
  changeTypeLabel,
  statusBadgeClass,
  statusLabel,
  formatDate,
  lastRunLabel,
  runStatusColor,
  runIdShort,
  itemsDetectedLabel,
  isSafeHttpUrl,
  buildDiff,
  isRejectReasonValid,
  isApproveEditSkip,
  buildProposedValue,
  approvePayload,
  approveWithChangesPayload,
  rejectPayload,
  skipPayload,
} from '../utils';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function mkRow(over: Partial<DriftRow> = {}): DriftRow {
  return {
    id: over.id ?? 'd-1',
    manufacturer: over.manufacturer ?? 'GAF',
    tier: over.tier ?? 'Premium',
    change_type: over.change_type ?? 'modified',
    status: over.status ?? 'pending_review',
    ...over,
  };
}

// ── DRIFT_FILTERS ─────────────────────────────────────────────────────────────

describe('DRIFT_FILTERS', () => {
  it('exposes exactly 5 keys in the correct order', () => {
    expect(DRIFT_FILTERS.map((f) => f.key)).toEqual([
      'pending_review',
      'applied',
      'rejected',
      'skipped',
      'all',
    ]);
  });

  it('has correct labels for each key', () => {
    const labels = Object.fromEntries(DRIFT_FILTERS.map((f) => [f.key, f.label]));
    expect(labels['pending_review']).toBe('Pending Review');
    expect(labels['applied']).toBe('Applied');
    expect(labels['rejected']).toBe('Rejected');
    expect(labels['skipped']).toBe('Skipped');
    expect(labels['all']).toBe('All');
  });
});

// ── changeTypeBadgeClass ──────────────────────────────────────────────────────

describe('changeTypeBadgeClass', () => {
  it('"no_source" → "badge-no-source"', () => {
    expect(changeTypeBadgeClass('no_source')).toBe('badge-no-source');
  });

  it('"modified" → "badge-modified"', () => {
    expect(changeTypeBadgeClass('modified')).toBe('badge-modified');
  });

  it('"deprecated" → "badge-deprecated"', () => {
    expect(changeTypeBadgeClass('deprecated')).toBe('badge-deprecated');
  });

  it('"added" → "badge-added"', () => {
    expect(changeTypeBadgeClass('added')).toBe('badge-added');
  });

  it('unknown type prefixed with "badge-"', () => {
    expect(changeTypeBadgeClass('unknown_type')).toBe('badge-unknown-type');
  });
});

// ── changeTypeLabel ───────────────────────────────────────────────────────────

describe('changeTypeLabel', () => {
  it('"no_source" → "Manual Review"', () => {
    expect(changeTypeLabel('no_source')).toBe('Manual Review');
  });

  it('"modified" → "Modified"', () => {
    expect(changeTypeLabel('modified')).toBe('Modified');
  });

  it('"deprecated" → "Deprecated"', () => {
    expect(changeTypeLabel('deprecated')).toBe('Deprecated');
  });

  it('"added" → "Added"', () => {
    expect(changeTypeLabel('added')).toBe('Added');
  });

  it('unknown type returns the raw value', () => {
    expect(changeTypeLabel('weird_type')).toBe('weird_type');
  });
});

// ── statusBadgeClass ──────────────────────────────────────────────────────────

describe('statusBadgeClass', () => {
  it('"pending_review" → "badge-pending"', () => {
    expect(statusBadgeClass('pending_review')).toBe('badge-pending');
  });

  it('"applied" → "badge-applied"', () => {
    expect(statusBadgeClass('applied')).toBe('badge-applied');
  });

  it('"rejected" → "badge-rejected"', () => {
    expect(statusBadgeClass('rejected')).toBe('badge-rejected');
  });

  it('"skipped" → "badge-skipped"', () => {
    expect(statusBadgeClass('skipped')).toBe('badge-skipped');
  });

  it('"approved" edge case → "badge-approved"', () => {
    expect(statusBadgeClass('approved')).toBe('badge-approved');
  });
});

// ── statusLabel ───────────────────────────────────────────────────────────────

describe('statusLabel', () => {
  it('"pending_review" → "pending review"', () => {
    // Only first underscore replaced (String.replace without /g)
    expect(statusLabel('pending_review')).toBe('pending review');
  });

  it('"applied" → "applied"', () => {
    expect(statusLabel('applied')).toBe('applied');
  });

  it('"rejected" → "rejected"', () => {
    expect(statusLabel('rejected')).toBe('rejected');
  });

  it('"skipped" → "skipped"', () => {
    expect(statusLabel('skipped')).toBe('skipped');
  });
});

// ── formatDate ────────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('null → "—"', () => {
    expect(formatDate(null)).toBe('—');
  });

  it('undefined → "—"', () => {
    expect(formatDate(undefined)).toBe('—');
  });

  it('empty string → "—"', () => {
    expect(formatDate('')).toBe('—');
  });

  it('a valid ISO → same as calling toLocaleDateString en-US short (avoids TZ flakiness)', () => {
    const iso = '2026-06-17T12:00:00Z';
    // Assert against the same call to avoid TZ-dependent hardcoded expectations
    const expected = new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    expect(formatDate(iso)).toBe(expected);
  });
});

// ── lastRunLabel ──────────────────────────────────────────────────────────────

describe('lastRunLabel', () => {
  it('null → "Never"', () => {
    expect(lastRunLabel(null)).toBe('Never');
  });

  it('undefined → "Never"', () => {
    expect(lastRunLabel(undefined)).toBe('Never');
  });

  it('a valid ISO → formatDate(iso)', () => {
    const iso = '2026-04-01T00:00:00Z';
    expect(lastRunLabel(iso)).toBe(formatDate(iso));
  });
});

// ── runStatusColor ────────────────────────────────────────────────────────────

describe('runStatusColor', () => {
  it('"success" → "#10B981"', () => {
    expect(runStatusColor('success')).toBe('#10B981');
  });

  it('"skipped_dedup" → "#94A3B8"', () => {
    expect(runStatusColor('skipped_dedup')).toBe('#94A3B8');
  });

  it('"failed" → "#EF4444"', () => {
    expect(runStatusColor('failed')).toBe('#EF4444');
  });

  it('unknown status → "#EF4444"', () => {
    expect(runStatusColor('unknown')).toBe('#EF4444');
  });
});

// ── runIdShort ────────────────────────────────────────────────────────────────

describe('runIdShort', () => {
  it('no metadata → ""', () => {
    expect(runIdShort(null)).toBe('');
    expect(runIdShort(undefined)).toBe('');
  });

  it('metadata without run_id → ""', () => {
    expect(runIdShort({})).toBe('');
  });

  it('run_id present → first 8 chars + "…"', () => {
    const meta: CronMetadata = { run_id: 'abcdef1234567890' };
    expect(runIdShort(meta)).toBe('abcdef12…');
  });

  it('run_id exactly 8 chars → all 8 + "…"', () => {
    const meta: CronMetadata = { run_id: '12345678' };
    expect(runIdShort(meta)).toBe('12345678…');
  });
});

// ── itemsDetectedLabel ────────────────────────────────────────────────────────

describe('itemsDetectedLabel', () => {
  it('null / undefined → ""', () => {
    expect(itemsDetectedLabel(null)).toBe('');
    expect(itemsDetectedLabel(undefined)).toBe('');
  });

  it('metadata without items_detected → ""', () => {
    expect(itemsDetectedLabel({})).toBe('');
  });

  it('items_detected = 0 → "0 item(s)"', () => {
    expect(itemsDetectedLabel({ items_detected: 0 })).toBe('0 item(s)');
  });

  it('items_detected = 3 → "3 item(s)"', () => {
    expect(itemsDetectedLabel({ items_detected: 3 })).toBe('3 item(s)');
  });
});

// ── isSafeHttpUrl ─────────────────────────────────────────────────────────────

describe('isSafeHttpUrl', () => {
  it('"https://example.com" → true', () => {
    expect(isSafeHttpUrl('https://example.com')).toBe(true);
  });

  it('"http://example.com" → true', () => {
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
  });

  it('"HTTPS://EXAMPLE.COM" (uppercase) → true', () => {
    expect(isSafeHttpUrl('HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it('"javascript:alert(1)" → false', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('"relative/path" → false', () => {
    expect(isSafeHttpUrl('relative/path')).toBe(false);
  });

  it('empty string → false', () => {
    expect(isSafeHttpUrl('')).toBe(false);
  });

  it('null → false', () => {
    expect(isSafeHttpUrl(null)).toBe(false);
  });

  it('undefined → false', () => {
    expect(isSafeHttpUrl(undefined)).toBe(false);
  });
});

// ── buildDiff ─────────────────────────────────────────────────────────────────

describe('buildDiff', () => {
  describe('no_source', () => {
    it('extracts tiers from current_value.tiers using tier field', () => {
      const row = mkRow({
        change_type: 'no_source',
        current_value: {
          tiers: [
            { tier: 'Silver', display_string: 'Silver Program' },
            { tier: 'Gold' },
          ],
        },
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('no_source');
      if (diff.kind === 'no_source') {
        expect(diff.tiers).toEqual(['Silver', 'Gold']);
      }
    });

    it('falls back to display_string when tier is missing', () => {
      const row = mkRow({
        change_type: 'no_source',
        current_value: {
          tiers: [{ display_string: 'Fallback Program' }],
        },
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('no_source');
      if (diff.kind === 'no_source') {
        expect(diff.tiers).toEqual(['Fallback Program']);
      }
    });

    it('empty tiers array when current_value has no tiers', () => {
      const row = mkRow({
        change_type: 'no_source',
        current_value: {},
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('no_source');
      if (diff.kind === 'no_source') {
        expect(diff.tiers).toEqual([]);
      }
    });
  });

  describe('deprecated', () => {
    it('uses display_string as current', () => {
      const row = mkRow({
        change_type: 'deprecated',
        current_value: { display_string: 'Old Program Name', program_name: 'PN' },
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('deprecated');
      if (diff.kind === 'deprecated') {
        expect(diff.current).toBe('Old Program Name');
      }
    });

    it('falls back to program_name when display_string missing', () => {
      const row = mkRow({
        change_type: 'deprecated',
        current_value: { program_name: 'Backup Name' },
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('deprecated');
      if (diff.kind === 'deprecated') {
        expect(diff.current).toBe('Backup Name');
      }
    });

    it('falls back to "Program" when both missing', () => {
      const row = mkRow({
        change_type: 'deprecated',
        current_value: {},
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('deprecated');
      if (diff.kind === 'deprecated') {
        expect(diff.current).toBe('Program');
      }
    });
  });

  describe('modified', () => {
    it('with proposed_value → kind:modified with current/proposed', () => {
      const row = mkRow({
        change_type: 'modified',
        current_value: { display_string: 'Old String' },
        proposed_value: { display_string: 'New String' },
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('modified');
      if (diff.kind === 'modified') {
        expect(diff.current).toBe('Old String');
        expect(diff.proposed).toBe('New String');
      }
    });

    it('falls back to JSON.stringify when display_string missing in current', () => {
      const cur = { program_name: 'PName' };
      const row = mkRow({
        change_type: 'modified',
        current_value: cur,
        proposed_value: { display_string: 'New' },
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('modified');
      if (diff.kind === 'modified') {
        expect(diff.current).toBe(JSON.stringify(cur));
      }
    });

    it('falls back to JSON.stringify for proposed when display_string missing', () => {
      const prop = { program_name: 'PNew' };
      const row = mkRow({
        change_type: 'modified',
        current_value: { display_string: 'Old' },
        proposed_value: prop,
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('modified');
      if (diff.kind === 'modified') {
        expect(diff.proposed).toBe(JSON.stringify(prop));
      }
    });

    it('WITHOUT proposed_value → kind:none', () => {
      const row = mkRow({
        change_type: 'modified',
        current_value: { display_string: 'Old' },
        proposed_value: null,
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('none');
    });
  });

  describe('added', () => {
    it('uses proposed display_string', () => {
      const row = mkRow({
        change_type: 'added',
        proposed_value: { display_string: 'Brand New Program' },
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('added');
      if (diff.kind === 'added') {
        expect(diff.proposed).toBe('Brand New Program');
      }
    });

    it('falls back to JSON.stringify when display_string missing', () => {
      const prop = { program_name: 'P2' };
      const row = mkRow({
        change_type: 'added',
        proposed_value: prop,
      });
      const diff = buildDiff(row);
      expect(diff.kind).toBe('added');
      if (diff.kind === 'added') {
        expect(diff.proposed).toBe(JSON.stringify(prop));
      }
    });
  });

  describe('unknown change_type', () => {
    it('returns kind:none', () => {
      const row = mkRow({ change_type: 'some_future_type' });
      expect(buildDiff(row).kind).toBe('none');
    });
  });
});

// ── isRejectReasonValid ───────────────────────────────────────────────────────

describe('isRejectReasonValid', () => {
  it('empty string → false', () => {
    expect(isRejectReasonValid('')).toBe(false);
  });

  it('"   " (whitespace only) → false', () => {
    expect(isRejectReasonValid('   ')).toBe(false);
  });

  it('"x" (single char) → true', () => {
    expect(isRejectReasonValid('x')).toBe(true);
  });

  it('"a reason" → true', () => {
    expect(isRejectReasonValid('a reason')).toBe(true);
  });

  it('null → false', () => {
    expect(isRejectReasonValid(null)).toBe(false);
  });

  it('undefined → false', () => {
    expect(isRejectReasonValid(undefined)).toBe(false);
  });
});

// ── isApproveEditSkip ─────────────────────────────────────────────────────────

describe('isApproveEditSkip', () => {
  it('both empty → true', () => {
    expect(isApproveEditSkip('', '')).toBe(true);
  });

  it('both whitespace-only → true', () => {
    expect(isApproveEditSkip('   ', '\t')).toBe(true);
  });

  it('displayString filled → false', () => {
    expect(isApproveEditSkip('New Name', '')).toBe(false);
  });

  it('programName filled → false', () => {
    expect(isApproveEditSkip('', 'Prog Name')).toBe(false);
  });

  it('both filled → false', () => {
    expect(isApproveEditSkip('New Name', 'Prog Name')).toBe(false);
  });
});

// ── buildProposedValue ────────────────────────────────────────────────────────

describe('buildProposedValue', () => {
  it('only displayString → { display_string }', () => {
    expect(buildProposedValue('Display A', '')).toEqual({ display_string: 'Display A' });
  });

  it('only programName → { program_name }', () => {
    expect(buildProposedValue('', 'Program B')).toEqual({ program_name: 'Program B' });
  });

  it('both → both keys', () => {
    expect(buildProposedValue('Display A', 'Program B')).toEqual({
      display_string: 'Display A',
      program_name: 'Program B',
    });
  });

  it('both empty → {}', () => {
    expect(buildProposedValue('', '')).toEqual({});
  });

  it('values are trimmed', () => {
    expect(buildProposedValue('  Trimmed  ', '  PN  ')).toEqual({
      display_string: 'Trimmed',
      program_name: 'PN',
    });
  });

  it('whitespace-only values are excluded', () => {
    expect(buildProposedValue('   ', 'Good')).toEqual({ program_name: 'Good' });
  });
});

// ── approvePayload ────────────────────────────────────────────────────────────

describe('approvePayload', () => {
  it('returns exactly { drift_id: "d-123" }', () => {
    expect(approvePayload('d-123')).toEqual({ drift_id: 'd-123' });
  });
});

// ── approveWithChangesPayload ─────────────────────────────────────────────────

describe('approveWithChangesPayload', () => {
  it('returns drift_id + proposed_value with display_string', () => {
    expect(approveWithChangesPayload('d-1', 'New Display', '')).toEqual({
      drift_id: 'd-1',
      proposed_value: { display_string: 'New Display' },
    });
  });

  it('both strings included', () => {
    expect(approveWithChangesPayload('d-2', 'DS', 'PN')).toEqual({
      drift_id: 'd-2',
      proposed_value: { display_string: 'DS', program_name: 'PN' },
    });
  });
});

// ── rejectPayload ─────────────────────────────────────────────────────────────

describe('rejectPayload', () => {
  it('returns exactly { drift_id, action: "reject", rejection_reason }', () => {
    expect(rejectPayload('d-1', 'not valid')).toEqual({
      drift_id: 'd-1',
      action: 'reject',
      rejection_reason: 'not valid',
    });
  });
});

// ── skipPayload ───────────────────────────────────────────────────────────────

describe('skipPayload', () => {
  it('returns exactly { drift_id, action: "skip" }', () => {
    expect(skipPayload('d-5')).toEqual({ drift_id: 'd-5', action: 'skip' });
  });
});
