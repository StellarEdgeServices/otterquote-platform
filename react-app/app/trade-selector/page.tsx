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

// ─── Constants ────────────────────────────────────────────────────────────────

const DASHBOARD_URL = 'https://otterquote.com/dashboard.html';
const REPAIR_INTAKE_URL = 'https://otterquote.com/repair-intake.html';
const GET_STARTED_URL = '/get-started';

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
      .from('referral_agents_public')
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
        .from('referral_agents_public')
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
  const { user, loading: authLoading } = useAuthReady();

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

  // Auth guard + returning-user guard
  useEffect(() => {
    if (authLoading) return;

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
  }, [authLoading, user]);

  // ── Step sequence ──
  const stepSequence: string[] = wizardState.fundingType === 'insurance'
    ? ['funding', 'policy', 'trades', 'repair']
    : ['funding', 'trades', 'repair'];
  const totalSteps = stepSequence.length;

  // ── Navigation ──
  const goToStep = useCallback((index: number) => {
    setCurrentStep(index);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  // ── Step 1: Funding ──
  const handleFundingSelect = (type: 'insurance' | 'cash') => {
    setWizardState(prev => ({ ...prev, fundingType: type, policyType: null }));
    setTimeout(() => goToStep(1), 300);
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
        const filePath = `${user.id}/loss-sheets/${Date.now()}-${file.name}`;
        const { error: uploadError } = await supabase.storage
          .from('claim-documents')
          .upload(filePath, file);
        if (uploadError) throw uploadError;
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

      // Read cs_signup profile data from localStorage
      let csSignup: Record<string, unknown> = {};
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('cs_signup') : null;
        if (raw) csSignup = JSON.parse(raw);
      } catch {
        // cs_signup missing — continue with empty
      }

      if (user) {
        // ── Upsert profiles table ──
        try {
          const address = (csSignup.address as string) || '';
          const addressParts = address.split(',').map((s: string) => s.trim());
          await supabase.from('profiles').upsert({
            id: user.id,
            role: 'homeowner',
            full_name: [(csSignup.first_name as string || '').trim(), (csSignup.last_name as string || '').trim()].filter(Boolean).join(' ') || null,
            phone: (csSignup.phone as string) || null,
            address_street: addressParts[0] || null,
            address_city: addressParts[1] || null,
            address_state: addressParts[2] || null,
            address_zip: addressParts[3] || null,
            referral_source: (csSignup.referral_source as string) || null,
            sms_consent_ts: (csSignup.sms_consent_ts as string) || null,
            updated_at: new Date().toISOString(),
          });
        } catch (profileErr) {
          console.warn('[trade-selector] profile upsert failed:', profileErr);
        }

        // ── Insert or update claims table ──
        try {
          const referralSource = sessionStorage.getItem('oq_referral_source') || null;
          const partnerIdParam = sessionStorage.getItem('oq_partner_id') || null;
          const referralAgentId = await resolveReferralAgentId(partnerIdParam);

          // #567: ref.html click-chain carry-forward — mirrors the static
          // trade-selector. localStorage survives the magic-link redirect, and
          // auth re-keys the id to oq_referral_id_for_claim after advancing.
          const chainReferralId =
            sessionStorage.getItem('oq_referral_id') ||
            localStorage.getItem('oq_referral_id') ||
            localStorage.getItem('oq_referral_id_for_claim') ||
            null;
          const chainReferralAgentId =
            sessionStorage.getItem('oq_referral_agent_id') ||
            localStorage.getItem('oq_referral_agent_id') ||
            null;
          const chainReferralCode =
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
          const csAddress = (csSignup.address as string) || '';
          const csParts = csAddress.split(',').map((s: string) => s.trim());
          const csStateToken = ((csParts[2] || '').split(/\s+/)[0] || '').toUpperCase() || null;

          const claimPayload: Record<string, unknown> = {
            funding_type: fundingType,
            policy_type: policyType,
            trades: trades,
            job_type: jobType,
            property_address: csAddress || null,
            property_state: csStateToken,
            updated_at: new Date().toISOString(),
            ...(referralSource && { referral_source: referralSource }),
            ...(referralAgentId && { referral_agent_id: referralAgentId }),
            // #567: ref.html click-chain attribution — the only writer of
            // claims.referral_id (the commission trigger's key column).
            ...(chainReferralId && { referral_id: chainReferralId }),
            ...(!referralAgentId && chainReferralAgentId && { referral_agent_id: chainReferralAgentId }),
            ...(chainReferralCode && { referral_code: chainReferralCode }),
          };

          if (existingClaim) {
            await supabase
              .from('claims')
              .update(claimPayload)
              .eq('id', existingClaim.id);
          } else {
            await supabase.from('claims').insert({
              user_id: user.id,
              ...claimPayload,
              created_at: new Date().toISOString(),
            });
          }

          // #571: the claim_submitted advance now lives in the database —
          // trg_claims_advance_referral fires on the claims.referral_id
          // write above. The old client-side UPDATE always no-opped
          // against RLS and has been removed.
        } catch (claimErr) {
          console.warn('[trade-selector] claim upsert failed:', claimErr);
        }
      }

      // GA4 funnel event
      gtag('event', 'trade_selector_complete', {
        funding_type: fundingType,
        policy_type: policyType,
        trades: trades.join(','),
        has_repair: hasRepair,
      });

      // Write oq_trade_selections for repair-intake.html cross-page handoff (feature parity D-211)
      // repair-intake.html reads sessionStorage('oq_trade_selections') as { [tradeName]: boolean }
      if (typeof sessionStorage !== 'undefined' && hasRepair) {
        const tradeSelectionsMap: Record<string, boolean> = {};
        trades.forEach(t => { tradeSelectionsMap[t] = true; });
        sessionStorage.setItem('oq_trade_selections', JSON.stringify(tradeSelectionsMap));
      }

      // Redirect
      const redirectUrl = hasRepair ? REPAIR_INTAKE_URL : DASHBOARD_URL;
      setTimeout(() => {
        window.location.href = redirectUrl;
      }, 300);
    } catch (err) {
      console.error('[trade-selector] completion error:', err);
      setError('Something went wrong. Please try again.');
      setCompleting(false);
    }
  };

  // ── Loading state ──
  if (authLoading) {
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
        @media (max-width: 640px) {
          .funding-grid { grid-template-columns: 1fr; }
          .policy-grid { grid-template-columns: 1fr; }
          .trade-grid { grid-template-columns: repeat(2, 1fr); }
          .rr-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className="ts-page">
        <div className="ts-container">
          {/* Step indicator */}
          <StepIndicator totalSteps={totalSteps} currentStep={currentStep} />

          {/* Error banner */}
          {error && (
            <div className="error-banner" role="alert">{error}</div>
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
                onBack={() => goToStep(0)}
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
