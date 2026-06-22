'use client';

/**
 * Homeowner dashboard — /dashboard (D-211 Phase 20).
 *
 * React port of the static dashboard.html. The homeowner SHELL (auth gate + nav)
 * is provided by HomeownerShell; this page wires the data:
 *   • latest claim (auto-creates a draft if none) + LIVE claim-stage updates via
 *     the shared useClaimStatus subscription;
 *   • D-178 state gate (blocks non-IN homeowners);
 *   • D-178 status banner, D-181 display-only rebate card, the pre-submission
 *     checklist (upload → parse-loss-sheet, submit → notify-contractors, Hover
 *     resend), D-231 home-profile prompt, D-171 switch-contractor survey, the
 *     W3-P4 warranty button, and the claim message thread.
 * use-notification-count drives the shell's live notification badge.
 */

import { useAuthReady } from '@/hooks/use-auth-ready';
import { useClaimStatus } from '@/hooks/use-claim-status';
import { HomeownerShell } from '../_shell/HomeownerShell';
import { useClaimAux, useHomeownerProfile, useLatestClaim } from './use-dashboard-data';
import { isStateGated } from './utils';
import type { HomeownerClaim } from './types';
import { StateGateCard } from './components/StateGateCard';
import { StatusBanner } from './components/StatusBanner';
import { RebateCard } from './components/RebateCard';
import { Checklist } from './components/Checklist';
import { HomeProfilePrompt } from './components/HomeProfilePrompt';
import { MessagesPanel } from './components/MessagesPanel';

function Loading() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem 1rem' }} role="status" aria-label="Loading dashboard">
      <div
        style={{
          width: 28,
          height: 28,
          border: '3px solid rgba(224,123,0,0.2)',
          borderTopColor: 'var(--amber, #E07B00)',
          borderRadius: '50%',
          animation: 'oqh-spin 0.8s linear infinite',
        }}
      />
    </div>
  );
}

function DashboardContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? '';
  const email = user?.email ?? '';

  const { claimId, loading: idLoading } = useLatestClaim(userId);
  // Live claim row + stage updates via the shared subscription hook. select('*')
  // carries the full homeowner row at runtime; cast to the homeowner shape.
  const { claim: liveClaim, loading: claimLoading } = useClaimStatus(claimId ?? '');
  const claim = liveClaim as HomeownerClaim | null;
  const { profile } = useHomeownerProfile(userId, email);
  const aux = useClaimAux(claimId, userId);

  if (idLoading || (!!claimId && claimLoading)) return <Loading />;

  if (!claim) {
    return (
      <div style={{ maxWidth: 560, margin: '3rem auto', padding: '0 1.5rem', color: 'rgba(255,255,255,0.85)' }}>
        <h1>Welcome to Otter Quotes</h1>
        <p>We couldn&apos;t load a project for your account yet. Please refresh, or start a claim from get-started.</p>
      </div>
    );
  }

  // D-178 — block non-IN homeowners before rendering the dashboard body.
  if (isStateGated(claim)) {
    return <StateGateCard claim={claim} userId={userId} />;
  }

  const firstName = (profile?.full_name || '').split(' ')[0] || 'there';

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1.5rem' }}>
      <h1 style={{ fontSize: '1.5rem', color: 'rgba(255,255,255,0.95)', marginBottom: '1.25rem' }}>
        Welcome back, {firstName}
      </h1>

      <StatusBanner
        claim={claim}
        profile={profile}
        email={email}
        bidCount={aux.bidCount}
        warrantyUrl={aux.warrantyUrl}
      />

      <HomeProfilePrompt claim={claim} profile={profile} hasHomeProfile={aux.hasHomeProfile} />

      <RebateCard order={aux.rebateOrder} />

      {!claim.ready_for_bids && (
        <Checklist claim={claim} hoverOrder={aux.hoverOrder} userId={userId} onChange={aux.refetch} />
      )}

      <MessagesPanel claimId={claimId} userId={userId} />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <HomeownerShell active="dashboard">
      <DashboardContent />
    </HomeownerShell>
  );
}
