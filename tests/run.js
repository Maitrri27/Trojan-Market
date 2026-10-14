#!/usr/bin/env node
/* Zero-dependency test runner.  node tests/run.js

   Environment is isolated HERE, before any server module is required —
   server/lib/config.js reads process.env once at load time, so setting these
   inside a test file would be too late and would touch the real database. */
const os = require('os');
const pathmod = require('path');
const stamp = Date.now() + '-' + process.pid;

process.env.PORT = process.env.PORT || '4123';
process.env.TM_ADMINS = 'admin@usc.edu';
process.env.TM_DB_FILE = pathmod.join(os.tmpdir(), 'tm-test-db-' + stamp + '.json');
process.env.TM_EVENT_LOG = pathmod.join(os.tmpdir(), 'tm-test-events-' + stamp + '.jsonl');
process.env.TM_REGISTRY_FILE = pathmod.join(os.tmpdir(), 'tm-test-registry-' + stamp + '.json');
process.env.TM_DATA_DIR = pathmod.join(os.tmpdir(), 'tm-test-data-' + stamp);
process.env.TM_ML_ENABLED = 'false';
process.env.TM_ML_WEIGHT = '0';
process.env.CREDENCE_LICENSE_KEY = '';
process.env.CREDENCE_PROFILE_ID = '';
process.env.TM_DEMO_CODE = '482913';
delete process.env.NODE_ENV;

const suites = [];
let currentSuite = null;
const results = { pass: 0, fail: 0, failures: [] };

function describe(name, fn) { suites.push({ name: name, fn: fn }); }
function it(name, fn) { currentSuite.tests.push({ name: name, fn: fn }); }

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg || 'equality') + ': expected ' + e + ', got ' + a);
}
function ok(v, msg) { if (!v) throw new Error((msg || 'assertion') + ': expected truthy, got ' + JSON.stringify(v)); }
function notOk(v, msg) { if (v) throw new Error((msg || 'assertion') + ': expected falsy, got ' + JSON.stringify(v)); }
function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error((msg || 'expected throw') + ': function did not throw');
}
function close(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > (tol || 1e-6)) throw new Error((msg || 'closeness') + ': ' + actual + ' vs ' + expected);
}

async function run() {
  const files = require('fs').readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  if (!files.length) { console.log('No test files found in ' + __dirname); process.exit(1); }
  files.forEach((f) => require(require('path').join(__dirname, f)));

  for (const s of suites) {
    currentSuite = { tests: [] };
    s.fn();
    console.log('\n' + s.name);
    for (const t of currentSuite.tests) {
      try {
        await t.fn();
        results.pass++;
        console.log('  ok   ' + t.name);
      } catch (e) {
        results.fail++;
        results.failures.push(s.name + ' > ' + t.name + '\n      ' + e.message);
        console.log('  FAIL ' + t.name + '\n       ' + e.message);
      }
    }
  }

  try {
    require('fs').unlinkSync(process.env.TM_DB_FILE);
    require('fs').unlinkSync(process.env.TM_EVENT_LOG);
  } catch (e) {}

  console.log('\n' + '='.repeat(60));
  console.log(results.pass + ' passed, ' + results.fail + ' failed');
  if (results.failures.length) {
    console.log('\nFailures:');
    results.failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(results.fail ? 1 : 0);
}

global.describe = describe;
global.it = it;
global.assert = { eq: eq, ok: ok, notOk: notOk, throws: throws, close: close };

if (require.main === module) run();
module.exports = { describe, it };
