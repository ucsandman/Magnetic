#!/usr/bin/env node
/**
 * Fake `claude` for E2E: speaks just enough of the headless contract.
 * --version -> prints a version. Otherwise: reads the prompt from stdin,
 * spawns the MCP server from --mcp-config, and -- when the prompt asks for a
 * cut -- REALLY calls the magnetic tools through it, then emits stream-json.
 * FAKE_CLAUDE_MODE=hang -> never answers (abort test). =authfail -> login error.
 *
 * The two short sleeps below are deliberate: they hold the process open long
 * enough after each stream delta for the E2E to observe the streaming text
 * before the final `result` event replaces it in the UI.
 */
import { readFileSync } from 'fs'
import { spawn } from 'child_process'

/**
 * Windows pipes are async: process.exit() right after a write() can drop the
 * write before the OS finishes flushing it, so every exit path here waits
 * for the write's callback before terminating.
 */
function writeAndExit(stream, text, code) {
  stream.write(text, () => process.exit(code))
}

const args = process.argv.slice(2)
if (args.includes('--version')) {
  writeAndExit(process.stdout, '9.9.9 (fake)\n', 0)
} else {
  const mode = process.env.FAKE_CLAUDE_MODE ?? 'normal'
  if (mode === 'authfail') {
    writeAndExit(process.stderr, 'Invalid API key . Please run /login\n', 1)
  } else if (mode === 'hang') {
    setTimeout(() => process.exit(1), 120_000) // killed by cancel long before this
  } else {
    void main()
  }
}

function argValue(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? null : args[index + 1]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

function delta(text) {
  emit({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  })
}

function rpc(child, id, method, params) {
  return new Promise((resolve) => {
    let buffered = ''
    const onData = (chunk) => {
      buffered += chunk.toString('utf8')
      let newline
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line.trim() === '') continue
        const message = JSON.parse(line)
        if (message.id === id) {
          child.stdout.off('data', onData)
          resolve(message)
          return
        }
      }
    }
    child.stdout.on('data', onData)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function main() {
  const prompt = await readStdin()
  const resumed = argValue('--resume') !== null
  const config = JSON.parse(readFileSync(argValue('--mcp-config'), 'utf8'))
  const serverConfig = config.mcpServers.magnetic
  const child = spawn(serverConfig.command, serverConfig.args, {
    env: { ...process.env, ...serverConfig.env }
  })
  await rpc(child, 1, 'initialize', { protocolVersion: '2024-11-05' })
  const list = await rpc(child, 2, 'tools/list', {})
  const names = list.result.tools.map((tool) => tool.name)
  delta('Looking at the timeline. ')
  await sleep(300)
  if (/cut the first second/i.test(prompt)) {
    // Confirmed against src/renderer/copilot/tools.ts EDIT_TOOLS: the real
    // seconds-range ripple delete is ripple_delete_range({from_sec, to_sec}).
    if (!names.includes('ripple_delete_range')) {
      writeAndExit(process.stderr, `fake-claude: edit tools missing, got ${names.join(',')}\n`, 1)
      return
    }
    await rpc(child, 3, 'tools/call', {
      name: 'ripple_delete_range',
      arguments: { from_sec: 0, to_sec: 1 }
    })
    await rpc(child, 4, 'tools/call', { name: 'read_timeline', arguments: {} })
    delta('Cut proposed.')
  } else {
    delta('No edits needed.')
  }
  await sleep(300)
  child.kill()
  writeAndExit(
    process.stdout,
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: resumed ? 'resumed-session answer' : 'first-session answer',
      session_id: resumed ? 'fake-session-two' : 'fake-session-one'
    }) + '\n',
    0
  )
}
