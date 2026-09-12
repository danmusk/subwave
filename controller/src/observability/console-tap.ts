// The console tap: the one place `console.*` is wrapped so every line the
// controller already writes can be mirrored somewhere else.
//
// This file imports NOTHING and has NO module-evaluation side effects — the
// patch happens only when `installConsoleTap()` is called, and the only caller
// is `seq-tap.ts`. That is what keeps the tap out of `npm test`: `events.ts` and
// `queue.ts` reach the sink through `seq.ts`, never through here.
//
// Three properties are load-bearing and each closes a specific hole:
//
//   1. The ORIGINAL is called first, unconditionally, outside the try. stdout is
//      never delayed, reordered or lost because a sink hung or threw. `docker
//      logs` output is byte-identical whether or not a sink is attached.
//   2. A REENTRANCY latch. A `console.*` emitted from inside the sink (the Seq
//      client's own `onError` default is literally `console.error`) reaches the
//      real console and goes no further. This makes a storm impossible rather
//      than merely unlikely.
//   3. The emit-path catch is SILENT, with a counter. A catch that logs is the
//      loop it was meant to prevent.

// Declared locally rather than imported, so this file keeps its zero-import
// promise. Structurally identical to seq-pure.ts's, so the two interoperate.
export type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

export type ConsoleSink = (method: ConsoleMethod, args: readonly unknown[]) => void;

const METHODS: readonly ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];

// Covers the microtask gap between installing the tap and the sink being
// attached — `seq-tap.ts` top-level-awaits a dynamic import in between, and boot
// logging happens during it. Small on purpose: this is a gap, not a buffer.
const RING_MAX = 200;

type AnyFn = (...args: unknown[]) => void;
type ConsoleBag = Record<string, AnyFn>;

let originals: Record<ConsoleMethod, AnyFn> | null = null;
let sink: ConsoleSink | null = null;
let ring: { method: ConsoleMethod; args: unknown[] }[] = [];
let inSink = false;
let installed = false;
let dropped = 0;

const NOOP: AnyFn = () => {};

/**
 * The console methods as they were before the patch. `onError` handlers and
 * anything else running inside the sink MUST write through these — writing
 * through the live `console` is how a shipping failure becomes a storm.
 * Safe before install and after uninstall.
 */
export function originalConsole(): Record<ConsoleMethod, AnyFn> {
  if (originals) return originals;
  const c = console as unknown as ConsoleBag;
  const live = {} as Record<ConsoleMethod, AnyFn>;
  for (const m of METHODS) live[m] = typeof c[m] === 'function' ? c[m] : NOOP;
  return live;
}

export function installConsoleTap(): void {
  if (installed) return;
  const c = console as unknown as ConsoleBag;

  const captured = {} as Record<ConsoleMethod, AnyFn>;
  for (const m of METHODS) captured[m] = typeof c[m] === 'function' ? c[m] : NOOP;
  originals = captured;

  for (const m of METHODS) {
    c[m] = function tapped(...args: unknown[]): void {
      // (1) Original first, always, before anything can go wrong.
      captured[m].apply(console, args);
      // (2) Reentrancy latch.
      if (inSink) return;
      const target = sink;
      inSink = true;
      try {
        if (target) target(m, args);
        else if (ring.length < RING_MAX) ring.push({ method: m, args });
        else dropped += 1;
      } catch {
        // (3) Silent by design — see the header.
        dropped += 1;
      } finally {
        inSink = false;
      }
    };
  }

  installed = true;
}

/** Restores the exact function objects that were there before `install`. */
export function uninstallConsoleTap(): void {
  if (!installed || !originals) return;
  const c = console as unknown as ConsoleBag;
  for (const m of METHODS) c[m] = originals[m];
  installed = false;
  sink = null;
  ring = [];
  inSink = false;
}

/** Attach the sink and hand it everything buffered since `install`, in order. */
export function attachSink(fn: ConsoleSink): void {
  sink = fn;
  const pending = ring;
  ring = [];
  for (const entry of pending) {
    if (inSink) break;
    inSink = true;
    try {
      fn(entry.method, entry.args);
    } catch {
      dropped += 1;
    } finally {
      inSink = false;
    }
  }
}

export function tapStats(): {
  installed: boolean;
  attached: boolean;
  buffered: number;
  dropped: number;
} {
  return { installed, attached: !!sink, buffered: ring.length, dropped };
}
