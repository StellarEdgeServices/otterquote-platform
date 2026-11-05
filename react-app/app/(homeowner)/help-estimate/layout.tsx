import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The root layout's generic "Otter Quotes App" title otherwise replaces the served one.
export const metadata: Metadata = {
  title: 'How to Get Your Insurance Estimate · Otter Quotes',
};

export default function HelpEstimateLayout({ children }: { children: ReactNode }) {
  return children;
}
