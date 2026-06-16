'use client';

/**
 * Contract Templates card (IMP-009) — port of loadContractTemplates / uploadTemplateFile /
 * viewContractTemplate / the Review-Field-Mapping modal in contractor-profile.html.
 *
 * 8 slots (trade × funding) backed by contractors.contract_templates (JSONB array).
 * Storage + signed-URL contracts UNCHANGED (contractor-templates bucket). Each uploaded
 * slot shows its D-199 anchor-validation status (see d199-validation.tsx). All DB-sourced
 * strings render as React text (the static page hand-built DOM for XSS safety; JSX is safe
 * by construction).
 */

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { PROFILE_COPY as T, AUTOFILL_FIELDS, DEFAULT_FIELD_MAPPINGS } from './copy';
import {
  CONTRACT_TEMPLATE_SLOTS, contractTemplatePath, findContractTemplate, upsertContractTemplate,
  setContractFieldMappings, storagePathFromValue, validatePdfUpload, initialFieldMappingValues,
  collectFieldMappings, type ContractTemplate,
} from './utils';
import { D199Validation } from './d199-validation';

export function ContractTemplates({ contractorId, initialTemplates }: {
  contractorId: string; initialTemplates: ContractTemplate[];
}) {
  const [templates, setTemplates] = useState<ContractTemplate[]>(initialTemplates ?? []);
  const [mappingSlot, setMappingSlot] = useState<{ trade: string; fundingType: string } | null>(null);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pending = useRef<{ trade: string; fundingType: string } | null>(null);

  async function reload() {
    const { data } = await supabase.from('contractors').select('contract_templates').eq('id', contractorId).single();
    setTemplates(((data?.contract_templates as ContractTemplate[]) ?? []));
  }

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [contractorId]);

  function pickFile(trade: string, fundingType: string) {
    pending.current = { trade, fundingType };
    fileRef.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const slot = pending.current;
    e.target.value = '';
    if (!file || !slot) return;
    const err = validatePdfUpload(file);
    if (err) { alert(err); return; }
    const key = `${slot.trade}/${slot.fundingType}`;
    setBusySlot(key);
    try {
      const filePath = contractTemplatePath(contractorId, slot.trade, slot.fundingType, Date.now());
      const { error: upErr } = await supabase.storage.from('contractor-templates').upload(filePath, file, { contentType: 'application/pdf' });
      if (upErr) throw upErr;
      const updated = upsertContractTemplate(templates, slot.trade, slot.fundingType, filePath, file.name, new Date().toISOString());
      const { error: dbErr } = await supabase.from('contractors').update({ contract_templates: updated, updated_at: new Date().toISOString() }).eq('id', contractorId);
      if (dbErr) throw dbErr;
      setTemplates(updated);
      setMappingSlot({ trade: slot.trade, fundingType: slot.fundingType });
    } catch (err2) {
      console.error('Error uploading template:', err2);
      alert(T.contractTemplates.uploadFailed);
    } finally {
      setBusySlot(null);
    }
  }

  async function view(fileUrl: string) {
    if (!fileUrl) { alert('No file URL available for this template.'); return; }
    try {
      const path = storagePathFromValue(fileUrl, 'contractor-templates');
      const { data, error } = await supabase.storage.from('contractor-templates').createSignedUrl(path, 3600);
      if (error || !data?.signedUrl) { console.error('Signed URL generation failed:', error); alert(T.contractTemplates.viewError); return; }
      window.open(data.signedUrl, '_blank');
    } catch (err) {
      console.error('viewContractTemplate error:', err);
      alert('Unable to open template. Please try again.');
    }
  }

  return (
    <section className="oqp-card" id="contract-templates">
      <h2 className="oqp-card-title"><span aria-hidden="true">📑</span>{T.contractTemplates.title}</h2>
      <div className="oqp-info-box">{T.contractTemplates.intro}</div>

      <div className="oqp-autofill">
        <h3>{T.contractTemplates.autofillHeading}</h3>
        <p>{T.contractTemplates.autofillIntro}</p>
        <div className="oqp-autofill-grid">
          {AUTOFILL_FIELDS.map((f) => (
            <div key={f.label}><strong>{f.label}</strong> → {f.maps}</div>
          ))}
        </div>
        <p className="oqp-help">{T.contractTemplates.autofillTip}</p>
      </div>

      <input ref={fileRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={onFile} />

      <div className="oqp-template-grid">
        {CONTRACT_TEMPLATE_SLOTS.map((slot) => {
          const key = `${slot.trade}/${slot.fundingType}`;
          const tpl = findContractTemplate(templates, slot.trade, slot.fundingType);
          const busy = busySlot === key;
          return (
            <div key={key} className="oqp-slot">
              <div className="oqp-slot-head">{slot.trade} — {slot.fundingType}</div>
              {tpl ? (
                <>
                  <div className="oqp-slot-file">
                    <div className="oqp-slot-file-name">{tpl.file_name || 'template.pdf'}</div>
                    <div className="oqp-slot-file-date">{T.contractTemplates.uploadedPrefix}{tpl.uploaded_at ? new Date(tpl.uploaded_at).toLocaleDateString() : 'Unknown date'}</div>
                  </div>
                  <div className="oqp-slot-btns">
                    <button type="button" className="oqp-btn-sm oqp-btn-sm-primary" onClick={() => view(String(tpl.file_url))}>{T.contractTemplates.view}</button>
                    <button type="button" className="oqp-btn-sm oqp-btn-sm-secondary" onClick={() => setMappingSlot({ trade: slot.trade, fundingType: slot.fundingType })}>{T.contractTemplates.reviewMapping}</button>
                    <button type="button" className="oqp-btn-sm oqp-btn-sm-secondary" disabled={busy} onClick={() => pickFile(slot.trade, slot.fundingType)}>{T.contractTemplates.replace}</button>
                  </div>
                  <D199Validation contractorId={contractorId} trade={slot.trade} fundingType={slot.fundingType} storagePath={String(tpl.file_url)} />
                </>
              ) : (
                <>
                  <div className="oqp-slot-sub">{T.contractTemplates.noTemplate}</div>
                  <button type="button" className="oqp-upload-box" disabled={busy} onClick={() => pickFile(slot.trade, slot.fundingType)}>
                    <span className="oqp-upload-icon" aria-hidden="true">📄</span>
                    <span className="oqp-upload-text">{busy ? 'Uploading…' : T.contractTemplates.uploadTemplate}</span>
                    <span className="oqp-upload-hint">{T.contractTemplates.uploadHint}</span>
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {mappingSlot && (
        <FieldMappingModal
          contractorId={contractorId}
          templates={templates}
          trade={mappingSlot.trade}
          fundingType={mappingSlot.fundingType}
          onClose={() => setMappingSlot(null)}
          onSaved={(updated) => setTemplates(updated)}
        />
      )}
    </section>
  );
}

function FieldMappingModal({ contractorId, templates, trade, fundingType, onClose, onSaved }: {
  contractorId: string; templates: ContractTemplate[]; trade: string; fundingType: string;
  onClose: () => void; onSaved: (t: ContractTemplate[]) => void;
}) {
  const tpl = findContractTemplate(templates, trade, fundingType);
  const [values, setValues] = useState<Record<string, string>>(() => initialFieldMappingValues(tpl, DEFAULT_FIELD_MAPPINGS));
  const [status, setStatus] = useState<{ msg: string; color: string } | null>(null);

  function reset() {
    const d: Record<string, string> = {};
    for (const k of Object.keys(DEFAULT_FIELD_MAPPINGS)) d[k] = DEFAULT_FIELD_MAPPINGS[k].label;
    setValues(d);
  }

  async function save() {
    const mappings = collectFieldMappings(values, DEFAULT_FIELD_MAPPINGS);
    const updated = setContractFieldMappings(templates, trade, fundingType, mappings);
    setStatus({ msg: T.fieldMapping.saved, color: '#065F46' });
    try {
      const { error } = await supabase.from('contractors').update({ contract_templates: updated }).eq('id', contractorId);
      if (error) throw error;
      onSaved(updated);
      setStatus({ msg: T.fieldMapping.saved, color: '#6EE7B7' });
      setTimeout(() => setStatus(null), 3000);
    } catch (e) {
      console.error('saveFieldMappings error:', e);
      setStatus({ msg: T.fieldMapping.saveError, color: '#FCA5A5' });
    }
  }

  return (
    <div className="oqp-modal-backdrop" role="dialog" aria-modal="true" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="oqp-modal">
        <div className="oqp-modal-head">
          <div>
            <h3>{T.fieldMapping.title}</h3>
            <p>{trade} — {fundingType}</p>
          </div>
          <button type="button" className="oqp-modal-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="oqp-modal-body">
          <p className="oqp-fm-intro">{T.fieldMapping.intro}</p>
          <div className="oqp-fm-headings">
            <div>{T.fieldMapping.leftHeading}</div><div></div><div>{T.fieldMapping.rightHeading}</div>
          </div>
          <div className="oqp-fm-rows">
            {Object.entries(DEFAULT_FIELD_MAPPINGS).map(([key, def]) => (
              <div className="oqp-fm-row" key={key}>
                <input type="text" className="oqp-input" value={values[key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} />
                <span className="oqp-fm-arrow" aria-hidden="true">→</span>
                <span className="oqp-fm-desc">{def.description}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="oqp-modal-foot">
          <button type="button" className="oqp-btn-sm oqp-btn-sm-secondary" onClick={reset}>{T.fieldMapping.reset}</button>
          <button type="button" className="oqp-btn-sm oqp-btn-sm-primary" onClick={save}>{T.fieldMapping.save}</button>
        </div>
        {status && <div className="oqp-fm-status" style={{ color: status.color }}>{status.msg}</div>}
      </div>
    </div>
  );
}
