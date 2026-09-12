// Seq log shipping: the pure conversion helpers, the console tap's safety
// properties, and the sink's filtering. No network, no `seq-logging`, no
// `seq-tap.ts` — importing that one would patch the console for real.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARGS_CAP,
  capText,
  consoleEventOf,
  effectiveLevel,
  levelForConsole,
  levelForEvent,
  logEventOf,
  MT_EVENT,
  MT_PLAIN,
  MT_WITH_SOURCE,
  parseLevel,
  resolveSeqConfig,
  safeJson,
  shouldEmit,
  splitSource,
  SEQ_LEVELS,
  type SeqLevel,
} from '../src/observability/seq-pure.js';

import {
  attachSink,
  installConsoleTap,
  originalConsole,
  tapStats,
  uninstallConsoleTap,
  type ConsoleMethod,
} from '../src/observability/console-tap.js';

import {
  flushSeq,
  onConsole,
  seqBooth,
  seqEnabled,
  seqLogEvent,
  seqMuted,
  setLogger,
  type SeqLoggerLike,
} from '../src/observability/seq.js';

const NOW = new Date('2026-09-13T10:00:00.000Z');

// ── pure: splitSource ──────────────────────────────────────────────────────

test('splitSource pulls the [subsystem] tag out of a line', () => {
  assert.deepEqual(splitSource('[queue] pushed "X"'), { source: 'queue', message: 'pushed "X"' });
  assert.deepEqual(splitSource('[spotify+] seam'), { source: 'spotify+', message: 'seam' });
  assert.deepEqual(splitSource('[a-b_c.d] x'), { source: 'a-b_c.d', message: 'x' });
  assert.deepEqual(splitSource('no prefix here'), { source: null, message: 'no prefix here' });
});

test('splitSource refuses a pseudo-prefix longer than a real tag', () => {
  const line = `[${'x'.repeat(200)}] hi`;
  assert.equal(splitSource(line).source, null, 'a 200-char bracket run is prose, not a tag');
});

// ── pure: the template must never be derived from input ────────────────────

test('a hostile message never reaches messageTemplate', () => {
  const hostile = [
    '{Foo}',
    '{"id":5,"a":"b"}',
    '{{literal}}',
    '100% {done}',
    '[queue] swapped {Title} for {Other}',
  ];
  for (const text of hostile) {
    const draft = consoleEventOf('log', [text], NOW);
    assert.ok(
      draft.messageTemplate === MT_WITH_SOURCE || draft.messageTemplate === MT_PLAIN,
      `template was derived from input: ${draft.messageTemplate}`,
    );
    const { message } = splitSource(text);
    assert.equal(draft.properties.Message, message, 'the text must survive verbatim in Message');
  }
});

test('a source-tagged line uses the source template, an untagged one does not', () => {
  assert.equal(consoleEventOf('log', ['[tag] hi'], NOW).messageTemplate, MT_WITH_SOURCE);
  assert.equal(consoleEventOf('log', ['hi'], NOW).messageTemplate, MT_PLAIN);
  assert.equal(consoleEventOf('log', ['hi'], NOW).properties.Source, undefined);
});

// ── pure: errors and extra args ────────────────────────────────────────────

test('the first Error becomes the exception; a second lands in Args', () => {
  const a = new Error('first');
  const b = new TypeError('second');
  const draft = consoleEventOf('error', ['[x] boom', a, b], NOW);
  assert.ok(draft.exception?.includes('first'));
  assert.ok(!draft.exception?.includes('second'));
  assert.ok(JSON.stringify(draft.properties.Args).includes('second'));
});

test('an Error-shaped plain object is treated as an error', () => {
  const draft = consoleEventOf('error', ['[x] boom', { stack: 'Fake: at nowhere' }], NOW);
  assert.ok(draft.exception?.includes('Fake'), 'duck-typed on .stack, not instanceof');
});

test('primitives join the message, objects go to Args', () => {
  const draft = consoleEventOf('log', ['[x] count', 5, true, { id: 'abc' }], NOW);
  assert.equal(draft.properties.Message, 'count 5 true');
  assert.deepEqual(draft.properties.Args, { id: 'abc' });
});

// ── pure: caps and safeJson ────────────────────────────────────────────────

test('a huge message is truncated with the events.ts marker', () => {
  const draft = consoleEventOf('log', ['x'.repeat(100_000)], NOW);
  const msg = String(draft.properties.Message);
  assert.ok(msg.length < 5_000);
  assert.match(msg, /…\[\+\d+ chars\]$/);
});

test('capText leaves a short string alone', () => {
  assert.equal(capText('short', 100), 'short');
});

test('a circular object serialises instead of throwing', () => {
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  const out = safeJson(a, ARGS_CAP) as Record<string, unknown>;
  assert.equal(out.name, 'a');
  assert.equal(out.self, '[Circular]');
});

test('the same object twice among siblings is not a cycle', () => {
  const shared = { id: 1 };
  const out = safeJson({ a: shared, b: shared }, ARGS_CAP) as Record<string, unknown>;
  assert.deepEqual(out.a, { id: 1 });
  assert.deepEqual(out.b, { id: 1 }, 'only ancestors make a cycle');
});

test('an adversarial payload still fits well inside eventSizeLimit', () => {
  const deep: Record<string, unknown> = {};
  let node = deep;
  for (let i = 0; i < 50; i += 1) {
    node.next = { pad: 'y'.repeat(500) };
    node = node.next as Record<string, unknown>;
  }
  const draft = consoleEventOf('log', ['[x] big', deep, 'z'.repeat(50_000)], NOW);
  assert.ok(JSON.stringify(draft).length < 64 * 1024);
});

// ── pure: levels ───────────────────────────────────────────────────────────

test('console methods map onto Seq levels', () => {
  assert.equal(levelForConsole('error', null), 'Error');
  assert.equal(levelForConsole('warn', null), 'Warning');
  assert.equal(levelForConsole('log', null), 'Information');
  assert.equal(levelForConsole('info', null), 'Information');
  assert.equal(levelForConsole('debug', null), 'Debug');
});

test('a + suffix marks a verbose channel and ships at Debug', () => {
  assert.equal(levelForConsole('log', 'spotify+'), 'Debug');
  assert.equal(consoleEventOf('log', ['[spotify+] seam'], NOW).level, 'Debug');
  assert.equal(consoleEventOf('log', ['[spotify] handoff'], NOW).level, 'Information');
});

test('a + suffix never demotes a real failure', () => {
  assert.equal(levelForConsole('error', 'spotify+'), 'Error');
  assert.equal(levelForConsole('warn', 'spotify+'), 'Warning');
});

test('logEvent types map onto Seq levels', () => {
  assert.equal(levelForEvent('error', {}), 'Error');
  assert.equal(levelForEvent('pick.failed', {}), 'Error');
  assert.equal(levelForEvent('warning', {}), 'Warning');
  assert.equal(levelForEvent('trace.end', { ok: false }), 'Warning');
  assert.equal(levelForEvent('trace.end', { ok: true }), 'Information');
  assert.equal(levelForEvent('llm', { error: 'timeout' }), 'Warning');
  assert.equal(levelForEvent('pick.rejected', { reason: 'cooldown' }), 'Information');
});

test('parseLevel accepts the casings and aliases an operator actually types', () => {
  for (const raw of ['Debug', 'debug', 'DEBUG', ' debug ']) {
    assert.equal(parseLevel(raw).level, 'Debug', raw);
  }
  assert.equal(parseLevel('info').level, 'Information');
  assert.equal(parseLevel('warn').level, 'Warning');
  assert.equal(parseLevel('trace').level, 'Verbose');
  assert.equal(parseLevel('critical').level, 'Fatal');
  assert.equal(parseLevel(undefined).level, 'Information', 'absent is not a complaint');
  assert.equal(parseLevel(undefined).problem, undefined);
});

test('an unparseable level falls back AND says so', () => {
  const got = parseLevel('chatty');
  assert.equal(got.level, 'Information');
  assert.match(String(got.problem), /chatty/);
});

test('shouldEmit is a floor across every level pair', () => {
  for (const level of SEQ_LEVELS) {
    for (const floor of SEQ_LEVELS) {
      const expected = SEQ_LEVELS.indexOf(level) >= SEQ_LEVELS.indexOf(floor);
      assert.equal(shouldEmit(level, floor), expected, `${level} vs ${floor}`);
    }
  }
});

test('a remote level may only restrict, never widen', () => {
  assert.equal(effectiveLevel('Information', 'Warning'), 'Warning', 'stricter remote wins');
  assert.equal(effectiveLevel('Information', 'Debug'), 'Information', 'looser remote is ignored');
  assert.equal(effectiveLevel('Debug', null), 'Debug');
  assert.equal(effectiveLevel('Debug', 'nonsense' as SeqLevel), 'Debug', 'junk never widens');
});

// ── pure: logEventOf ───────────────────────────────────────────────────────

test('logEventOf carries the trace as a W3C id and cannot be shadowed', () => {
  const draft = logEventOf(
    'llm.call',
    { ms: 42, EventType: 'spoofed' },
    { traceId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', seq: 7 },
    NOW,
  );
  assert.equal(draft.messageTemplate, MT_EVENT);
  assert.equal(draft.traceId, '3f2504e04f8911d39a0c0305e82c3301');
  assert.equal(String(draft.traceId).length, 32);
  assert.equal(draft.properties.EventType, 'llm.call', 'the envelope wins over the payload');
  assert.equal(draft.properties.TraceSeq, 7);
  assert.equal(draft.properties.ms, 42);
  assert.equal(draft.properties.Source, 'llm');
});

test('Detail prefers an explicit message, then falls back to leading scalars', () => {
  assert.equal(logEventOf('x.y', { message: 'said it' }, null, NOW).properties.Detail, 'said it');
  assert.equal(logEventOf('x.y', { error: 'timed out' }, null, NOW).properties.Detail, 'timed out');
  // The common case: no message field at all, so the event list would otherwise
  // read as a bare type name with every fact hidden in the property list.
  assert.equal(
    logEventOf('pick.made', { title: 'Hurricane', artist: 'Bob Dylan', ms: 412, meta: { a: 1 } }, null, NOW)
      .properties.Detail,
    'title=Hurricane artist=Bob Dylan ms=412',
    'objects are skipped, and only the first three scalars are taken',
  );
  assert.equal(logEventOf('tick', {}, null, NOW).properties.Detail, '', 'nothing to say stays empty');
});

test('logEventOf without a trace omits the id rather than nulling it', () => {
  const draft = logEventOf('navidrome', { ms: 3 }, null, NOW);
  assert.equal('traceId' in draft, false);
  assert.equal(draft.properties.Source, 'navidrome');
});

test('logEventOf survives a payload JSON.stringify would reject', () => {
  const data: Record<string, unknown> = { kind: 'pick' };
  data.self = data;
  const draft = logEventOf('pick.made', data, null, NOW);
  assert.equal(draft.properties.self, '[Circular]');
});

// ── pure: resolveSeqConfig ─────────────────────────────────────────────────

test('no SEQ_URL means off, with nothing to complain about', () => {
  const { cfg, problems } = resolveSeqConfig({});
  assert.equal(cfg.enabled, false);
  assert.deepEqual(problems, []);
});

test('a malformed SEQ_URL stays off and reports, never throws', () => {
  const { cfg, problems } = resolveSeqConfig({ SEQ_URL: 'not-a-url' });
  assert.equal(cfg.enabled, false);
  assert.equal(problems.length, 1);
  const ftp = resolveSeqConfig({ SEQ_URL: 'ftp://logs.example.com' });
  assert.equal(ftp.cfg.enabled, false);
});

test('a full config resolves, with defaults for what is absent', () => {
  const { cfg, problems } = resolveSeqConfig({
    SEQ_URL: 'https://log.danmusk.com',
    SEQ_API_KEY: ' abc123 ',
    SEQ_LOG_LEVEL: 'debug',
  });
  assert.deepEqual(problems, []);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.apiKey, 'abc123');
  assert.equal(cfg.level, 'Debug');
  assert.equal(cfg.batchMs, 2000);
  assert.equal(cfg.flushMs, 1500);
  assert.equal(cfg.app, 'subwave');
});

test('a junk numeric var falls back and reports rather than shipping NaN', () => {
  const { cfg, problems } = resolveSeqConfig({ SEQ_URL: 'http://seq:5341', SEQ_BATCH_MS: 'soon' });
  assert.equal(cfg.batchMs, 2000);
  assert.equal(problems.length, 1);
  const huge = resolveSeqConfig({ SEQ_URL: 'http://seq:5341', SEQ_BATCH_MS: '999999' });
  assert.equal(huge.cfg.batchMs, 2000);
  assert.equal(huge.problems.length, 1);
});

// ── the console tap ────────────────────────────────────────────────────────

interface Harness {
  printed: { method: ConsoleMethod; args: unknown[] }[];
  restore(): void;
}

// Swap the real console for a recorder BEFORE installing the tap, so the tap
// captures the recorder as "the original" and the suite's output stays clean.
function harness(): Harness {
  const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];
  const bag = console as unknown as Record<string, (...a: unknown[]) => void>;
  const real: Record<string, (...a: unknown[]) => void> = {};
  const printed: { method: ConsoleMethod; args: unknown[] }[] = [];
  for (const m of methods) {
    real[m] = bag[m];
    bag[m] = (...args: unknown[]) => { printed.push({ method: m, args }); };
  }
  installConsoleTap();
  return {
    printed,
    restore() {
      uninstallConsoleTap();
      for (const m of methods) bag[m] = real[m];
    },
  };
}

test('the tap forwards to the sink and still prints', () => {
  const h = harness();
  try {
    const seen: { method: ConsoleMethod; args: readonly unknown[] }[] = [];
    attachSink((method, args) => { seen.push({ method, args }); });
    console.log('[x] hi');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'log');
    assert.deepEqual(seen[0].args, ['[x] hi']);
    assert.equal(h.printed.length, 1, 'the original still ran');
  } finally {
    h.restore();
  }
});

test('a sink that throws never reaches the caller, and the line still prints', () => {
  const h = harness();
  try {
    attachSink(() => { throw new Error('sink exploded'); });
    assert.doesNotThrow(() => console.log('[x] hi'));
    assert.equal(h.printed.length, 1);
    assert.ok(tapStats().dropped >= 1);
  } finally {
    h.restore();
  }
});

test('a sink that logs is called exactly once — no storm', () => {
  const h = harness();
  try {
    let calls = 0;
    attachSink(() => {
      calls += 1;
      // Exactly what seq-logging's default onError does.
      console.error('[seq] shipping failed');
    });
    console.log('[x] hi');
    assert.equal(calls, 1, 'the reentrancy latch must stop the second pass');
  } finally {
    h.restore();
  }
});

test('lines logged before the sink attaches are drained in order', () => {
  const h = harness();
  try {
    console.log('[x] one');
    console.log('[x] two');
    console.log('[x] three');
    const seen: string[] = [];
    attachSink((_m, args) => { seen.push(String(args[0])); });
    assert.deepEqual(seen, ['[x] one', '[x] two', '[x] three']);
  } finally {
    h.restore();
  }
});

test('the pre-sink ring is bounded and drops rather than growing', () => {
  const h = harness();
  try {
    for (let i = 0; i < 600; i += 1) console.log(`[x] ${i}`);
    assert.equal(tapStats().buffered, 200);
    let drained = 0;
    attachSink(() => { drained += 1; });
    assert.equal(drained, 200);
    assert.equal(h.printed.length, 600, 'every line still printed');
  } finally {
    h.restore();
  }
});

// The byte-identical-console guarantee an operator without SEQ_URL relies on.
test('uninstall restores the exact original functions', () => {
  const bag = console as unknown as Record<string, unknown>;
  const before = bag.log;
  installConsoleTap();
  try {
    assert.notEqual(bag.log, before, 'install must actually patch');
    assert.equal(originalConsole().log, before, 'and must capture what it replaced');
  } finally {
    uninstallConsoleTap();
  }
  assert.equal(bag.log, before, 'uninstall must put back the very same function');
});

// ── the sink ───────────────────────────────────────────────────────────────

function fakeLogger(): { emitted: Record<string, unknown>[]; logger: SeqLoggerLike } {
  const emitted: Record<string, unknown>[] = [];
  return {
    emitted,
    logger: {
      emit(event) { emitted.push(event as unknown as Record<string, unknown>); },
      flush() { return Promise.resolve(true); },
    },
  };
}

test('with no logger the sink is inert', () => {
  setLogger(null);
  assert.equal(seqEnabled(), false);
  assert.doesNotThrow(() => onConsole('log', ['[x] hi']));
  assert.doesNotThrow(() => seqLogEvent('pick.made', { a: 1 }, null));
  assert.doesNotThrow(() => seqBooth('queued', 'hi', { id: 1 }));
});

test('the floor drops what is below it before the event is built', () => {
  const f = fakeLogger();
  setLogger(f.logger, { floor: 'Warning', base: {} });
  try {
    onConsole('log', ['[x] chatty']);
    assert.equal(f.emitted.length, 0);
    onConsole('error', ['[x] real']);
    assert.equal(f.emitted.length, 1);
    assert.equal(f.emitted[0].level, 'Error');
  } finally {
    setLogger(null);
  }
});

test('a verbose channel is filtered at the default floor but its event is not', () => {
  const f = fakeLogger();
  setLogger(f.logger, { floor: 'Information', base: {} });
  try {
    // This is the strace double-emit: one console line plus one logEvent.
    onConsole('log', ['[spotify+] seam decision']);
    seqLogEvent('spotify.seam', { action: 'wait' }, null);
    assert.equal(f.emitted.length, 1, 'exactly one of the pair survives');
    assert.equal(f.emitted[0].messageTemplate, MT_EVENT, 'the structured half is the one kept');
  } finally {
    setLogger(null);
  }
});

test('base properties ride every event but never shadow its own', () => {
  const f = fakeLogger();
  setLogger(f.logger, { floor: 'Information', base: { Application: 'subwave', Source: 'base' } });
  try {
    onConsole('log', ['[queue] hi']);
    const props = f.emitted[0].properties as Record<string, unknown>;
    assert.equal(props.Application, 'subwave');
    assert.equal(props.Source, 'queue', 'the event wins over the base');
  } finally {
    setLogger(null);
  }
});

test('seqBooth carries the meta bag the console line cannot', () => {
  const f = fakeLogger();
  setLogger(f.logger, { floor: 'Information', base: {} });
  try {
    seqBooth('queued', 'Swapped "A" for "B"', { fromId: 'a1', toId: 'b2' });
    const props = f.emitted[0].properties as Record<string, unknown>;
    assert.equal(props.Source, 'queued');
    assert.equal(props.Booth, true);
    assert.deepEqual(props.Meta, { fromId: 'a1', toId: 'b2' });
    assert.equal(f.emitted[0].messageTemplate, MT_WITH_SOURCE);
  } finally {
    setLogger(null);
  }
});

test('a booth kind of warn or error carries that severity', () => {
  const f = fakeLogger();
  setLogger(f.logger, { floor: 'Information', base: {} });
  try {
    seqBooth('warn', 'something is off');
    seqBooth('error', 'something broke');
    assert.equal(f.emitted[0].level, 'Warning');
    assert.equal(f.emitted[1].level, 'Error');
  } finally {
    setLogger(null);
  }
});

test('seqMuted suppresses the sink but never the console', () => {
  const h = harness();
  const f = fakeLogger();
  setLogger(f.logger, { floor: 'Information', base: {} });
  try {
    attachSink(onConsole);
    seqMuted(() => { console.log('[queued] already mirrored'); });
    assert.equal(f.emitted.length, 0, 'the tap must not double-emit a booth line');
    assert.equal(h.printed.length, 1, 'stdout is unchanged');
    console.log('[queued] not muted');
    assert.equal(f.emitted.length, 1, 'the mute is scoped to the call');
  } finally {
    setLogger(null);
    h.restore();
  }
});

test('flushSeq resolves even when the client rejects', async () => {
  setLogger({
    emit() {},
    flush() { return Promise.reject(new Error('seq is down')); },
  }, { floor: 'Information', base: {} });
  try {
    await assert.doesNotReject(() => flushSeq());
  } finally {
    setLogger(null);
  }
});

test('flushSeq with no logger resolves immediately', async () => {
  setLogger(null);
  await assert.doesNotReject(() => flushSeq());
});

test('an emit that throws is counted, not propagated', () => {
  setLogger({
    emit() { throw new Error('queue full'); },
    flush() { return Promise.resolve(true); },
  }, { floor: 'Information', base: {} });
  try {
    assert.doesNotThrow(() => onConsole('log', ['[x] hi']));
  } finally {
    setLogger(null);
  }
});
