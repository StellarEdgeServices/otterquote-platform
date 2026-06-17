'use client';

/**
 * Contractor Bid Form route — /contractor/bid/[claimId] (D-211 Phase 7 / BF-2,
 * port of contractor-bid-form.html). Wrapped by the reusable ContractorShell
 * (auth + contractor-role gate + nav). Reuses the shared auth scaffolding +
 * contractor-track shell — does NOT re-implement auth.
 *
 * Gating parity with the static init() (contractor-bid-form.html:3563-3602), in
 * the EXACT order — pending → attestation → COI → CPA → profile-completeness —
 * with the static page's *.html redirect targets flipped to the now-live React
 * routes (Phases 2/5/6): pending → /contractor/dashboard, attestation/COI →
 * /contractor/settings, CPA → /contractor/dashboard, profile → /contractor/profile.
 * Consumes the PR-1 pure gates (preCpaBidGate + profileIncompleteRedirect) and the
 * shell CPA guard (enforceCpaRedirect). Mode (submit / change / renew / rescind)
 * is resolved from the route + query via resolveClaimId / resolveBidMode.
 *
 * Tier-3 surfaces (bid_can_submit RPC, fee/quotes/fee_acceptances, send-bid-
 * confirmation / notify-contractors / get-hover-* / rescind-bid EFs) are called
 * with their UNCHANGED contracts; fee + legal copy is VERBATIM (copy.ts). The
 * §6.1 Phase-7 backend findings are filed for migration-author (86e1xe0wb).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { ContractorShell } from '../../_shell/ContractorShell';
import { useContractorRecord } from '../../_shell/use-contractor-record';
import { enforceCpaRedirect } from '../../_shell/cpa-guard';
import { BID_STYLES } from './bid-ui';
import { BidForm } from './bid-form';
import { RescindCard, type RescindQuote } from './rescind-card';
import {
  type BidClaim, type BidGateContractor, type BidMode,
  resolveClaimId, resolveBidMode, preCpaBidGate, profileIncompleteRedirect,
  deriveTradeFlags, BID_GATE_ROUTES,
} from './utils';

type LoadedClaim = BidClaim & Record<string, unknown> & { siding_bid_released_at?: string | null };

export default function ContractorBidPage() {
  return (
    <ContractorShell active="opportunities">
      <style>{BID_STYLES}</style>
      <BidPageContent />
    </ContractorShell>
  );
}

function BidPageContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;
  const { contractor, loading: contractorLoading } = useContractorRecord(userId);
  const router = useRouter();

  // Read the route segment + query from window.location (client-only), mirroring the
  // app's established pattern (auth-callback). This deliberately avoids next/navigation's
  // useSearchParams, which Next 15 requires to sit under a Suspense boundary or it breaks
  // the prerender (and typescript.ignoreBuildErrors would NOT suppress that build error).
  const [loc, setLoc] = useState<{ segment: string | null; search: URLSearchParams } | null>(null);
  useEffect(() => {
    const m = window.location.pathname.match(/\/contractor\/bid\/([^/?#]+)/);
    const segment = m ? decodeURIComponent(m[1]) : null;
    setLoc({ segment, search: new URLSearchParams(window.location.search) });
  }, []);
  const claimId = useMemo(() => (loc ? resolveClaimId(loc.segment, loc.search) : null), [loc]);
  const action = loc?.search.get('action') ?? null;
  const renewParam = loc?.search.get('renew') ?? null;

  const [claim, setClaim] = useState<LoadedClaim | null>(null);
  const [claimChecked, setClaimChecked] = useState(false);
  const [existingQuote, setExistingQuote] = useState<(Record<string, unknown> & { id: string }) | null>(null);
  const [quoteChecked, setQuoteChecked] = useState(false);
  const [gateResolved, setGateResolved] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  // ── Gating: pending → attestation → COI → CPA → profile (init() order, :3563-3602). ──
  useEffect(() => {
    if (!contractor) return;
    const gate: BidGateContractor = {
      status: contractor.status ?? null,
      attestation_accepted_at: (contractor.attestation_accepted_at as string | null) ?? null,
      coi_file_url: (contractor.coi_file_url as string | null) ?? null,
      coi_expires_at: (contractor.coi_expires_at as string | null) ?? null,
      company_name: contractor.company_name ?? null,
      phone: (contractor.phone as string | null) ?? null,
      trades: contractor.trades ?? null,
      service_counties: contractor.service_counties ?? null,
    };
    const pre = preCpaBidGate(gate);
    if (pre) { setRedirecting(true); router.replace(pre); return; }
    if (enforceCpaRedirect(contractor, router.replace, BID_GATE_ROUTES.dashboard)) { setRedirecting(true); return; }
    const prof = profileIncompleteRedirect(gate);
    if (prof) { setRedirecting(true); router.replace(prof); return; }
    setGateResolved(true);
  }, [contractor, router]);

  // ── Load the claim (with carrier name), once we have a claimId. ──
  useEffect(() => {
    if (!claimId) { setClaimChecked(true); return; }
    let active = true;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('claims')
          .select('*, carrier_profiles(carrier_name)')
          .eq('id', claimId)
          .single();
        if (!active) return;
        if (error) { console.error('Error loading claim:', error); setClaim(null); }
        else setClaim((data as LoadedClaim) ?? null);
      } catch (err) {
        if (active) { console.error('Error loading claim:', err); setClaim(null); }
      } finally {
        if (active) setClaimChecked(true);
      }
    })();
    return () => { active = false; };
  }, [claimId]);

  // ── Change-bid detection: the contractor's existing quote for this claim. ──
  useEffect(() => {
    if (!contractor || !claimId) { if (!claimId) setQuoteChecked(true); return; }
    let active = true;
    (async () => {
      try {
        const { data } = await supabase
          .from('quotes')
          .select('*')
          .eq('claim_id', claimId)
          .eq('contractor_id', contractor.id)
          .maybeSingle();
        if (!active) return;
        setExistingQuote((data as (Record<string, unknown> & { id: string }) | null) ?? null);
      } catch (err) {
        if (active) console.error('Error checking existing quote:', err);
      } finally {
        if (active) setQuoteChecked(true);
      }
    })();
    return () => { active = false; };
  }, [contractor, claimId]);

  const mode: BidMode = useMemo(() => resolveBidMode({
    action, renewParam,
    hasExistingQuote: !!existingQuote,
    existingBidStatus: (existingQuote?.bid_status as string | null) ?? null,
  }), [action, renewParam, existingQuote]);

  const flags = useMemo(() => deriveTradeFlags(claim), [claim]);
  const claimRcv = useMemo(() => {
    if (!claim) return null;
    const pli = claim.parsed_line_items as { summary?: { rcv?: number } } | string | null | undefined;
    let parsed: { summary?: { rcv?: number } } | null = null;
    if (typeof pli === 'string') { try { parsed = JSON.parse(pli); } catch { parsed = null; } }
    else if (pli && typeof pli === 'object') parsed = pli as { summary?: { rcv?: number } };
    if (parsed?.summary?.rcv != null) return parsed.summary.rcv;
    if (claim.rcv_amount != null) return claim.rcv_amount as number;
    return null;
  }, [claim]);

  if (!loc || contractorLoading || redirecting || !gateResolved || !claimChecked || !quoteChecked) {
    return <div className="oqb-loading"><div className="oqb-spin" /></div>;
  }
  if (!claimId) {
    return <div className="oqb-wrap"><div className="oqb-err">No project specified. Open a bid from your Opportunities list.</div></div>;
  }
  if (!claim) {
    return <div className="oqb-wrap"><div className="oqb-err">This project could not be loaded. It may no longer be available.</div></div>;
  }
  if (!contractor) {
    return <div className="oqb-loading"><div className="oqb-spin" /></div>;
  }

  if (mode === 'rescind') {
    const rq: RescindQuote | null = existingQuote ? {
      id: existingQuote.id,
      total_price: (existingQuote.total_price as number | null) ?? null,
      bid_status: (existingQuote.bid_status as string | null) ?? null,
      created_at: (existingQuote.created_at as string | null) ?? null,
    } : null;
    return <RescindCard contractorId={contractor.id} quote={rq} />;
  }

  return (
    <BidForm
      mode={mode}
      claim={claim}
      contractor={contractor}
      existingQuote={existingQuote}
      flags={flags}
      claimRcv={claimRcv}
      userId={userId as string}
    />
  );
}
