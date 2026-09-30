import { createServer } from 'node:http'

// Scripted DeepSeek Messages-API SSE server (the wire the 0.2.0 dsh-llm-deepseek
// adapter speaks: POST {root}/messages, anthropic-version header, Anthropic-style
// SSE events — message_start / content_block_start / content_block_delta /
// content_block_stop / message_delta / message_stop). FIFO turns like before;
// {{U1}} live-seq templates still throw on unknown placeholders; usage stays
// honest so rule 12's projection anchor keeps working.
const state = { turns: [], index: 0, seqs: {}, requests: [] }
const sseEvent = (payload) => {
  return 'data: ' + JSON.stringify(payload) + '\n\n'
}
const startFakeLlm = async (options) => {
  state.turns = options.turns
  state.seqs = options.seqs
  state.index = 0
  state.requests = []
  const server = await createServer(handler)
  await listen(server, options.port ?? 0)
  return {
    port: server.address().port,
    baseURL: `http://127.0.0.1:${server.address().port}`,
    requests: state.requests,
    close: async () => {
      const done = new Promise((resolve) => { server.close(() => resolve()) })
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      await done
    }
  }
}
const listen = async (server, port) => {
  const p = new Promise((resolve) => {
    server.listen(port, () => resolve())
  })
  return await p
}
const handler = (req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('error', () => {})
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const parsed = JSON.parse(body)
    const turn = state.turns[state.index++]
    if (!turn) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { message: 'fake script exhausted', type: 'MOCK_EXHAUSTED' } }))
      state.requests.push({ type: 'error', path: req.url })
      return
    }
    const usage = {
      input_tokens: Math.ceil(JSON.stringify(parsed.messages ?? []).length / 4) + Math.ceil(JSON.stringify(parsed.tools ?? []).length / 4),
      output_tokens: Math.max(1, Math.ceil(Array.from(turn.kind === 'text' ? turn.text : '').length / 4))
    }
    if (turn.kind === 'text') {
      openSse(res)
      writeSse(res, { type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } })
      writeSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } })
      writeSse(res, { type: 'content_block_stop', index: 0 })
      writeSse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage })
      writeSse(res, { type: 'message_stop' })
      res.end()
      state.requests.push({ kind: 'text', raw: body, body: parsed })
      return
    }
    if (turn.kind === 'tool') {
      const args = render(turn.argsTemplate, state.seqs)
      const callId = 'mock-call-' + state.index
      // Two input_json_delta chunks: exercises the adapter's argument
      // reassembly, the same split-stream risk the old wire exercised.
      const half = Math.max(1, Math.floor(args.length / 2))
      openSse(res)
      writeSse(res, { type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } })
      writeSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: turn.name, input: {} } })
      writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(0, half) } })
      writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(half) } })
      writeSse(res, { type: 'content_block_stop', index: 0 })
      writeSse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage })
      writeSse(res, { type: 'message_stop' })
      res.end()
      state.requests.push({ kind: 'tool', name: turn.name, raw: body, body: parsed })
    }
  })
}
const openSse = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  res.flushHeaders()
}
const writeSse = (res, payload) => {
  res.write(sseEvent(payload))
}
// Unknown placeholders throw instead of degrading to a literal: a scenario
// typo ({{U9}}) must fail the suite on the spot, not surface later as a
// confusing "startSeq: MISSING" deep in the engine's error chain.
const render = (template, seqs) => {
  const found = template.replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (!(k in seqs)) throw new Error(`unknown seq placeholder {{"${k}"}} — recorded seqs: ${Object.keys(seqs).join(', ') || '(none)'}`)
  return String(seqs[k])
})
return found
}
export { startFakeLlm }
