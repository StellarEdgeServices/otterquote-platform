'use client';

import type { CarrierTips, CarrierTip } from '../types';

interface CarrierTipsBlockProps {
  data: CarrierTips;
}

function renderTip(tip: CarrierTip, index: number): React.ReactNode {
  switch (tip.kind) {
    case 'portal':
      return (
        <li key={index}>
          Check your online portal:{' '}
          <a href={tip.url} target="_blank" rel="noopener noreferrer">
            {tip.carrierName} Claims Portal
          </a>
        </li>
      );
    case 'email':
      return (
        <li key={index}>
          Email their claims department: <strong>{tip.email}</strong>
        </li>
      );
    case 'phone':
      return (
        <li key={index}>
          Call claims directly: <strong>{tip.phone}</strong>
        </li>
      );
    case 'days':
      return (
        <li key={index}>
          {tip.carrierName} typically sends estimates within{' '}
          <strong>{tip.days} business days</strong> after inspection.
        </li>
      );
    case 'text':
      return <li key={index}>{tip.text}</li>;
    default:
      return null;
  }
}

export function CarrierTipsBlock({ data }: CarrierTipsBlockProps) {
  return (
    <div className="he-carrier-tips">
      <h4>{data.title}</h4>
      <ul>{data.tips.map((tip, i) => renderTip(tip, i))}</ul>
    </div>
  );
}
