'use client';

/**
 * Project Confirmation Templates card (D-161) — port of loadPcTemplates /
 * uploadPcTemplateFile / viewPcTemplate. 8 slots backed by
 * contractors.color_confirmation_template (JSONB map keyed `trade/funding`).
 * Storage + signed-URL contracts UNCHANGED (contractor-templates bucket).
 */

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { PROFILE_COPY as T } from './copy';
import {
  PC_TEMPLATE_SLOTS, pcSlotKey, pcTemplatePath, mergePcTemplate, fileNameFromUrl,
  storagePathFromValue, validatePdfUpload, type PcTemplateMap,
} from './utils';

export function PcTemplates({ contractorId }: { contractorId: string }) {
  const [map, setMap] = useState<PcTemplateMap>({});
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pending = useRef<{ trade: string; fundingType: string } | null>(null);

  async function reload() {
    const { data } = await supabase.from('contractors').select('color_confirmation_template').eq('id', contractorId).single();
    setMap(((data?.color_confirmation_template as PcTemplateMap) ?? {}));
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
    const slotKey = pcSlotKey(slot.trade, slot.fundingType);
    setBusySlot(slotKey);
    try {
      const filePath = pcTemplatePath(contractorId, slot.trade, slot.fundingType, Date.now());
      const { error: upErr } = await supabase.storage.from('contractor-templates').upload(filePath, file, { contentType: 'application/pdf' });
      if (upErr) throw upErr;
      // Merge into the freshest JSONB to avoid clobbering concurrent slot writes.
      const { data: fresh } = await supabase.from('contractors').select('color_confirmation_template').eq('id', contractorId).single();
      const updated = mergePcTemplate((fresh?.color_confirmation_template as PcTemplateMap) ?? {}, slotKey, filePath, new Date().toISOString());
      const { error: dbErr } = await supabase.from('contractors')
        .update({ color_confirmation_template: updated, pc_template_migration_pending: false, updated_at: new Date().toISOString() })
        .eq('id', contractorId);
      if (dbErr) throw dbErr;
      setMap(updated);
    } catch (err2) {
      console.error('Error uploading PC template:', err2);
      alert(T.pcTemplates.uploadFailed);
    } finally {
      setBusySlot(null);
    }
  }

  async function view(fileUrl: string) {
    if (!fileUrl) { alert('No file available for this slot.'); return; }
    try {
      const path = storagePathFromValue(fileUrl, 'contractor-templates');
      const { data, error } = await supabase.storage.from('contractor-templates').createSignedUrl(path, 3600);
      if (error || !data?.signedUrl) { console.error('Signed URL generation failed:', error); alert(T.pcTemplates.viewError); return; }
      window.open(data.signedUrl, '_blank');
    } catch (err) {
      console.error('viewPcTemplate error:', err);
      alert('Unable to open template. Please try again.');
    }
  }

  return (
    <section className="oqp-card" id="pc-templates">
      <h2 className="oqp-card-title"><span aria-hidden="true">📋</span>{T.pcTemplates.title}</h2>
      <div className="oqp-info-box">{T.pcTemplates.intro}</div>
      <div className="oqp-info-box oqp-info-box-warn">{T.pcTemplates.warning}</div>

      <input ref={fileRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={onFile} />

      <div className="oqp-template-grid">
        {PC_TEMPLATE_SLOTS.map((slot) => {
          const slotKey = pcSlotKey(slot.trade, slot.fundingType);
          const data = map[slotKey];
          const busy = busySlot === slotKey;
          return (
            <div key={slotKey} className="oqp-slot">
              <div className="oqp-slot-head">{slot.label}</div>
              {data && data.file_url ? (
                <>
                  <div className="oqp-slot-file">
                    <div className="oqp-slot-file-name">{fileNameFromUrl(String(data.file_url))}</div>
                    <div className="oqp-slot-file-date">{T.pcTemplates.uploadedPrefix}{data.uploaded_at ? new Date(data.uploaded_at).toLocaleDateString() : 'Unknown date'}</div>
                  </div>
                  <div className="oqp-slot-btns">
                    <button type="button" className="oqp-btn-sm oqp-btn-sm-primary" onClick={() => view(String(data.file_url))}>{T.pcTemplates.view}</button>
                    <button type="button" className="oqp-btn-sm oqp-btn-sm-secondary" disabled={busy} onClick={() => pickFile(slot.trade, slot.fundingType)}>{T.pcTemplates.replace}</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="oqp-slot-sub">{T.pcTemplates.noTemplate}</div>
                  <button type="button" className="oqp-upload-box" disabled={busy} onClick={() => pickFile(slot.trade, slot.fundingType)}>
                    <span className="oqp-upload-icon" aria-hidden="true">📋</span>
                    <span className="oqp-upload-text">{busy ? 'Uploading…' : T.pcTemplates.uploadTemplate}</span>
                    <span className="oqp-upload-hint">{T.pcTemplates.uploadHint}</span>
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
