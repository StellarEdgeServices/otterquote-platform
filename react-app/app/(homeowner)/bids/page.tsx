'use client';

/**
 * Homeowner bids — /bids (D-211 Phase 21, H2). React port of the static bids.html
 * "Your Bids" page. The homeowner SHELL (auth gate + nav) is provided by
 * HomeownerShell (reused from P20); this page wires the data and behaviour:
 *   • the claim + its live bids (shared useBidUpdates realtime hook) + contractor
 *     profiles with signed owner photos;
 *   • D-150 bid expiration (active / expiring / expired) with renewal;
 *   • the Cards ↔ Compare 16-row comparison grid (2+ active bids);
 *   • select-winning-contractor → payment-method gate → award → contract-signing
 *     handoff (the downstream contract/payment flow is a SEPARATE page);
 *   • the bid_updated banner, all-expired banner, and empty/loading/error states.
 *
 * Audit fold-in #4: the static page's auth-failure redirect to /sign-in.html (a
 * 404 dead-end) is NOT reproduced — the shell routes unauth homeowners to
 * get-started.html.
 */

import { useCallback, useMemo, useState } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { useBidUpdates } from '@/hooks/use-bid-updates';
import { HomeownerShell } from '../_shell/HomeownerShell';
import { useBidContractors, useBidsClaim, useBidUpdatedNotifications, useContractorLicenses } from './use-bids-data';
import { acknowledgeBidUpdatedNotifications, requestBidRenewal } from './actions';
import { isAllExpired, showCompareToggle } from './utils';
import { BIDS_STYLES } from './styles';
import { BidCard } from './components/BidCard';
import { BidsCompareGrid } from './components/BidsCompareGrid';
import { CredentialEducationModal } from './components/CredentialEducationModal';
import { SelectContractorModal } from './components/SelectContractorModal';
import { AllExpiredBanner, BidUpdatedBanner, EmptyState, ErrorState } from './components/Banners';
import type { BidRow } from './types';

function Loading() {
  return (
    <div className="oqb-loading" role="status" aria-label="Loading your bids">
      <div className="oqb-spin" />
    </div>
  );
}

function claimIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('claim_id');
}

type RenewState = 'idle' | 'sending' | 'sent';

function BidsContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? '';
  const [claimIdParam] = useState<string | null>(claimIdFromUrl);

  const { claim, claimId, loading: claimLoading, error: claimError } = useBidsClaim(userId, claimIdParam);
  const { bids: rawBids, loading: bidsLoading, error: bidsError } = useBidUpdates(claimId || '');
  const bids = rawBids as unknown as BidRow[];
  const { contractors } = useBidContractors(bids);
  const { licenses } = useContractorLicenses(bids);
  const notifs = useBidUpdatedNotifications(userId, claimId);

  const [view, setView] = useState<'cards' | 'compare'>('cards');
  const [pending, setPending] = useState<BidRow | null>(null);
  const [eduContractorId, setEduContractorId] = useState<string | null>(null);
  const [renewals, setRenewals] = useState<Record<string, RenewState>>({});

  const onSelect = useCallback((bid: BidRow) => setPending(bid), []);
  const onCredentials = useCallback((contractorId: string) => setEduContractorId(contractorId), []);

  const onRenew = useCallback(
    async (bid: BidRow) => {
      setRenewals((r) => ({ ...r, [bid.id]: 'sending' }));
      const contractor = contractors[bid.contractor_id] || { id: bid.contractor_id };
      const res = await requestBidRenewal({ claim, contractor, bidId: bid.id });
      setRenewals((r) => ({ ...r, [bid.id]: res.notifOk || res.emailOk ? 'sent' : 'idle' }));
    },
    [claim, contractors],
  );

  const onDismissBanner = useCallback(() => {
    const ids = notifs.ids;
    notifs.clear();
    void acknowledgeBidUpdatedNotifications(ids);
  }, [notifs]);

  const allExpired = useMemo(() => isAllExpired(bids), [bids]);
  const canCompare = useMemo(() => showCompareToggle(bids), [bids]);

  if (claimLoading || (!!claimId && bidsLoading)) return <Loading />;
  if (claimError || bidsError) return <ErrorState onRetry={() => window.location.reload()} />;

  return (
    <div className="oqb-wrap">
      <style>{BIDS_STYLES}</style>
      <h1 className="oqb-title">Your Bids</h1>

      <BidUpdatedBanner count={notifs.notifications.length} onDismiss={onDismissBanner} />
      {allExpired && <AllExpiredBanner />}

      {bids.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {canCompare && (
            <div className="oqb-view-toggle" role="tablist" aria-label="Bid view">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'cards'}
                className={'oqb-view-btn' + (view === 'cards' ? ' active' : '')}
                onClick={() => setView('cards')}
              >
                Cards
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'compare'}
                className={'oqb-view-btn' + (view === 'compare' ? ' active' : '')}
                onClick={() => setView('compare')}
              >
                Compare
              </button>
            </div>
          )}

          {view === 'compare' && canCompare ? (
            <BidsCompareGrid bids={bids} contractors={contractors} />
          ) : (
            <div className="oqb-grid">
              {bids.map((bid) => (
                <BidCard
                  key={bid.id}
                  bid={bid}
                  bids={bids}
                  claim={claim}
                  contractor={contractors[bid.contractor_id] || { id: bid.contractor_id }}
                  licenses={licenses[bid.contractor_id] || []}
                  onSelect={onSelect}
                  onRenew={onRenew}
                  onCredentials={onCredentials}
                  renewalState={renewals[bid.id] || 'idle'}
                />
              ))}
            </div>
          )}
        </>
      )}

      {pending && claim && (
        <SelectContractorModal
          bid={pending}
          claim={claim}
          contractor={contractors[pending.contractor_id] || { id: pending.contractor_id }}
          onClose={() => setPending(null)}
        />
      )}

      {eduContractorId && (
        <CredentialEducationModal
          contractor={contractors[eduContractorId] || { id: eduContractorId }}
          licenses={licenses[eduContractorId] || []}
          onClose={() => setEduContractorId(null)}
        />
      )}
    </div>
  );
}

export default function BidsPage() {
  return (
    <HomeownerShell active="bids">
      <BidsContent />
    </HomeownerShell>
  );
}
