/**
 * RecordingTelemetry — a {@link Telemetry} that remembers every event.
 *
 * @module
 */

import type {
  AttemptEvent,
  CallErrorEvent,
  CallStartEvent,
  CallSuccessEvent,
  Telemetry,
} from '@gullabs/core'

/** One event the telemetry saw, with the span handle it was given. */
export type RecordedTelemetryEvent =
  | { type: 'start'; event: CallStartEvent }
  | { type: 'attempt'; event: AttemptEvent; span: unknown }
  | { type: 'success'; event: CallSuccessEvent; span: unknown }
  | { type: 'error'; event: CallErrorEvent; span: unknown }

/**
 * An in-memory {@link Telemetry}. `onStart` returns a fresh span handle
 * (`{ span: n }`), and the later events record the handle they received, so a
 * test can check that one call's events share one span.
 *
 * ```ts
 * const telemetry = new RecordingTelemetry()
 * // … run a call with { telemetry } …
 * expect(telemetry.attempts).toHaveLength(2)
 * expect(telemetry.successes[0]?.callCost?.attempts).toBe(2)
 * ```
 */
export class RecordingTelemetry implements Telemetry {
  /** Every event, in the order it arrived. */
  readonly events: RecordedTelemetryEvent[] = []

  private _spans = 0

  onStart(event: CallStartEvent): unknown {
    this.events.push({ type: 'start', event })
    this._spans += 1
    return { span: this._spans }
  }

  onAttempt(event: AttemptEvent, span?: unknown): void {
    this.events.push({ type: 'attempt', event, span })
  }

  onSuccess(event: CallSuccessEvent, span?: unknown): void {
    this.events.push({ type: 'success', event, span })
  }

  onError(event: CallErrorEvent, span?: unknown): void {
    this.events.push({ type: 'error', event, span })
  }

  /** The `onStart` events. */
  get starts(): CallStartEvent[] {
    return this.events.flatMap((e) => (e.type === 'start' ? [e.event] : []))
  }

  /** The `onAttempt` events, one per provider attempt. */
  get attempts(): AttemptEvent[] {
    return this.events.flatMap((e) => (e.type === 'attempt' ? [e.event] : []))
  }

  /** The `onSuccess` events. */
  get successes(): CallSuccessEvent[] {
    return this.events.flatMap((e) => (e.type === 'success' ? [e.event] : []))
  }

  /** The `onError` events. */
  get errors(): CallErrorEvent[] {
    return this.events.flatMap((e) => (e.type === 'error' ? [e.event] : []))
  }
}
