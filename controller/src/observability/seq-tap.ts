// Boot the Seq log sink. THIS IS THE ONLY FILE IN THE FEATURE WITH MODULE-LEVEL
// SIDE EFFECTS, and it is imported by `server.ts` and its own test — nothing
// else. Everything the rest of the controller touches goes through `seq.ts`,
// which is inert until this file hands it a logger.
//
// It must stay `server.ts`'s FIRST import. ESM evaluates a module's dependency
// graph depth-first in import order, and a dependency's body runs before the
// importing module's body — so from line 1 this file's body runs before
// `express`, `helmet` or `config.ts` evaluate, which is what catches
// `util/env.ts`'s `[env] …` warnings and everything else logged at import time.
//
// The top-level `await import('seq-logging')` is deliberate: it attaches the
// sink before the rest of the graph evaluates, so there is no second call site
// to wire into `server.ts`. The console tap is installed BEFORE that await and
// rings whatever lands during it.
//
// With `SEQ_URL` unset this ends by restoring the exact console methods it
// found, so an operator who has not opted in runs a byte-identical process —
// `seq-logging` is never even loaded.

import { attachSink, installConsoleTap, originalConsole, uninstallConsoleTap } from './console-tap.js';
import { resolveSeqConfig } from './seq-pure.js';
import { noteShippingError, onConsole, setLogger, type SeqLoggerLike } from './seq.js';

export { flushSeq, seqEnabled, seqStats } from './seq.js';

// Installed before anything is resolved, so nothing logged during the dynamic
// import below is lost.
installConsoleTap();

const { cfg, problems } = resolveSeqConfig(process.env);

/** Hard cap on the shutdown flush, read by `server.ts`. */
export const SEQ_FLUSH_MS = cfg.flushMs;

// Everything in this file writes through the ORIGINALS. Writing through the
// live `console` from inside the sink's own error path is precisely how a Seq
// outage becomes a log storm — and it is the seq-logging client's default.
const out = originalConsole();

for (const problem of problems) out.warn(`[seq] ${problem}`);

if (!cfg.enabled) {
  uninstallConsoleTap();
} else {
  // Rate-limited, and defensive about its argument: the client passes an Error
  // on most paths but a STRING CONTAINING THE WHOLE EVENT BODY (up to its
  // eventSizeLimit) on the oversize path. Printing that verbatim would dump a
  // quarter-megabyte into a log compose caps at 10 MB.
  let lastErrorAt = 0;
  const onError = (e: Error): void => {
    noteShippingError();
    const now = Date.now();
    if (now - lastErrorAt < 60_000) return;
    lastErrorAt = now;
    out.error('[seq] log shipping failed:', String((e as { message?: string })?.message ?? e).slice(0, 300));
  };

  try {
    const { Logger } = await import('seq-logging');
    const logger = new Logger({
      serverUrl: cfg.url,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      maxBatchingTime: cfg.batchMs,
      // Every one of these overrides a default that is wrong for a radio
      // station: stock settings spend ~3 minutes per batch giving up on a dead
      // Seq (30s timeout × 5 retries × 5s delay). ~15s here.
      requestTimeout: 5_000,
      maxRetries: 2,
      retryDelay: 1_000,
      // Our own caps in seq-pure.ts keep events far below this, which is what
      // makes the oversize path above unreachable in practice.
      eventSizeLimit: 64 * 1024,
      batchSizeLimit: 256 * 1024,
      onError,
    });

    setLogger(logger as unknown as SeqLoggerLike, {
      floor: cfg.level,
      base: {
        Application: cfg.app,
        Environment: process.env.NODE_ENV || 'development',
      },
    });
    // Drains everything the ring caught during the import above.
    attachSink(onConsole);
    out.log(`[seq] shipping logs to ${cfg.url} at ${cfg.level}${cfg.apiKey ? ' (with API key)' : ''}`);
  } catch (err) {
    // A missing or broken client must cost the station nothing at all.
    uninstallConsoleTap();
    setLogger(null);
    out.error(
      '[seq] disabled — could not load seq-logging:',
      String((err as { message?: string })?.message ?? err).slice(0, 300),
    );
  }
}
