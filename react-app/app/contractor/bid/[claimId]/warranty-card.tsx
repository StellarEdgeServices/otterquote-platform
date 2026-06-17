'use client';

/**
 * D-202 manufacturer × tier warranty selection (D-211 Phase 7 / BF-2 — port of
 * contractor-bid-form.html loadWarrantyOptions/loadD204State/initWarrantyDropdowns/
 * onWarranty*Change/getD202WarrantySelection, :4391-4710). Reads warranty_options
 * (sessionStorage d202_warranty_options, 5-min TTL) + the D-204 SOFT/HARD cert
 * filter (platform_settings.D204_HARD_FILTER + contractor_cert_verifications),
 * exposes manufacturer→tier dropdowns + an Other/Custom free-text fallback, and
 * lifts a WarrantySelectionInput up so the page serializes it with the PR-1
 * serializeWarrantySelection (verbatim D-204 tail in copy.ts). All reads use the
 * supabase singleton; values render as JSX text.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, Field, Select, Checkbox, TextInput, type Opt } from './bid-ui';
import type { WarrantySelectionInput } from './utils';

interface WarrantyOption {
  id: string;
  manufacturer: string;
  tier: string;
  material_years: string | null;
  labor_years: number | null;
  labor_note: string | null;
  tearoff_years: number | null;
  wind_mph: number | null;
  hail_class: string | null;
  cert_required: string | null;
  display_string: string | null;
}

const OPTS_TTL = 5 * 60 * 1000;

async function loadWarrantyOptions(): Promise<WarrantyOption[]> {
  try {
    const cached = sessionStorage.getItem('d202_warranty_options');
    const cachedAt = sessionStorage.getItem('d202_warranty_options_at');
    if (cached && cachedAt && Date.now() - parseInt(cachedAt, 10) < OPTS_TTL) {
      return JSON.parse(cached) as WarrantyOption[];
    }
  } catch { /* ignore */ }
  const { data, error } = await supabase
    .from('warranty_options')
    .select('id,manufacturer,tier,material_years,labor_years,labor_note,tearoff_years,wind_mph,hail_class,cert_required,display_string')
    .order('manufacturer', { ascending: true })
    .order('tier', { ascending: true });
  if (error) { console.warn('[D-202] loadWarrantyOptions error:', error); return []; }
  const rows = (data as WarrantyOption[]) || [];
  try {
    sessionStorage.setItem('d202_warranty_options', JSON.stringify(rows));
    sessionStorage.setItem('d202_warranty_options_at', String(Date.now()));
  } catch { /* ignore */ }
  return rows;
}

interface D204State { hardFilter: boolean; verifiedCerts: Set<string>; }

async function loadD204State(contractorId: string | null): Promise<D204State> {
  let hardFilter = false;
  try {
    const { data: flagRow } = await supabase.from('platform_settings').select('value').eq('key', 'D204_HARD_FILTER').maybeSingle();
    hardFilter = !!flagRow && flagRow.value === true;
  } catch { hardFilter = false; }
  if (!contractorId) return { hardFilter, verifiedCerts: new Set() };
  try {
    const { data, error } = await supabase
      .from('contractor_cert_verifications')
      .select('manufacturer, cert_name, status')
      .eq('contractor_id', contractorId)
      .eq('status', 'verified');
    if (error) return { hardFilter, verifiedCerts: new Set() };
    return { hardFilter, verifiedCerts: new Set((data || []).map((r: { manufacturer: string; cert_name: string }) => `${r.manufacturer}::${r.cert_name}`)) };
  } catch { return { hardFilter, verifiedCerts: new Set() }; }
}

export function WarrantyCard({ contractorId, onChange }: {
  contractorId: string | null;
  onChange: (sel: WarrantySelectionInput) => void;
}) {
  const [options, setOptions] = useState<WarrantyOption[]>([]);
  const [d204, setD204] = useState<D204State>({ hardFilter: false, verifiedCerts: new Set() });
  const [manufacturer, setManufacturer] = useState('');
  const [optionId, setOptionId] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [workmanship, setWorkmanship] = useState('');
  const [custom, setCustom] = useState({ manufacturer: '', tier: '', materialYears: '', laborYears: '', windMph: '', hailClass: '' });

  useEffect(() => {
    let active = true;
    (async () => {
      const [opts, state] = await Promise.all([loadWarrantyOptions(), loadD204State(contractorId)]);
      if (!active) return;
      setOptions(opts);
      setD204(state);
    })();
    return () => { active = false; };
  }, [contractorId]);

  const selectedOption = useMemo(() => options.find((o) => o.id === optionId) || null, [options, optionId]);

  // Lift the current selection up on every change (page serializes at submit).
  useEffect(() => {
    onChange({
      isCustom,
      optionId: isCustom ? null : (optionId || null),
      snapshot: isCustom ? null : (selectedOption?.display_string || null),
      custom: isCustom ? {
        manufacturer: custom.manufacturer, tier: custom.tier, materialYears: custom.materialYears,
        laborYears: custom.laborYears, windMph: custom.windMph, hailClass: custom.hailClass,
      } : undefined,
      workmanshipYearsRaw: workmanship,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustom, optionId, selectedOption, workmanship, custom]);

  const manufacturers = useMemo(() => Array.from(new Set(options.map((o) => o.manufacturer))).sort(), [options]);
  const mfrOptions: Opt[] = [
    { value: '', label: '— Select manufacturer —' },
    ...manufacturers.map((m) => ({ value: m, label: m })),
    { value: '__OTHER__', label: 'Other (free-text)' },
  ];

  // Tier options for the selected manufacturer, with the D-204 SOFT/HARD filter.
  let banneredAny = false;
  const tierOptions: Opt[] = [{ value: '', label: '— Select tier —' }];
  if (manufacturer && manufacturer !== '__OTHER__') {
    for (const t of options.filter((o) => o.manufacturer === manufacturer)) {
      const lacksCert = !!t.cert_required && !d204.verifiedCerts.has(`${manufacturer}::${t.cert_required}`);
      if (!lacksCert) { tierOptions.push({ value: t.id, label: t.tier }); continue; }
      if (d204.hardFilter) continue; // hard-filter hides the tier entirely
      banneredAny = true;
      tierOptions.push({ value: t.id, label: `${t.tier} ⓘ` });
    }
  }

  function onManufacturer(v: string) {
    setOptionId('');
    if (v === '__OTHER__') { setManufacturer(v); setIsCustom(true); return; }
    setManufacturer(v);
    if (isCustom) setIsCustom(false);
  }

  function onCustomToggle(v: boolean) {
    setIsCustom(v);
    if (v) { setOptionId(''); if (manufacturer !== '__OTHER__') setManufacturer(''); }
  }

  return (
    <Card title="Manufacturer Warranty (D-202)" sub="Select the manufacturer warranty you will register for this roof, or enter a custom warranty.">
      <div className="oqb-grid2">
        <Field label="Manufacturer">
          <Select value={manufacturer} onChange={onManufacturer} options={mfrOptions} />
        </Field>
        <Field label="Tier">
          <Select value={optionId} onChange={setOptionId} options={tierOptions} />
        </Field>
      </div>

      {!d204.hardFilter && banneredAny && (
        <div className="oqb-fee-info" style={{ background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 8, padding: '0.5rem 0.7rem', color: '#92400E' }}>
          ⓘ Some tiers above require manufacturer certifications you have not verified yet. Add them on your profile to lock in those warranties.
        </div>
      )}

      {!isCustom && selectedOption && (
        <div className="oqb-fee-box" style={{ marginTop: '0.75rem' }}>
          {selectedOption.display_string && <div className="oqb-summary-v" style={{ marginBottom: '0.4rem' }}>{selectedOption.display_string}</div>}
          <div className="oqb-fee-row"><span>Material</span><span>{selectedOption.material_years || '—'}</span></div>
          <div className="oqb-fee-row"><span>Labor</span><span>{selectedOption.labor_years != null ? `${selectedOption.labor_years} years${selectedOption.labor_note ? ` (${selectedOption.labor_note})` : ''}` : (selectedOption.labor_note || 'None')}</span></div>
          <div className="oqb-fee-row"><span>Tear-off</span><span>{selectedOption.tearoff_years != null ? `${selectedOption.tearoff_years} years` : '—'}</span></div>
          <div className="oqb-fee-row"><span>Wind</span><span>{selectedOption.wind_mph != null ? `${selectedOption.wind_mph} mph` : '—'}</span></div>
          <div className="oqb-fee-row"><span>Hail</span><span>{selectedOption.hail_class || '—'}</span></div>
          <div className="oqb-fee-row"><span>Cert required</span><span>{selectedOption.cert_required || 'None required'}</span></div>
        </div>
      )}

      <Checkbox checked={isCustom} onChange={onCustomToggle} label="Enter a custom / other warranty (free-text)" />

      {isCustom && (
        <div className="oqb-grid2" style={{ marginTop: '0.5rem' }}>
          <Field label="Manufacturer"><TextInput value={custom.manufacturer} onChange={(v) => setCustom({ ...custom, manufacturer: v })} placeholder="e.g. GAF" /></Field>
          <Field label="Tier / product"><TextInput value={custom.tier} onChange={(v) => setCustom({ ...custom, tier: v })} placeholder="e.g. Golden Pledge" /></Field>
          <Field label="Material years"><TextInput value={custom.materialYears} onChange={(v) => setCustom({ ...custom, materialYears: v })} placeholder="e.g. Lifetime" /></Field>
          <Field label="Labor years"><TextInput value={custom.laborYears} onChange={(v) => setCustom({ ...custom, laborYears: v })} placeholder="e.g. 25" /></Field>
          <Field label="Wind (mph)"><TextInput value={custom.windMph} onChange={(v) => setCustom({ ...custom, windMph: v })} placeholder="e.g. 130" /></Field>
          <Field label="Hail class"><TextInput value={custom.hailClass} onChange={(v) => setCustom({ ...custom, hailClass: v })} placeholder="e.g. Class 4" /></Field>
        </div>
      )}

      <Field label="Workmanship warranty (years)">
        <TextInput type="number" value={workmanship} onChange={setWorkmanship} placeholder="e.g. 10" />
      </Field>
    </Card>
  );
}
