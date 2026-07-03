'use client';

/**
 * Shared presentational filter-tabs component — D-211 Phase 9.
 *
 * Renders the `.filter-tabs` / `.filter-tab` / `.filter-tab.active`
 * class pattern from admin-cert-verifications.html. Contains NO
 * filtering logic — that lives in utils.ts.
 *
 * §6.1 XSS: all tab labels render as JSX text.
 */

export function FilterTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onChange: (key: string) => void;
}): React.JSX.Element {
  return (
    <div className="filter-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={'filter-tab' + (tab.key === active ? ' active' : '')}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
