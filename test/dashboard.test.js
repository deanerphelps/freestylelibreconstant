import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('transient errors preserve recent readings; stale readings cannot feed the calculator', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('    let lastDisplayedReading'), html.indexOf('    function connectWs'));
  const context = vm.createContext({ Date, Number, Math, setTimeout });
  vm.runInContext(`
    const glucoseEl = {}, trendEl = {}, updatedEl = {}, statusEl = {};
    const calcGlucose = {}, calcResult = {};
    const DISPLAY_TIME_ZONE = 'America/New_York';
    let latestGlucoseForCalc = null, latestGlucoseTimestampForCalc = null;
    const chart = { data: { labels: [], datasets: [{ data: [] }] }, update() {} };
    function updateCalcLatest(reading) { latestGlucoseForCalc = reading.glucose; }
    ${source}
  `, context);
  const evaluate = code => vm.runInContext(code, context);
  evaluate(`applyReading({ glucose: 123, trend: '→', sourceTimestamp: new Date().toISOString() }); showUnavailable('retrying');`);
  assert.equal(evaluate('glucoseEl.textContent'), 123);
  assert.equal(evaluate('latestGlucoseForCalc'), 123);
  assert.equal(evaluate('statusEl.textContent'), 'retrying');
  evaluate(`applyReading({ glucose: 125, trend: '↑', sourceTimestamp: new Date(Date.now() - 11 * 60000).toISOString() });`);
  assert.equal(evaluate('glucoseEl.textContent'), 125);
  assert.match(evaluate('statusEl.textContent'), /stale.*11 min old/);
  assert.equal(evaluate('latestGlucoseForCalc'), null);
  assert.equal(evaluate('trendEl.textContent'), '⏳');
  evaluate(`applyReading({ glucose: 126, trend: '→', sourceTimestamp: new Date().toISOString() });`);
  assert.equal(evaluate('statusEl.textContent'), 'live');
  assert.equal(evaluate('latestGlucoseForCalc'), 126);
  evaluate(`applyReading(lastDisplayedReading);`);
  assert.equal(evaluate('chart.data.labels.length'), 3, 'repeat heartbeats do not duplicate chart points');
});
