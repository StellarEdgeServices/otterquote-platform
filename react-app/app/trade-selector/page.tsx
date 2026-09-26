/**
 * Trade Selector — D-211 Phase 2
 *
 * Auth-protected homeowner intake wizard (step 2 of intake flow).
 * Feature-parity with static trade-selector.html.
 *
 * Step sequences:
 *   Insurance path:  Funding → Policy Type → Trades → Repair/Replace  (4 steps)
 *   Cash/retail path: Funding → Trades → Repair/Replace                (3 steps)
 *
 * On completion:
 *   - Reads cs_signup from localStorage for profile data
 *   - Upserts profiles table
 *   - Inserts or updates claims table
 *   - Redirects to repair-intake (if any repair) or dashboard (if replace/cash)
 *
 * References: D-211 (React surface), D-189 (HubSpot), F-007 (auth)
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ReactNode, ChangeEvent } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { readReferralIds, clearReferralIds } from '@/lib/cookie-storage';
import { recordFirstTouch } from '@/lib/attribution';
import { isTestEmail } from '@/lib/test-signal';
import { parseAddress, fullAddress, isValidZip, hasFullAddress, type ParsedAddress } from './utils';
import { gtagEventBeforeNavigation } from '@/lib/ga-events';

// ─── Constants ────────────────────────────────────────────────────────────────

const DASHBOARD_URL = 'https://otterquote.com/dashboard.html';
const REPAIR_INTAKE_URL = 'https://otterquote.com/repair-intake.html';
// gh-1276: dedicated project-information page per payment path (mirrors the
// pre-existing repair-intake.html split) — RCV/ACV/Cash previously all
// landed on DASHBOARD_URL directly with no guided collection step.
const PROJECT_INFO_RCV_URL = 'https://otterquote.com/project-info-rcv.html';
const PROJECT_INFO_ACV_URL = 'https://otterquote.com/project-info-acv.html';
const PROJECT_INFO_CASH_URL = 'https://otterquote.com/project-info-cash.html';
const GET_STARTED_URL = '/get-started';
// gh-2070: single versioned sessionStorage key for a loss sheet staged before
// a claim id exists — read by attachPendingLossSheetToClaim once
// handleComplete knows savedClaimId. Distinct from the legacy
// `oq_pending_loss_sheet` filename-only key used for the signed-out path.
const PENDING_LOSS_SHEET_KEY = 'oq_pending_loss_sheet_v1';

type FundingType = 'insurance' | 'cash' | null;
type PolicyType = 'rcv' | 'acv' | 'idk' | null;
type TradeKey = 'roofing' | 'siding' | 'gutters' | 'windows';
type RepairIntent = 'repair' | 'replace';

const TRADE_OPTIONS: { key: TradeKey; label: string; icon: string }[] = [
  { key: 'roofing', label: 'Roofing', icon: '🏠' },
  { key: 'siding', label: 'Siding', icon: '🧱' },
  { key: 'gutters', label: 'Gutters', icon: '💧' },
  { key: 'windows', label: 'Windows', icon: '🪟' },
];

// gh-1991: get-started Step 1's "what do you need help with?" chip
// (cs_signup.project_type) pre-selects the matching trade here so a
// homeowner who already said "Gutters" doesn't have to say it twice.
// Keys are get-started's ProjectType values 1:1 — 'other' and '' (unset)
// intentionally have no entry, so they fall through to no pre-selection.
// FIX ROUND 2 (PR #1998 comment 5700692978, non-blocking #4): a Map (rather
// than a plain object indexed by an arbitrary string) sidesteps prototype
// lookups entirely — .get() never resolves 'constructor'/'toString'/etc.
// against Object.prototype the way `obj[projectType]` can.
const PROJECT_TYPE_TO_TRADE: ReadonlyMap<string, TradeKey> = new Map([
  ['roof', 'roofing'],
  ['siding', 'siding'],
  ['gutters', 'gutters'],
  ['windows', 'windows'],
]);

// gh-2004: 50 states + DC + Puerto Rico — byte-for-byte the same list as
// get-started/page.tsx's STATE_CODE_OPTIONS (kept local rather than
// imported, matching that file's own "no cross-feature dependency" choice)
// so a homeowner who lands here with no cs_signup/profile address sees the
// identical state picker get-started already shipped in #1993/#1998.
const STATE_CODE_OPTIONS: { value: string; label: string }[] = [
  { value: 'AL', label: 'Alabama' }, { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' }, { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' }, { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' }, { value: 'DE', label: 'Delaware' },
  { value: 'DC', label: 'District of Columbia' }, { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' }, { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' }, { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' }, { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' }, { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' }, { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' }, { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' }, { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' }, { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' }, { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' }, { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' }, { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' }, { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' }, { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' }, { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' }, { value: 'PR', label: 'Puerto Rico' },
  { value: 'RI', label: 'Rhode Island' }, { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' }, { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' }, { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' }, { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' }, { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' }, { value: 'WY', label: 'Wyoming' },
];

interface AddressFormState {
  street: string;
  city: string;
  state: string;
  zip: string;
}

const EMPTY_ADDRESS_FORM: AddressFormState = { street: '', city: '', state: '', zip: '' };

interface WizardState {
  fundingType: FundingType;
  policyType: PolicyType;
  trades: TradeKey[];
  repairReplace: Partial<Record<TradeKey, RepairIntent>>;
}

// ─── GA4 helper ──────────────────────────────────────────────────────────────

function gtag(...args: unknown[]) {
  if (typeof window !== 'undefined' && (window as any).gtag) {
    (window as any).gtag(...args);
  }
}

// ─── Referral resolution ─────────────────────────────────────────────────────

async function resolveReferralAgentId(partnerIdParam: string | null): Promise<string | null> {
  if (!partnerIdParam) return null;
  try {
    // Try unique_code match first
    const { data } = await supabase
      .rpc('get_referral_agents_public')
      .select('id')
      .eq('unique_code', partnerIdParam.toUpperCase())
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    if (data) return data.id;

    // Fall back to UUID match
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(partnerIdParam)) {
      const { data: byId } = await supabase
        .rpc('get_referral_agents_public')
        .select('id')
        .eq('id', partnerIdParam)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      if (byId) return byId.id;
    }
  } catch {
    // No match
  }
  return null;
}

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({
  totalSteps,
  currentStep,
}: {
  totalSteps: number;
  currentStep: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '1.5rem',
        marginBottom: '3rem',
      }}
    >
      {Array.from({ length: totalSteps }, (_, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 600,
              fontSize: '0.9rem',
              border: '2px solid var(--amber, #E07B00)',
              background:
                i < currentStep
                  ? 'var(--amber, #E07B00)'
                  : i === currentStep
                    ? 'var(--amber, #E07B00)'
                    : 'transparent',
              color:
                i <= currentStep
                  ? 'var(--navy, #0B1929)'
                  : 'var(--amber, #E07B00)',
              boxShadow:
                i === currentStep ? '0 0 16px rgba(224,123,0,0.3)' : 'none',
              transition: 'all 0.2s',
            }}
          >
            {i + 1}
          </div>
          {i < totalSteps - 1 && (
            <div
              style={{
                width: 40,
                height: 2,
                background:
                  i < currentStep
                    ? 'var(--amber, #E07B00)'
                    : 'rgba(224,123,0,0.2)',
                transition: 'background 0.2s',
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Card components ──────────────────────────────────────────────────────────

function SelectionCard({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: selected ? 'rgba(224,123,0,0.08)' : 'var(--navy-2, #0f2036)',
        border: `2px solid ${selected ? 'var(--amber, #E07B00)' : 'rgba(255,255,255,0.06)'}`,
        borderRadius: '12px',
        padding: '2rem',
        cursor: 'pointer',
        transition: 'all 0.2s',
        boxShadow: selected ? '0 0 24px rgba(224,123,0,0.15)' : 'none',
        transform: selected ? 'none' : undefined,
      }}
      onMouseEnter={e => {
        if (!selected) {
          (e.currentTarget as HTMLElement).style.borderColor = 'var(--amber, #E07B00)';
          (e.currentTarget as HTMLElement).style.boxShadow = '0 0 24px rgba(224,123,0,0.1)';
          (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
        }
      }}
      onMouseLeave={e => {
        if (!selected) {
          (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.06)';
          (e.currentTarget as HTMLElement).style.boxShadow = 'none';
          (e.currentTarget as HTMLElement).style.transform = 'none';
        }
      }}
    >
      {children}
    </div>
  );
}

function ActionButtons({
  onBack,
  onContinue,
  continueDisabled,
  continueLabel = 'Continue →',
  loading,
}: {
  onBack?: () => void;
  onContinue: () => void;
  continueDisabled?: boolean;
  continueLabel?: string;
  loading?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        gap: '1rem',
        marginTop: '3rem',
        flexWrap: 'wrap',
      }}
    >
      {onBack && (
        <button
          onClick={onBack}
          style={{
            padding: '12px 24px',
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'transparent',
            color: 'var(--white, #fff)',
            borderRadius: '8px',
            fontSize: '1rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.borderColor = 'var(--amber, #E07B00)';
            (e.currentTarget as HTMLElement).style.color = 'var(--amber, #E07B00)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.2)';
            (e.currentTarget as HTMLElement).style.color = 'var(--white, #fff)';
          }}
        >
          ← Back
        </button>
      )}
      <button
        onClick={onContinue}
        disabled={continueDisabled || loading}
        style={{
          padding: '12px 32px',
          border: 'none',
          background: 'var(--amber, #E07B00)',
          color: 'var(--navy, #0B1929)',
          borderRadius: '8px',
          fontSize: '1rem',
          fontWeight: 700,
          cursor: continueDisabled || loading ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
          opacity: continueDisabled ? 0.5 : 1,
          transition: 'all 0.15s',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        {loading && (
          <span
            style={{
              display: 'inline-block',
              width: 16,
              height: 16,
              border: '2px solid rgba(11,25,41,0.3)',
              borderTopColor: 'var(--navy, #0B1929)',
              borderRadius: '50%',
              animation: 'spin 0.6s linear infinite',
            }}
          />
        )}
        {continueLabel}
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TradeSelectorPage() {
  const { user, settled } = useAuthReady();

  // Wizard state
  const [wizardState, setWizardState] = useState<WizardState>({
    fundingType: null,
    policyType: null,
    trades: [],
    repairReplace: {},
  });
  const [currentStep, setCurrentStep] = useState(0);
  const [lossSheetFile, setLossSheetFile] = useState<File | null>(null);
  const [lossSheetUploading, setLossSheetUploading] = useState(false);
  const [lossSheetStatus, setLossSheetStatus] = useState('');

  // Completion state
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState('');

  // gh-2004: a returning homeowner who reaches this page without a live
  // `cs_signup` in localStorage (new device, cleared storage, or a plain
  // sign-in that skipped get-started) previously created a claim with
  // property_address/city/state/zip all NULL — example claim `9bea2213`.
  // `resolvedAddress` is the single source of truth every write site below
  // reads from; it stays null only while we are still checking cs_signup
  // and the profile, or while an address-less visitor is on the new
  // 'address' step. `addressResolving` gates the whole page the same way
  // `!settled` already does, so no step ever renders before we know
  // whether the address step is needed.
  const [resolvedAddress, setResolvedAddress] = useState<ParsedAddress | null>(null);
  const [addressResolving, setAddressResolving] = useState(true);
  const [needsAddressStep, setNeedsAddressStep] = useState(false);
  const [addressForm, setAddressForm] = useState<AddressFormState>(EMPTY_ADDRESS_FORM);
  const [addressFormError, setAddressFormError] = useState('');
  const [addressSaving, setAddressSaving] = useState(false);

  // gh-1991: pre-select the trade get-started's project_type chip already
  // told us. Read-only, runs once on mount; only applies while `trades` is
  // still empty so it can never clobber a selection the visitor made on
  // THIS page (e.g. after using Back). Not gated on auth `settled` — this
  // only touches local UI state, no network/DB call.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem('cs_signup');
      if (!raw) return;
      const signup = JSON.parse(raw) as Record<string, unknown>;
      const projectType = typeof signup.project_type === 'string' ? signup.project_type : '';
      const mapped = PROJECT_TYPE_TO_TRADE.get(projectType);
      if (mapped) {
        setWizardState(prev => (prev.trades.length === 0 ? { ...prev, trades: [mapped] } : prev));
      }
    } catch {
      // cs_signup missing/malformed — no prefill, not fatal
    }
  }, []);

  // gh-2004: resolve an address for this claim BEFORE any step renders,
  // trying — in order — (1) cs_signup's structured fields, (2) a legacy
  // cs_signup payload written before #1993 (a single combined string), (3)
  // the signed-in user's saved profile (the fix for the actual bug: a
  // returning homeowner with no live cs_signup). Only when all three come
  // up short do we ask the homeowner here. Every candidate must clear
  // hasFullAddress() (all four fields non-empty) before it is accepted —
  // never insert a claim with a NULL address field from this page, not
  // just never insert one with all four NULL.
  useEffect(() => {
    if (!settled || !user) return;
    let cancelled = false;

    (async () => {
      let csSignup: Record<string, unknown> = {};
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('cs_signup') : null;
        if (raw) csSignup = JSON.parse(raw);
      } catch {
        // cs_signup missing/malformed — treated the same as absent below
      }

      // 1. cs_signup's structured fields (get-started, post-#1993).
      const structured: ParsedAddress = {
        street: ((csSignup.address_street as string) || '').trim() || null,
        city: ((csSignup.address_city as string) || '').trim() || null,
        state: ((csSignup.address_state as string) || '').trim() || null,
        zip: ((csSignup.address_zip as string) || '').trim() || null,
      };
      if (hasFullAddress(structured)) {
        if (!cancelled) { setResolvedAddress(structured); setAddressResolving(false); }
        return;
      }

      // 2. A legacy cs_signup payload (pre-#1993, combined string only).
      const legacyParsed = parseAddress((csSignup.address as string) || '');
      if (hasFullAddress(legacyParsed)) {
        if (!cancelled) { setResolvedAddress(legacyParsed); setAddressResolving(false); }
        return;
      }

      // 3. gh-2004: no usable cs_signup — fall back to the profile this
      // user already saved (verified live: profiles.address_street/
      // address_city/address_state/address_zip all exist, nullable text).
      try {
        const { data: profileRow } = await supabase
          .from('profiles')
          .select('address_street, address_city, address_state, address_zip')
          .eq('id', user.id)
          .maybeSingle();
        const fromProfile: ParsedAddress = {
          street: (profileRow?.address_street || '').trim() || null,
          city: (profileRow?.address_city || '').trim() || null,
          state: (profileRow?.address_state || '').trim() || null,
          zip: (profileRow?.address_zip || '').trim() || null,
        };
        if (hasFullAddress(fromProfile)) {
          if (!cancelled) { setResolvedAddress(fromProfile); setAddressResolving(false); }
          return;
        }
      } catch (e) {
        console.warn('[trade-selector] gh-2004 profile address lookup failed:', e);
      }

      // 4. Nothing usable anywhere — ask the homeowner on the new step.
      if (!cancelled) {
        setNeedsAddressStep(true);
        setAddressResolving(false);
      }
    })();

    return () => { cancelled = true; };
  }, [settled, user]);

  // Auth guard + returning-user guard
  useEffect(() => {
    if (!settled) return;

    if (!user) {
      window.location.href = GET_STARTED_URL;
      return;
    }

    // Returning-user guard: if user already has a claim, skip intake
    const checkExistingClaim = async () => {
      try {
        const { data: existingClaim } = await supabase
          .from('claims')
          .select('id')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingClaim) {
          window.location.href = DASHBOARD_URL;
        }
      } catch (e) {
        console.warn('[trade-selector] returning-user guard failed:', e);
      }
    };

    checkExistingClaim();

    // Capture referral params from URL into sessionStorage
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get('ref');
      const partnerId = params.get('partner_id');
      if (ref) sessionStorage.setItem('oq_referral_source', ref.trim().toLowerCase());
      if (partnerId) sessionStorage.setItem('oq_partner_id', partnerId.trim());
    }
  }, [settled, user]);

  // ── Step sequence ──
  // gh-2004: 'address' only ever joins the sequence when the resolution
  // effect above found no usable address anywhere (cs_signup, legacy
  // cs_signup, profile). It always leads — the same position get-started
  // asks for it in — so a claim can never be created before it is answered.
  const baseSequence: string[] = wizardState.fundingType === 'insurance'
    ? ['funding', 'policy', 'trades', 'repair']
    : ['funding', 'trades', 'repair'];
  const stepSequence: string[] = needsAddressStep ? ['address', ...baseSequence] : baseSequence;
  const totalSteps = stepSequence.length;

  // ── Navigation ──
  const goToStep = useCallback((index: number) => {
    setCurrentStep(index);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  // ── Step 0 (gh-2004, only when needed): Address ──
  // Same field-by-field validation as get-started's validateHomeInfo() so
  // the two forms behave identically.
  const validateAddressForm = (): string | null => {
    if (!addressForm.street.trim()) return 'Please enter your street address.';
    if (!addressForm.city.trim()) return 'Please enter your city.';
    if (!addressForm.state.trim()) return 'Please select your state.';
    if (!isValidZip(addressForm.zip)) return 'Please enter a valid 5-digit ZIP code.';
    return null;
  };

  const handleAddressContinue = async () => {
    const validationError = validateAddressForm();
    if (validationError) {
      setAddressFormError(validationError);
      return;
    }
    setAddressFormError('');
    const parsed: ParsedAddress = {
      street: addressForm.street.trim(),
      city: addressForm.city.trim(),
      state: addressForm.state.trim(),
      zip: addressForm.zip.trim(),
    };
    setResolvedAddress(parsed);

    // gh-2004: write the address back to the profile right away — a
    // returning homeowner who hits this step once should never hit it
    // again. Non-fatal: handleComplete's own upsert (below) re-persists the
    // same values from resolvedAddress regardless of whether this succeeds.
    if (user) {
      setAddressSaving(true);
      try {
        await supabase.from('profiles').upsert({
          id: user.id,
          address_street: parsed.street,
          address_city: parsed.city,
          address_state: parsed.state,
          address_zip: parsed.zip,
          updated_at: new Date().toISOString(),
        });
      } catch (e) {
        console.warn('[trade-selector] gh-2004 address write-back to profile failed:', e);
      } finally {
        setAddressSaving(false);
      }
    }

    goToStep(stepSequence.indexOf('funding'));
  };

  // ── Step 1: Funding ──
  const handleFundingSelect = (type: 'insurance' | 'cash') => {
    setWizardState(prev => ({ ...prev, fundingType: type, policyType: null }));
    // gh-2004: was a bare `goToStep(1)`, which only worked because 'funding'
    // was always stepSequence[0] and the next step ('policy' or 'trades')
    // was always stepSequence[1]. Once 'address' can lead the sequence,
    // 'funding' is stepSequence[1] instead, so the fixed index would land
    // back on funding itself instead of advancing. indexOf('funding') + 1
    // is correct in both cases: index 0 (no address step) or 1 (address
    // step present) — the step immediately after funding either way.
    const fundingIdx = stepSequence.indexOf('funding');
    setTimeout(() => goToStep(fundingIdx + 1), 300);
  };

  // ── Step 2 (Insurance): Policy ──
  const handlePolicySelect = (type: PolicyType) => {
    setWizardState(prev => ({ ...prev, policyType: type }));
  };

  // ── Step 3: Trades ──
  const toggleTrade = (trade: TradeKey) => {
    setWizardState(prev => {
      const next = prev.trades.includes(trade)
        ? prev.trades.filter(t => t !== trade)
        : [...prev.trades, trade];
      return { ...prev, trades: next };
    });
  };

  // ── Step 4: Repair/Replace ──
  const setRepairIntent = (trade: TradeKey, intent: RepairIntent) => {
    setWizardState(prev => ({
      ...prev,
      repairReplace: { ...prev.repairReplace, [trade]: intent },
    }));
  };

  // Initialize repair/replace defaults when entering repair step
  const initRepairStep = useCallback(() => {
    setWizardState(prev => {
      const defaults: Partial<Record<TradeKey, RepairIntent>> = {};
      prev.trades.forEach(t => {
        defaults[t] = prev.repairReplace[t] ?? 'replace';
      });
      return { ...prev, repairReplace: defaults };
    });
  }, []);

  // ── Loss sheet upload ──
  const handleLossSheetUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLossSheetFile(file);
    setLossSheetUploading(true);
    setLossSheetStatus(`Uploading "${file.name}"...`);

    try {
      if (user) {
        const timestamp = Date.now();
        const filePath = `${user.id}/loss-sheets/${timestamp}-${file.name}`;
        const { error: uploadError } = await supabase.storage
          .from('claim-documents')
          .upload(filePath, file);
        if (uploadError) throw uploadError;
        // gh-2070: the claim row may not exist yet at this step (the wizard
        // hasn't reached handleComplete). Stage the reference so
        // attachPendingLossSheetToClaim can move it onto the claim and write
        // back has_estimate/estimate_filename once savedClaimId is known —
        // mirrors dashboard.html's checklist upload, which already has a
        // claim id at upload time and writes back immediately. `timestamp`
        // is carried through and reused (not regenerated) for the post-move
        // destination path — see attachPendingLossSheetToClaim — so a
        // second loss-sheet upload in the same session can't collide with
        // the first's already-moved object under the same claim.
        try {
          sessionStorage.setItem(
            PENDING_LOSS_SHEET_KEY,
            JSON.stringify({ storagePath: filePath, filename: file.name, userId: user.id, timestamp }),
          );
        } catch {
          // storage blocked — attach step below simply finds nothing staged
        }
        setLossSheetStatus(`"${file.name}" uploaded successfully. We'll review it and get back to you.`);
      } else {
        sessionStorage.setItem('oq_pending_loss_sheet', file.name);
        setLossSheetStatus(`"${file.name}" saved. We'll review it after you complete sign-up.`);
      }
    } catch (err) {
      console.error('[trade-selector] upload error:', err);
      setLossSheetStatus('Upload failed. Please try again or continue without uploading.');
    } finally {
      setLossSheetUploading(false);
    }
  };

  // gh-2070: move a loss sheet staged by handleLossSheetUpload onto the claim
  // once savedClaimId is known — called from BOTH handleComplete branches
  // (the existing-claim update and the new-claim insert) right after each
  // sets savedClaimId, so a homeowner who uploads before or after the claim
  // row exists gets the same outcome. Order matters for move + PATCH (move
  // -> PATCH has_estimate/estimate_filename) — see the trade-selector attach
  // vitest spec.
  //
  // Returns true when there was nothing to attach or the attach (move +
  // PATCH) succeeded, false when it failed — the caller (handleComplete)
  // uses this to surface a visible error, since this function has no render
  // access of its own to a reachable one (see below).
  //
  // REVIEW gh-2070 PR #2080: this function is itself `await`ed from
  // handleComplete, which is the homeowner's primary conversion path.
  // parse-loss-sheet (supabase/functions/parse-loss-sheet/index.ts:337-400)
  // synchronously downloads the PDF and makes a non-streaming Claude vision
  // call — routinely 15-60s, bounded only by the EF's 150s wall clock. The
  // first round of this fix `await`ed that invoke here, which meant a slow
  // or hung parse-loss-sheet call stalled the homeowner's redirect for the
  // same amount of time (worst case 150s+, or indefinitely on a
  // never-settling promise). Fixed: the invoke below is fire-and-forget
  // (`void ...catch(...)`, no `await`) — only the move and the PATCH, which
  // are fast and whose success this function's return value depends on,
  // are awaited.
  const attachPendingLossSheetToClaim = async (claimId: string): Promise<boolean> => {
    if (!user) return true;
    let staged: { storagePath: string; filename: string; userId: string; timestamp: number } | null = null;
    try {
      const raw = sessionStorage.getItem(PENDING_LOSS_SHEET_KEY);
      if (raw) staged = JSON.parse(raw);
    } catch {
      staged = null;
    }
    if (!staged) return true;
    // REVIEW gh-2070 PR #2080: a staged entry from a different signed-in
    // user (e.g. a shared machine) is discarded rather than attempted. Prod
    // RLS (`Users can update own files`, `USING foldername[1] = auth.uid()`,
    // no `WITH CHECK`) fails the move closed either way — no data leak —
    // but attempting it produces a confusing silent failure instead of this
    // explicit, understood no-op.
    if (staged.userId !== user.id) return true;

    const destPath = `${user.id}/${claimId}/${staged.timestamp}-${staged.filename}`;
    try {
      const { error: moveError } = await supabase.storage
        .from('claim-documents')
        .move(staged.storagePath, destPath);
      if (moveError) throw moveError;

      const { error: patchError } = await supabase
        .from('claims')
        .update({ has_estimate: true, estimate_filename: destPath })
        .eq('id', claimId);
      if (patchError) throw patchError;

      // REVIEW gh-2070 PR #2080: kept (not cleared) on failure below, but
      // that is not an active retry — nothing currently reads this key
      // again once handleComplete redirects away from this component, and
      // there is no path back to it for this claim. This just avoids
      // silently discarding the reference in case a future surface (e.g.
      // the dashboard) is built to read it.
      try {
        sessionStorage.removeItem(PENDING_LOSS_SHEET_KEY);
      } catch {
        // storage blocked — non-fatal, the attach itself already succeeded
      }

      // Parsing is fire-and-forget — see the REVIEW note above this
      // function. A parse failure (or a slow/hung EF call) must never delay
      // or fail completion (mirrors the INTENT, though not the `await`, of
      // dashboard/actions.ts's uploadClaimDocument, #336).
      void supabase.functions.invoke('parse-loss-sheet', {
        body: { claim_id: claimId, storage_path: destPath },
      }).catch((parseErr) => {
        console.warn('[trade-selector] parse-loss-sheet failed (non-fatal):', parseErr);
      });
      return true;
    } catch (attachErr) {
      console.warn('[trade-selector] loss sheet attach failed:', attachErr);
      // REVIEW gh-2070 PR #2080: setLossSheetStatus is NOT used here — that
      // state only renders inside the policy step's "I'm Not Sure" panel,
      // which is unmounted by the time handleComplete runs from a later
      // step, making it silent dead code in practice. The caller surfaces
      // this failure via the page-level error banner instead (rendered
      // regardless of wizard step) and extends the pre-redirect delay so it
      // is actually visible — see handleComplete.
      return false;
    }
  };

  // ── Completion ──
  const handleComplete = async () => {
    setCompleting(true);
    setError('');

    try {
      const { trades, repairReplace, fundingType, policyType } = wizardState;

      // Determine job type
      const hasRepair = trades.some(t => repairReplace[t] === 'repair');
      let jobType: string;
      if (fundingType === 'insurance') {
        if (hasRepair) jobType = 'repair';
        else if (policyType === 'acv') jobType = 'insurance_acv';
        else jobType = 'insurance_rcv';
      } else {
        jobType = 'retail';
      }

      // gh-1276: captured below (existingClaim.id or the insert's returned
      // id) and passed through the redirect URL — see the redirect logic
      // near the end of this function.
      let savedClaimId: string | null = null;
      // gh-2070: set by attachPendingLossSheetToClaim's return value when a
      // staged loss sheet's move/PATCH failed — read below to surface the
      // error banner and extend the pre-redirect delay.
      let lossSheetAttachFailed = false;
      // gh-1984: analytics sends awaited (bounded) before the redirect below.
      const analyticsSends: Promise<void>[] = [];

      // Read cs_signup profile data from localStorage
      let csSignup: Record<string, unknown> = {};
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('cs_signup') : null;
        if (raw) csSignup = JSON.parse(raw);
      } catch {
        // cs_signup missing — continue with empty
      }

      // gh-2004: the address this claim uses comes from `resolvedAddress`,
      // set before this step was ever reachable — by the mount effect
      // (cs_signup's structured fields, a legacy cs_signup combined-string
      // parse, or the signed-in user's saved profile) or, if none of those
      // had one, by the homeowner filling in the new address step just
      // above. It is guaranteed non-null and hasFullAddress() by the time
      // Continue on the final step can be clicked — see the loading gate
      // and the 'address' step's own Continue handler. The `?? {...}`
      // fallback below is defense in depth only; every real path already
      // guarantees a value here.
      const parsedAddress: ParsedAddress = resolvedAddress ?? { street: null, city: null, state: null, zip: null };

      if (user) {
        // ── Upsert profiles table ──
        try {
          await supabase.from('profiles').upsert({
            id: user.id,
            role: 'homeowner',
            full_name: [(csSignup.first_name as string || '').trim(), (csSignup.last_name as string || '').trim()].filter(Boolean).join(' ') || null,
            phone: (csSignup.phone as string) || null,
            address_street: parsedAddress.street,
            address_city: parsedAddress.city,
            address_state: parsedAddress.state,
            address_zip: parsedAddress.zip,
            referral_source: (csSignup.referral_source as string) || null,
            sms_consent_ts: (csSignup.sms_consent_ts as string) || null,
            updated_at: new Date().toISOString(),
          });
        } catch (profileErr) {
          console.warn('[trade-selector] profile upsert failed:', profileErr);
        }

        // gh-1983: second chance to persist first-touch ad attribution (the
        // first is /auth-callback). Runs BEFORE the claim write so the claims
        // BEFORE INSERT trigger copies it onto the new claim; the RPC also
        // backfills an existing claim. Write-once and non-fatal.
        await recordFirstTouch(supabase);

        // ── Insert or update claims table ──
        try {
          const referralSource = sessionStorage.getItem('oq_referral_source') || null;
          const partnerIdParam = sessionStorage.getItem('oq_partner_id') || null;
          const referralAgentId = await resolveReferralAgentId(partnerIdParam);

          // #567: ref.html click-chain carry-forward — mirrors the static
          // trade-selector. localStorage survives the magic-link redirect, and
          // auth re-keys the id to oq_referral_id_for_claim after advancing.
          // Bridge 2026-08-26 (P0): cookie FIRST. These keys are written by
          // ref.html on otterquote.com; this page runs on app.otterquote.com,
          // and localStorage is ORIGIN-scoped — so every read below returned
          // null and claims.referral_id was silently never written. That is the
          // only column apply_referral_commission() walks.
          const refCookie = readReferralIds();
          const chainReferralId =
            refCookie.oq_referral_id ||
            sessionStorage.getItem('oq_referral_id') ||
            localStorage.getItem('oq_referral_id') ||
            localStorage.getItem('oq_referral_id_for_claim') ||
            null;
          const chainReferralAgentId =
            refCookie.oq_referral_agent_id ||
            sessionStorage.getItem('oq_referral_agent_id') ||
            localStorage.getItem('oq_referral_agent_id') ||
            null;
          const chainReferralCode =
            refCookie.oq_referral_code ||
            sessionStorage.getItem('oq_referral_code') ||
            localStorage.getItem('oq_referral_code') ||
            null;

          // Fetch existing claim
          const { data: existingClaim } = await supabase
            .from('claims')
            .select('id')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          // #482: static-stack parity — property_address/property_state must land
          // on the claim (contractor cards + D-178 state gating read them).
          // gh-1993 REVIEW: FAIL (PR #1998 comment 5698654086, B1/B2) +
          // CEO RULING (comment 5698876771): property_address STAYS the full
          // combined line ("street, city, ST zip"), not the street line
          // alone — notify-contractors, check-siding-design-completion, the
          // contractor opportunities card (D-074 city-before-street-reveal),
          // agreement_requested email/SMS, DocuSign customer_address and
          // color-selection.html's ZIP extraction all parse this column
          // expecting the combined shape.
          //
          // gh-2004: property_address is now built from `resolvedAddress`
          // via fullAddress() rather than read as the raw `csSignup.address`
          // string, because resolvedAddress may have come from the profile
          // fallback or the new address step, neither of which has a
          // pre-built combined string to read. For the get-started
          // cs_signup path this is byte-identical to before: get-started
          // itself builds cs_signup.address with this exact same
          // fullAddress(street, city, state, zip) call, so recomputing it
          // from the same four values reproduces the same string.
          // property_city/property_zip are the two additive columns (PR
          // #1998's migration, already applied to production) that carry
          // the split city/zip alongside the combined property_address.
          // gh-2004: never NULL — resolvedAddress is hasFullAddress() by
          // construction (see the mount effect and the address step above),
          // so all four of property_address/city/state/zip are always
          // populated from this page now, not just property_address.
          const claimPayload: Record<string, unknown> = {
            funding_type: fundingType,
            policy_type: policyType,
            trades: trades,
            job_type: jobType,
            property_address: fullAddress(
              parsedAddress.street || '',
              parsedAddress.city || '',
              parsedAddress.state || '',
              parsedAddress.zip || '',
            ) || null,
            property_city: parsedAddress.city,
            property_state: parsedAddress.state,
            property_zip: parsedAddress.zip,
            updated_at: new Date().toISOString(),
            ...(referralSource && { referral_source: referralSource }),
            ...(referralAgentId && { referral_agent_id: referralAgentId }),
            // #567: ref.html click-chain attribution — the only writer of
            // claims.referral_id (the commission trigger's key column).
            ...(chainReferralId && { referral_id: chainReferralId }),
            ...(!referralAgentId && chainReferralAgentId && { referral_agent_id: chainReferralAgentId }),
            ...(chainReferralCode && { referral_code: chainReferralCode }),
            // gh-1337: only write when get-started's checkbox actually ran —
            // undefined (cs_signup absent/stale/pre-dates this change) must
            // leave the column NULL ("never asked"), not FALSE ("did not opt
            // out"). Read by send-partner-status-email's consent gate.
            ...(typeof csSignup.referrer_updates_opt_out === 'boolean' && {
              referrer_updates_opt_out: csSignup.referrer_updates_opt_out,
            }),
          };
          // gh-1993 CEO RULING (comment 5698876771): property_city/
          // property_zip are applied to production now (Tier 3A additive,
          // verified present) — no pre-migration retry path. REVIEW: FAIL
          // B3 was correct that the retry this PR previously had only
          // matched 42703 (a SELECT-on-missing-column code) when PostgREST
          // actually rejects an insert/update payload naming an unknown
          // column with PGRST204, so the retry never would have fired
          // anyway. Rather than fix the error code, the columns are simply
          // live now, so there is no pre-migration window to guard and no
          // dead retry path to carry.

          // gh-2062 round 2 (REVIEW: FAIL): Supabase does not throw on a
          // failed write by default — there is no throwOnError() anywhere
          // in this repo — so an RLS denial or constraint violation
          // resolves normally as { data: null, error: {...} }. Round 1's
          // clear() below only checked whether a referral was PRESENT to
          // carry forward, not whether the write that was supposed to
          // carry it actually succeeded.
          //
          // gh-2062 round 3 (REVIEW: FAIL): error === null is NOT success.
          // An UPDATE without .select() that matches ZERO rows — e.g. RLS
          // silently filtering the WHERE match — also resolves with
          // error: null. "Consumed" means a row was actually WRITTEN, not
          // merely that the call did not complain. .select('id') added so
          // the affected row (if any) comes back and can be checked.
          let claimWriteSucceeded = false;
          if (existingClaim) {
            const { data: updatedRows, error: updateError } = await supabase
              .from('claims')
              .update(claimPayload)
              .eq('id', existingClaim.id)
              .select('id');
            claimWriteSucceeded = !updateError && Array.isArray(updatedRows) && updatedRows.length > 0;
            savedClaimId = existingClaim.id;
            if (!(await attachPendingLossSheetToClaim(existingClaim.id))) lossSheetAttachFailed = true;
          } else {
            // gh-397/#689: stamp is_test on this React parity insert path —
            // PR #714 only fixed the COI-identity contractor insert, never
            // any claims insert. Predicate mirrors the CEO-approved
            // contractor check (#543 / test-exclusion.ts).
            const { data: insertedClaim, error: insertError } = await supabase
              .from('claims')
              .insert({
                user_id: user.id,
                ...claimPayload,
                is_test: isTestEmail(user.email),
                created_at: new Date().toISOString(),
              })
              .select('id')
              .single();
            // gh-2062 round 3 audit: this insert branch does NOT have the
            // round-2 zero-rows gap. .single() requires EXACTLY one row
            // back from the .select('id') re-read — PostgREST/Supabase
            // errors (PGRST116) if the insert produced zero or more than
            // one row, so a silent zero-row success is not possible here
            // the way it was on the update branch. !!insertedClaim is
            // therefore redundant with !insertError in practice, but kept
            // as an explicit belt-and-suspenders row check to match the
            // update branch's shape.
            claimWriteSucceeded = !insertError && !!insertedClaim;
            // gh-1276: capture the new row's id — previously never captured
            // here either (same gap as the static trade-selector.html this
            // file keeps parity with), so repair-intake.html's
            // `params.get('claim_id') || sessionStorage.getItem('oq_claim_id')`
            // fallback always found neither and unconditionally inserted a
            // SECOND claim row for every repair-path homeowner using this
            // (the actually-live) React surface.
            if (insertedClaim) {
              savedClaimId = insertedClaim.id;
              if (!(await attachPendingLossSheetToClaim(insertedClaim.id))) lossSheetAttachFailed = true;
              // gh-1940/gh-1984: "claim started" funnel step — fires once,
              // only on the first claim row for this user (the `else`
              // branch above is an update to an already-started claim, not
              // a new start). #1988/gh-1984 already shipped this emission
              // on this exact surface (dedupe per gh-1940 ruling
              // 2026-09-16T13:12:08Z comment 5698022815) — kept as-is
              // rather than adding a second, PR #1979-local emission here.
              analyticsSends.push(
                gtagEventBeforeNavigation('claim_started', {
                  funding_type: fundingType,
                  policy_type: policyType,
                  job_type: jobType,
                  trades: trades.join(','),
                  source: 'trade_selector',
                  test_account: isTestEmail(user.email),
                }),
              );
            }
          }

          // #571: the claim_submitted advance now lives in the database —
          // trg_claims_advance_referral fires on the claims.referral_id
          // write above. The old client-side UPDATE always no-opped
          // against RLS and has been removed.

          // gh-2062: the referral id has now been consumed — stamped onto
          // claims.referral_id (or already resolved to referralAgentId, in
          // which case there was nothing left for the raw cookie to do).
          // Clear it so it cannot resurface on a later, unrelated signup on
          // the same browser within its 90-day TTL. Only clear when this
          // pass actually carried a referral forward AND the write that was
          // supposed to record it actually succeeded — round 2 (REVIEW:
          // FAIL): an RLS denial or constraint violation on the claim write
          // must leave a live, unconsumed referral cookie alone, not
          // destroy it out from under a partner who is still owed the
          // commission. Mirrors the static trade-selector.html claim writer.
          if ((chainReferralId || chainReferralAgentId) && claimWriteSucceeded) {
            clearReferralIds();
            localStorage.removeItem('oq_referral_id_for_claim');
          }
        } catch (claimErr) {
          console.warn('[trade-selector] claim upsert failed:', claimErr);
        }
      }

      // GA4 funnel event
      analyticsSends.push(gtagEventBeforeNavigation('trade_selector_complete', {
        funding_type: fundingType,
        policy_type: policyType,
        trades: trades.join(','),
        has_repair: hasRepair,
      }));

      // Write oq_trade_selections for repair-intake.html cross-page handoff (feature parity D-211)
      // repair-intake.html reads sessionStorage('oq_trade_selections') as { [tradeName]: boolean }
      if (typeof sessionStorage !== 'undefined' && hasRepair) {
        const tradeSelectionsMap: Record<string, boolean> = {};
        trades.forEach(t => { tradeSelectionsMap[t] = true; });
        sessionStorage.setItem('oq_trade_selections', JSON.stringify(tradeSelectionsMap));
      }

      // Redirect — gh-1276: route to the dedicated project-information page
      // for this payment path (mirrors the pre-existing repair-intake.html
      // split; RCV/ACV/Cash previously all landed on DASHBOARD_URL directly).
      // Bridge 2026-08-26: repair routes to repair-intake for BOTH funding
      // types. Gating it on insurance sent a CASH repair-only job to the
      // cash page, which never collects existing shingle brand/line/colour
      // or squares being repaired — the fields a repair quote cannot be
      // produced without. Mirrors the static trade-selector.html fix.
      // Bridge 2026-08-26: repair-intake's payment-path banner falls back to
      // this when it has no claim row to read yet.
      try { sessionStorage.setItem('oq_funding_type', fundingType || ''); } catch { /* storage blocked */ }
      let redirectUrl: string;
      if (hasRepair) {
        redirectUrl = REPAIR_INTAKE_URL;
      } else if (fundingType === 'insurance') {
        redirectUrl = policyType === 'acv' ? PROJECT_INFO_ACV_URL : PROJECT_INFO_RCV_URL;
      } else {
        redirectUrl = PROJECT_INFO_CASH_URL;
      }
      if (savedClaimId) {
        redirectUrl += `?claim_id=${encodeURIComponent(savedClaimId)}`;
      }
      // gh-2070: the claim itself saved fine — only the loss-sheet attach
      // failed — so this does not throw into the catch block below (which
      // would block the redirect entirely). It surfaces via the page-level
      // error banner (rendered regardless of wizard step, unlike the "I'm
      // Not Sure" panel's own status line) and gets a longer pre-redirect
      // window than the default so the homeowner has a real chance to read
      // it before the page navigates away.
      if (lossSheetAttachFailed) {
        setError("Your claim was saved, but we couldn't attach your loss sheet. You can upload it again from your dashboard.");
      }
      // gh-1984: wait for the analytics sends (each bounded to 1 s), never less
      // than the original 300 ms.
      await Promise.all([
        Promise.all(analyticsSends),
        new Promise((resolve) => setTimeout(resolve, lossSheetAttachFailed ? 4000 : 300)),
      ]);
      window.location.href = redirectUrl;
    } catch (err) {
      console.error('[trade-selector] completion error:', err);
      setError('Something went wrong. Please try again.');
      setCompleting(false);
    }
  };

  // ── Loading state ──
  // gh-2004: also wait on the address-resolution effect (only meaningful
  // once a user exists — a signed-out visitor falls through to the
  // redirect-in-flight `!user` branch below instead of spinning forever).
  if (!settled || (user && addressResolving)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              display: 'inline-block',
              width: 32,
              height: 32,
              border: '3px solid rgba(224,123,0,0.2)',
              borderTopColor: 'var(--amber, #E07B00)',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          <p style={{ color: 'var(--slate, #94a3b8)', marginTop: '1rem' }}>Loading…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!user) return null; // Redirect in-flight

  const currentStepId = stepSequence[currentStep];

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .ts-page { min-height: calc(100vh - 64px); padding: 3rem 0; }
        .ts-container { max-width: 900px; margin: 0 auto; padding: 0 1.5rem; }
        .ts-header { margin-bottom: 3rem; animation: fadeUp 0.6s ease both 0.1s; }
        .ts-header h1 { font-size: clamp(1.75rem, 4vw, 2.5rem); color: var(--white, #fff); margin-bottom: 0.5rem; }
        .ts-subtitle { color: var(--slate, #94a3b8); font-size: 1.1rem; max-width: 600px; }
        .funding-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 2rem;
          margin-bottom: 3rem;
          animation: fadeUp 0.6s ease both 0.2s;
        }
        .funding-card-inner {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1.5rem;
          text-align: center;
        }
        .funding-icon { font-size: 3rem; }
        .funding-card-inner h3 { margin: 0; font-size: 1.25rem; color: var(--white, #fff); }
        .funding-card-inner p { margin: 0; font-size: 0.95rem; color: rgba(255,255,255,0.8); }
        .policy-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 2rem;
          margin-bottom: 2rem;
          animation: fadeUp 0.6s ease both 0.2s;
        }
        .policy-card-inner { display: flex; flex-direction: column; gap: 1rem; }
        .policy-icon { font-size: 2.5rem; }
        .policy-card-inner h3 { margin: 0; font-size: 1.15rem; color: var(--white, #fff); }
        .policy-card-inner p { margin: 0; font-size: 0.95rem; color: rgba(255,255,255,0.8); line-height: 1.5; }
        .info-panel {
          background: var(--navy-2, #0f2036);
          border: 1px solid rgba(224,123,0,0.15);
          border-left: 4px solid var(--amber, #E07B00);
          border-radius: 12px;
          padding: 2rem;
          margin-bottom: 2rem;
          animation: fadeUp 0.4s ease;
        }
        .info-panel h3 { margin: 0 0 1rem; font-size: 1.15rem; color: var(--amber, #E07B00); }
        .info-panel p { color: var(--slate, #94a3b8); font-size: 0.95rem; line-height: 1.7; margin: 0 0 1rem; }
        .info-panel p:last-child { margin-bottom: 0; }
        .fraud-warning {
          background: rgba(239,68,68,0.08);
          border: 1px solid rgba(239,68,68,0.2);
          border-radius: 8px;
          padding: 1rem 1.5rem;
          margin-top: 1.5rem;
        }
        .fraud-warning p { color: #FECACA; font-size: 0.9rem; margin: 0; }
        .tip-box {
          background: rgba(224,123,0,0.06);
          border: 1px solid rgba(224,123,0,0.15);
          border-radius: 8px;
          padding: 1rem 1.5rem;
          margin-top: 1.5rem;
        }
        .tip-box p { color: var(--white, #fff); font-size: 0.9rem; margin: 0; }
        .idk-options { display: grid; gap: 1rem; margin-top: 1.5rem; }
        .idk-option {
          display: flex;
          align-items: flex-start;
          gap: 1rem;
          background: rgba(224,123,0,0.04);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          padding: 1rem 1.5rem;
        }
        .idk-num {
          background: var(--amber, #E07B00);
          color: var(--navy, #0B1929);
          width: 28px; height: 28px; min-width: 28px;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-weight: 700; font-size: 0.85rem; margin-top: 2px;
        }
        .idk-option h4 { margin: 0 0 4px; font-size: 1rem; color: var(--white, #fff); }
        .idk-option p { margin: 0; font-size: 0.9rem; color: var(--slate, #94a3b8); line-height: 1.5; }
        .upload-label {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 8px 16px;
          background: var(--amber, #E07B00); color: var(--navy, #0B1929);
          border-radius: 6px; font-weight: 600; font-size: 0.9rem;
          cursor: pointer; margin-top: 1rem; transition: all 0.15s;
        }
        .upload-label:hover { background: #f08c10; transform: translateY(-1px); }
        .upload-status { margin-top: 0.5rem; font-size: 0.85rem; color: var(--amber, #E07B00); }
        .trade-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 1.5rem;
          margin-bottom: 3rem;
          animation: fadeUp 0.6s ease both 0.2s;
        }
        .trade-card-inner {
          display: flex; flex-direction: column; align-items: center;
          gap: 1rem; text-align: center; position: relative;
        }
        .trade-check {
          position: absolute; top: -8px; right: -8px;
          width: 24px; height: 24px;
          border: 2px solid var(--amber, #E07B00);
          background: var(--amber, #E07B00);
          border-radius: 4px;
          display: flex; align-items: center; justify-content: center;
          font-size: 0.9rem; color: var(--navy, #0B1929);
          font-weight: 700;
        }
        .trade-icon { font-size: 2.5rem; }
        .trade-card-inner h3 { margin: 0; font-size: 1.1rem; color: var(--white, #fff); }
        .rr-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 2rem;
          margin-bottom: 3rem;
          animation: fadeUp 0.6s ease both 0.2s;
        }
        .rr-card-inner { display: flex; flex-direction: column; gap: 1rem; }
        .rr-icon { font-size: 2.5rem; }
        .rr-card-inner h3 { margin: 0; font-size: 1.25rem; color: var(--white, #fff); }
        .rr-card-inner p { margin: 0; font-size: 0.95rem; color: rgba(255,255,255,0.8); }
        .rr-table { width: 100%; border-collapse: collapse; margin-bottom: 3rem; }
        .rr-table th, .rr-table td { padding: 1rem; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.06); }
        .rr-table th { font-weight: 600; color: var(--slate, #94a3b8); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
        .toggle-group { display: flex; gap: 0.75rem; }
        .toggle-btn {
          padding: 6px 16px;
          border: 1px solid rgba(255,255,255,0.2);
          background: transparent;
          color: var(--white, #fff);
          border-radius: 6px;
          cursor: pointer;
          font-size: 0.9rem;
          font-weight: 500;
          transition: all 0.15s;
          font-family: inherit;
        }
        .toggle-btn.active { background: var(--amber, #E07B00); color: var(--navy, #0B1929); border-color: var(--amber, #E07B00); }
        .toggle-btn:not(.active):hover { border-color: var(--amber, #E07B00); color: var(--amber, #E07B00); }
        .error-banner {
          background: rgba(239,68,68,0.1);
          border: 1px solid rgba(239,68,68,0.3);
          border-left: 4px solid #EF4444;
          color: #FECACA;
          padding: 12px 16px;
          border-radius: 8px;
          margin-bottom: 1.5rem;
        }
        /* gh-2004: address-step fields, matching get-started's
           .form-group/.form-label/.form-input/.form-row/.form-hint
           byte-for-byte (PR #1998) so this page's fallback address form is
           visually identical to the one get-started already ships. */
        .ts-address-form {
          display: flex;
          flex-direction: column;
          gap: var(--sp-5, 1.25rem);
          animation: fadeUp 0.6s ease both 0.2s;
        }
        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--sp-4, 1rem);
        }
        .form-group {
          display: flex;
          flex-direction: column;
          gap: var(--sp-1, 0.25rem);
        }
        .form-label {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--white, #fff);
        }
        .form-input {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 8px;
          padding: 10px 14px;
          color: var(--white, #fff);
          font-size: 1rem;
          width: 100%;
          box-sizing: border-box;
          font-family: inherit;
          transition: border-color 0.15s;
        }
        .form-input:focus {
          outline: none;
          border-color: var(--amber, #E07B00);
        }
        .form-hint {
          font-size: 0.8rem;
          color: var(--slate, #94a3b8);
        }
        @media (max-width: 640px) {
          .funding-grid { grid-template-columns: 1fr; }
          .policy-grid { grid-template-columns: 1fr; }
          .trade-grid { grid-template-columns: repeat(2, 1fr); }
          .rr-grid { grid-template-columns: 1fr; }
          .form-row { grid-template-columns: 1fr; }
        }
      `}</style>

      {/* gh-1939: authenticated page on the Clarity allowlist -- mask all text/inputs in replay (Dustin: "Fields masked."). */}
      <div className="ts-page" data-clarity-mask="true">
        <div className="ts-container">
          {/* Step indicator */}
          <StepIndicator totalSteps={totalSteps} currentStep={currentStep} />

          {/* Error banner */}
          {error && (
            <div className="error-banner" role="alert">{error}</div>
          )}

          {/* ── STEP: Address (gh-2004, only when cs_signup/profile had none) ── */}
          {currentStepId === 'address' && (
            <>
              <div className="ts-header">
                <h1>What&apos;s the property address?</h1>
                <p className="ts-subtitle">
                  We need this to match you with contractors who work in your area.
                </p>
              </div>

              <div className="ts-address-form">
                <div className="form-group">
                  <label className="form-label" htmlFor="ts-street">Street Address</label>
                  <input
                    type="text"
                    id="ts-street"
                    className="form-input"
                    required
                    autoComplete="address-line1"
                    placeholder="123 Main St"
                    value={addressForm.street}
                    onChange={e => setAddressForm(prev => ({ ...prev, street: e.target.value }))}
                  />
                  <span className="form-hint">The address for your project.</span>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label" htmlFor="ts-city">City</label>
                    <input
                      type="text"
                      id="ts-city"
                      className="form-input"
                      required
                      autoComplete="address-level2"
                      placeholder="Anytown"
                      value={addressForm.city}
                      onChange={e => setAddressForm(prev => ({ ...prev, city: e.target.value }))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="ts-state">State</label>
                    <select
                      id="ts-state"
                      className="form-input"
                      required
                      autoComplete="address-level1"
                      value={addressForm.state}
                      onChange={e => setAddressForm(prev => ({ ...prev, state: e.target.value }))}
                    >
                      <option value="">Select...</option>
                      {STATE_CODE_OPTIONS.map(({ value, label }) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="ts-zip">ZIP Code</label>
                    <input
                      type="text"
                      id="ts-zip"
                      className="form-input"
                      required
                      inputMode="numeric"
                      autoComplete="postal-code"
                      pattern="\d{5}"
                      maxLength={5}
                      placeholder="12345"
                      value={addressForm.zip}
                      onChange={e => setAddressForm(prev => ({ ...prev, zip: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                    />
                  </div>
                </div>

                {addressFormError && (
                  <div className="error-banner" role="alert">{addressFormError}</div>
                )}

                <ActionButtons
                  onContinue={handleAddressContinue}
                  continueLabel={addressSaving ? 'Saving…' : 'Continue →'}
                  loading={addressSaving}
                />
              </div>
            </>
          )}

          {/* ── STEP: Funding ── */}
          {currentStepId === 'funding' && (
            <>
              <div className="ts-header">
                <h1>How is this job being funded?</h1>
                <p className="ts-subtitle">
                  Let us know how you&apos;re planning to pay for your project so we can match you with the right contractors.
                </p>
              </div>
              <div className="funding-grid">
                <SelectionCard
                  selected={wizardState.fundingType === 'insurance'}
                  onClick={() => handleFundingSelect('insurance')}
                >
                  <div className="funding-card-inner">
                    <div className="funding-icon">📋</div>
                    <h3>Insurance Claim</h3>
                    <p>I have an insurance claim</p>
                  </div>
                </SelectionCard>
                <SelectionCard
                  selected={wizardState.fundingType === 'cash'}
                  onClick={() => handleFundingSelect('cash')}
                >
                  <div className="funding-card-inner">
                    <div className="funding-icon">💰</div>
                    <h3>Out of Pocket</h3>
                    <p>I&apos;m paying for this myself (retail/cash)</p>
                  </div>
                </SelectionCard>
              </div>
            </>
          )}

          {/* ── STEP: Policy Type (insurance only) ── */}
          {currentStepId === 'policy' && (
            <>
              <div className="ts-header">
                <h1>What type of insurance policy do you have?</h1>
                <p className="ts-subtitle">
                  This determines how much your insurance will cover and how we help you get the best value.
                </p>
              </div>

              <div className="policy-grid">
                {(
                  [
                    { key: 'rcv' as PolicyType, icon: '🛡️', title: 'Replacement Cost Value (RCV)', desc: 'Insurance pays for the cost of the repair, minus your deductible.' },
                    { key: 'acv' as PolicyType, icon: '📉', title: 'Actual Cash Value (ACV)', desc: 'Insurance only pays the depreciated amount of the damaged items.' },
                    { key: 'idk' as PolicyType, icon: '❓', title: "I'm Not Sure", desc: "No worries — we'll help you figure it out." },
                  ]
                ).map(({ key, icon, title, desc }) => (
                  <SelectionCard
                    key={key}
                    selected={wizardState.policyType === key}
                    onClick={() => handlePolicySelect(key)}
                  >
                    <div className="policy-card-inner">
                      <div className="policy-icon">{icon}</div>
                      <h3>{title}</h3>
                      <p>{desc}</p>
                    </div>
                  </SelectionCard>
                ))}
              </div>

              {/* Policy info panels */}
              {wizardState.policyType === 'rcv' && (
                <div className="info-panel">
                  <h3>How Replacement Cost Value Works</h3>
                  <p>
                    With an RCV policy, your insurance company agrees to pay the full cost of repairing or replacing your damaged property with materials of similar kind and quality — minus your deductible. This is the better of the two policy types for homeowners.
                  </p>
                  <p>
                    Your insurance company will typically issue two payments: an initial payment (the actual cash value) and a second payment (the recoverable depreciation) after the work is completed and you submit proof of completion.
                  </p>
                  <div className="tip-box">
                    <p><strong>What this means for you:</strong> Since insurance is covering the cost, your goal should be to find the highest-rated contractor with the best products and strongest warranties — not the cheapest bid. Otter Quotes will help you compare contractors on quality, not just price.</p>
                  </div>
                  <div className="fraud-warning">
                    <p><strong>A word of caution:</strong> You are legally required to pay your deductible. Any contractor who offers to &quot;waive your deductible,&quot; &quot;give you money back,&quot; or &quot;work with your insurance so you don&apos;t pay anything out of pocket&quot; may be committing insurance fraud on your behalf. This can jeopardize your claim, void your policy, and expose you to legal liability. Otter Quotes will never facilitate this — and we recommend you avoid any contractor who suggests it.</p>
                  </div>
                </div>
              )}

              {wizardState.policyType === 'acv' && (
                <div className="info-panel">
                  <h3>How Actual Cash Value Works</h3>
                  <p>
                    With an ACV policy, your insurance company pays only the depreciated value of your damaged property — meaning they deduct for age and wear. For example, if your 15-year roof originally cost $15,000 but has depreciated to $6,000, that&apos;s roughly what they&apos;ll pay (minus your deductible).
                  </p>
                  <p>Unlike RCV policies, there is no second payment. What insurance gave you is all you are going to get from them.</p>
                  <div className="tip-box">
                    <p><strong>What this means for you:</strong> You should still negotiate for the best materials, warranties, and workmanship you can get — but you&apos;ll also benefit from competitive pricing since you&apos;re more sensitive to cost. Otter Quotes will help you compare bids on both quality and price so you get the most value from your insurance payout.</p>
                  </div>
                </div>
              )}

              {wizardState.policyType === 'idk' && (
                <div className="info-panel">
                  <h3>Let&apos;s Figure It Out</h3>
                  <p>Knowing your policy type is important because it changes how much insurance will cover and how you should evaluate bids. Here are a few ways to find out:</p>
                  <div className="idk-options">
                    <div className="idk-option">
                      <div className="idk-num">1</div>
                      <div>
                        <h4>Call Your Claims Adjuster</h4>
                        <p>Your adjuster is the person assigned to your claim. Ask them: &quot;Is my policy replacement cost or actual cash value?&quot;</p>
                      </div>
                    </div>
                    <div className="idk-option">
                      <div className="idk-num">2</div>
                      <div>
                        <h4>Call Your Insurance Agent</h4>
                        <p>Your agent can look up your coverage details and tell you whether you have RCV or ACV coverage.</p>
                      </div>
                    </div>
                    <div className="idk-option">
                      <div className="idk-num">3</div>
                      <div>
                        <h4>Check Your Loss Sheet for &quot;Non-Recoverable Depreciation&quot;</h4>
                        <p>If your insurance estimate lists &quot;non-recoverable depreciation,&quot; that&apos;s a strong indicator you have an ACV policy. If it lists &quot;recoverable depreciation,&quot; you likely have RCV.</p>
                      </div>
                    </div>
                    <div className="idk-option">
                      <div className="idk-num">4</div>
                      <div>
                        <h4>Upload Your Loss Sheet and We&apos;ll Help</h4>
                        <p>Upload your insurance estimate (loss sheet) and we&apos;ll review it and tell you what type of policy you have.</p>
                        <label className="upload-label" htmlFor="loss-sheet-upload">
                          📄 {lossSheetUploading ? 'Uploading…' : 'Upload Loss Sheet'}
                          <input
                            type="file"
                            id="loss-sheet-upload"
                            accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                            style={{ display: 'none' }}
                            onChange={handleLossSheetUpload}
                            disabled={lossSheetUploading}
                          />
                        </label>
                        {lossSheetStatus && (
                          <div className="upload-status">{lossSheetStatus}</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <ActionButtons
                onBack={() => goToStep(stepSequence.indexOf('funding'))}
                onContinue={() => {
                  const idx = stepSequence.indexOf('trades');
                  goToStep(idx);
                }}
                continueDisabled={!wizardState.policyType}
              />
            </>
          )}

          {/* ── STEP: Trades ── */}
          {currentStepId === 'trades' && (
            <>
              <div className="ts-header">
                <h1>What do you need done?</h1>
                <p className="ts-subtitle">Select all the trades you need work on. You can choose more than one.</p>
              </div>

              <div className="trade-grid">
                {TRADE_OPTIONS.map(({ key, label, icon }) => {
                  const selected = wizardState.trades.includes(key);
                  return (
                    <SelectionCard
                      key={key}
                      selected={selected}
                      onClick={() => toggleTrade(key)}
                    >
                      <div className="trade-card-inner">
                        {selected && <div className="trade-check">✓</div>}
                        <div className="trade-icon">{icon}</div>
                        <h3>{label}</h3>
                      </div>
                    </SelectionCard>
                  );
                })}
              </div>

              <ActionButtons
                onBack={() => {
                  const idx = stepSequence.indexOf('trades');
                  goToStep(idx - 1);
                }}
                onContinue={() => {
                  initRepairStep();
                  const idx = stepSequence.indexOf('repair');
                  goToStep(idx);
                }}
                continueDisabled={wizardState.trades.length === 0}
              />
            </>
          )}

          {/* ── STEP: Repair / Replace ── */}
          {currentStepId === 'repair' && (
            <>
              <div className="ts-header">
                <h1>Repair or Replace?</h1>
                <p className="ts-subtitle">Let us know what you&apos;d like to do with your selected trades.</p>
              </div>

              {wizardState.trades.length === 1 ? (
                /* Single trade — two big cards */
                <div className="rr-grid">
                  {(
                    [
                      { intent: 'repair' as RepairIntent, icon: '🔧', title: 'Repair', desc: 'Fix specific damage or issues' },
                      {
                        intent: 'replace' as RepairIntent,
                        icon: '✨',
                        title: 'Replace',
                        desc: `Full replacement of existing ${wizardState.trades[0]}`,
                      },
                    ]
                  ).map(({ intent, icon, title, desc }) => (
                    <SelectionCard
                      key={intent}
                      selected={(wizardState.repairReplace[wizardState.trades[0]] ?? 'replace') === intent}
                      onClick={() => setRepairIntent(wizardState.trades[0], intent)}
                    >
                      <div className="rr-card-inner">
                        <div className="rr-icon">{icon}</div>
                        <h3>{title}</h3>
                        <p>{desc}</p>
                      </div>
                    </SelectionCard>
                  ))}
                </div>
              ) : (
                /* Multi-trade — table with per-row toggles */
                <table className="rr-table">
                  <thead>
                    <tr>
                      <th>Trade</th>
                      <th>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wizardState.trades.map(trade => {
                      const current = wizardState.repairReplace[trade] ?? 'repair';
                      return (
                        <tr key={trade}>
                          <td style={{ color: 'var(--white, #fff)', fontWeight: 500 }}>
                            {trade.charAt(0).toUpperCase() + trade.slice(1)}
                          </td>
                          <td>
                            <div className="toggle-group">
                              {(['repair', 'replace'] as RepairIntent[]).map(intent => (
                                <button
                                  key={intent}
                                  className={`toggle-btn${current === intent ? ' active' : ''}`}
                                  onClick={() => setRepairIntent(trade, intent)}
                                >
                                  {intent.charAt(0).toUpperCase() + intent.slice(1)}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              <ActionButtons
                onBack={() => {
                  const idx = stepSequence.indexOf('repair');
                  goToStep(idx - 1);
                }}
                onContinue={handleComplete}
                continueLabel={completing ? 'Saving…' : 'Continue →'}
                loading={completing}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
