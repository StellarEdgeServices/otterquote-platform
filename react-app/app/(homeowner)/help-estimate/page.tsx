'use client';

import { useMemo, useState } from 'react';
import { HomeownerShell } from '../_shell/HomeownerShell';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { useHelpEstimateClaim, useHelpEstimateProfile, useCarrierHelp } from './use-help-estimate-data';
import { buildCarrierTips } from './utils';
import { HELP_ESTIMATE_CSS } from './styles';
import { CarrierTipsBlock } from './components/CarrierTipsBlock';
import { EmailFlow } from './components/EmailFlow';
import type { TriageSection } from './types';

export default function HelpEstimatePage() {
  return (
    <HomeownerShell active="dashboard">
      <HelpEstimateContent />
    </HomeownerShell>
  );
}

function HelpEstimateContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? '';

  const { claim, loading: claimLoading, error: claimError } = useHelpEstimateClaim(userId);
  const { profile, loading: profileLoading } = useHelpEstimateProfile(userId);
  const { carrier } = useCarrierHelp(claim?.carrier_id as string | null | undefined);

  const carrierTips = useMemo(() => buildCarrierTips(carrier), [carrier]);

  const homeownerName = (profile?.full_name ?? '').trim();
  const homeownerPhone = profile?.phone ?? '';

  const [section, setSection] = useState<TriageSection>('triage');

  if (claimLoading || profileLoading) {
    return (
      <div className="oqh-help">
        <style>{HELP_ESTIMATE_CSS}</style>
        <div className="he-spinner" role="status" aria-label="Loading">
          <div className="he-spinner-ring" />
        </div>
      </div>
    );
  }

  return (
    <div className="oqh-help">
      <style>{HELP_ESTIMATE_CSS}</style>

      <div className="he-header">
        <a href="/dashboard" className="he-back">← Back to Dashboard</a>
        <h1 className="he-title">Insurance Estimate</h1>
        <p className="he-subtitle">Help Me: Get your insurance estimate</p>
      </div>

      {claimError && (
        <div className="he-status error" role="alert">
          We couldn&apos;t load your claim. Please refresh.
        </div>
      )}

      {section === 'triage' && (
        <TriageSection setSection={setSection} />
      )}

      {section === 'findit' && (
        <FindItSection carrierTips={carrierTips} setSection={setSection} />
      )}

      {section === 'email' && (
        <EmailFlow
          claim={claim}
          homeownerName={homeownerName}
          homeownerPhone={homeownerPhone}
          onSent={() => setSection('success')}
          onBack={() => setSection('triage')}
        />
      )}

      {section === 'explainer' && (
        <ExplainerSection setSection={setSection} />
      )}

      {section === 'success' && (
        <SuccessSection />
      )}
    </div>
  );
}

function TriageSection({ setSection }: { setSection: (s: TriageSection) => void }) {
  function onKeyDown(e: React.KeyboardEvent, section: TriageSection) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSection(section);
    }
  }

  return (
    <div>
      <div className="he-info-callout">
        <strong>Not paying through insurance?</strong> If you&apos;re paying out-of-pocket, you
        don&apos;t need an insurance estimate. You can{' '}
        <a href="/dashboard" style={{ color: '#b8860b' }}>
          go to your dashboard
        </a>{' '}
        to review contractor bids directly.
      </div>

      <p className="he-triage-question">Do you have your insurance estimate?</p>

      <div className="he-triage-cards">
        <button
          className="he-triage-card"
          onClick={() => setSection('findit')}
          onKeyDown={(e) => onKeyDown(e, 'findit')}
        >
          <h3>Yes, but I can&apos;t find it</h3>
          <p>You received it at some point but can&apos;t locate the email or document.</p>
        </button>

        <button
          className="he-triage-card"
          onClick={() => setSection('email')}
          onKeyDown={(e) => onKeyDown(e, 'email')}
        >
          <h3>My adjuster hasn&apos;t sent it yet</h3>
          <p>
            Your adjuster completed the inspection but you haven&apos;t received the estimate
            document.
          </p>
        </button>

        <button
          className="he-triage-card"
          onClick={() => setSection('explainer')}
          onKeyDown={(e) => onKeyDown(e, 'explainer')}
        >
          <h3>What is an insurance estimate?</h3>
          <p>Learn what an insurance estimate (scope of loss) is and why you need it.</p>
        </button>
      </div>
    </div>
  );
}

function FindItSection({
  carrierTips,
  setSection,
}: {
  carrierTips: ReturnType<typeof buildCarrierTips>;
  setSection: (s: TriageSection) => void;
}) {
  return (
    <div className="he-section-card">
      <h2 className="he-section-heading">Finding Your Insurance Estimate</h2>
      <p className="he-section-intro">
        Here are some common places your estimate may have been sent or stored.
      </p>

      {carrierTips && <CarrierTipsBlock data={carrierTips} />}

      <ul className="he-tips-list">
        <li>Check your email inbox and spam/junk folder for a message from your insurance company.</li>
        <li>Log in to your insurance carrier&apos;s online portal or mobile app — estimates are often posted there.</li>
        <li>Check any physical mail you received after your inspection appointment.</li>
        <li>Call your insurance company&apos;s claims line and ask them to resend the estimate to your email.</li>
        <li>If you have a public adjuster or attorney, they may already have a copy on file.</li>
      </ul>

      <p style={{ color: 'var(--slate, #94a3b8)', fontSize: '0.9rem', marginBottom: '0' }}>
        Still can&apos;t find it? We can contact your adjuster directly to request a copy.
      </p>

      <div className="he-btn-row">
        <button
          type="button"
          className="he-btn he-btn-amber"
          onClick={() => setSection('email')}
        >
          Request from Adjuster
        </button>
        <a href="/dashboard" className="he-btn he-btn-outline">
          I Found It — Upload Now
        </a>
      </div>
    </div>
  );
}

function ExplainerSection({ setSection }: { setSection: (s: TriageSection) => void }) {
  return (
    <div className="he-section-card">
      <h2 className="he-section-heading">What Is an Insurance Estimate?</h2>

      <div className="he-explainer-section">
        <h3>The Official Document from Your Insurance Company</h3>
        <p>
          An insurance estimate — also called a scope of loss or scope of work — is a detailed
          document your insurance adjuster prepares after inspecting your property. It lists every
          item of damage they found and how much your insurance company will pay to repair or
          replace it.
        </p>
      </div>

      <div className="he-explainer-section">
        <h3>Why Contractors Need It</h3>
        <p>
          When your contractor submits a bid through OtterQuote, they&apos;re pricing their work
          against your insurance estimate. The estimate is the blueprint — it tells them exactly
          what your insurance approved, so their bid can match (or supplement) the covered scope.
        </p>
      </div>

      <div className="he-explainer-section">
        <h3>What It Looks Like</h3>
        <p>
          It&apos;s typically a multi-page PDF from your insurance carrier (e.g., Xactimate
          software output). It includes line items like &quot;Remove and replace roof decking,&quot;
          &quot;Install 30-year architectural shingles,&quot; and labor costs. Each item has a unit
          cost and quantity.
        </p>
      </div>

      <div className="he-explainer-section">
        <h3>When You Should Have Received It</h3>
        <p>
          Your adjuster should send it within a few days to a few weeks after your inspection. Some
          carriers post it directly to their online portal. If it&apos;s been more than 2 weeks
          since your inspection, it&apos;s reasonable to follow up.
        </p>
      </div>

      <div className="he-info-callout">
        <strong>Haven&apos;t filed a claim yet?</strong> If you haven&apos;t had an adjuster
        inspection, you won&apos;t have an estimate yet. Contact your insurance company to open a
        claim and schedule an inspection first.
      </div>

      <div className="he-btn-row">
        <button
          type="button"
          className="he-btn he-btn-amber"
          onClick={() => setSection('email')}
        >
          Help Me Get My Estimate
        </button>
        <a href="/dashboard" className="he-btn he-btn-outline">
          I Have It — Upload Now
        </a>
      </div>
    </div>
  );
}

function SuccessSection() {
  return (
    <div className="he-success">
      <span className="he-success-icon">✓</span>
      <h2>Email Sent Successfully</h2>
      <p>
        Your request has been sent to your adjuster. They&apos;ll reply directly to you with
        your insurance estimate attached. We&apos;ve also set up a special reply address so any
        documents they send back will be automatically captured.
      </p>
      <p className="he-success-followup">
        We&apos;ll send you a follow-up reminder in 48 hours if you haven&apos;t heard back. You
        can always call your adjuster directly if you prefer a faster response.
      </p>
      <a href="/dashboard" className="he-btn he-btn-amber">
        Return to Dashboard
      </a>
    </div>
  );
}
