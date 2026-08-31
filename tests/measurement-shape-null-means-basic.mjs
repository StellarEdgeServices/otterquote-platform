/**
 * Groundwork test for gh-1410 / D-317 — js/measurement-shape.js
 *
 * Locks the tolerance contract BEFORE the claims.measurement_shape column
 * exists: the resolver must return 'basic' (the non-upgraded, safe shape)
 * for a missing row, a row without the column (pre-migration select('*')),
 * an explicit NULL (post-migration claim with no upgrade on record), and
 * any unexpected value — and 'full' only for an exact 'full'. This is the
 * contract gh-1411's upgrade-purchase gate and gh-1377's later basic-gate
 * consume; see the module header for why 'basic' is the safe direction.
 *
 * Run: node tests/measurement-shape-null-means-basic.mjs
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
  if (!api || typeof api.resolveClaimMeasurementShape !== 'function') {
    console.log('✗ FAIL: window.MeasurementShape.resolveClaimMeasurementShape not found.');
    process.exit(1);
  }
  const resolve = api.resolveClaimMeasurementShape;

  // The tolerance contract: everything short of an explicit 'full' is 'basic'.
  assertEqual(resolve(null), 'basic', 'null claim -> basic');
  assertEqual(resolve(undefined), 'basic', 'undefined claim -> basic');
  assertEqual(resolve({}), 'basic', "column absent from row (pre-migration select('*')) -> basic");
  assertEqual(resolve({ measurement_shape: null }), 'basic', 'explicit NULL (no upgrade on record) -> basic');
  assertEqual(resolve({ measurement_shape: 'basic' }), 'basic', "explicit 'basic' -> basic");
  assertEqual(resolve({ measurement_shape: 'full' }), 'full', "explicit 'full' -> full");

  // Unexpected values fail toward the non-upgraded shape, never toward 'full'.
  assertEqual(resolve({ measurement_shape: 'FULL' }), 'basic', "case variant 'FULL' -> basic (DB CHECK is lowercase)");
  assertEqual(resolve({ measurement_shape: 'none' }), 'basic', "unknown value 'none' -> basic");
  assertEqual(resolve({ measurement_shape: 42 }), 'basic', 'non-string value -> basic');
  assertEqual(resolve('full'), 'basic', 'non-object claim -> basic (never sniff scalars)');

  // Predicate mirrors the resolver.
  assertEqual(api.claimHasFullMeasurements({ measurement_shape: 'full' }), true, 'predicate: full -> true');
  assertEqual(api.claimHasFullMeasurements({}), false, 'predicate: absent -> false');

  // Constants: the enum matches the drafted CHECK constraint, default is the safe shape.
  assertEqual(api.MEASUREMENT_SHAPES.length, 2, 'exactly two shapes');
  assertEqual(api.MEASUREMENT_SHAPES[0], 'basic', "shapes[0] === 'basic'");
  assertEqual(api.MEASUREMENT_SHAPES[1], 'full', "shapes[1] === 'full'");
  assertEqual(api.DEFAULT_MEASUREMENT_SHAPE, 'basic', "default shape is 'basic' (non-upgraded)");
  assertEqual(Object.isFrozen(api.MEASUREMENT_SHAPES), true, 'shape list is frozen');

  console.log("✓ PASS: measurement-shape resolver treats NULL/absent/unexpected as 'basic' and only exact 'full' as full.");
  process.exit(0);
}

main();
