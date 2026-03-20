#!/usr/bin/env bun
/**
 * Slack MCP Server for Claude Code
 *
 * Custom PULL-based MCP server with file upload support.
 * Registered via mcpServers in settings.json.
 *
 * Key difference from official claude.ai Slack MCP:
 * - Official: read-only + text send only
 * - Custom: get_messages (pull) + send_message + send_file (images/docs)
 *
 * Architecture:
 *   Slack Bot API (polling via @slack/web-api)
 *     -> inbound messages stored in memory queue
 *     -> Claude calls get_messages to retrieve them
 *     -> Claude calls send_message / send_file to respond
 *
 * Required Slack Bot Token Scopes:
 *   channels:history, groups:history, im:history, mpim:history
 *   chat:write, files:write, users:read
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { WebClient } from '@slack/web-api'
import { readFileSync, createReadStream, statSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

// ── Configuration ──────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.claude', 'channels', 'slack')
const ENV_FILE = join(STATE_DIR, '.env')
const CONFIG_FILE = join(STATE_DIR, 'config.json')

const MAX_QUEUE_SIZE = 100
const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50MB

// ── Load .env ──────────────────────────────────────────────────────────────

try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.SLACK_BOT_TOKEN

if (!TOKEN) {
  process.stderr.write(
    `slack-mcp: SLACK_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: SLACK_BOT_TOKEN=xoxb-...\n`,
  )
  process.exit(1)
}

// ── Config ─────────────────────────────────────────────────────────────────

type Config = {
  allowChannels: string[]   // allowed channel IDs
  botUserId?: string        // bot's own user ID (auto-fetched)
}

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config
  } catch {
    return { allowChannels: [] }
  }
}

// ── Message Queue ──────────────────────────────────────────────────────────

type QueuedMessage = {
  channel_id: string
  message_ts: string
  user_id: string
  user_name: string
  text: string
  ts: string
  thread_ts?: string
}

const messageQueue: QueuedMessage[] = []
let lastPollTs: Record<string, string> = {}

function enqueue(msg: QueuedMessage): void {
  messageQueue.push(msg)
  while (messageQueue.length > MAX_QUEUE_SIZE) messageQueue.shift()
}

function dequeue(limit?: number): QueuedMessage[] {
  const count = limit && limit > 0 ? Math.min(limit, messageQueue.length) : messageQueue.length
  return messageQueue.splice(0, count)
}

// ── Slack Client ────────────────────────────────────────────────────────────

const slack = new WebClient(TOKEN)
let botUserId = ''

async function initBot(): Promise<void> {
  try {
    const res = await slack.auth.test()
    botUserId = res.user_id as string
    process.stderr.write(`slack-mcp: connected as @${res.user} (${botUserId})\n`)

    // Save botUserId to config
    const cfg = loadConfig()
    cfg.botUserId = botUserId
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  } catch (err) {
    process.stderr.write(`slack-mcp: auth failed: ${err}\n`)
  }
}

async function pollChannel(channelId: string): Promise<void> {
  try {
    const oldest = lastPollTs[channelId] ?? String(Date.now() / 1000 - 60)
    const res = await slack.conversations.history({
      channel: channelId,
      oldest,
      limit: 20,
    })

    if (!res.messages?.length) return

    // newest first → reverse to process oldest first
    const msgs = [...res.messages].reverse()
    for (const msg of msgs) {
      if (!msg.ts) continue
      if (msg.ts <= (lastPollTs[channelId] ?? '0')) continue
      lastPollTs[channelId] = msg.ts

      // skip bot's own messages
      if (msg.user === botUserId) continue
      if (msg.bot_id) continue

      // get username
      let userName = msg.user ?? 'unknown'
      try {
        const info = await slack.users.info({ user: msg.user ?? '' })
        userName = (info.user as { name?: string })?.name ?? msg.user ?? 'unknown'
      } catch {}

      enqueue({
        channel_id: channelId,
        message_ts: msg.ts,
        user_id: msg.user ?? '',
        user_name: userName,
        text: msg.text ?? '',
        ts: new Date(Number(msg.ts) * 1000).toISOString(),
        thread_ts: msg.thread_ts,
      })

      process.stderr.write(`slack-mcp: queued message from @${userName} in ${channelId}\n`)
    }
  } catch (err) {
    process.stderr.write(`slack-mcp: poll ${channelId} failed: ${err}\n`)
  }
}

// ── MCP Server ─────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'slack-claude', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Slack MCP Server -- use these tools to communicate via Slack.',
      '',
      'Workflow:',
      '1. Call get_messages to check for new Slack messages',
      '2. Process each message and call send_message with the channel_id',
      '3. Use send_file to attach images or documents',
      '',
      'Important:',
      '- Messages are queued in memory. Call get_messages periodically (e.g., via /loop).',
      '- Use thread_ts from the received message to reply in thread.',
      '- send_file supports images (png/jpg/gif) and documents (pdf, txt, etc.).',
    ].join('\n'),
  },
)

// ── Tool Definitions ───────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_messages',
      description: 'Get new messages from Slack channels. Returns all queued inbound messages and clears the queue. Call this periodically to check for new messages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: {
            type: 'string',
            description: 'Optional: poll a specific channel immediately before returning queued messages.',
          },
          limit: {
            type: 'number',
            description: 'Max number of messages to return. Default: all queued.',
          },
        },
      },
    },
    {
      name: 'send_message',
      description: 'Send a text message to a Slack channel or DM.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Channel or DM ID.' },
          text: { type: 'string', description: 'Message text (supports Slack markdown).' },
          thread_ts: { type: 'string', description: 'Thread timestamp to reply in thread.' },
        },
        required: ['channel_id', 'text'],
      },
    },
    {
      name: 'send_file',
      description: 'Upload a file (image, document, etc.) to a Slack channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string' },
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          title: { type: 'string', description: 'Optional file title shown in Slack.' },
          comment: { type: 'string', description: 'Optional text message with the file.' },
          thread_ts: { type: 'string', description: 'Thread timestamp to upload in thread.' },
        },
        required: ['channel_id', 'file_path'],
      },
    },
    {
      name: 'get_bot_info',
      description: 'Get the bot username, user ID, and connection status.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'add_channel',
      description: 'Add a channel ID to the polling allowlist.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string' },
        },
        required: ['channel_id'],
      },
    },
  ],
}))

// ── Tool Handlers ──────────────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {

      // ── get_messages ──
      case 'get_messages': {
        const channelId = args.channel_id as string | undefined
        if (channelId) await pollChannel(channelId)

        const messages = dequeue(args.limit as number | undefined)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ messages, count: messages.length, queue_remaining: messageQueue.length }, null, 2),
          }],
        }
      }

      // ── send_message ──
      case 'send_message': {
        const res = await slack.chat.postMessage({
          channel: args.channel_id as string,
          text: args.text as string,
          ...(args.thread_ts ? { thread_ts: args.thread_ts as string } : {}),
        })
        return {
          content: [{ type: 'text', text: `sent (ts: ${res.ts})` }],
        }
      }

      // ── send_file ──
      case 'send_file': {
        const filePath = args.file_path as string
        const st = statSync(filePath)
        if (st.size > MAX_FILE_BYTES) {
          throw new Error(`file too large: ${(st.size / 1024 / 1024).toFixed(1)}MB (max 50MB)`)
        }

        const res = await slack.filesUploadV2({
          channel_id: args.channel_id as string,
          file: createReadStream(filePath),
          filename: basename(filePath),
          title: args.title as string | undefined,
          initial_comment: args.comment as string | undefined,
          thread_ts: args.thread_ts as string | undefined,
        })
        return {
          content: [{ type: 'text', text: `file uploaded: ${basename(filePath)}` }],
        }
      }

      // ── get_bot_info ──
      case 'get_bot_info': {
        const cfg = loadConfig()
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              bot_user_id: botUserId,
              queue_size: messageQueue.length,
              allowed_channels: cfg.allowChannels,
            }, null, 2),
          }],
        }
      }

      // ── add_channel ──
      case 'add_channel': {
        const channelId = args.channel_id as string
        const cfg = loadConfig()
        if (!cfg.allowChannels.includes(channelId)) {
          cfg.allowChannels.push(channelId)
          const { mkdirSync, writeFileSync } = await import('fs')
          mkdirSync(STATE_DIR, { recursive: true })
          writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
        }
        return { content: [{ type: 'text', text: `channel ${channelId} added` }] }
      }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

// ── Start ──────────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
await initBot()

// Poll allowed channels every 30s
setInterval(async () => {
  const cfg = loadConfig()
  for (const ch of cfg.allowChannels) {
    await pollChannel(ch)
  }
}, 30_000)

process.stderr.write(`slack-mcp: ready -- use get_messages tool to receive messages\n`)
