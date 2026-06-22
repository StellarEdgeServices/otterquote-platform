'use client';

/**
 * D-231 post-completion home-profile prompt + capture modal.
 *
 * Shown once a job completes (contract_signed + completion_date) when the
 * homeowner has a profile, has no home_profiles row yet, and has not dismissed the
 * card. Dismissal persists per-claim in localStorage. Mirrors dashboard.html
 * (#home-profile-prompt-card + #home-profile-modal + submitHomeProfile()).
 */

import { useEffect, useState } from 'react';
import { saveHomeProfile } from '../actions';
import { homeProfileDismissKey, shouldShowHomeProfilePrompt } from '../utils';
import type { HomeownerClaim, HomeownerProfile } from '../types';

const FUTURE_PROJECT_OPTIONS = [
  'Roof',
  'Siding',
  'Gutters',
  'Windows',
  'Solar',
  'Kitchen',
  'Bathroom',
];

const SIDING_MATERIALS = ['Vinyl', 'Fiber cement', 'Wood', 'Metal', 'Stucco', 'Brick', 'Other'];

export function HomeProfilePrompt({
  claim,
  profile,
  hasHomeProfile,
}: {
  claim: HomeownerClaim;
  profile: HomeownerProfile | null;
  hasHomeProfile: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  // Read the per-claim dismissal flag on mount (client-only).
  useEffect(() => {
    try {
      if (localStorage.getItem(homeProfileDismissKey(claim.id))) setDismissed(true);
    } catch {
      /* ignore */
    }
  }, [claim.id]);

  const visible = shouldShowHomeProfilePrompt({
    claim,
    profileId: profile?.id,
    hasHomeProfile,
    dismissed,
  });

  if (!visible || saved) return null;

  function dismiss() {
    try {
      localStorage.setItem(homeProfileDismissKey(claim.id), String(Date.now()));
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }

  return (
    <>
      <div
        style={{
          marginTop: '1.25rem',
          background: 'rgba(16,185,129,0.08)',
          border: '1px solid rgba(16,185,129,0.35)',
          borderRadius: '0.875rem',
          padding: '1.25rem 1.5rem',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '1rem',
        }}
      >
        <div style={{ fontSize: '1.5rem', lineHeight: 1 }} aria-hidden="true">
          🏡
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, color: '#34D399', marginBottom: '0.35rem' }}>
            Keep your home profile for next time
          </div>
          <div style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.85)', marginBottom: '0.85rem' }}>
            Save a few details about your home so your next project starts faster.
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
            Save my home profile
          </button>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '1.1rem' }}
        >
          ✕
        </button>
      </div>

      {open && (
        <HomeProfileModal
          claim={claim}
          profileId={profile!.id}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setSaved(true);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function HomeProfileModal({
  claim,
  profileId,
  onClose,
  onSaved,
}: {
  claim: HomeownerClaim;
  profileId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [yearBuilt, setYearBuilt] = useState('');
  const [sqft, setSqft] = useState('');
  const [stories, setStories] = useState('');
  const [futureProjects, setFutureProjects] = useState<string[]>([]);
  const [roofYear, setRoofYear] = useState('');
  const [siding, setSiding] = useState('');
  const [hvacAge, setHvacAge] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleProject(p: string) {
    setFutureProjects((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  }

  async function submit() {
    const yb = Number(yearBuilt);
    const sf = Number(sqft);
    if (!yb || yb < 1800 || yb > 2100) return setError('Enter a valid year built (1800–2100).');
    if (!sf || sf < 1) return setError('Enter a valid square footage.');
    if (!stories) return setError('Select the number of stories.');
    if (futureProjects.length === 0) return setError('Pick at least one future project.');

    setBusy(true);
    setError(null);
    const res = await saveHomeProfile({
      homeowner_user_id: profileId,
      year_built: yb,
      square_footage: sf,
      stories,
      future_projects: futureProjects,
      roof_last_replaced: roofYear ? Number(roofYear) : null,
      siding_material: siding || null,
      hvac_age_years: hvacAge ? Number(hvacAge) : null,
    });
    setBusy(false);
    if (res.ok) onSaved();
    else setError(res.error || 'Could not save. Please try again.');
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Save your home profile"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: 'var(--navy-2, #0f2942)',
          borderRadius: '1rem',
          padding: '1.75rem',
          maxWidth: 520,
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          color: 'rgba(255,255,255,0.9)',
        }}
      >
        <h2 style={{ marginTop: 0 }}>Your home profile</h2>
        <div style={{ display: 'grid', gap: '0.85rem' }}>
          <Field label="Year built *">
            <input type="number" value={yearBuilt} onChange={(e) => setYearBuilt(e.target.value)} min={1800} max={2100} />
          </Field>
          <Field label="Square footage *">
            <input type="number" value={sqft} onChange={(e) => setSqft(e.target.value)} min={1} />
          </Field>
          <Field label="Stories *">
            <select value={stories} onChange={(e) => setStories(e.target.value)}>
              <option value="">Select…</option>
              <option value="1">1</option>
              <option value="1.5">1.5</option>
              <option value="2">2</option>
              <option value="3+">3+</option>
            </select>
          </Field>
          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ fontSize: '0.85rem', marginBottom: '0.35rem' }}>Future projects *</legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {FUTURE_PROJECT_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => toggleProject(p)}
                  aria-pressed={futureProjects.includes(p)}
                  style={{
                    padding: '0.35rem 0.75rem',
                    borderRadius: 9999,
                    border: '1px solid rgba(255,255,255,0.25)',
                    background: futureProjects.includes(p) ? 'var(--amber, #E07B00)' : 'transparent',
                    color: futureProjects.includes(p) ? '#0D1B2E' : 'rgba(255,255,255,0.85)',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </fieldset>

          <details>
            <summary style={{ cursor: 'pointer', fontSize: '0.85rem' }}>Optional details</summary>
            <div style={{ display: 'grid', gap: '0.85rem', marginTop: '0.75rem' }}>
              <Field label="Roof last replaced (year)">
                <input type="number" value={roofYear} onChange={(e) => setRoofYear(e.target.value)} min={1800} max={2100} />
              </Field>
              <Field label="Siding material">
                <select value={siding} onChange={(e) => setSiding(e.target.value)}>
                  <option value="">Select…</option>
                  {SIDING_MATERIALS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="HVAC age (years)">
                <input type="number" value={hvacAge} onChange={(e) => setHvacAge(e.target.value)} min={0} />
              </Field>
            </div>
          </details>

          {error && (
            <p role="alert" style={{ color: '#f87171', margin: 0 }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn" disabled={busy} onClick={submit}>
              {busy ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: '0.25rem', fontSize: '0.85rem' }}>
      <span>{label}</span>
      {children}
    </label>
  );
}
