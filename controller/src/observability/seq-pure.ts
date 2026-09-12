// Pure helpers for the Seq log sink. This file imports NOTHING — not a node
// builtin, not a repo module — which is what lets it sit at the very front of
// the boot graph and be exercised by a test with no side effects at all.
//
// The one rule worth defending here is the message template. Seq parses `{…}`
// in a `messageTemplate` as a property placeholder, so a template derived from a
// log line misparses the first JSON dump it meets. ESCAPING the braces is worse:
// it makes every interpolated string its own Seq event type, so `[queue] pushed
// "Foo"` and `[queue] pushed "Baz"` become two types and the grouping Seq exists
// to provide is gone. So the rendered text always rides in `properties.Message`,
// which Seq never parses, and the template is only ever one of the three
// constants below. Grouping lands on `Source` instead — the `[subsystem]` prefix
// the codebase already writes on nearly every console line.

export const SEQ_LEVELS = ['Verbose', 'Debug', 'Information', 'Warning', 'Error', 'Fatal'] as const;
export type SeqLevel = (typeof SEQ_LEVELS)[number];

const LEVEL_RANK: Record<SeqLevel, number> = {
  Verbose: 0, Debug: 1, Information: 2, Warning: 3, Error: 4, Fatal: 5,
};

/** The ONLY values that ever reach `messageTemplate`. See the header. */
export const MT_WITH_SOURCE = '[{Source}] {Message}';
export const MT_PLAIN = '{Message}';
export const MT_EVENT = '{EventType} {Detail}';

export type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface SeqEventDraft {
  timestamp: Date;
  level: SeqLevel;
  messageTemplate: string;
  properties: Record<string, unknown>;
  exception?: string;
  traceId?: string;
}

export interface SeqConfig {
  enabled: boolean;
  url: string;
  apiKey: string;
  level: SeqLevel;
  batchMs: number;
  flushMs: number;
  app: string;
}

export interface ResolvedSeqConfig {
  cfg: SeqConfig;
  /** Malformed vars, in read order. Reported once; never thrown. */
  problems: string[];
}

// Our own caps, applied before the library sees an event. They keep every event
// far below `eventSizeLimit`, which matters because the library's oversize path
// hands `onError` a string containing the WHOLE event body.
export const MESSAGE_CAP = 4000;
export const ARGS_CAP = 2000;
export const EXCEPTION_CAP = 8000;

const MAX_DEPTH = 4;

// Same marker convention as `cap()` in events.ts, so a truncated value reads the
// same wherever an operator meets it.
export function capText(str: string, n: number): string {
  if (typeof str !== 'string') return str;
  if (str.length <= n) return str;
  return str.slice(0, n) + `…[+${str.length - n} chars]`;
}

const LEVEL_ALIASES: Record<string, SeqLevel> = {
  verbose: 'Verbose', trace: 'Verbose',
  debug: 'Debug',
  info: 'Information', information: 'Information',
  warn: 'Warning', warning: 'Warning',
  error: 'Error', err: 'Error',
  fatal: 'Fatal', critical: 'Fatal',
};

// Deliberately NOT `envEnum` from util/env.ts: a log level is exactly the var an
// operator types in three different casings, and an exact-match enum would
// warn-and-fall-back on `SEQ_LOG_LEVEL=Debug`.
export function parseLevel(
  raw: string | undefined | null,
  fallback: SeqLevel = 'Information',
): { level: SeqLevel; problem?: string } {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return { level: fallback };
  const hit = LEVEL_ALIASES[key];
  if (hit) return { level: hit };
  return {
    level: fallback,
    problem: `SEQ_LOG_LEVEL="${raw}" is not a Seq level (${SEQ_LEVELS.join('|')}) — using ${fallback} instead`,
  };
}

// Remote may only RESTRICT. A remote setting able to LOWER the floor would let
// whoever reaches the Seq UI raise the air path's cost on a constrained host —
// the same posture as config.ts's "env always wins, settings fill the gaps".
// `remote` is null today (see seq-tap.ts); the rule is written now so it stays
// correct if the level is ever polled.
export function effectiveLevel(local: SeqLevel, remote: SeqLevel | null | undefined): SeqLevel {
  if (!remote || !(remote in LEVEL_RANK)) return local;
  return LEVEL_RANK[remote] > LEVEL_RANK[local] ? remote : local;
}

export function shouldEmit(level: SeqLevel, floor: SeqLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[floor];
}

// A tag is 1-32 chars so a stray "[" in prose cannot swallow a whole paragraph
// into a property name.
const SOURCE_RE = /^\[([A-Za-z0-9_+.-]{1,32})\]\s?/;

export function splitSource(text: string): { source: string | null; message: string } {
  const m = SOURCE_RE.exec(text);
  if (!m) return { source: null, message: text };
  return { source: m[1], message: text.slice(m[0].length) };
}

function isErrorLike(v: unknown): v is { name?: string; message?: string; stack: string } {
  // Duck-typed, not `instanceof`: an Error crossing a realm boundary fails that
  // check, and a worker/vm boundary is exactly where a stack matters most.
  return !!v && typeof v === 'object' && typeof (v as { stack?: unknown }).stack === 'string';
}

function errorText(e: { name?: string; message?: string; stack: string }): string {
  return e.stack || `${e.name || 'Error'}: ${e.message || ''}`;
}

// Depth- and budget-capped, circular-safe. Deliberately ours rather than the
// library's `removeCirculars`: that costs a full extra walk AND emits its own
// Error-level Seq event per occurrence.
export function safeJson(value: unknown, budget: number = ARGS_CAP): unknown {
  const seen = new WeakSet<object>();
  let spent = 0;

  function walk(v: unknown, depth: number): unknown {
    if (spent >= budget) return '…[truncated]';
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'boolean') { spent += 5; return v; }
    if (t === 'number') { spent += 8; return Number.isFinite(v as number) ? v : String(v); }
    if (t === 'bigint' || t === 'symbol') { const s = String(v); spent += s.length; return s; }
    if (t === 'function') { spent += 12; return `[Function ${(v as { name?: string }).name || 'anonymous'}]`; }
    if (t === 'string') {
      const s = capText(v as string, Math.max(16, budget - spent));
      spent += s.length;
      return s;
    }

    const obj = v as object;
    if (seen.has(obj)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Object]';
    if (typeof (obj as { toISOString?: unknown }).toISOString === 'function') {
      spent += 24;
      try { return (obj as { toISOString(): string }).toISOString(); } catch { return '[Date]'; }
    }
    if (isErrorLike(obj)) {
      const s = capText(errorText(obj), Math.max(64, budget - spent));
      spent += s.length;
      return s;
    }

    // Only ANCESTORS make a cycle, so the mark is lifted on the way out and the
    // same object may legitimately appear twice among siblings.
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const out: unknown[] = [];
        for (const item of obj) {
          if (spent >= budget) { out.push('…[truncated]'); break; }
          out.push(walk(item, depth + 1));
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      let entries: [string, unknown][] = [];
      try { entries = Object.entries(obj as Record<string, unknown>); } catch { return '[Object]'; }
      for (const [k, val] of entries) {
        if (spent >= budget) { out['…'] = '…[truncated]'; break; }
        spent += k.length;
        out[k] = walk(val, depth + 1);
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  }

  return walk(value, 0);
}

// A `+` suffix on a subsystem tag marks that subsystem's VERBOSE channel, and
// ships at Debug so it is off at the default floor. This is a house convention,
// not a feature-branch special case — develop-only code must not name a branch.
//
// The demotion deliberately does NOT touch warn/error. Hiding a real failure
// because its tag ends in `+` would be the worst kind of quiet.
export function levelForConsole(method: ConsoleMethod, source: string | null): SeqLevel {
  if (method === 'error') return 'Error';
  if (method === 'warn') return 'Warning';
  if (source && source.endsWith('+')) return 'Debug';
  if (method === 'debug') return 'Debug';
  return 'Information';
}

export function levelForEvent(type: string, data: unknown): SeqLevel {
  const t = String(type || '').toLowerCase();
  if (t === 'error' || t.endsWith('.error') || t.endsWith('.failed')) return 'Error';
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (d.error != null || d.err != null) return 'Warning';
    if (d.ok === false) return 'Warning';
  }
  if (t === 'warn' || t === 'warning') return 'Warning';
  return 'Information';
}

function formatPrimitive(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  return String(v);
}

export function consoleEventOf(
  method: ConsoleMethod,
  args: readonly unknown[],
  now: Date,
): SeqEventDraft {
  const parts: string[] = [];
  const extras: unknown[] = [];
  let exception: string | undefined;

  for (const a of args) {
    if (isErrorLike(a)) {
      // The FIRST error becomes the event's exception; later ones ride in Args
      // rather than overwriting it.
      if (exception === undefined) { exception = capText(errorText(a), EXCEPTION_CAP); continue; }
      extras.push(a);
      continue;
    }
    if (a === null || typeof a !== 'object') { parts.push(formatPrimitive(a)); continue; }
    extras.push(a);
  }

  const { source, message } = splitSource(parts.join(' '));
  const properties: Record<string, unknown> = { Message: capText(message, MESSAGE_CAP) };
  if (source) properties.Source = source;
  if (extras.length) {
    properties.Args = safeJson(extras.length === 1 ? extras[0] : extras, ARGS_CAP);
  }

  return {
    timestamp: now,
    level: levelForConsole(method, source),
    messageTemplate: source ? MT_WITH_SOURCE : MT_PLAIN,
    properties,
    ...(exception === undefined ? {} : { exception }),
  };
}

export function logEventOf(
  type: string,
  data: unknown,
  trace: { traceId: string; seq: number } | null | undefined,
  now: Date,
): SeqEventDraft {
  const bag = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : { value: data };

  const detailRaw = bag.message ?? bag.msg ?? bag.error ?? bag.err ?? '';
  const spread = safeJson(bag, ARGS_CAP);

  const properties: Record<string, unknown> = {
    ...(spread && typeof spread === 'object' && !Array.isArray(spread)
      ? (spread as Record<string, unknown>)
      : { Data: spread }),
    // Envelope last, so a `data.EventType` cannot shadow it.
    EventType: type,
    Detail: capText(formatPrimitive(detailRaw), MESSAGE_CAP),
    // Keeps the Source filter axis uniform with the console tap's `[prefix]`.
    Source: type.includes('.') ? type.slice(0, type.indexOf('.')) : type,
  };

  let traceId: string | undefined;
  if (trace?.traceId) {
    // randomUUID() minus its dashes is exactly 32 hex chars — a valid W3C trace
    // id, which is what makes one DJ decision read as one trace in Seq.
    const flat = trace.traceId.replace(/-/g, '');
    if (/^[0-9a-f]{32}$/i.test(flat)) traceId = flat;
    properties.TraceSeq = trace.seq;
  }

  return {
    timestamp: now,
    level: levelForEvent(type, bag),
    messageTemplate: MT_EVENT,
    properties,
    ...(traceId === undefined ? {} : { traceId }),
  };
}

function readMs(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
  problems: string[],
): number {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;
  if (!/^\d+$/.test(s)) {
    problems.push(`${name}="${raw}" is not a whole number — using ${fallback} instead`);
    return fallback;
  }
  const n = Number(s);
  if (n < min || n > max) {
    problems.push(`${name}="${raw}" is outside ${min}-${max} — using ${fallback} instead`);
    return fallback;
  }
  return n;
}

const OFF: SeqConfig = {
  enabled: false, url: '', apiKey: '', level: 'Information',
  batchMs: 2000, flushMs: 1500, app: 'subwave',
};

// PURE: takes an env record, returns a config and a list of complaints. Never
// throws, never reads process.env itself, never imports config.ts — importing it
// would drag the whole config graph in front of the console tap, which is the
// ordering problem this file exists to avoid.
export function resolveSeqConfig(env: Record<string, string | undefined>): ResolvedSeqConfig {
  const problems: string[] = [];
  const rawUrl = String(env.SEQ_URL ?? '').trim();
  // Unset is the ordinary case, not a complaint: the whole feature is opt-in.
  if (!rawUrl) return { cfg: { ...OFF }, problems };

  let url: string;
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error('scheme');
    url = u.toString();
  } catch {
    problems.push(`SEQ_URL="${rawUrl}" is not an http(s) URL — Seq log shipping stays off`);
    return { cfg: { ...OFF }, problems };
  }

  const parsed = parseLevel(env.SEQ_LOG_LEVEL, 'Information');
  if (parsed.problem) problems.push(parsed.problem);

  return {
    cfg: {
      enabled: true,
      url,
      apiKey: String(env.SEQ_API_KEY ?? '').trim(),
      level: parsed.level,
      batchMs: readMs(env.SEQ_BATCH_MS, 2000, 250, 60_000, 'SEQ_BATCH_MS', problems),
      flushMs: readMs(env.SEQ_FLUSH_MS, 1500, 0, 10_000, 'SEQ_FLUSH_MS', problems),
      app: String(env.SEQ_APP ?? '').trim() || 'subwave',
    },
    problems,
  };
}
