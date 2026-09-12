// The Seq sink's state and emit API.
//
// This is the file the rest of the controller imports (`events.ts`, `queue.ts`),
// so it must stay cheap and side-effect-free: module evaluation is a handful of
// `let` declarations, and every entry point begins with a null check that is the
// whole cost when Seq is off. It imports `seq-pure.js` and nothing else — the
// console patch and the `seq-logging` client both live in `seq-tap.ts`, which
// only `server.ts` imports.
//
// Everything here is best-effort in the same sense as `logEvent`: a shipping
// failure is counted, never logged and never thrown. Nothing on the air path
// awaits anything — `emit()` is a synchronous array push into the client's own
// batch, and the HTTP work runs on its timer.

import {
  ARGS_CAP,
  capText,
  consoleEventOf,
  effectiveLevel,
  levelForEvent,
  logEventOf,
  MESSAGE_CAP,
  MT_WITH_SOURCE,
  safeJson,
  shouldEmit,
  type ConsoleMethod,
  type SeqEventDraft,
  type SeqLevel,
} from './seq-pure.js';

/** The slice of `seq-logging`'s Logger we depend on — so a test can fake it. */
export interface SeqLoggerLike {
  emit(event: {
    timestamp: Date;
    level?: string;
    messageTemplate?: string;
    properties?: object;
    exception?: string;
    traceId?: string;
  }): void;
  flush(): Promise<boolean>;
}

let logger: SeqLoggerLike | null = null;
let floor: SeqLevel = 'Information';
let remote: SeqLevel | null = null;
let baseProps: Record<string, unknown> = {};
let sent = 0;
let dropped = 0;

// Degrade latch. A Seq outage must be genuinely free, not merely bounded: past
// this many shipping errors in a window we stop building events entirely for a
// while, which also caps the client's unbounded internal queue from our side.
const DEGRADE_ERRORS = 20;
const DEGRADE_WINDOW_MS = 60_000;
const DEGRADE_PAUSE_MS = 60_000;
let errWindowStart = 0;
let errCount = 0;
let pausedUntil = 0;

// Set while `queue.log` writes its own console line, which it has ALREADY
// mirrored to Seq with the richer `meta` bag. Without this every booth line
// would arrive twice. `console.log` is synchronous, so the latch is exact
// rather than heuristic.
let muteDepth = 0;

export function seqMuted<T>(fn: () => T): T {
  muteDepth += 1;
  try {
    return fn();
  } finally {
    muteDepth -= 1;
  }
}

export function setLogger(
  next: SeqLoggerLike | null,
  opts: { floor?: SeqLevel; base?: Record<string, unknown> } = {},
): void {
  logger = next;
  if (opts.floor) floor = opts.floor;
  if (opts.base) baseProps = opts.base;
  if (!next) {
    remote = null;
    pausedUntil = 0;
    errCount = 0;
    errWindowStart = 0;
  }
}

export function seqEnabled(): boolean {
  return !!logger;
}

/** Seq's own minimum-level, if it is ever polled. May only RESTRICT — see seq-pure. */
export function setRemoteLevel(level: SeqLevel | null): void {
  remote = level;
}

function currentFloor(): SeqLevel {
  return effectiveLevel(floor, remote);
}

/** Called by `seq-tap.ts`'s onError. Trips the degrade latch. */
export function noteShippingError(): void {
  const now = Date.now();
  if (now - errWindowStart > DEGRADE_WINDOW_MS) {
    errWindowStart = now;
    errCount = 0;
  }
  errCount += 1;
  if (errCount >= DEGRADE_ERRORS) {
    pausedUntil = now + DEGRADE_PAUSE_MS;
    errCount = 0;
    errWindowStart = now;
  }
}

function shipping(): boolean {
  if (!logger) return false;
  if (pausedUntil > Date.now()) {
    dropped += 1;
    return false;
  }
  return true;
}

export function emitDraft(draft: SeqEventDraft): void {
  const target = logger;
  if (!target) return;
  // The authoritative level check. The callers' pre-filters below are a COST
  // optimisation over a method's ceiling — they cannot see the demotion a
  // `+`-suffixed source applies, so the real level is only known here.
  if (!shouldEmit(draft.level, currentFloor())) return;
  try {
    target.emit({
      timestamp: draft.timestamp,
      level: draft.level,
      messageTemplate: draft.messageTemplate,
      properties: { ...baseProps, ...draft.properties },
      ...(draft.exception === undefined ? {} : { exception: draft.exception }),
      ...(draft.traceId === undefined ? {} : { traceId: draft.traceId }),
    });
    sent += 1;
  } catch {
    // Silent: a catch that logs is the loop.
    dropped += 1;
  }
}

// The HIGHEST level a given console method can produce. Exact rather than
// approximate, because a `+`-suffixed source only ever DEMOTES — so this is a
// real pre-filter, and it is what makes SEQ_LOG_LEVEL bound cost (the event
// object is never built) rather than merely bound traffic.
function ceilingFor(method: ConsoleMethod): SeqLevel {
  if (method === 'error') return 'Error';
  if (method === 'warn') return 'Warning';
  if (method === 'debug') return 'Debug';
  return 'Information';
}

/** The console tap's sink. Installed by `seq-tap.ts`, never called directly. */
export function onConsole(method: ConsoleMethod, args: readonly unknown[]): void {
  if (muteDepth > 0) return;
  if (!shipping()) return;
  if (!shouldEmit(ceilingFor(method), currentFloor())) return;
  try {
    emitDraft(consoleEventOf(method, args, new Date()));
  } catch {
    dropped += 1;
  }
}

/** Tap 2 — the structured mirror of `logEvent`, carrying its traceId. */
export function seqLogEvent(
  type: string,
  data: unknown,
  trace: { traceId: string; seq: number } | null | undefined,
): void {
  if (!shipping()) return;
  try {
    if (!shouldEmit(levelForEvent(type, data), currentFloor())) return;
    emitDraft(logEventOf(type, data, trace, new Date()));
  } catch {
    dropped += 1;
  }
}

/** Tap 3 — the booth log, with the `meta` bag its console line cannot carry. */
export function seqBooth(
  kind: string,
  message: string,
  meta: Record<string, unknown> = {},
): void {
  if (!shipping()) return;
  try {
    // The booth log's `kind` is a free-form tag, not a severity, but two of its
    // conventional values are.
    const level: SeqLevel = kind === 'error' ? 'Error' : kind === 'warn' ? 'Warning' : 'Information';
    if (!shouldEmit(level, currentFloor())) return;

    const properties: Record<string, unknown> = {
      Message: capText(String(message ?? ''), MESSAGE_CAP),
      Source: String(kind || 'booth'),
      Booth: true,
    };
    if (meta && typeof meta === 'object' && Object.keys(meta).length) {
      properties.Meta = safeJson(meta, ARGS_CAP);
    }
    emitDraft({ timestamp: new Date(), level, messageTemplate: MT_WITH_SOURCE, properties });
  } catch {
    dropped += 1;
  }
}

/**
 * Flush whatever is batched. MUST NOT reject: the only caller is `shutdown()`,
 * and a rejection there routes through the `unhandledRejection` handler into
 * `console.error` and back through the tap, mid-teardown.
 */
export async function flushSeq(): Promise<void> {
  const target = logger;
  if (!target) return;
  try {
    await target.flush();
  } catch {
    /* best effort */
  }
}

export function seqStats(): {
  enabled: boolean;
  floor: SeqLevel;
  remote: SeqLevel | null;
  sent: number;
  dropped: number;
  pausedMs: number;
} {
  return {
    enabled: !!logger,
    floor,
    remote,
    sent,
    dropped,
    pausedMs: Math.max(0, pausedUntil - Date.now()),
  };
}
