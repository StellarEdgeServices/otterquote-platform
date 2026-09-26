/**
 * gh-1411 / D-317 cl. 4-5 — js/measurement-shape.js:
 * shouldFlipMeasurementShapeOnDeliver(order, delivering)
 *
 * Locks the ONLY condition under which admin-measurements.html may flip
 * claims.measurement_shape to 'full': the save must actually be delivering
 * the order (report/measurements entered this save), the order's
 * product_code must be the paid upgrade SKU (roof_upgrade_detailed), and it
 * must carry a claim_id. Delivering a roof_basic or roof_full order — the
 * two other hover_orders product codes admin-measurements.html fulfils —
 * must NEVER flip the shape; this is the negative control that makes the
 * positive case mean something.
 *
 * FAIL-FIRST: before gh-1411 extracted this function, admin-measurements.html
 * only had the equivalent condition inline in a <script> block with no DOM,
 * so it could not be exercised by any test — this file existing and failing
 * against a pre-extraction checkout (function undefined) is the fail-first
 * evidence; it passes once js/measurement-shape.js exports the function.
 *
 * Run: node tests/measurement-shape-flip-on-deliver.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'measurement-shape.js'), 'utf8');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'js/measurement-shape.js' });

const api = sandbox.window.MeasurementShape;

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.log(`✗ FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  console.log(`✓ PASS: ${label} (${JSON.stringify(actual)})`);
}

function main() {
  if (!api || typeof api.shouldFlipMeasurementShapeOnDeliver !== 'function') {
    console.log('✗ FAIL: window.MeasurementShape.shouldFlipMeasurementShapeOnDeliver not found.');
    process.exit(1);
  }
  const fn = api.shouldFlipMeasurementShapeOnDeliver;

  assertEqual(
    fn({ product_code: 'roof_upgrade_detailed', claim_id: 'claim-1' }, true),
    true,
    'delivering a roof_upgrade_detailed order with a claim_id flips the shape',
  );

  assertEqual(
    fn({ product_code: 'roof_basic', claim_id: 'claim-1' }, true),
    false,
    'NEGATIVE CONTROL: delivering a roof_basic order never flips the shape',
  );

  assertEqual(
    fn({ product_code: 'roof_full', claim_id: 'claim-1' }, true),
    false,
    'NEGATIVE CONTROL: delivering a roof_full order never flips the shape',
  );

  assertEqual(
    fn({ product_code: 'roof_upgrade_detailed', claim_id: 'claim-1' }, false),
    false,
    'editing (not delivering) a roof_upgrade_detailed order never flips the shape',
  );

  assertEqual(
    fn({ product_code: 'roof_upgrade_detailed', claim_id: null }, true),
    false,
    'a delivering order with no claim_id never flips the shape',
  );

  assertEqual(
    fn(null, true),
    false,
    'a null order never flips the shape (defensive)',
  );

  assertEqual(
    fn(undefined, true),
    false,
    'an undefined order never flips the shape (defensive)',
  );

  console.log('\nAll assertions passed.');
  process.exit(0);
}

main();
