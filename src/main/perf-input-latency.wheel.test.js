'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputLatencyCollector } = require('./perf-input-latency');
const fixture = require('./perf-input-latency.wheel.fixture.json');
const clone = () => structuredClone(fixture.events);

function collect(events = clone(), finish = {}) {
  const collector = createInputLatencyCollector(fixture.options);
  collector.write('{"traceEvents":[\n' + events.map(e => JSON.stringify(e)).join(',\n') + '\n]}');
  return collector.finish({ completeExport: true, dataLoss: false,
    clockMarkers: fixture.clockMarkers, rendererClockRelation: fixture.rendererClockRelation,
    trigger: fixture.trigger, ...finish });
}
const tail = result => result.flows.find(f => f.traceId === '4');
const main = flow => flow.linkedNativeIntervals.find(s => s.name === 'STEP_HANDLE_INPUT_EVENT_MAIN');

test('Chromium120 EventMetrics can finish inside its enclosing main handler without losing scope CPU', () => {
  const result = collect(), flow = tail(result), scope = main(flow);
  assert.equal(flow.status, 'measured');
  assert.deepEqual(flow.issues, []);
  assert.equal(scope.durationMs, 0.024);
  assert.equal(scope.threadMs, 0.024, 'CPU belongs to the entire linked handler, not only EventLatency');
  assert.equal(scope.eventRootOverlapMs, 0.012);
  assert.equal(scope.scopeTailAfterEventMs, 0.012);
  assert.equal(scope.eventRootRelation, 'metrics-end-inside-main-handler');
  assert.equal(scope.cpuQualification, 'exact-flow-and-thread');
  assert.equal(flow.stages.find(s => s.name === 'RendererMainProcessing').threadMs, null);
});

test('two same-original wheel packets remain ambiguous even with complete per-flow measurements', () => {
  const result = collect();
  assert.equal(result.trigger.status, 'ambiguous');
  assert.equal(result.trigger.reason, 'nonunique-native-original');
  assert.deepEqual(result.trigger.candidates, ['3', '4']);
  assert.equal(result.trigger.candidateCount, 2);
  assert.equal(result.trigger.omittedCandidates, 0);
  assert.equal(result.flows[0].originalUs, result.flows[1].originalUs);
  assert.equal(result.flows.filter(f => f.status === 'measured').length, 2);
});

test('no clock receipt, export loss and duplicate identity never become a matched wheel', () => {
  for (const finish of [{ rendererClockRelation: null }, { dataLoss: true }, { completeExport: false }]) {
    assert.notEqual(collect(clone(), finish).trigger.status, 'matched');
  }
  const events = clone();
  const scope = events.find(e => e.name === 'LatencyInfo.Flow'
    && e.args.chrome_latency_info.trace_id === '4'
    && e.args.chrome_latency_info.step === 'STEP_HANDLE_INPUT_EVENT_MAIN');
  const duplicate = tail(collect([...events, { ...scope }]));
  assert(duplicate.issues.includes('duplicate-native-interval'));
  assert.equal(main(duplicate).threadMs, null);
});

test('a detached scope or scope not enclosing RendererMainProcessing still fails the outside-root guard', () => {
  for (const mutate of [
    e => { e.ts += 1000000; },
    e => { e.ts += 10; e.dur -= 10; e.tdur -= 10; },
    e => { e.args.chrome_latency_info.step = 'STEP_HANDLE_INPUT_EVENT_IMPL'; },
    e => { e.tid = 2; },
  ]) {
    const events = clone();
    const scope = events.find(e => e.name === 'LatencyInfo.Flow'
      && e.args.chrome_latency_info.trace_id === '4'
      && e.args.chrome_latency_info.step === 'STEP_HANDLE_INPUT_EVENT_MAIN');
    mutate(scope);
    const flow = tail(collect(events));
    assert(flow.issues.includes('native-interval-outside-root'));
    assert(flow.linkedNativeIntervals.every(s => s.threadMs === null));
  }
});
