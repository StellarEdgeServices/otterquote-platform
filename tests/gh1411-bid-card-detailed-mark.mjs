/**
 * gh-1411 / D-317 cl. 5 -- homeowner bids.html: the bid card of a contractor who bought the detailed measurement
 * upgrade carries the mark "Bid on detailed measurements"; other cards do not. Static checks on the page source.
 * Run: node tests/gh1411-bid-card-detailed-mark.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(process.env.GH1411_BIDS_PAGE || path.join(root, 'bids.html'), 'utf8');
let pass = 0, fail = 0;
function ok(c, l) { if (c) { console.log('PASS: ' + l); pass++; } else { console.log('FAIL: ' + l); fail++; } }
ok(html.includes('Bid on detailed measurements'), 'page carries the D-317 cl. 5 wording exactly');
ok((html.match(/Bid on detailed measurements/g) || []).length === 1, 'wording appears once (one render site)');
ok(/detailedBidContractors\.has\(bid\.contractor_id\)\s*\?[^:]*Bid on detailed measurements[^:]*:\s*''/.test(html), 'mark is conditional on the contractor being in the detailed set, empty otherwise');
const card = html.slice(html.indexOf('<div class="bid-card ${'));
ok(card.indexOf('bid-detailed-mark') > 0 && card.indexOf('bid-detailed-mark') < card.indexOf('bid-card-meta'), 'mark is inside the bid card header');
ok(html.includes("rpc('get_claim_detailed_measurement_bidders'"), 'data comes from the homeowner-safe RPC');
ok(/detailedBidContractors = new Set\(\);\s*try \{/.test(html) && /detErr\.message/.test(html), 'lookup resets the set and fails open on error');
ok(!/hover_orders/.test(html), 'homeowner page never reads hover_orders directly');
const mig = fs.readFileSync(path.join(root, 'supabase/migrations_drafts/20261026210000_gh1411_claim_detailed_measurement_bidders.sql'), 'utf8');
ok(/c\.user_id = auth\.uid\(\)/.test(mig) && /SECURITY DEFINER/.test(mig) && /REVOKE ALL[^;]*anon/.test(mig), 'draft RPC is owner-scoped, definer, anon revoked');
ok(/EXISTS\s*\(\s*SELECT 1 FROM public\.quotes q\s+WHERE q\.claim_id = h\.claim_id\s+AND q\.contractor_id = h\.requested_by_contractor_id\s*\)/.test(mig), 'draft RPC returns only contractors who have a quote on the claim (no non-bidder disclosure)');
ok(/REVOKE ALL[^;]*PUBLIC[^;]*anon/.test(mig) && /GRANT EXECUTE[^;]*TO authenticated/.test(mig) && /SET search_path TO 'public'/.test(mig), 'draft RPC keeps REVOKE FROM PUBLIC, anon, GRANT to authenticated, pinned search_path');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
