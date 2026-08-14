#!/usr/bin/env node
/**
 * magnetic-mcp — MCP stdio bridge to a running Magnetic editor.
 *
 * Speaks the Model Context Protocol (newline-delimited JSON-RPC 2.0 over
 * stdio) so any MCP client (Claude Code, Claude Desktop, custom harnesses)
 * can see and co-edit the OPEN project. Zero dependencies.
 *
 * Every timeline edit is a PROPOSAL: it ghost-renders on the editor's
 * timeline and applies only when the human clicks Accept. There is no
 * export tool. The one exception is import_media, which lands assets
 * directly in the open library (visible in the browser, no proposal gate) —
 * imports are additive and allowlisted, not edits to existing work.
 *
 * Config: MAGNETIC_AGENT_PORT + MAGNETIC_AGENT_TOKEN env vars, or the
 * discovery file the editor writes while Agent Access is enabled
 * (%APPDATA%/magnetic/agent-sidecar.json — "Magnetic" when packaged).
 *
 * Claude Code:  claude mcp add magnetic -- node scripts/magnetic-mcp.mjs
 *
 * Second role — in-app copilot subscription transport: when the editor
 * itself spawns this shim with MAGNETIC_MCP_ROLE=copilot (plus the same
 * port/token env), tools/list is fetched live from the sidecar's
 * __list_tools instead of the static TOOLS list above, and tools/call
 * results carry the sidecar's image payloads through as MCP image blocks.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'

function discover() {
  const { MAGNETIC_AGENT_PORT, MAGNETIC_AGENT_TOKEN } = process.env
  if (MAGNETIC_AGENT_PORT !== undefined && MAGNETIC_AGENT_TOKEN !== undefined) {
    return { port: Number(MAGNETIC_AGENT_PORT), token: MAGNETIC_AGENT_TOKEN }
  }
  const appData =
    process.env.APPDATA ?? join(process.env.HOME ?? '', 'Library', 'Application Support')
  for (const name of ['magnetic', 'Magnetic']) {
    try {
      const parsed = JSON.parse(readFileSync(join(appData, name, 'agent-sidecar.json'), 'utf8'))
      if (typeof parsed.port === 'number' && typeof parsed.token === 'string') return parsed
    } catch {
      // keep looking
    }
  }
  return null
}

async function callSidecar(tool, input) {
  const config = discover()
  if (config === null) {
    throw new Error(
      'Magnetic is not reachable — open the editor and enable Agent Access in the sidebar (or set MAGNETIC_AGENT_PORT / MAGNETIC_AGENT_TOKEN).'
    )
  }
  let response
  try {
    response = await fetch(`http://127.0.0.1:${config.port}/tool`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ tool, input })
    })
  } catch {
    throw new Error('Magnetic refused the connection — Agent Access is switched off.')
  }
  const payload = await response.json()
  if (!response.ok || payload.error !== undefined) {
    throw new Error(payload.error ?? `sidecar answered HTTP ${response.status}`)
  }
  return payload.result
}

const TOOLS = [
  {
    name: 'import_media',
    description:
      "Import video files from the user's allowlisted agent media folders into the open library. Rejects paths outside the allowlist.",
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths']
    }
  },
  {
    name: 'read_timeline',
    description:
      'The open sequence as text: clips with ids and m:ss.s timecodes, detected dead air, and the timestamped transcript. Read this before proposing anything.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_status',
    description:
      'Editor status: project open, spine item count, duration, whether a proposal is pending, and the verdict on your last proposal (accepted / discarded).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'check_flow',
    description:
      'Grade the current cut 0-100 with flags for residual dead air, untransitioned jump cuts, and sub-half-second slivers.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'propose_edits',
    description:
      'Propose a batch of edits. Ops (times in SECONDS, clip ids from read_timeline): ripple_delete_range {from_sec,to_sec}; ripple_delete_clips {clip_ids}; blade {clip_id,at_sec}; trim_clip {clip_id,edge:head|tail,delta_sec}; move_clip {clip_id,to_index}; roll_edit {edit_point_index,delta_sec}; slip_clip {clip_id,delta_sec}; add_transition {edit_point_index,duration_sec,kind:dissolve|wipeL|wipeR|fadeBlack}; set_role {clip_id,role:dialogue|music|sfx}; set_volume {clip_id,volume_db}; add_marker {at_sec,text,color?:blue|green|orange|red}; remove_marker {marker_id}; append_clip {asset_id} (spine end); insert_clip {asset_id,at_index} (ripple); connect_clip {asset_id,at_sec} (connected lane). asset_id comes from import_media. An unknown asset_id rejects the whole batch, naming it. NOTHING is applied: the human sees a ghost-diff preview and decides. Poll get_status for their verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, input: { type: 'object' } },
            required: ['name', 'input']
          }
        }
      },
      required: ['ops']
    }
  },
  {
    name: 'cut_words',
    description:
      'Text-based editing: cut the timeline range where the given words are spoken (case/punctuation-insensitive match against the transcript). If the quote occurs more than once, the occurrences come back with timestamps — pass occurrence (0-based) to pick one. Presented as a ghost-diff proposal — poll get_status for the verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        quote: { type: 'string', description: 'The spoken words to remove, e.g. "um so anyway"' },
        occurrence: { type: 'number', description: '0-based pick when the quote repeats' }
      },
      required: ['quote']
    }
  },
  {
    name: 'duck_music',
    description:
      'Auto-duck: find where dialogue is speaking and propose gain dips on every music-role bed under it (default −12 dB). Presented as a ghost-diff proposal — poll get_status for the verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        amount_db: { type: 'number', description: 'Negative dip depth, defaults to -12' }
      }
    }
  },
  {
    name: 'normalize_loudness',
    description:
      'Measure each target clip’s source loudness (EBU R128) and propose per-clip volume changes that bring them to the target LUFS (default −14, the streaming standard). Targets every dialogue-role clip unless clip_ids narrows it. Presented as a ghost-diff proposal like any edit — poll get_status for the verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        target_lufs: { type: 'number', description: 'Defaults to -14' },
        clip_ids: { type: 'array', items: { type: 'string' } }
      }
    }
  }
]

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n'
  )
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (method === undefined) return
  if (method.startsWith('notifications/')) return // no response for notifications
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'magnetic-mcp', version: '1.0.0' }
    })
    return
  }
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (method === 'tools/list') {
    if (process.env.MAGNETIC_MCP_ROLE === 'copilot') {
      void callSidecar('__list_tools', {})
        .then((result) => reply(id, { tools: result.tools }))
        .catch((error) =>
          replyError(id, error instanceof Error ? error.message : String(error))
        )
      return
    }
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const input = params?.arguments ?? {}
    void callSidecar(name, input)
      .then((result) => {
        if (result !== null && typeof result === 'object' && result.__image !== undefined) {
          reply(id, {
            content: [
              { type: 'image', data: result.__image.data, mimeType: result.__image.mimeType },
              { type: 'text', text: String(result.note ?? '') }
            ]
          })
          return
        }
        reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] })
      })
      .catch((error) => {
        reply(id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true
        })
      })
    return
  }
  replyError(id, `unknown method "${method}"`)
})
