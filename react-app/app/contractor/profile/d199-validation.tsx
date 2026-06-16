'use client';

/**
 * D-199 anchor-validation display + manual anchor-mapping modal.
 * Port of js/contract-template-validation.js (window.D199) — the per-slot validation
 * status the static contractor-profile.html attaches to each Contract Template cell.
 *
 * Edge Function contract UNCHANGED: calls validate-contract-template with body
 * { contractor_template_id, manualOverrides? } — identical to the static fetch, now via
 * the supabase singleton's functions.invoke (auth handled by the client). The EF is NOT
 * modified. contractor_templates reads/writes mirror the static module exactly.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { d199StatusLabel } from './copy';
import {
  tradeKey, fundingKey, validationCounts, missingAnchors, D199_FAIL_STATES,
  type D199Row, type D199Anchor,
} from './utils';

async function findValidationRow(contractorId: string, trade: string, fundingType: string): Promise<D199Row | null> {
  try {
    const { data, error } = await supabase
      .from('contractor_templates')
      .select('*')
      .eq('contractor_id', contractorId)
      .eq('trade', tradeKey(trade))
      .eq('funding_type', fundingKey(fundingType))
      .maybeSingle();
    if (error) { console.warn('[D-199] findValidationRow error:', error); return null; }
    return (data as D199Row) ?? null;
  } catch (e) {
    console.warn('[D-199] findValidationRow threw:', e);
    return null;
  }
}

async function upsertValidationRow(contractorId: string, trade: string, fundingType: string, storagePath: string): Promise<D199Row | null> {
  try {
    const { data, error } = await supabase
      .from('contractor_templates')
      .upsert(
        {
          contractor_id: contractorId,
          trade: tradeKey(trade),
          funding_type: fundingKey(fundingType),
          pdf_storage_path: storagePath,
          status: 'pending_validation',
          validation_result: null,
          manual_overrides: null,
        },
        { onConflict: 'contractor_id,trade,funding_type' },
      )
      .select('*')
      .single();
    if (error) { console.error('[D-199] upsertValidationRow error:', error); return null; }
    return (data as D199Row) ?? null;
  } catch (e) {
    console.error('[D-199] upsertValidationRow threw:', e);
    return null;
  }
}

/** Call validate-contract-template. Body shape identical to the static fetch; EF unchanged. */
async function callValidate(contractorTemplateId: string, manualOverrides?: Record<string, string>): Promise<{ validation_result?: unknown; status?: string; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('validate-contract-template', {
      body: { contractor_template_id: contractorTemplateId, manualOverrides: manualOverrides || undefined },
    });
    if (error) return { error: error.message };
    return (data as { validation_result?: unknown; status?: string }) ?? {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function D199Validation({ contractorId, trade, fundingType, storagePath }: {
  contractorId: string; trade: string; fundingType: string; storagePath: string;
}) {
  const [row, setRow] = useState<D199Row | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!contractorId || !trade || !fundingType) return;
    let r = await findValidationRow(contractorId, trade, fundingType);
    if (!r && storagePath) {
      r = await upsertValidationRow(contractorId, trade, fundingType, storagePath);
      if (r && r.id) {
        const result = await callValidate(r.id);
        if (result && result.validation_result) {
          r = { ...r, validation_result: result.validation_result as D199Row['validation_result'], status: result.status ?? r.status };
        }
      }
    }
    setRow(r);
  }, [contractorId, trade, fundingType, storagePath]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!row) return null;

  const info = d199StatusLabel(row.status);
  const counts = validationCounts(row.validation_result);
  const anchors: D199Anchor[] = Array.isArray(row.validation_result?.anchors) ? row.validation_result!.anchors! : [];
  const showActions = D199_FAIL_STATES.includes(row.status);

  async function requestAdminReview() {
    if (!row?.id) return;
    if (!window.confirm('Submit this template for admin review? You will be notified once Otter Quotes has reviewed it.')) return;
    try {
      const { data, error } = await supabase
        .from('contractor_templates')
        .update({ status: 'submitted_for_admin_review' })
        .eq('id', row.id)
        .select('*')
        .single();
      if (error) throw error;
      if (data) setRow(data as D199Row);
    } catch (e) {
      alert('Could not submit for admin review: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <div className={'oqp-val ' + info.cls}>
      <div className="oqp-val-row">
        <span className="oqp-val-icon" aria-hidden="true">{info.icon}</span>
        <span>{info.label}</span>
        {counts && <span> — {counts.found} / {counts.total} anchors found</span>}
        {counts && anchors.length > 0 && (
          <button type="button" className="oqp-val-toggle" onClick={() => setDetailsOpen((v) => !v)}>
            {detailsOpen ? 'Hide details' : 'Show details'}
          </button>
        )}
      </div>

      {detailsOpen && anchors.length > 0 && (
        <div className="oqp-val-anchors">
          <div className="oqp-val-anchors-head">Required anchor strings — {counts?.found} / {counts?.total} found:</div>
          {anchors.map((a, i) => (
            <span key={`${a.anchor}-${i}`} className={'oqp-anchor ' + (a.found ? 'found' : 'missing')} title={a.field + (a.manualOverride ? ' (mapped manually)' : '')}>
              {(a.found ? '✓ ' : '✗ ') + a.anchor}
            </span>
          ))}
        </div>
      )}

      {showActions && (
        <div className="oqp-val-actions">
          <button type="button" className="oqp-btn-sm oqp-btn-sm-primary" onClick={() => setMappingOpen(true)}>Map anchors manually</button>
          <button type="button" className="oqp-btn-sm oqp-btn-sm-amber" onClick={requestAdminReview}>Request admin review</button>
        </div>
      )}

      {mappingOpen && row.id && (
        <ManualMappingModal
          row={row}
          onClose={() => setMappingOpen(false)}
          onResolved={(updated) => { setRow(updated); setMappingOpen(false); }}
        />
      )}
    </div>
  );
}

function ManualMappingModal({ row, onClose, onResolved }: {
  row: D199Row; onClose: () => void; onResolved: (r: D199Row) => void;
}) {
  const missing = missingAnchors(row.validation_result);
  const total = row.validation_result?.requiredCount ?? missing.length;
  const [choices, setChoices] = useState<Record<string, { choice: 'have' | 'missing' | null; value: string }>>(
    () => Object.fromEntries(missing.map((a) => [a.anchor, { choice: null, value: '' }])),
  );
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (missing.length === 0) return null;

  function setChoice(anchor: string, choice: 'have' | 'missing') {
    setChoices((c) => ({ ...c, [anchor]: { ...c[anchor], choice } }));
  }
  function setValue(anchor: string, value: string) {
    setChoices((c) => ({ ...c, [anchor]: { ...c[anchor], value } }));
  }

  async function submit() {
    setErr('');
    const states = Object.entries(choices);
    if (states.some(([, s]) => s.choice === null)) {
      setErr(`Please make a choice for each field before submitting (${states.filter(([, s]) => s.choice === null).length} remaining).`);
      return;
    }
    if (states.some(([, s]) => s.choice === 'have' && !s.value.trim())) {
      setErr('Please type the actual label for each "My PDF has this" entry.');
      return;
    }
    setBusy(true);
    const overrides: Record<string, string> = {};
    const missingFields: string[] = [];
    for (const [anchor, s] of states) {
      if (s.choice === 'have') overrides[anchor] = s.value.trim();
      else if (s.choice === 'missing') missingFields.push(anchor);
    }
    try {
      if (missingFields.length > 0) {
        const { error: persistErr } = await supabase
          .from('contractor_templates')
          .update({ manual_overrides: { ...overrides, _missing_fields: missingFields }, status: 'submitted_for_admin_review' })
          .eq('id', row.id!);
        if (persistErr) throw persistErr;
        const { data: refreshed } = await supabase.from('contractor_templates').select('*').eq('id', row.id!).single();
        alert('Submitted for admin review. We will notify you once a member of the Otter Quotes team has looked at your template.');
        onResolved((refreshed as D199Row) ?? row);
        return;
      }
      const result = await callValidate(row.id!, overrides);
      if (result.error) { setErr('Validation error: ' + result.error); setBusy(false); return; }
      const { data: refreshed } = await supabase.from('contractor_templates').select('*').eq('id', row.id!).single();
      if (result.status === 'manual_validated') alert('Validated. Your template now passes all required anchors and is ready for use on bids.');
      else if (result.status === 'manual_mapping_pending') alert('Some labels you provided still could not be matched in your PDF. Please double-check spelling and capitalization, or use "Request admin review" if you need help.');
      onResolved((refreshed as D199Row) ?? row);
    } catch (e) {
      setErr('Submission failed: ' + (e instanceof Error ? e.message : String(e)));
      setBusy(false);
    }
  }

  return (
    <div className="oqp-modal-backdrop" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="oqp-modal oqp-modal-wide">
        <div className="oqp-modal-head">
          <div>
            <h3>Map missing fields in your PDF</h3>
            <p>For each field below, tell us the exact label you used in your PDF, or confirm your PDF does not contain it. We will re-validate against your input.</p>
          </div>
          <button type="button" className="oqp-modal-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="oqp-modal-body">
          <div className="oqp-modal-summary">{missing.length} of {total} required anchors were not found in your uploaded PDF. Map each one below.</div>
          {missing.map((a) => {
            const st = choices[a.anchor];
            return (
              <div key={a.anchor} className={'oqp-anchor-row' + (st.choice === 'have' ? ' choice-have' : st.choice === 'missing' ? ' choice-missing' : '')}>
                <div><strong>Expected anchor:</strong> <code>{a.anchor}</code></div>
                <div className="oqp-anchor-field">{a.field}{a.source ? ' · ' + a.source : ''}</div>
                <div className="oqp-anchor-choices">
                  <button type="button" className={'oqp-choice' + (st.choice === 'have' ? ' active' : '')} onClick={() => setChoice(a.anchor, 'have')}>My PDF has this (different label)</button>
                  <button type="button" className={'oqp-choice missing' + (st.choice === 'missing' ? ' active' : '')} onClick={() => setChoice(a.anchor, 'missing')}>My PDF does not have this field</button>
                </div>
                {st.choice === 'have' && (
                  <div className="oqp-anchor-input">
                    <label>Type the exact label/text from your PDF for this field:</label>
                    <input type="text" value={st.value} placeholder={'e.g., ' + a.anchor.replace(/[/]/g, '')} onChange={(e) => setValue(a.anchor, e.target.value)} />
                    <small>Case-sensitive. Match the text exactly as it appears in your PDF.</small>
                  </div>
                )}
              </div>
            );
          })}
          {err && <div className="oqp-modal-err">{err}</div>}
        </div>
        <div className="oqp-modal-foot">
          <button type="button" className="oqp-btn-sm oqp-btn-sm-amber" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="oqp-btn-sm oqp-btn-sm-primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit for re-validation'}</button>
        </div>
      </div>
    </div>
  );
}
