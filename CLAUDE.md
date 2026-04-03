# CLAUDE.md — ClawTab Project Instructions

## Feishu Bridge (飞书消息桥接)

This project is connected to a Feishu bot via OpenClaw MCP bridge. You have access to an MCP server called `openclaw-feishu` that lets you read and send Feishu messages.

### Available MCP Tools

- **`conversations_list`** — List recent Feishu conversations with the bot
- **`messages_read`** — Read message history for a conversation (pass `session_key`)
- **`events_poll`** — Check for new messages since a cursor
- **`events_wait`** — Wait for the next new message (long-poll, with timeout)
- **`messages_send`** — Send a reply to a conversation (pass `session_key` and `message`)

### When to Use

- When the user mentions "Feishu", "飞书", or "check messages"
- When the user asks you to reply to someone
- When you want to proactively check if there are new messages

### Typical Workflow

1. Use `conversations_list` to discover conversations
2. Use `messages_read` with a `session_key` to read recent messages
3. Use `events_wait` to monitor for new incoming messages
4. Use `messages_send` to reply

### Notes

- Messages may include voice-to-text transcriptions (Feishu handles the conversion).
- Always confirm with the user before sending messages on their behalf.
- Reply in Chinese (中文) when the Feishu message is in Chinese.
- Keep replies concise — this is chat, not documentation.
