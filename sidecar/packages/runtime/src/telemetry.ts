/**
 * One-line JSON telemetry on stdout, the shape the sidecar log already
 * carries (`[marvin.telemetry] {...}`) and the practice loop's extractors
 * already read. The chat route has a private copy of this for historical
 * reasons; runtime modules import this one.
 */
export function logTelemetry(fields: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line no-console
    console.log(`[marvin.telemetry] ${JSON.stringify({ ...fields, at: new Date().toISOString() })}`);
  } catch {
    /* telemetry must never throw */
  }
}
