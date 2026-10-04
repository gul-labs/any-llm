import { describe, expect, it } from 'vitest'
import { readSseFrames } from './sse.js'
import type { SseFrame } from './sse.js'

function bodyOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

async function read(chunks: Array<string | Uint8Array>): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  for await (const frame of readSseFrames(bodyOf(chunks))) frames.push(frame)
  return frames
}

describe('readSseFrames', () => {
  it('yields event and data per blank-line-terminated frame', async () => {
    expect(
      await read(['event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\n']),
    ).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: 'b', data: '{"y":2}' },
    ])
  })

  it('joins several data lines with LF and removes one leading space only', async () => {
    expect(await read(['data:  two spaces\ndata: next\ndata:none\n\n'])).toEqual([
      { event: undefined, data: ' two spaces\nnext\nnone' },
    ])
  })

  it('accepts LF, CRLF and CR line endings, also when a CRLF is split between chunks', async () => {
    expect(await read(['event: a\r\ndata: 1\r\n\r\n', 'event: b\rdata: 2\r\r'])).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ])
    expect(await read(['event: a\r', '\ndata: 1\r', '\n\r', '\n'])).toEqual([
      { event: 'a', data: '1' },
    ])
  })

  it('skips comment lines and a comment-only block, and reports a bare named frame as data-less', async () => {
    expect(
      await read([': heartbeat\n\n', 'event: keepalive\n\n', ': x\ndata: y\n\n']),
    ).toEqual([
      { event: 'keepalive', data: '' },
      { event: undefined, data: 'y' },
    ])
  })

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: héllo ✓ 😀\n\n')
    const frames: SseFrame[] = []
    for await (const frame of readSseFrames(
      bodyOf([...bytes].map((b) => new Uint8Array([b]))),
    )) {
      frames.push(frame)
    }
    expect(frames).toEqual([{ event: undefined, data: 'héllo ✓ 😀' }])
  })

  it('drops a leading byte order mark', async () => {
    expect(await read(['﻿data: 1\n\n'])).toEqual([{ event: undefined, data: '1' }])
  })

  it('drops a frame that was cut off before its blank line', async () => {
    expect(await read(['data: 1\n\ndata: {"cut":'])).toEqual([
      { event: undefined, data: '1' },
    ])
    expect(await read(['data: 1\n\ndata: 2\n'])).toEqual([
      { event: undefined, data: '1' },
    ])
  })

  it('calls onChunk for every chunk of bytes, a comment-only chunk included', async () => {
    let chunks = 0
    const frames: SseFrame[] = []
    for await (const frame of readSseFrames(
      bodyOf([': hb\n\n', ': hb\n\n', 'data: 1\n\n']),
      {
        onChunk: () => chunks++,
      },
    )) {
      frames.push(frame)
    }
    expect(chunks).toBe(3)
    expect(frames).toHaveLength(1)
  })

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    for await (const frame of readSseFrames(body)) {
      expect(frame.data).toBe('1')
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)
  })

  it('is released by `aborted` even when the body never reacts to the abort', async () => {
    const silent = new ReadableStream<Uint8Array>({ start() {} })
    let reject: (reason: unknown) => void = () => {}
    const aborted = new Promise<never>((_resolve, r) => {
      reject = r
    })
    aborted.catch(() => undefined)
    const pending = (async () => {
      for await (const frame of readSseFrames(silent, { aborted })) void frame
    })()
    setTimeout(() => reject(new Error('stop')), 10)
    await expect(pending).rejects.toThrow('stop')
  })
})
