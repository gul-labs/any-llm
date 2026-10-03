/**
 * RecordingLogger — a {@link Logger} that remembers every line.
 *
 * @module
 */

import type { Logger } from '@gullabs/core'

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

/** One logged line: its level, structured fields and message (the event name). */
export interface LogEntry {
  level: LogLevel
  fields: object
  message: string
}

/**
 * An in-memory {@link Logger}. The engine's canonical event names
 * (`llm.call.start`, `llm.call.sink.timeout`, ...) are the `message`.
 *
 * ```ts
 * const logger = new RecordingLogger()
 * // … run a call with { logger } …
 * expect(logger.messages('error')).toContain('llm.call.sink.timeout')
 * expect(logger.find('llm.call.retry')?.fields).toMatchObject({ attemptNumber: 1 })
 * ```
 */
export class RecordingLogger implements Logger {
  /** Every line, in the order it was logged. */
  readonly entries: LogEntry[] = []

  info(fields: object, message: string): void {
    this.entries.push({ level: 'info', fields, message })
  }

  warn(fields: object, message: string): void {
    this.entries.push({ level: 'warn', fields, message })
  }

  error(fields: object, message: string): void {
    this.entries.push({ level: 'error', fields, message })
  }

  debug(fields: object, message: string): void {
    this.entries.push({ level: 'debug', fields, message })
  }

  /** The messages logged, optionally only at `level`. */
  messages(level?: LogLevel): string[] {
    return this.entries
      .filter((e) => level === undefined || e.level === level)
      .map((e) => e.message)
  }

  /** The first entry whose message is `message`, or `undefined`. */
  find(message: string): LogEntry | undefined {
    return this.entries.find((e) => e.message === message)
  }

  /** Every entry whose message is `message`. */
  findAll(message: string): LogEntry[] {
    return this.entries.filter((e) => e.message === message)
  }
}
