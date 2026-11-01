'use client';

/**
 * D-407 "project information" card (gh-3283 RCV page, gh-3285 Out-of-pocket).
 * Byte-identical in both PRs. Contact info (name, phone editable; email and
 * address read-only) on top, then the timeline/notes fields copied from the
 * static project-info pages.
 */

import { URGENCY_OPTIONS, type ContactInfo, type ProjectInfoInput, type Urgency } from './project-info';

interface Props {
  contact: ContactInfo;
  onContact: (next: ContactInfo) => void;
  info: ProjectInfoInput;
  onInfo: (next: ProjectInfoInput) => void;
}

export function ContactProjectCard({ contact, onContact, info, onInfo }: Props) {
  return (
    <div className="d407-card">
      <h2>Project information</h2>

      <div className="d407-row">
        <div className="d407-field">
          <label className="d407-label" htmlFor="d407-name">Full name</label>
          <input
            id="d407-name"
            className="d407-input"
            type="text"
            autoComplete="name"
            value={contact.fullName}
            onChange={(e) => onContact({ ...contact, fullName: e.target.value })}
          />
        </div>
        <div className="d407-field">
          <label className="d407-label" htmlFor="d407-phone">Phone</label>
          <input
            id="d407-phone"
            className="d407-input"
            type="tel"
            autoComplete="tel"
            value={contact.phone}
            onChange={(e) => onContact({ ...contact, phone: e.target.value })}
          />
        </div>
      </div>
      <div className="d407-row">
        <div className="d407-field">
          <label className="d407-label" htmlFor="d407-email">Email</label>
          <input id="d407-email" className="d407-input" type="email" value={contact.email} readOnly />
        </div>
        <div className="d407-field">
          <label className="d407-label" htmlFor="d407-address">Property address</label>
          <input id="d407-address" className="d407-input" type="text" value={contact.address} readOnly />
        </div>
      </div>

      <div className="d407-field">
        <label className="d407-label" htmlFor="d407-urgency">When do you need this completed?</label>
        <select
          id="d407-urgency"
          className="d407-input"
          value={info.urgency}
          onChange={(e) => onInfo({ ...info, urgency: e.target.value as Urgency })}
        >
          {URGENCY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      {info.urgency === 'asap' && (
        <div className="d407-row">
          <div className="d407-field">
            <label className="d407-label" htmlFor="d407-deadline">Deadline Date</label>
            <input
              id="d407-deadline"
              className="d407-input"
              type="date"
              value={info.urgencyDeadline}
              onChange={(e) => onInfo({ ...info, urgencyDeadline: e.target.value })}
            />
          </div>
          <div className="d407-field">
            <label className="d407-label" htmlFor="d407-reason">Reason</label>
            <input
              id="d407-reason"
              className="d407-input"
              type="text"
              placeholder="e.g. Real estate closing, temporary repairs failing"
              value={info.urgencyReason}
              onChange={(e) => onInfo({ ...info, urgencyReason: e.target.value })}
            />
          </div>
        </div>
      )}
      <div className="d407-field">
        <label className="d407-label" htmlFor="d407-notes">Notes for Contractors (optional)</label>
        <textarea
          id="d407-notes"
          className="d407-input"
          rows={3}
          maxLength={500}
          placeholder="Anything contractors should know — tree fell on north side, specific concerns, access instructions, etc."
          value={info.notes}
          onChange={(e) => onInfo({ ...info, notes: e.target.value })}
        />
      </div>
    </div>
  );
}
