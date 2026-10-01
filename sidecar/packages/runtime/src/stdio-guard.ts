/**
 * Absorb write errors on the sidecar's own stdout / stderr.
 *
 * Those streams are pipes to the macOS app, and the sidecar outlives the app
 * by design (a turn keeps running across a relaunch). When the app goes, the
 * pipe's read end closes and every later write fails with EPIPE — emitted as
 * an `error` event that, with no listener, becomes an uncaught exception.
 * Next's uncaught-exception handler logs it with `console.error`, to the same
 * dead pipe, which raises the next one. Observed 2026-10-01: the orphaned
 * sidecar spun at 84 % CPU source-mapping that one EPIPE stack forever and
 * answered no request, so the relaunched app adopted a dead server.
 *
 * A listener ends the loop. There is nobody to report a failed write to on a
 * stream whose reader is gone, so every write error on these streams is
 * dropped — this is never applied to a stream that carries data.
 */
export function guardStdio(streams: readonly NodeJS.EventEmitter[]): void {
  for (const stream of streams) {
    if ((stream as { __marvinStdioGuard?: boolean }).__marvinStdioGuard) continue;
    (stream as { __marvinStdioGuard?: boolean }).__marvinStdioGuard = true;
    stream.on("error", () => {
      // Deliberately empty: see above.
    });
  }
}
