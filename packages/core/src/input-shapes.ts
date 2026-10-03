/**
 * Shape checks for caller-supplied parts and messages, run before anything reads
 * them. TypeScript types do not stop a `null`, an `{}` or a part of an unknown
 * kind from reaching the engine at runtime; without these checks such a value
 * surfaces as a raw `TypeError` classified `unknown`, or reaches an adapter.
 *
 * @module
 */

import { LlmError } from './errors.js'
import type { LlmErrorIssue } from './errors.js'

const PART_KINDS: ReadonlySet<string> = new Set([
  'text',
  'inline-media',
  'file-uri',
  'file-ref',
  'tool-call',
  'tool-result',
])

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function partIssues(part: unknown, path: string, issues: LlmErrorIssue[]): void {
  if (!isRecord(part)) {
    issues.push({ path, message: 'must be a part object with a "kind".' })
    return
  }
  const kind = part['kind']
  if (typeof kind !== 'string' || !PART_KINDS.has(kind)) {
    issues.push({
      path: `${path}.kind`,
      message: `must be one of ${[...PART_KINDS].join(', ')}.`,
    })
  }
}

function listIssues(
  list: unknown,
  path: string,
  what: string,
  each: (item: unknown, itemPath: string, issues: LlmErrorIssue[]) => void,
): LlmErrorIssue[] {
  const issues: LlmErrorIssue[] = []
  if (!Array.isArray(list)) {
    issues.push({ path, message: `must be an array of ${what}.` })
    return issues
  }
  list.forEach((item, i) => {
    each(item, `${path}[${i}]`, issues)
  })
  return issues
}

function messageIssues(message: unknown, path: string, issues: LlmErrorIssue[]): void {
  if (!isRecord(message)) {
    issues.push({ path, message: 'must be a message object with a role and parts.' })
    return
  }
  const role = message['role']
  if (typeof role !== 'string' || !ROLES.has(role)) {
    issues.push({ path: `${path}.role`, message: 'must be "user" or "assistant".' })
  }
  issues.push(...listIssues(message['parts'], `${path}.parts`, 'parts', partIssues))
}

function refuse(issues: LlmErrorIssue[], what: string): never {
  const first = issues[0] as LlmErrorIssue
  throw new LlmError(`Invalid ${what}: ${first.path} ${first.message}`, {
    kind: 'bad_request',
    retryable: false,
    issues,
  })
}

/**
 * Throws `LlmError('bad_request')` naming the first bad path unless `parts` is
 * an array of part objects whose `kind` is a known part kind. `path` is the
 * caller's name for the array (`attachments`).
 *
 * @internal
 */
export function assertPartsShape(parts: unknown, path: string): void {
  const issues = listIssues(parts, path, 'parts', partIssues)
  if (issues.length > 0) refuse(issues, path)
}

/**
 * Throws `LlmError('bad_request')` naming the first bad path unless `messages`
 * is an array of `{ role: 'user' | 'assistant', parts }` objects whose parts
 * pass {@link assertPartsShape}. `path` is the caller's name for the array
 * (`messages`, `history`).
 *
 * @internal
 */
export function assertMessagesShape(messages: unknown, path: string): void {
  const issues = listIssues(messages, path, 'messages', messageIssues)
  if (issues.length > 0) refuse(issues, path)
}
