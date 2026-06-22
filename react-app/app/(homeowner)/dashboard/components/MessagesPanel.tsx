'use client';

/**
 * Claim message thread (homeowner ⇄ contractor). Loads the thread for the current
 * claim, polls every 30s (mirrors the static messaging poll), and sends messages
 * via the messages table + the send-message-notification EF. Mirrors the
 * dashboard.html messaging section (loadMessages / send handler).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { sendClaimMessage } from '../actions';
import type { ClaimMessage } from '../types';

const POLL_MS = 30_000;

export function MessagesPanel({
  claimId,
  userId,
}: {
  claimId: string | null;
  userId: string;
}) {
  const [messages, setMessages] = useState<ClaimMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!claimId) return;
    const { data, error: err } = await supabase
      .from('messages')
      .select('id, sender_id, sender_role, body, created_at, profiles:sender_id(full_name)')
      .eq('claim_id', claimId)
      .order('created_at', { ascending: true });
    if (!err && data) setMessages(data as unknown as ClaimMessage[]);
  }, [claimId]);

  // Initial load + 30s poll while a claim is selected.
  useEffect(() => {
    if (!claimId) return;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [claimId, load]);

  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  async function send() {
    const body = draft.trim();
    if (!body || !claimId) return;
    setBusy(true);
    setError(null);
    const res = await sendClaimMessage({ claimId, senderId: userId, body });
    setBusy(false);
    if (res.ok) {
      setDraft('');
      await load();
    } else {
      setError(res.error || 'Could not send your message. Please try again.');
    }
  }

  if (!claimId) return null;

  return (
    <section
      style={{
        marginTop: '1.5rem',
        background: 'var(--navy-2, #0f2942)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '0.875rem',
        padding: '1.5rem',
        color: 'rgba(255,255,255,0.9)',
      }}
    >
      <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Messages</h2>

      <div
        style={{
          maxHeight: 280,
          overflowY: 'auto',
          display: 'grid',
          gap: '0.5rem',
          padding: '0.5rem 0',
        }}
      >
        {messages.length === 0 ? (
          <p style={{ fontSize: '0.875rem', color: 'rgba(255,255,255,0.6)' }}>
            No messages yet. Once a contractor is selected you can chat with them here.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.sender_id === userId;
            return (
              <div
                key={m.id}
                style={{
                  justifySelf: mine ? 'end' : 'start',
                  maxWidth: '80%',
                  background: mine ? 'var(--amber, #E07B00)' : 'rgba(255,255,255,0.06)',
                  color: mine ? '#0D1B2E' : 'rgba(255,255,255,0.9)',
                  borderRadius: '0.75rem',
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.875rem',
                }}
              >
                {!mine && (
                  <div style={{ fontSize: '0.7rem', opacity: 0.75, marginBottom: 2 }}>
                    {m.profiles?.full_name || (m.sender_role === 'contractor' ? 'Contractor' : 'Them')}
                  </div>
                )}
                {m.body}
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder="Type a message…"
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-sm" disabled={busy || !draft.trim()} onClick={send}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      {error && (
        <p role="alert" style={{ color: '#f87171', marginTop: '0.5rem' }}>
          {error}
        </p>
      )}
    </section>
  );
}
