'use client';

/**
 * Homeowner Project-Confirmation surface — /project-confirmation (D-211 Phase 26,
 * PR 2/2). Behaviour-faithful React port of project-confirmation.html (repo root).
 *
 * Tri-state top-level: pending → iframe-return → page.
 * Data layer: use-project-confirmation-data.ts.
 * Pure logic: utils.ts + signing-utils.ts.
 * Locked copy: copy.ts (TIER-3 — DO NOT modify).
 *
 * Intentional delta from the static:
 *   • buildProjectConfirmationEnvelopeRequest omits `signer` (D-220: EF derives it).
 *   • return_url targets the React route (this page), not the static .html.
 *   • EF failure renders an explicit "saved / signing unavailable" state instead of
 *     silently continuing (improvement: data is never lost).
 *   • Shingle-color inline error replaces window.alert.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import {
  DocuSignEmbed,
  isSigningCompleteReturn,
  runSigningReturnBridge,
} from '@/components/docusign-embed';
import { HomeownerShell } from '../_shell/HomeownerShell';
import { CONFIRM_COPY as C } from './copy';
import {
  normalizeSelectedTrades,
  detectTrades,
  isInsuranceClaim,
  buildAckIds,
  allAcksChecked,
  buildPayload,
  type ConfirmationFormValues,
  type StructureData,
  type SkylightData,
  type AckCheckboxState,
} from './utils';
import {
  useProjectConfirmationData,
  saveProjectConfirmation,
  createProjectConfirmationEnvelope,
} from './use-project-confirmation-data';
import {
  resolveShingleManufacturerOption,
  depreciationDisclosureAmountText,
  depreciationBannerText,
  deckingRateAckText,
  deckingRateBannerText,
} from './signing-utils';

// ── Shingle manufacturer options (matches the static <select> values) ──────────
const SHINGLE_MFTR_OPTIONS = [
  'Owens Corning',
  'GAF',
  'CertainTeed',
  'TAMKO',
  'Atlas',
  'IKO',
  'Malarkey',
  'Other',
];

// ── Default structure names (static renderStructureCards:1574) ────────────────
const STRUCTURE_DEFAULTS = [
  'Main House',
  'Detached Garage',
  'Barn / Workshop',
  'Pool House',
  'Other Structure',
];

function makeDefaultStructure(i: number, existing?: Partial<StructureData>): StructureData {
  return {
    name: existing?.name ?? STRUCTURE_DEFAULTS[i] ?? `Structure ${i + 1}`,
    roofAsphalt: existing?.roofAsphalt ?? '',
    roofMetal: existing?.roofMetal ?? '',
    siding: existing?.siding ?? '',
    gutters: existing?.gutters ?? '',
    downspouts: existing?.downspouts ?? '',
    skylightsReplace: existing?.skylightsReplace ?? '0',
    skylightsReflash: existing?.skylightsReflash ?? '0',
  };
}

function makeDefaultSkylight(existing?: Partial<SkylightData>): SkylightData {
  return {
    scope: existing?.scope ?? 'N/A',
    length: existing?.length ?? '',
    width: existing?.width ?? '',
    hinge: existing?.hinge ?? 'Top Hinge',
    operation: existing?.operation ?? 'None',
    blinds: existing?.blinds ?? 'No Blinds',
  };
}

// ── Top-level page: tri-state boot ────────────────────────────────────────────

export default function ProjectConfirmationPage() {
  const [view, setView] = useState<'pending' | 'iframe-return' | 'page'>('pending');

  useEffect(() => {
    if (runSigningReturnBridge()) {
      setView('iframe-return');
      return;
    }
    setView('page');
  }, []);

  if (view === 'pending') {
    return (
      <div className="oqpc-boot">
        <div className="oqpc-spin" />
        <style>{STYLES}</style>
      </div>
    );
  }

  if (view === 'iframe-return') {
    return (
      <div className="oqpc-return">
        <p>Finalizing your signature…</p>
        <style>{STYLES}</style>
      </div>
    );
  }

  return (
    <HomeownerShell active="dashboard">
      <style>{STYLES}</style>
      <Content />
    </HomeownerShell>
  );
}

// ── Content: auth + params + data layer ──────────────────────────────────────

function Content() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;

  // Resolve URL params once client-side.
  const [claimId, setClaimId] = useState<string | null>(null);
  const [paramsReady, setParamsReady] = useState(false);
  const [signedReturn, setSignedReturn] = useState(false);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setClaimId(sp.get('claim_id'));
    setSignedReturn(isSigningCompleteReturn(sp));
    setParamsReady(true);
  }, []);

  const data = useProjectConfirmationData(userId, claimId, paramsReady);

  // ── Render gates ──
  if (!paramsReady || data.loading) {
    return <Boot />;
  }

  if (data.gate === 'missing-claim') {
    return (
      <Wrap>
        <ErrorPanel
          title="Missing claim ID"
          detail="No claim ID was found in the URL. Please return to your dashboard and navigate here from your project page."
        />
      </Wrap>
    );
  }

  if (data.error) {
    return (
      <Wrap>
        <ErrorPanel title="Unable to load project" detail={data.error} />
      </Wrap>
    );
  }

  if (data.gate === 'access-denied') {
    return (
      <Wrap>
        <GatePanel title="Access Denied" body="You do not have permission to access this project." />
      </Wrap>
    );
  }

  if (data.gate === 'not-signed') {
    return (
      <Wrap>
        <GatePanel
          title="Contract not yet signed"
          body="Project confirmation is available after your contract is signed. Please complete the contract signing step first."
        />
      </Wrap>
    );
  }

  if (data.gate === 'no-contractor') {
    return (
      <Wrap>
        <GatePanel
          title="No contractor selected"
          body="No contractor has been selected for this claim yet."
        />
      </Wrap>
    );
  }

  // gate === 'ready'
  return (
    <FormContent
      data={data}
      claimId={claimId!}
      userId={userId!}
      user={user}
      signedReturn={signedReturn}
    />
  );
}

// ── FormContent: form state + phases ─────────────────────────────────────────

function FormContent({
  data,
  claimId,
  userId,
  user,
  signedReturn,
}: {
  data: ReturnType<typeof useProjectConfirmationData>;
  claimId: string;
  userId: string;
  user: { id: string; email?: string } | null;
  signedReturn: boolean;
}) {
  const { claim, contractor, quote, contractorId, homeownerName, depreciation, deckingRatePerSheet, existingConfirmation } = data;

  const trades = useMemo(
    () => normalizeSelectedTrades(claim?.selected_trades),
    [claim?.selected_trades],
  );
  const { hasRoofing, hasSiding, hasGutters, hasWindows } = useMemo(
    () => detectTrades(trades),
    [trades],
  );
  const isInsurance = useMemo(() => isInsuranceClaim(claim), [claim]);

  // ── Form state ──
  const [form, setForm] = useState<ConfirmationFormValues>({});
  const [numStructures, setNumStructures] = useState(1);
  const [structures, setStructures] = useState<StructureData[]>([makeDefaultStructure(0)]);
  const [skylights, setSkylights] = useState<SkylightData[]>([
    makeDefaultSkylight(),
    makeDefaultSkylight(),
    makeDefaultSkylight(),
    makeDefaultSkylight(),
  ]);

  // ── Conditional conditional visibility ──
  const [showBadDeckingSheets, setShowBadDeckingSheets] = useState(false);
  const [showGutterGuardsNotes, setShowGutterGuardsNotes] = useState(false);
  const [showWindowWrapsColor, setShowWindowWrapsColor] = useState(false);
  const [showRottenSheathingSqFt, setShowRottenSheathingSqFt] = useState(false);
  const [showDownspoutColorOther, setShowDownspoutColorOther] = useState(false);

  // ── Phase ──
  const [phase, setPhase] = useState<'form' | 'signing' | 'done' | 'ef-failed'>('form');
  const [signingUrl, setSigningUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [shingleColorError, setShingleColorError] = useState(false);

  // ── Initialize form from existing data + prefill (static order: prefill first, restore wins) ──
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Default structures (1 card)
    let initNumStructures = 1;
    let initStructures: StructureData[] = [makeDefaultStructure(0)];
    let initSkylights: SkylightData[] = [0, 1, 2, 3].map((i) => makeDefaultSkylight());

    // Prefill: shingle manufacturer from quote (case-insensitive match) + shingle type
    const prefillMftr = quote?.brand
      ? resolveShingleManufacturerOption(quote.brand, SHINGLE_MFTR_OPTIONS)
      : null;
    const prefillType = quote?.product_line ?? '';

    let initForm: ConfirmationFormValues = {
      shingleManufacturer: prefillMftr ?? '',
      shingleType: prefillType,
    };

    // Restore existing confirmation on top of prefill (static 2308-2311: restore wins)
    if (existingConfirmation) {
      const d = existingConfirmation;

      // numStructures + structures
      const savedNum = typeof d.numStructures === 'number' ? d.numStructures : parseInt(String(d.numStructures ?? '1')) || 1;
      initNumStructures = savedNum;
      const savedStructures = Array.isArray(d.structures) ? d.structures as Partial<StructureData>[] : [];
      initStructures = Array.from({ length: savedNum }, (_, i) =>
        makeDefaultStructure(i, savedStructures[i] ?? {}),
      );

      // skylights
      if (Array.isArray(d.skylights)) {
        initSkylights = [0, 1, 2, 3].map((i) => {
          const s = (d.skylights as SkylightData[])[i];
          return s ? makeDefaultSkylight(s) : makeDefaultSkylight();
        });
      }

      initForm = {
        // Prefilled values (can be overridden by restore)
        shingleManufacturer: prefillMftr ?? '',
        shingleType: prefillType,
        // Restored values win
        ...(d.shingleManufacturer != null && { shingleManufacturer: d.shingleManufacturer as string }),
        ...(d.shingleType != null && { shingleType: d.shingleType as string }),
        shingleColor: (d.shingleColor as string | undefined) ?? '',
        dripEdgeColor: (d.dripEdgeColor as string | undefined) ?? '',
        valleys: (d.valleys as string | undefined) ?? '',
        gutterGuards: (d.gutterGuards as string | undefined) ?? 'None',
        gutterGuardsNotes: (d.gutterGuardsNotes as string | undefined) ?? '',
        ventBox: d.ventBox != null ? String(d.ventBox) : '0',
        ventRidge: d.ventRidge != null ? String(d.ventRidge) : '0',
        ventOther: (d.ventOther as string | undefined) ?? '',
        satelliteDish: (d.satelliteDish as string | undefined) ?? 'None',
        badDecking: (d.badDecking as string | undefined) ?? 'Unexpected',
        badDeckingSheets: d.badDeckingSheets != null ? String(d.badDeckingSheets) : '0',
        chimney1Material: (d.chimney1Material as string | undefined) ?? '',
        chimney1Size: (d.chimney1Size as string | undefined) ?? '',
        chimney1Cricket: (d.chimney1Cricket as string | undefined) ?? '',
        chimney1Reflash: (d.chimney1Reflash as string | undefined) ?? '',
        chimney2Material: (d.chimney2Material as string | undefined) ?? '',
        chimney2Size: (d.chimney2Size as string | undefined) ?? '',
        chimney2Cricket: (d.chimney2Cricket as string | undefined) ?? '',
        chimney2Reflash: (d.chimney2Reflash as string | undefined) ?? '',
        exclusions: (d.exclusions as string | undefined) ?? '',
        projectNotes: (d.projectNotes as string | undefined) ?? '',
        // Siding
        ...(hasSiding && {
          soffitFascia: (d.soffitFascia as string | undefined) ?? '',
          windowWraps: (d.windowWraps as string | undefined) ?? '',
          windowWrapsColor: (d.windowWrapsColor as string | undefined) ?? '',
          rottenSheathing: (d.rottenSheathing as string | undefined) ?? 'Unexpected',
          rottenSheathingSqFt: d.rottenSheathingSqFt != null ? String(d.rottenSheathingSqFt) : '0',
          ackRottenSheathing: !!(d.ackRottenSheathing),
        }),
        // Gutters
        ...(hasGutters && {
          gutterSize: (d.gutterSize as string | undefined) ?? '',
          gutterColorInput: (d.gutterColorInput as string | undefined) ?? '',
          downspoutColorType: (d.downspoutColorType as string | undefined) ?? '',
          downspoutColorOther: (d.downspoutColorOther as string | undefined) ?? '',
          splashBlocks: (d.splashBlocks as string | undefined) ?? '',
          gutterNotes: (d.gutterNotes as string | undefined) ?? '',
        }),
        // Acks
        ackBadDecking: !!(d.ackBadDecking),
        ackDepreciation: !!(d.ackDepreciation),
        ackPaymentTerms: !!(d.ackPaymentTerms),
        ackProjectChanges: !!(d.ackProjectChanges),
        ackInfoCorrect: !!(d.ackInfoCorrect),
      };

      // Restore conditional field visibility
      if (d.badDecking === 'Expected') setShowBadDeckingSheets(true);
      if (d.gutterGuards === 'On Some Gutters') setShowGutterGuardsNotes(true);
      const ww = d.windowWraps as string | undefined;
      if (ww === 'Included - All' || ww === 'Included - Damaged Only') setShowWindowWrapsColor(true);
      if (d.rottenSheathing === 'Expected') setShowRottenSheathingSqFt(true);
      if (d.downspoutColorType === 'Other') setShowDownspoutColorOther(true);
    }

    setNumStructures(initNumStructures);
    setStructures(initStructures);
    setSkylights(initSkylights);
    setForm(initForm);
  }, [existingConfirmation, quote, hasSiding, hasGutters]);

  // ── Ack state for submit gate ──
  const ackIds = useMemo(() => buildAckIds(trades, isInsurance), [trades, isInsurance]);

  const ackStates = useMemo((): Record<string, AckCheckboxState | undefined> => {
    const s: Record<string, AckCheckboxState> = {};
    // ackBadDecking: present if hasRoofing (case-insensitive, detectTrades); hidden if not required by buildAckIds
    s.ackBadDecking = { present: hasRoofing, hidden: !hasRoofing, checked: !!(form.ackBadDecking) };
    s.ackRottenSheathing = { present: hasSiding, hidden: !hasSiding, checked: !!(form.ackRottenSheathing) };
    s.ackDepreciation = { present: isInsurance, hidden: !isInsurance, checked: !!(form.ackDepreciation) };
    s.ackPaymentTerms = { present: true, hidden: false, checked: !!(form.ackPaymentTerms) };
    s.ackProjectChanges = { present: true, hidden: false, checked: !!(form.ackProjectChanges) };
    s.ackInfoCorrect = { present: true, hidden: false, checked: !!(form.ackInfoCorrect) };
    return s;
  }, [form, hasRoofing, hasSiding, isInsurance]);

  const shingleColorFilled = (form.shingleColor ?? '').trim().length > 0;
  const submitEnabled = allAcksChecked(ackIds, ackStates) && shingleColorFilled;

  // ── onComplete ref ──
  const onCompleteRef = useRef<() => void>(() => {});
  onCompleteRef.current = () => {
    setPhase('done');
    setSigningUrl(null);
  };
  const handleComplete = useCallback(() => onCompleteRef.current(), []);

  // ── Init-time signed=true return (static 2182-2185 analog) ──
  const firedReturn = useRef(false);
  useEffect(() => {
    if (signedReturn && !firedReturn.current && data.gate === 'ready') {
      firedReturn.current = true;
      setPhase('done');
    }
  }, [signedReturn, data.gate]);

  // ── numStructures change handler ──
  const handleNumStructuresChange = useCallback(
    (n: number) => {
      setNumStructures(n);
      setStructures((prev) =>
        Array.from({ length: n }, (_, i) => prev[i] ?? makeDefaultStructure(i)),
      );
    },
    [],
  );

  // ── Submit ──
  const handleSubmit = useCallback(async () => {
    if (!allAcksChecked(ackIds, ackStates)) return;

    const color = (form.shingleColor ?? '').trim();
    if (!color) {
      setShingleColorError(true);
      return;
    }
    setShingleColorError(false);
    setSubmitting(true);
    setSubmitError(null);

    const autoFill = {
      homeownerName: homeownerName ?? null,
      propertyAddress: claim?.property_address ?? null,
      shingleMftrFromBid: quote?.brand ?? null,
      shingleTypeFromBid: quote?.product_line ?? null,
      depreciation: depreciation ?? null,
      deckingRatePerSheet: deckingRatePerSheet ?? null,
      contractorName: contractor?.company_name ?? null,
    };

    const payload = buildPayload({
      trades,
      submittedAt: new Date().toISOString(),
      form,
      structures,
      skylights,
      autoFill,
    });

    // a. Save first
    try {
      await saveProjectConfirmation(claimId, payload);
    } catch (saveErr) {
      setSubmitting(false);
      setSubmitError(saveErr instanceof Error ? saveErr.message : 'Failed to save project confirmation.');
      return;
    }

    // b. Create envelope
    try {
      const result = await createProjectConfirmationEnvelope({
        claimId,
        contractorId: contractorId!,
        origin: window.location.origin,
      });
      setSigningUrl(result.signingUrl);
      setPhase('signing');
      setSubmitting(false);
    } catch (efErr) {
      // c. EF failed — but save succeeded; show graceful state
      setSubmitting(false);
      setPhase('ef-failed');
    }
  }, [
    ackIds, ackStates, form, structures, skylights, trades,
    claimId, contractorId, claim, quote, contractor,
    homeownerName, depreciation, deckingRatePerSheet,
  ]);

  // ── Success screen ──
  if (phase === 'done') {
    return (
      <Wrap>
        <div className="oqpc-success">
          <div className="oqpc-success-icon">✅</div>
          <h2 className="oqpc-success-title">Confirmation Submitted!</h2>
          <p className="oqpc-success-subtitle">
            Your project details have been saved and sent to your contractor. They&apos;ll be in touch to confirm your installation schedule.
          </p>
          <a className="oqpc-btn oqpc-btn-primary" href="/dashboard">
            Go to My Dashboard →
          </a>
        </div>
      </Wrap>
    );
  }

  // ── EF failed screen ──
  if (phase === 'ef-failed') {
    return (
      <Wrap>
        <div className="oqpc-ef-failed">
          <div className="oqpc-ef-failed-icon">💾</div>
          <h2 className="oqpc-ef-failed-title">Your confirmation details are saved</h2>
          <p className="oqpc-ef-failed-body">
            Signing is temporarily unavailable — we&apos;ve saved everything and our team will follow up to complete the signature. No action is needed right now.
          </p>
          <a className="oqpc-btn oqpc-btn-primary" href="/dashboard">
            Go to My Dashboard →
          </a>
        </div>
      </Wrap>
    );
  }

  // ── Signing iframe ──
  if (phase === 'signing' && signingUrl) {
    return (
      <Wrap>
        <DocuSignEmbed signingUrl={signingUrl} onComplete={handleComplete} />
      </Wrap>
    );
  }

  // ── Form ──
  return (
    <Wrap>
      {/* Page header */}
      <header className="oqpc-head">
        <h1 className="oqpc-title">{C.headerTitle}</h1>
        <p className="oqpc-subtitle">{C.headerSubtitle}</p>
      </header>

      {/* Contractor card */}
      <div className="oqpc-contractor-card">
        <div className="oqpc-contractor-avatar">
          {contractor?.logo_url ? (
            <img src={contractor.logo_url} alt={contractor.company_name ?? 'Contractor'} />
          ) : (
            <span>{contractor?.company_name?.charAt(0)?.toUpperCase() ?? '🏠'}</span>
          )}
        </div>
        <div className="oqpc-contractor-info">
          <div className="oqpc-contractor-name">{contractor?.company_name ?? 'Your Contractor'}</div>
          <div className="oqpc-contractor-meta">
            {contractor?.years_in_business
              ? `${contractor.years_in_business} years in business`
              : 'Contractor details on file'}
          </div>
          <div className="oqpc-contractor-badge">✅ Contract Signed</div>
        </div>
      </div>

      {/* Auto-fill banner */}
      <div className="oqpc-autofill">
        <div className="oqpc-autofill-header">
          <span>✨</span>
          <h3 className="oqpc-autofill-title">Auto-filled from your claim &amp; winning bid</h3>
          <span className="oqpc-autofill-tag">Pre-filled</span>
        </div>
        <div className="oqpc-autofill-grid">
          <div className="oqpc-autofill-item">
            <div className="oqpc-autofill-label">Homeowner</div>
            <div className="oqpc-autofill-value">{homeownerName ?? user?.email ?? '—'}</div>
          </div>
          <div className="oqpc-autofill-item">
            <div className="oqpc-autofill-label">Property Address</div>
            <div className="oqpc-autofill-value">{claim?.property_address ?? '—'}</div>
          </div>
          <div className="oqpc-autofill-item">
            <div className="oqpc-autofill-label">Shingle Manufacturer</div>
            <div className="oqpc-autofill-value">{quote?.brand ?? claim?.shingle_manufacturer ?? '—'}</div>
          </div>
          <div className="oqpc-autofill-item">
            <div className="oqpc-autofill-label">Shingle Type</div>
            <div className="oqpc-autofill-value">{quote?.product_line ?? claim?.shingle_type ?? '—'}</div>
          </div>
          <div className="oqpc-autofill-item">
            <div className="oqpc-autofill-label">Non-Recoverable Depreciation</div>
            <div className="oqpc-autofill-value">{depreciationBannerText(depreciation ?? null)}</div>
          </div>
          <div className="oqpc-autofill-item">
            <div className="oqpc-autofill-label">Decking Rate (Per Sheet)</div>
            <div className="oqpc-autofill-value">{deckingRateBannerText(deckingRatePerSheet ?? null)}</div>
          </div>
        </div>
      </div>

      {/* ── Section 1: Structures ── */}
      <section className="oqpc-section">
        <h2 className="oqpc-section-title">🏗️ Structures &amp; Trade Scope</h2>
        <p className="oqpc-section-desc">How many structures on the property need work? For each structure, confirm which trades will be completed.</p>

        <div className="oqpc-form-group oqpc-form-group-narrow">
          <label className="oqpc-label" htmlFor="numStructures">Number of Structures on Property</label>
          <select
            id="numStructures"
            className="oqpc-select"
            value={numStructures}
            onChange={(e) => handleNumStructuresChange(parseInt(e.target.value) || 1)}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>

        {structures.slice(0, numStructures).map((s, i) => (
          <StructureCard
            key={i}
            index={i}
            data={s}
            onChange={(updated) =>
              setStructures((prev) => {
                const next = [...prev];
                next[i] = updated;
                return next;
              })
            }
          />
        ))}
      </section>

      {/* ── Roofing sections ── */}
      {hasRoofing && (
        <>
          {/* Section 2: Shingle & Material Selections */}
          <section className="oqpc-section">
            <h2 className="oqpc-section-title">🎨 Shingle &amp; Material Selections <span className="oqpc-badge">Roofing</span></h2>
            <div className="oqpc-form-grid">
              <div className="oqpc-form-group">
                <label className="oqpc-label" htmlFor="shingleManufacturer">Shingle Manufacturer</label>
                <select
                  id="shingleManufacturer"
                  className="oqpc-select"
                  value={form.shingleManufacturer ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, shingleManufacturer: e.target.value }))}
                >
                  <option value="">Not yet confirmed</option>
                  {SHINGLE_MFTR_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>

              <div className="oqpc-form-group">
                <label className="oqpc-label" htmlFor="shingleType">Shingle Type / Product Line</label>
                <input
                  type="text"
                  id="shingleType"
                  className="oqpc-input"
                  placeholder="e.g., Duration, Timberline HDZ, Landmark"
                  value={form.shingleType ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, shingleType: e.target.value }))}
                />
              </div>

              <div className="oqpc-form-group">
                <label className="oqpc-label oqpc-label-required" htmlFor="shingleColor">Shingle Color</label>
                <input
                  type="text"
                  id="shingleColor"
                  className={`oqpc-input${shingleColorError ? ' oqpc-input-error' : ''}`}
                  placeholder="e.g., Estate Gray, Weathered Wood, Charcoal"
                  value={form.shingleColor ?? ''}
                  onChange={(e) => {
                    setShingleColorError(false);
                    setForm((f) => ({ ...f, shingleColor: e.target.value }));
                  }}
                />
                {shingleColorError && (
                  <div className="oqpc-field-error">Please enter your shingle color before submitting.</div>
                )}
              </div>

              <div className="oqpc-form-group">
                <label className="oqpc-label oqpc-label-required" htmlFor="dripEdgeColor">Drip Edge Color</label>
                <select
                  id="dripEdgeColor"
                  className="oqpc-select"
                  value={form.dripEdgeColor ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, dripEdgeColor: e.target.value }))}
                >
                  <option value="">Select...</option>
                  <option value="Black">Black</option>
                  <option value="White">White</option>
                  <option value="Special Order">Special Order*</option>
                </select>
              </div>

              <div className="oqpc-form-group">
                <label className="oqpc-label" htmlFor="valleys">Valleys</label>
                <select
                  id="valleys"
                  className="oqpc-select"
                  value={form.valleys ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, valleys: e.target.value }))}
                >
                  <option value="">Not specified</option>
                  <option value="Closed">Closed</option>
                  <option value="Open/Metal">Open / Metal</option>
                </select>
              </div>

              <div className="oqpc-form-group">
                <label className="oqpc-label" htmlFor="gutterGuards">Gutter Guards</label>
                <select
                  id="gutterGuards"
                  className="oqpc-select"
                  value={form.gutterGuards ?? 'None'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((f) => ({ ...f, gutterGuards: v }));
                    setShowGutterGuardsNotes(v === 'On Some Gutters');
                  }}
                >
                  <option value="None">None</option>
                  <option value="On All Gutters">On All Gutters</option>
                  <option value="On Some Gutters">On Some Gutters*</option>
                </select>
              </div>

              {showGutterGuardsNotes && (
                <div className="oqpc-form-group oqpc-form-group-full">
                  <label className="oqpc-label" htmlFor="gutterGuardsNotes">Which gutters?</label>
                  <input
                    type="text"
                    id="gutterGuardsNotes"
                    className="oqpc-input"
                    placeholder="e.g., Front and left side only"
                    value={form.gutterGuardsNotes ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, gutterGuardsNotes: e.target.value }))}
                  />
                </div>
              )}
            </div>

            {/* Vents */}
            <div className="oqpc-vents">
              <label className="oqpc-label">Vent Type &amp; Count</label>
              <div className="oqpc-vent-row">
                <span className="oqpc-vent-label">Box Vents</span>
                <input
                  type="number"
                  className="oqpc-input oqpc-count-input"
                  placeholder="0"
                  min={0}
                  value={form.ventBox ?? '0'}
                  onChange={(e) => setForm((f) => ({ ...f, ventBox: e.target.value }))}
                />
              </div>
              <div className="oqpc-vent-row">
                <span className="oqpc-vent-label">Ridge Vents (ln ft)</span>
                <input
                  type="number"
                  className="oqpc-input oqpc-count-input"
                  placeholder="0"
                  min={0}
                  value={form.ventRidge ?? '0'}
                  onChange={(e) => setForm((f) => ({ ...f, ventRidge: e.target.value }))}
                />
              </div>
              <div className="oqpc-vent-row">
                <span className="oqpc-vent-label">Other</span>
                <input
                  type="text"
                  className="oqpc-input"
                  placeholder="e.g., 2 turbines, 1 power vent"
                  value={form.ventOther ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, ventOther: e.target.value }))}
                />
              </div>
            </div>
          </section>

          {/* Section 3: Satellite Dish */}
          <section className="oqpc-section">
            <h2 className="oqpc-section-title">📡 Satellite Dish</h2>
            <div className="oqpc-form-group oqpc-form-group-narrow">
              <label className="oqpc-label oqpc-label-required" htmlFor="satelliteDish">Satellite Dish on Roof</label>
              <select
                id="satelliteDish"
                className="oqpc-select"
                value={form.satelliteDish ?? 'None'}
                onChange={(e) => setForm((f) => ({ ...f, satelliteDish: e.target.value }))}
              >
                <option value="None">None</option>
                <option value="Remove - Trash">Remove &amp; Trash (homeowner canceling service)</option>
                <option value="Remove - Reset">Remove &amp; Reset (homeowner keeping service)</option>
              </select>
            </div>
          </section>

          {/* Section 4: Bad Decking */}
          <section className="oqpc-section">
            <h2 className="oqpc-section-title">🔨 Bad Decking</h2>
            <div className="oqpc-form-grid">
              <div className="oqpc-form-group">
                <label className="oqpc-label oqpc-label-required" htmlFor="badDecking">Bad Decking Expectation</label>
                <select
                  id="badDecking"
                  className="oqpc-select"
                  value={form.badDecking ?? 'Unexpected'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((f) => ({ ...f, badDecking: v }));
                    setShowBadDeckingSheets(v === 'Expected');
                  }}
                >
                  <option value="Unexpected">Unexpected — I don&apos;t anticipate bad decking</option>
                  <option value="Expected">Expected — I know some sheets need replacing</option>
                </select>
              </div>
              {showBadDeckingSheets && (
                <div className="oqpc-form-group">
                  <label className="oqpc-label" htmlFor="badDeckingSheets">Estimated Number of Bad Sheets</label>
                  <input
                    type="number"
                    id="badDeckingSheets"
                    className="oqpc-input"
                    placeholder="0"
                    min={0}
                    value={form.badDeckingSheets ?? '0'}
                    onChange={(e) => setForm((f) => ({ ...f, badDeckingSheets: e.target.value }))}
                  />
                </div>
              )}
            </div>

            {/* Bad decking disclosure + ack */}
            <div className="oqpc-disclosure">{C.badDeckingDisclosure}</div>
            <div className="oqpc-ack-item">
              <input
                type="checkbox"
                className="oqpc-ack-checkbox"
                id="ackBadDecking"
                checked={!!(form.ackBadDecking)}
                onChange={(e) => setForm((f) => ({ ...f, ackBadDecking: e.target.checked }))}
              />
              <label className="oqpc-ack-label" htmlFor="ackBadDecking">
                {C.badDeckingAckLabel}
                <span className="oqpc-ack-sublabel">
                  {C.deckingRateSublabelLabel}{' '}
                  <strong>{deckingRateAckText(deckingRatePerSheet ?? null)}</strong>
                </span>
              </label>
            </div>
          </section>

          {/* Section 5: Chimneys */}
          <section className="oqpc-section">
            <h2 className="oqpc-section-title">🛖 Chimney Details</h2>
            <p className="oqpc-section-desc">If no chimney, leave all fields as N/A. Complete one card per chimney (up to 2).</p>
            <ChimneyCard num={1} prefix="chimney1" form={form} setForm={setForm} />
            <ChimneyCard num={2} prefix="chimney2" form={form} setForm={setForm} />
          </section>

          {/* Section 6: Skylights */}
          <section className="oqpc-section">
            <h2 className="oqpc-section-title">🪟 Skylight Details</h2>
            <p className="oqpc-section-desc">Select N/A for skylights that are not part of this project. Complete scope for each skylight that needs work (up to 4).</p>
            {skylights.map((sl, i) => (
              <SkylightCard
                key={i}
                index={i}
                data={sl}
                onChange={(updated) =>
                  setSkylights((prev) => {
                    const next = [...prev] as SkylightData[];
                    next[i] = updated;
                    return next;
                  })
                }
              />
            ))}
          </section>
        </>
      )}

      {/* ── Siding section ── */}
      {hasSiding && (
        <section className="oqpc-section">
          <h2 className="oqpc-section-title">🏠 Siding Details</h2>
          <div className="oqpc-callout oqpc-callout-info">
            <div className="oqpc-callout-icon">ℹ️</div>
            <div>
              <div className="oqpc-callout-title">Siding design already locked in</div>
              <div className="oqpc-callout-body">Your manufacturer, profile, color, and trim selections were captured during property design before bids were released. Contractors bid on those exact specifications — you don&apos;t need to re-enter them here.</div>
            </div>
          </div>
          <div className="oqpc-form-grid">
            <div className="oqpc-form-group">
              <label className="oqpc-label" htmlFor="soffitFascia">Soffit &amp; Fascia</label>
              <select
                id="soffitFascia"
                className="oqpc-select"
                value={form.soffitFascia ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, soffitFascia: e.target.value }))}
              >
                <option value="">Select…</option>
                <option value="Included">Included in scope</option>
                <option value="Not Included">Not included</option>
                <option value="Damaged Only">Included — damaged areas only</option>
              </select>
            </div>
            <div className="oqpc-form-group">
              <label className="oqpc-label" htmlFor="windowWraps">Window Wraps</label>
              <select
                id="windowWraps"
                className="oqpc-select"
                value={form.windowWraps ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => ({ ...f, windowWraps: v }));
                  setShowWindowWrapsColor(v === 'Included - All' || v === 'Included - Damaged Only');
                }}
              >
                <option value="">Select…</option>
                <option value="Included - All">Included — all windows</option>
                <option value="Included - Damaged Only">Included — damaged windows only</option>
                <option value="Not Included">Not included</option>
              </select>
              {showWindowWrapsColor && (
                <input
                  type="text"
                  className="oqpc-input"
                  style={{ marginTop: '0.5rem' }}
                  placeholder="Window wrap color…"
                  value={form.windowWrapsColor ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, windowWrapsColor: e.target.value }))}
                />
              )}
            </div>
          </div>

          {/* Rotten Sheathing */}
          <div className="oqpc-form-grid">
            <div className="oqpc-form-group">
              <label className="oqpc-label" htmlFor="rottenSheathing">Rotten Sheathing Expectation</label>
              <select
                id="rottenSheathing"
                className="oqpc-select"
                value={form.rottenSheathing ?? 'Unexpected'}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => ({ ...f, rottenSheathing: v }));
                  setShowRottenSheathingSqFt(v === 'Expected');
                }}
              >
                <option value="Unexpected">Unexpected — not anticipated</option>
                <option value="Expected">Expected — I know some exists</option>
              </select>
            </div>
            {showRottenSheathingSqFt && (
              <div className="oqpc-form-group">
                <label className="oqpc-label" htmlFor="rottenSheathingSqFt">Estimated sq ft of rotten sheathing</label>
                <input
                  type="number"
                  id="rottenSheathingSqFt"
                  className="oqpc-input"
                  min={0}
                  placeholder="0"
                  value={form.rottenSheathingSqFt ?? '0'}
                  onChange={(e) => setForm((f) => ({ ...f, rottenSheathingSqFt: e.target.value }))}
                />
              </div>
            )}
          </div>

          {/* Rotten sheathing disclosure + ack */}
          <div className="oqpc-disclosure">
            <h4 className="oqpc-disclosure-heading">{C.rottenSheathingHeading}</h4>
            <p>{C.rottenSheathingDisclosure}</p>
          </div>
          <div className="oqpc-ack-item">
            <input
              type="checkbox"
              className="oqpc-ack-checkbox"
              id="ackRottenSheathing"
              checked={!!(form.ackRottenSheathing)}
              onChange={(e) => setForm((f) => ({ ...f, ackRottenSheathing: e.target.checked }))}
            />
            <label className="oqpc-ack-label" htmlFor="ackRottenSheathing">
              {C.rottenSheathingAckLabel}
            </label>
          </div>
        </section>
      )}

      {/* ── Gutters section ── */}
      {hasGutters && (
        <section className="oqpc-section">
          <h2 className="oqpc-section-title">🌧️ Gutter Details</h2>
          <div className="oqpc-form-grid">
            <div className="oqpc-form-group">
              <label className="oqpc-label" htmlFor="gutterSize">Gutter Size</label>
              <select
                id="gutterSize"
                className="oqpc-select"
                value={form.gutterSize ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, gutterSize: e.target.value }))}
              >
                <option value="">Select size…</option>
                <option value='5" K-Style'>5&quot; K-Style (standard)</option>
                <option value='6" K-Style'>6&quot; K-Style (premium)</option>
                <option value="Half-Round">Half-Round</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="oqpc-form-group">
              <label className="oqpc-label" htmlFor="gutterColorInput">Gutter Color</label>
              <input
                type="text"
                id="gutterColorInput"
                className="oqpc-input"
                placeholder="e.g., White, Musket Brown, Bronze…"
                value={form.gutterColorInput ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, gutterColorInput: e.target.value }))}
              />
            </div>
            <div className="oqpc-form-group">
              <label className="oqpc-label" htmlFor="downspoutColorType">Downspout Color</label>
              <select
                id="downspoutColorType"
                className="oqpc-select"
                value={form.downspoutColorType ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => ({ ...f, downspoutColorType: v }));
                  setShowDownspoutColorOther(v === 'Other');
                }}
              >
                <option value="">Select…</option>
                <option value="Same as gutters">Same as gutters</option>
                <option value="Other">Different color</option>
              </select>
              {showDownspoutColorOther && (
                <input
                  type="text"
                  className="oqpc-input"
                  style={{ marginTop: '0.5rem' }}
                  placeholder="Downspout color…"
                  value={form.downspoutColorOther ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, downspoutColorOther: e.target.value }))}
                />
              )}
            </div>
            <div className="oqpc-form-group">
              <label className="oqpc-label" htmlFor="splashBlocks">Splash Blocks</label>
              <select
                id="splashBlocks"
                className="oqpc-select"
                value={form.splashBlocks ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, splashBlocks: e.target.value }))}
              >
                <option value="">Select…</option>
                <option value="Include">Include splash blocks</option>
                <option value="Replace Existing">Replace existing only</option>
                <option value="Not Needed">Not needed</option>
              </select>
            </div>
          </div>
          <div className="oqpc-form-group">
            <label className="oqpc-label" htmlFor="gutterNotes">Additional Gutter Notes (optional)</label>
            <textarea
              id="gutterNotes"
              className="oqpc-textarea"
              rows={3}
              placeholder="Any special gutter requirements, custom miters, end caps, etc.…"
              value={form.gutterNotes ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, gutterNotes: e.target.value }))}
            />
          </div>
        </section>
      )}

      {/* ── Windows (coming soon) ── */}
      {hasWindows && (
        <section className="oqpc-section">
          <h2 className="oqpc-section-title">🪟 Windows</h2>
          <div className="oqpc-windows-soon">
            <div className="oqpc-windows-icon">🪟</div>
            <div>
              <div className="oqpc-windows-title">Window scope confirmation is on the way.</div>
              <div className="oqpc-windows-body">We&apos;re finalizing the window scope workflow. Your project coordinator will reach out directly to confirm window specifications before your contractor begins work. No action needed from you on this page.</div>
            </div>
          </div>
        </section>
      )}

      {/* ── Section: Work NOT Being Done ── */}
      <section className="oqpc-section">
        <h2 className="oqpc-section-title">❌ Work NOT Being Done</h2>
        <div className="oqpc-form-group">
          <label className="oqpc-label" htmlFor="exclusions">Excluded Scope (Line Items or Trades)</label>
          <textarea
            id="exclusions"
            className="oqpc-textarea"
            rows={4}
            placeholder="List any line items from the estimate or any trades that are excluded from this scope of work. e.g., Chimney cap replacement, HVAC flashing, Interior water damage, Siding trade."
            value={form.exclusions ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, exclusions: e.target.value }))}
          />
        </div>
      </section>

      {/* ── Section: Project Notes ── */}
      <section className="oqpc-section">
        <h2 className="oqpc-section-title">💬 Project Notes</h2>
        <div className="oqpc-form-group">
          <label className="oqpc-label" htmlFor="projectNotes">Notes</label>
          <textarea
            id="projectNotes"
            className="oqpc-textarea"
            rows={4}
            placeholder="e.g., Gate code 1234. Dog in backyard — please call before entering. I work from home — prefer not to start before 8am."
            value={form.projectNotes ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, projectNotes: e.target.value }))}
          />
        </div>
      </section>

      {/* ── Section: Disclosures & Acknowledgments ── */}
      <section className="oqpc-section">
        <h2 className="oqpc-section-title">{C.disclosuresSectionTitle}</h2>
        <p className="oqpc-section-desc">{C.disclosuresIntro}</p>

        <div className="oqpc-ack-group">
          {/* Non-Recoverable Depreciation — hidden for retail */}
          {isInsurance && (
            <div className="oqpc-ack-item">
              <input
                type="checkbox"
                className="oqpc-ack-checkbox"
                id="ackDepreciation"
                checked={!!(form.ackDepreciation)}
                onChange={(e) => setForm((f) => ({ ...f, ackDepreciation: e.target.checked }))}
              />
              <label className="oqpc-ack-label" htmlFor="ackDepreciation">
                <div className="oqpc-disclosure">
                  {C.depreciationDisclosureLead}
                  <strong>{depreciationDisclosureAmountText(depreciation ?? null)}</strong>
                  {C.depreciationDisclosureTail}
                </div>
                {C.depreciationAckLabel}
                <span className="oqpc-ack-sublabel">{C.depreciationAckSublabel}</span>
              </label>
            </div>
          )}

          {/* Payment Terms */}
          <div className="oqpc-ack-item">
            <input
              type="checkbox"
              className="oqpc-ack-checkbox"
              id="ackPaymentTerms"
              checked={!!(form.ackPaymentTerms)}
              onChange={(e) => setForm((f) => ({ ...f, ackPaymentTerms: e.target.checked }))}
            />
            <label className="oqpc-ack-label" htmlFor="ackPaymentTerms">
              <div className="oqpc-disclosure">{C.paymentTermsDisclosure}</div>
              {C.paymentTermsAckLabel}
            </label>
          </div>

          {/* Project Changes */}
          <div className="oqpc-ack-item">
            <input
              type="checkbox"
              className="oqpc-ack-checkbox"
              id="ackProjectChanges"
              checked={!!(form.ackProjectChanges)}
              onChange={(e) => setForm((f) => ({ ...f, ackProjectChanges: e.target.checked }))}
            />
            <label className="oqpc-ack-label" htmlFor="ackProjectChanges">
              <div className="oqpc-disclosure">{C.projectChangesDisclosure}</div>
              {C.projectChangesAckLabel}
            </label>
          </div>

          {/* Info Correct */}
          <div className="oqpc-ack-item">
            <input
              type="checkbox"
              className="oqpc-ack-checkbox"
              id="ackInfoCorrect"
              checked={!!(form.ackInfoCorrect)}
              onChange={(e) => setForm((f) => ({ ...f, ackInfoCorrect: e.target.checked }))}
            />
            <label className="oqpc-ack-label" htmlFor="ackInfoCorrect">
              {C.infoCorrectLabel}
              <span className="oqpc-ack-sublabel">{C.infoCorrectSublabel}</span>
            </label>
          </div>
        </div>
      </section>

      {/* ── Submit ── */}
      <div className="oqpc-form-actions">
        {submitError && (
          <div className="oqpc-submit-error">{submitError}</div>
        )}
        <button
          type="button"
          id="submitBtn"
          className="oqpc-btn oqpc-btn-primary oqpc-btn-large"
          disabled={!submitEnabled || submitting}
          onClick={handleSubmit}
        >
          {submitting ? 'Submitting…' : C.submitCta}
        </button>
        <a href="/dashboard" className="oqpc-back-link">← Back to Dashboard</a>
      </div>
    </Wrap>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StructureCard({
  index,
  data,
  onChange,
}: {
  index: number;
  data: StructureData;
  onChange: (updated: StructureData) => void;
}) {
  const up = (field: keyof StructureData, value: string) =>
    onChange({ ...data, [field]: value });

  return (
    <div className="oqpc-structure-card">
      <div className="oqpc-structure-header">
        <div className="oqpc-structure-num">{index + 1}</div>
        <div className="oqpc-form-group" style={{ flex: 1, margin: 0 }}>
          <input
            type="text"
            className="oqpc-input"
            style={{ fontWeight: 600 }}
            value={data.name}
            placeholder="Structure name (e.g., Main House)"
            onChange={(e) => up('name', e.target.value)}
          />
        </div>
      </div>
      <div className="oqpc-structure-scope-grid">
        <StructureScopeItem label="Roof — Asphalt">
          <select className="oqpc-select" value={data.roofAsphalt} onChange={(e) => up('roofAsphalt', e.target.value)}>
            <option value="">Select...</option>
            <option value="Full">FULL</option>
            <option value="Part/Repair">PART / REPAIR</option>
            <option value="None">NONE</option>
            <option value="Other">OTHER*</option>
          </select>
        </StructureScopeItem>
        <StructureScopeItem label="Roof — Metal">
          <select className="oqpc-select" value={data.roofMetal} onChange={(e) => up('roofMetal', e.target.value)}>
            <option value="None">NONE</option>
            <option value="Full">FULL</option>
            <option value="Unsure">UNSURE</option>
          </select>
        </StructureScopeItem>
        <StructureScopeItem label="Siding">
          <select className="oqpc-select" value={data.siding} onChange={(e) => up('siding', e.target.value)}>
            <option value="None">NONE</option>
            <option value="Full">FULL</option>
            <option value="Part/Repair">PART / REPAIR</option>
            <option value="Unsure">UNSURE</option>
          </select>
        </StructureScopeItem>
        <StructureScopeItem label="Gutters">
          <select className="oqpc-select" value={data.gutters} onChange={(e) => up('gutters', e.target.value)}>
            <option value="Unsure">UNSURE</option>
            <option value="No">NO</option>
            <option value="Yes">YES</option>
          </select>
        </StructureScopeItem>
        <StructureScopeItem label="Downspouts">
          <select className="oqpc-select" value={data.downspouts} onChange={(e) => up('downspouts', e.target.value)}>
            <option value="Unsure">UNSURE</option>
            <option value="No">NO</option>
            <option value="Yes">YES</option>
          </select>
        </StructureScopeItem>
      </div>
      <div className="oqpc-structure-skylight-row">
        <div className="oqpc-form-group">
          <label className="oqpc-label"># Skylights to REPLACE</label>
          <input
            type="number"
            className="oqpc-input"
            value={data.skylightsReplace}
            min={0}
            max={20}
            placeholder="0"
            onChange={(e) => up('skylightsReplace', e.target.value)}
          />
        </div>
        <div className="oqpc-form-group">
          <label className="oqpc-label"># Skylights to REFLASH</label>
          <input
            type="number"
            className="oqpc-input"
            value={data.skylightsReflash}
            min={0}
            max={20}
            placeholder="0"
            onChange={(e) => up('skylightsReflash', e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function StructureScopeItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="oqpc-scope-item">
      <div className="oqpc-scope-label">{label}</div>
      {children}
    </div>
  );
}

function SkylightCard({
  index,
  data,
  onChange,
}: {
  index: number;
  data: SkylightData;
  onChange: (updated: SkylightData) => void;
}) {
  const isActive = data.scope !== 'N/A';

  return (
    <div className={`oqpc-skylight-card${isActive ? ' active' : ''}`}>
      <div className="oqpc-skylight-header">
        <div className="oqpc-skylight-num">{index + 1}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1 }}>
          <span className="oqpc-skylight-title">Skylight #{index + 1}</span>
          <select
            className="oqpc-select"
            style={{ maxWidth: 200 }}
            value={data.scope}
            onChange={(e) => onChange({ ...data, scope: e.target.value })}
          >
            <option value="N/A">N/A — Not Part of This Project</option>
            <option value="Reflash">REFLASH</option>
            <option value="Replace">REPLACE</option>
          </select>
        </div>
      </div>
      {isActive && (
        <div className="oqpc-form-grid">
          <div className="oqpc-form-group">
            <label className="oqpc-label">Length (inches)</label>
            <input
              type="number"
              className="oqpc-input"
              value={data.length ?? ''}
              placeholder="e.g., 24"
              min={0}
              onChange={(e) => onChange({ ...data, length: e.target.value })}
            />
          </div>
          <div className="oqpc-form-group">
            <label className="oqpc-label">Width (inches)</label>
            <input
              type="number"
              className="oqpc-input"
              value={data.width ?? ''}
              placeholder="e.g., 36"
              min={0}
              onChange={(e) => onChange({ ...data, width: e.target.value })}
            />
          </div>
          <div className="oqpc-form-group">
            <label className="oqpc-label">Hinge Position</label>
            <select
              className="oqpc-select"
              value={data.hinge ?? 'Top Hinge'}
              onChange={(e) => onChange({ ...data, hinge: e.target.value })}
            >
              <option value="Top Hinge">Top Hinge</option>
              <option value="Middle Hinge">Middle Hinge</option>
            </select>
          </div>
          <div className="oqpc-form-group">
            <label className="oqpc-label">Operation</label>
            <select
              className="oqpc-select"
              value={data.operation ?? 'None'}
              onChange={(e) => onChange({ ...data, operation: e.target.value })}
            >
              <option value="None">None (Fixed)</option>
              <option value="Manual">Manual</option>
              <option value="Solar">Solar</option>
              <option value="Electric">Electric</option>
            </select>
          </div>
          <div className="oqpc-form-group">
            <label className="oqpc-label">Blinds</label>
            <select
              className="oqpc-select"
              value={data.blinds ?? 'No Blinds'}
              onChange={(e) => onChange({ ...data, blinds: e.target.value })}
            >
              <option value="No Blinds">No Blinds</option>
              <option value="Room-Darkening">Room-Darkening</option>
              <option value="Light Filtering">Light Filtering</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

function ChimneyCard({
  num,
  prefix,
  form,
  setForm,
}: {
  num: number;
  prefix: 'chimney1' | 'chimney2';
  form: ConfirmationFormValues;
  setForm: React.Dispatch<React.SetStateAction<ConfirmationFormValues>>;
}) {
  const mat = `${prefix}Material` as keyof ConfirmationFormValues;
  const sz = `${prefix}Size` as keyof ConfirmationFormValues;
  const cric = `${prefix}Cricket` as keyof ConfirmationFormValues;
  const ref = `${prefix}Reflash` as keyof ConfirmationFormValues;

  return (
    <div className="oqpc-structure-card" style={{ marginBottom: '1.25rem' }}>
      <div className="oqpc-structure-header">
        <div className="oqpc-structure-num">{num}</div>
        <div className="oqpc-structure-title">Chimney #{num}</div>
      </div>
      <div className="oqpc-structure-scope-grid">
        <StructureScopeItem label="Material">
          <select className="oqpc-select" value={(form[mat] as string) ?? (num === 1 ? 'N/A' : 'N/A')} onChange={(e) => setForm((f) => ({ ...f, [mat]: e.target.value }))}>
            <option value="N/A">{num === 1 ? 'N/A — No Chimney' : 'N/A — No Second Chimney'}</option>
            <option value="Brick">Brick</option>
            <option value="Vinyl">Vinyl</option>
            <option value="Hardie/LP">Hardie / LP</option>
            <option value="Wood">Wood</option>
            <option value="Other">Other</option>
          </select>
        </StructureScopeItem>
        <StructureScopeItem label="Size">
          <select className="oqpc-select" value={(form[sz] as string) ?? 'N/A'} onChange={(e) => setForm((f) => ({ ...f, [sz]: e.target.value }))}>
            <option value="N/A">N/A</option>
            <option value="Small">Small</option>
            <option value="Medium">Medium</option>
            <option value="Large">Large</option>
            <option value="X-Large">X-Large</option>
          </select>
        </StructureScopeItem>
        <StructureScopeItem label="Cricket">
          <select className="oqpc-select" value={(form[cric] as string) ?? 'No'} onChange={(e) => setForm((f) => ({ ...f, [cric]: e.target.value }))}>
            <option value="No">No</option>
            <option value="Yes">Yes</option>
          </select>
        </StructureScopeItem>
        <StructureScopeItem label="Reflash">
          <select className="oqpc-select" value={(form[ref] as string) ?? 'N/A'} onChange={(e) => setForm((f) => ({ ...f, [ref]: e.target.value }))}>
            <option value="N/A">N/A</option>
            <option value="No - Homeowner will NOT pay OOP">No — Homeowner will NOT pay OOP</option>
            <option value="Yes - Homeowner will pay OOP">Yes — Homeowner will pay OOP</option>
          </select>
        </StructureScopeItem>
      </div>
    </div>
  );
}

// ── Presentational helpers ─────────────────────────────────────────────────────

function Boot() {
  return (
    <div className="oqpc-boot">
      <div className="oqpc-spin" />
    </div>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="oqpc-wrap">{children}</div>;
}

function GatePanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="oqpc-panel oqpc-panel-info">
      <h1 className="oqpc-panel-title">{title}</h1>
      <p className="oqpc-panel-body">{body}</p>
      <a className="oqpc-btn oqpc-btn-primary" href="/dashboard">Go to My Dashboard →</a>
    </div>
  );
}

function ErrorPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="oqpc-error">
      <div className="oqpc-error-icon">⚠️</div>
      <p className="oqpc-error-title">{title}</p>
      <p className="oqpc-error-detail">{detail}</p>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const STYLES = `
  .oqpc-boot, .oqpc-return { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; gap:1rem; color:var(--white,#fff); }
  .oqpc-return p { color:var(--green,#10b981); font-size:1.2rem; }
  .oqpc-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:oqpc-spin .8s linear infinite; }
  @keyframes oqpc-spin { to { transform:rotate(360deg); } }
  .oqpc-wrap { max-width:860px; margin:0 auto; padding:2rem 1.5rem 3rem; color:var(--white,#fff); }
  .oqpc-head { margin-bottom:1.5rem; }
  .oqpc-title { font-size:1.6rem; margin:0 0 .35rem; }
  .oqpc-subtitle { color:var(--slate,#94a3b8); font-size:.95rem; margin:0; }
  .oqpc-btn { display:inline-block; border:none; border-radius:8px; padding:.7rem 1.4rem; font-size:.95rem; font-weight:700; cursor:pointer; font-family:inherit; text-decoration:none; }
  .oqpc-btn:disabled { opacity:.5; cursor:not-allowed; }
  .oqpc-btn-primary { background:var(--amber,#E07B00); color:var(--navy,#0B1929); }
  .oqpc-btn-primary:hover:not(:disabled) { filter:brightness(1.05); }
  .oqpc-btn-large { padding:.85rem 2rem; font-size:1rem; }
  .oqpc-back-link { color:var(--slate,#94a3b8); text-decoration:none; font-size:.9rem; }
  .oqpc-back-link:hover { color:var(--white,#fff); }
  .oqpc-section { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); border-radius:12px; padding:1.5rem; margin-bottom:1.25rem; }
  .oqpc-section-title { font-size:1.15rem; margin:0 0 .5rem; display:flex; align-items:center; gap:.5rem; }
  .oqpc-section-desc { color:var(--slate,#94a3b8); font-size:.92rem; margin:0 0 1.25rem; }
  .oqpc-badge { background:rgba(224,123,0,0.15); color:var(--amber,#E07B00); font-size:.72rem; font-weight:700; padding:.2rem .55rem; border-radius:4px; text-transform:uppercase; }
  .oqpc-form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:1rem; margin-bottom:1rem; }
  .oqpc-form-group { display:flex; flex-direction:column; gap:.35rem; }
  .oqpc-form-group-narrow { max-width:280px; margin-bottom:1.25rem; }
  .oqpc-form-group-full { grid-column:1/-1; }
  .oqpc-label { font-size:.87rem; font-weight:600; color:var(--slate,#94a3b8); }
  .oqpc-label-required::after { content:" *"; color:#ef4444; }
  .oqpc-input, .oqpc-select, .oqpc-textarea { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12); border-radius:7px; padding:.6rem .85rem; color:var(--white,#fff); font-family:inherit; font-size:.92rem; }
  .oqpc-input:focus, .oqpc-select:focus, .oqpc-textarea:focus { outline:none; border-color:var(--amber,#E07B00); }
  .oqpc-input-error { border-color:#ef4444 !important; }
  .oqpc-field-error { color:#ef4444; font-size:.8rem; }
  .oqpc-select { cursor:pointer; }
  .oqpc-textarea { resize:vertical; min-height:80px; }
  .oqpc-vents { margin-top:1.25rem; padding-top:1.25rem; border-top:1px solid rgba(255,255,255,0.06); display:flex; flex-direction:column; gap:.6rem; }
  .oqpc-vent-row { display:flex; align-items:center; gap:.75rem; }
  .oqpc-vent-label { min-width:160px; font-size:.87rem; color:var(--slate,#94a3b8); }
  .oqpc-count-input { width:80px; }
  .oqpc-contractor-card { display:flex; gap:1rem; align-items:center; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:1.25rem; margin-bottom:1.25rem; }
  .oqpc-contractor-avatar { width:52px; height:52px; border-radius:50%; background:rgba(224,123,0,0.15); display:flex; align-items:center; justify-content:center; font-size:1.3rem; font-weight:700; color:var(--amber,#E07B00); flex-shrink:0; overflow:hidden; }
  .oqpc-contractor-avatar img { width:100%; height:100%; object-fit:cover; }
  .oqpc-contractor-name { font-weight:700; font-size:1.05rem; }
  .oqpc-contractor-meta { color:var(--slate,#94a3b8); font-size:.87rem; margin:.2rem 0 .4rem; }
  .oqpc-contractor-badge { font-size:.8rem; color:var(--green,#10b981); font-weight:600; }
  .oqpc-autofill { background:rgba(224,123,0,0.06); border:1px solid rgba(224,123,0,0.2); border-radius:12px; padding:1.25rem; margin-bottom:1.25rem; }
  .oqpc-autofill-header { display:flex; align-items:center; gap:.6rem; margin-bottom:.75rem; }
  .oqpc-autofill-title { font-size:.95rem; font-weight:700; margin:0; }
  .oqpc-autofill-tag { background:rgba(224,123,0,0.18); color:var(--amber,#E07B00); font-size:.7rem; font-weight:700; padding:.15rem .45rem; border-radius:4px; text-transform:uppercase; margin-left:auto; }
  .oqpc-autofill-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:.75rem; }
  .oqpc-autofill-label { font-size:.78rem; color:var(--slate,#94a3b8); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .oqpc-autofill-value { font-size:.92rem; color:var(--white,#fff); margin-top:.2rem; }
  .oqpc-structure-card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.09); border-radius:10px; padding:1rem; margin-bottom:.85rem; }
  .oqpc-structure-header { display:flex; align-items:center; gap:.75rem; margin-bottom:.85rem; }
  .oqpc-structure-num { width:28px; height:28px; border-radius:50%; background:var(--amber,#E07B00); color:var(--navy,#0B1929); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:.87rem; flex-shrink:0; }
  .oqpc-structure-title { font-weight:600; font-size:.95rem; }
  .oqpc-structure-scope-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:.75rem; margin-bottom:.85rem; }
  .oqpc-scope-item { display:flex; flex-direction:column; gap:.3rem; }
  .oqpc-scope-label { font-size:.78rem; color:var(--slate,#94a3b8); font-weight:600; }
  .oqpc-structure-skylight-row { display:grid; grid-template-columns:1fr 1fr; gap:.75rem; }
  .oqpc-skylight-card { background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.07); border-radius:10px; padding:1rem; margin-bottom:.85rem; opacity:.6; }
  .oqpc-skylight-card.active { opacity:1; border-color:rgba(224,123,0,0.3); }
  .oqpc-skylight-header { display:flex; align-items:center; gap:.75rem; margin-bottom:.75rem; }
  .oqpc-skylight-num { width:26px; height:26px; border-radius:50%; background:rgba(255,255,255,0.1); color:var(--white,#fff); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:.82rem; flex-shrink:0; }
  .oqpc-skylight-title { font-size:.9rem; font-weight:600; }
  .oqpc-disclosure { background:rgba(255,255,255,0.04); border-left:3px solid rgba(224,123,0,0.5); border-radius:0 6px 6px 0; padding:.85rem 1rem; font-size:.88rem; line-height:1.65; color:var(--slate,#94a3b8); margin:.75rem 0; }
  .oqpc-disclosure-heading { font-weight:700; color:var(--white,#fff); margin:0 0 .5rem; font-size:.95rem; }
  .oqpc-ack-group { display:flex; flex-direction:column; gap:1rem; }
  .oqpc-ack-item { display:flex; gap:.75rem; align-items:flex-start; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); border-radius:9px; padding:.9rem 1.1rem; }
  .oqpc-ack-checkbox { margin-top:.2rem; width:18px; height:18px; flex:0 0 auto; accent-color:var(--amber,#E07B00); cursor:pointer; }
  .oqpc-ack-label { cursor:pointer; font-size:.9rem; line-height:1.55; color:var(--white,#fff); }
  .oqpc-ack-sublabel { display:block; color:var(--slate,#94a3b8); font-size:.8rem; margin-top:.3rem; }
  .oqpc-form-actions { display:flex; align-items:center; gap:1.5rem; flex-wrap:wrap; margin-top:1.5rem; }
  .oqpc-submit-error { width:100%; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:.75rem 1rem; color:#ef4444; font-size:.9rem; }
  .oqpc-callout { display:flex; gap:1rem; background:#FFFBEB; border:1px solid #E07B00; border-radius:10px; padding:1rem 1.25rem; margin-bottom:1rem; }
  .oqpc-callout-icon { font-size:1.4rem; line-height:1.2; }
  .oqpc-callout-title { color:#0B1929; font-weight:700; margin-bottom:.25rem; font-size:.93rem; }
  .oqpc-callout-body { color:#374151; font-size:.87rem; line-height:1.6; }
  .oqpc-success { text-align:center; padding:2rem 0; }
  .oqpc-success-icon { font-size:2.5rem; margin-bottom:.5rem; }
  .oqpc-success-title { font-size:1.6rem; margin:0 0 .5rem; }
  .oqpc-success-subtitle { color:var(--slate,#94a3b8); font-size:.95rem; margin:0 0 1.5rem; }
  .oqpc-ef-failed { text-align:center; padding:2rem 0; }
  .oqpc-ef-failed-icon { font-size:2.2rem; margin-bottom:.5rem; }
  .oqpc-ef-failed-title { font-size:1.4rem; margin:0 0 .75rem; }
  .oqpc-ef-failed-body { color:var(--slate,#94a3b8); font-size:.95rem; line-height:1.6; margin:0 0 1.5rem; max-width:500px; margin-left:auto; margin-right:auto; }
  .oqpc-panel { text-align:center; padding:2.5rem 1.5rem; border-radius:12px; }
  .oqpc-panel-info { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); }
  .oqpc-panel-title { font-size:1.3rem; margin:0 0 .6rem; }
  .oqpc-panel-body { color:var(--slate,#94a3b8); font-size:.95rem; line-height:1.6; max-width:520px; margin:0 auto 1.5rem; }
  .oqpc-error { text-align:center; padding:1.75rem 1.5rem; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.3); border-radius:12px; }
  .oqpc-error-icon { font-size:2rem; margin-bottom:.5rem; }
  .oqpc-error-title { color:#ef4444; font-weight:600; margin:0 0 .35rem; }
  .oqpc-error-detail { color:var(--slate,#94a3b8); font-size:.9rem; margin:0; }
  .oqpc-windows-soon { display:flex; align-items:flex-start; gap:1rem; background:rgba(99,102,241,0.06); border:1px solid rgba(99,102,241,0.2); border-radius:9px; padding:1.25rem; }
  .oqpc-windows-icon { font-size:1.6rem; flex-shrink:0; margin-top:2px; }
  .oqpc-windows-title { font-weight:600; margin-bottom:.35rem; }
  .oqpc-windows-body { font-size:.9rem; color:var(--slate,#94a3b8); line-height:1.6; }
  @media (max-width:768px){ .oqpc-wrap{ padding:1.5rem 1rem 2.5rem; } .oqpc-structure-scope-grid{ grid-template-columns:repeat(2,1fr); } }
`;
