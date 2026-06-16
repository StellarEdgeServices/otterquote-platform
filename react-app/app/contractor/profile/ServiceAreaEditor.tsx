'use client';

/**
 * D-192 service-area editor — port of the SVC object in contractor-profile.html.
 * State grid → per-state "Entire State / Specific Counties" → county checkboxes
 * (loaded live from the Census 2020 PL API, same endpoint as the static page).
 * Pure transforms (URL build, county parse, collect/populate) live in utils.ts.
 *
 * Persist parity (D4 fix): only service_counties is saved; service_states is NOT a
 * real contractors column. onSave receives the flat county list.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  STATE_ABBRS, STATE_NAMES, censusCountyUrl, parseCountyList,
  buildInitialServiceConfigs, collectServiceCountiesForSave,
  type SvcConfigs, type SvcMode,
} from './utils';
import { PROFILE_COPY as T } from './copy';

interface ServiceAreaEditorProps {
  initialStates: string[];
  initialCounties: string[];
  saving: boolean;
  onSave: (counties: string[]) => void;
  onCancel: () => void;
}

export function ServiceAreaEditor({ initialStates, initialCounties, saving, onSave, onCancel }: ServiceAreaEditorProps) {
  const [configs, setConfigs] = useState<SvcConfigs>(() => buildInitialServiceConfigs(initialStates, initialCounties));
  const [countyCache, setCountyCache] = useState<Record<string, string[]>>({});
  const [countyError, setCountyError] = useState<Record<string, boolean>>({});
  const [loadingCounties, setLoadingCounties] = useState<Record<string, boolean>>({});
  const cacheRef = useRef(countyCache);
  cacheRef.current = countyCache;

  const selectedStates = useMemo(
    () => STATE_ABBRS.filter((abbr) => configs[abbr] !== undefined),
    [configs],
  );

  // Lazy-load counties whenever a state enters 'specific' mode without a cache hit.
  useEffect(() => {
    for (const abbr of Object.keys(configs)) {
      const cfg = configs[abbr];
      if (cfg.mode === 'specific' && !cacheRef.current[abbr] && !loadingCounties[abbr] && !countyError[abbr]) {
        void loadCounties(abbr);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configs]);

  async function loadCounties(abbr: string) {
    const url = censusCountyUrl(abbr);
    if (!url) return;
    setLoadingCounties((m) => ({ ...m, [abbr]: true }));
    setCountyError((m) => ({ ...m, [abbr]: false }));
    try {
      const r = await fetch(url);
      const d = await r.json();
      const list = parseCountyList(d);
      if (!list.length) {
        setCountyError((m) => ({ ...m, [abbr]: true }));
      } else {
        setCountyCache((m) => ({ ...m, [abbr]: list }));
      }
    } catch (e) {
      console.error('County fetch failed for', abbr, e);
      setCountyError((m) => ({ ...m, [abbr]: true }));
    } finally {
      setLoadingCounties((m) => ({ ...m, [abbr]: false }));
    }
  }

  function toggleState(abbr: string, checked: boolean) {
    setConfigs((c) => {
      const next = { ...c };
      if (checked) next[abbr] = { mode: 'entire', counties: [] };
      else delete next[abbr];
      return next;
    });
  }

  function setMode(abbr: string, mode: SvcMode) {
    setConfigs((c) => ({ ...c, [abbr]: { ...c[abbr], mode } }));
  }

  function toggleCounty(abbr: string, county: string, checked: boolean) {
    setConfigs((c) => {
      const cur = c[abbr];
      if (!cur) return c;
      const set = new Set(cur.counties);
      if (checked) set.add(county);
      else set.delete(county);
      return { ...c, [abbr]: { ...cur, counties: Array.from(set) } };
    });
  }

  function selectAll(abbr: string, checked: boolean) {
    setConfigs((c) => {
      const cur = c[abbr];
      if (!cur) return c;
      return { ...c, [abbr]: { ...cur, counties: checked ? [...(countyCache[abbr] || [])] : [] } };
    });
  }

  return (
    <div className="oqp-svc">
      <p className="oqp-svc-intro">{T.serviceArea.intro}</p>

      <div className="oqp-svc-grid">
        {STATE_ABBRS.map((abbr) => (
          <label key={abbr} className="oqp-svc-state" title={STATE_NAMES[abbr]}>
            <input
              type="checkbox"
              className="oqp-cb"
              checked={configs[abbr] !== undefined}
              onChange={(e) => toggleState(abbr, e.target.checked)}
            />
            <span>{abbr} — {STATE_NAMES[abbr]}</span>
          </label>
        ))}
      </div>

      <div className="oqp-svc-configs">
        {selectedStates.map((abbr) => {
          const cfg = configs[abbr];
          const counties = countyCache[abbr] || [];
          const selected = new Set(cfg.counties);
          return (
            <div key={abbr} className="oqp-svc-config">
              <div className="oqp-svc-config-name">{STATE_NAMES[abbr]}</div>
              <div className="oqp-svc-modes">
                <label className="oqp-svc-mode">
                  <input
                    type="radio"
                    name={`svc-mode-${abbr}`}
                    checked={cfg.mode !== 'specific'}
                    onChange={() => setMode(abbr, 'entire')}
                  /> {T.serviceArea.entireState}
                </label>
                <label className="oqp-svc-mode">
                  <input
                    type="radio"
                    name={`svc-mode-${abbr}`}
                    checked={cfg.mode === 'specific'}
                    onChange={() => setMode(abbr, 'specific')}
                  /> {T.serviceArea.specificCounties}
                </label>
              </div>
              {cfg.mode === 'specific' && (
                <div className="oqp-svc-counties">
                  {loadingCounties[abbr] ? (
                    <div className="oqp-svc-hint">{T.serviceArea.loadingCounties}</div>
                  ) : countyError[abbr] ? (
                    <div className="oqp-svc-err">{T.serviceArea.countiesError}</div>
                  ) : (
                    <>
                      <div className="oqp-svc-county-grid">
                        {counties.map((c) => (
                          <label key={c} className="oqp-svc-county">
                            <input
                              type="checkbox"
                              className="oqp-cb"
                              checked={selected.has(c)}
                              onChange={(e) => toggleCounty(abbr, c, e.target.checked)}
                            />{c}
                          </label>
                        ))}
                      </div>
                      <div className="oqp-svc-county-actions">
                        <button type="button" onClick={() => selectAll(abbr, true)}>{T.serviceArea.selectAll}</button>
                        <button type="button" onClick={() => selectAll(abbr, false)}>{T.serviceArea.clearAll}</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="oqp-actions">
        <button type="button" className="oqp-btn oqp-btn-primary" disabled={saving} onClick={() => onSave(collectServiceCountiesForSave(configs))}>
          {saving ? 'Saving…' : T.serviceArea.save}
        </button>
        <button type="button" className="oqp-btn oqp-btn-secondary" disabled={saving} onClick={onCancel}>{T.serviceArea.cancel}</button>
      </div>
    </div>
  );
}
