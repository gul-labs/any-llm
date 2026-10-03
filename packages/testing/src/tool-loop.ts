/**
 * runToolLoop — a function-calling loop for host tests.
 *
 * It follows `result.continuation` after every turn, so a host test exercises
 * the contract the provider actually has: append `result.message` and resend
 * the full history for `'history'`, or send only the new tool results plus
 * `result.transientProviderState` for `'state'`. The library itself runs no
 * loop (ADR-029); this is a test helper, not an agent runtime.
 *
 * @module
 */

import type {
  GenerateOptions,
  JsonValue,
  LlmRequest,
  LlmResult,
  Message,
  ToolResultPart,
} from '@gullabs/core'

/** The part of a client {@link runToolLoop} uses. */
export interface ToolLoopClient {
  generate(request: LlmRequest, opts: GenerateOptions): Promise<LlmResult>
}

/** A tool implementation: receives the model's arguments, returns the result. */
export type ToolImplementation = (args: JsonValue) => JsonValue | Promise<JsonValue>

export interface ToolLoopOptions extends GenerateOptions {
  /** Most model turns before the helper throws. Default 8. */
  maxTurns?: number
}

export interface ToolLoopOutcome {
  /** The final result: the first turn that returned no tool calls. */
  result: LlmResult
  /** Every turn's result, in order. */
  turns: LlmResult[]
}

/**
 * Run `req` to completion, executing tool calls with `tools` (by tool name).
 * `req.tools` declares the tools to the model; `tools` implements them.
 */
export async function runToolLoop(
  client: ToolLoopClient,
  req: LlmRequest,
  tools: Record<string, ToolImplementation>,
  opts: ToolLoopOptions,
): Promise<ToolLoopOutcome> {
  const { maxTurns = 8, ...generateOpts } = opts
  const turns: LlmResult[] = []
  let messages: Message[] = [...req.messages]
  let state: JsonValue | undefined = req.transientProviderState

  for (let turn = 1; turn <= maxTurns; turn++) {
    const next: LlmRequest = { ...req, messages }
    if (state === undefined) delete next.transientProviderState
    else next.transientProviderState = state
    const result = await client.generate(next, generateOpts)
    turns.push(result)
    const calls = result.toolCalls ?? []
    if (calls.length === 0) return { result, turns }

    const toolResults: ToolResultPart[] = []
    for (const call of calls) {
      const implementation = tools[call.toolName]
      if (implementation === undefined) {
        throw new Error(`runToolLoop: no implementation for tool "${call.toolName}".`)
      }
      toolResults.push({
        kind: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: await implementation(call.args),
      })
    }
    const resultsMessage: Message = { role: 'user', parts: toolResults }

    if (result.continuation === 'history') {
      messages = [...messages, result.message, resultsMessage]
    } else {
      // 'state': the state already holds the provider's output; send only the new
      // messages. result.message is for display and must not be replayed.
      if (result.transientProviderState === undefined) {
        throw new Error(
          'runToolLoop: continuation "state" requires result.transientProviderState.',
        )
      }
      messages = [resultsMessage]
    }
    state = result.transientProviderState
  }
  throw new Error(`runToolLoop: still calling tools after ${maxTurns} turns.`)
}
