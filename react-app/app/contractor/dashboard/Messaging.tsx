'use client';

/**
 * Contractor ↔ homeowner messaging (D-211 Phase 2).
 *
 * SINGLE implementation — folds a client-side audit finding: the static
 * contractor-dashboard.html shipped TWO messaging <script> blocks that both
 * wired the Send button (double-send) and one posted to a dead Netlify URL
 * (https://otterquote.com/.netlify/functions/send-message-notification). This
 * ports the correct v74 behavior once, calling the Supabase Edge Function
 * (send-message-notification) via the public NEXT_PUBLIC_SUPABASE_URL. The EF
 * contract is unchanged ({ message_id }); notification failures are non-fatal.
 * Message bodies render as JSX text (React auto-escapes).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { DASHBOARD_COPY as C } from './copy';
import { efUrl } from './utils';

const POLL_MS = 30000;

interface ClaimOption {
  claimId: string;
  label: string;
}
interface MessageRow {
  id: string;
  sender_id: string;
  sender_role: string;
  body: string;
  created_at: string;
  full_name: string;
}

export function Messaging({ userId }: { userId: string }) {
  const [claims, setClaims] = useState<ClaimOption[]>([]);
  const [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);

  // Load the contractor's projects (claims they have a quote on).
  useEffect(() => {
    let active = true;
    (async () => {
      const { data: contractor } = await supabase
        .from('contractors').select('id').eq('user_id', userId).single();
      if (!contractor || !active) return;
      const { data: quotes } = await supabase
        .from('quotes')
        .select('claim_id, claims:claim_id(id, property_address)')
        .eq('contractor_id', contractor.id);
      if (!active) return;
      const opts: ClaimOption[] = (quotes || []).map((q: Record<string, unknown>) => {
        const claim = (q.claims as Record<string, unknown>) || {};
        const claimId = String(q.claim_id);
        return {
          claimId,
          label: (claim.property_address as string) || `Claim ${claimId.substring(0, 8)}`,
        };
      });
      setClaims(opts);
    })();
    return () => { active = false; };
  }, [userId]);

  const loadMessages = useCallback(async (claimId: string) => {
    if (!claimId) return;
    const { data, error } = await supabase
      .from('messages')
      .select('id, sender_id, sender_role, body, created_at, profiles:sender_id(full_name)')
      .eq('claim_id', claimId)
      .order('created_at', { ascending: true });
    if (error) { console.error('Error loading messages:', error); return; }
    setMessages(
      (data || []).map((m: Record<string, unknown>) => ({
        id: String(m.id),
        sender_id: String(m.sender_id),
        sender_role: String(m.sender_role),
        body: String(m.body ?? ''),
        created_at: String(m.created_at),
        full_name: String(((m.profiles as Record<string, unknown>) || {}).full_name ?? ''),
      })),
    );
  }, []);

  // Poll the selected thread.
  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    loadMessages(selected);
    const t = setInterval(() => loadMessages(selected), POLL_MS);
    return () => clearInterval(t);
  }, [selected, loadMessages]);

  // Auto-scroll to newest.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const send = async () => {
    const text = body.trim();
    if (!selected || !text) return;
    setSending(true);
    setStatus(C.messagesSending);
    try {
      const { data: newMessage, error: insertError } = await supabase
        .from('messages')
        .insert([{ claim_id: selected, sender_id: userId, sender_role: 'contractor', body: text }])
        .select('id')
        .single();
      if (insertError) throw insertError;
      setBody('');
      setStatus('');
      // Fire-and-forget notification (EF contract unchanged; failure non-fatal).
      try {
        await fetch(efUrl('send-message-notification'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: newMessage.id }),
        });
      } catch (notifErr) {
        console.error('Notification error:', notifErr);
      }
      await loadMessages(selected);
    } catch (err) {
      console.error('Send error:', err);
      setStatus(C.messagesError);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="oqd-card oqd-messages">
      <h3 className="oqd-card-title">{C.messagesHeading}</h3>
      <label className="oqd-msg-label" htmlFor="oqd-claim-select">{C.messagesSelectLabel}</label>
      <select
        id="oqd-claim-select"
        className="oqd-select"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">{claims.length ? C.messagesSelectPrompt : C.messagesNoProjects}</option>
        {claims.map((c) => (
          <option key={c.claimId} value={c.claimId}>{c.label}</option>
        ))}
      </select>

      {selected && (
        <div className="oqd-thread">
          <div className="oqd-msg-list" ref={listRef}>
            {messages.length === 0 ? (
              <p className="oqd-msg-empty">{C.messagesEmpty}</p>
            ) : (
              messages.map((m) => {
                const own = m.sender_id === userId;
                return (
                  <div key={m.id} className={'oqd-msg' + (own ? ' is-own' : '')}>
                    <div className="oqd-msg-from">{m.full_name}{own ? ' (You)' : ''}</div>
                    <div className="oqd-msg-body">{m.body}</div>
                    <div className="oqd-msg-time">{new Date(m.created_at).toLocaleString()}</div>
                  </div>
                );
              })
            )}
          </div>
          <div className="oqd-msg-compose">
            <textarea
              className="oqd-textarea"
              placeholder={C.messagesPlaceholder}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <button type="button" className="oqd-btn-send" onClick={send} disabled={sending}>
              {sending ? C.messagesSending : C.messagesSend}
            </button>
          </div>
          <div className="oqd-msg-status">{status}</div>
        </div>
      )}
    </section>
  );
}
