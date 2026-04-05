# Channels

## Purpose

Meso separates:
- channel runners
- channel tools

This keeps communication providers separate from scheduler logic.

## Channel runner layer

The channel runner layer chooses a provider such as:
- Slack
- Discord (future)
- Telegram (future)

Current generic entrypoint:

```bash
meso run <agent> --channel
```

Optional explicit provider:

```bash
meso run <agent> --channel --provider slack
```

## Current provider

Today, Slack is the first built-in provider.

The architecture is intentionally ready for more providers later.

## Channel tools

Communication actions should be modeled as tools.

Current built-in example:
- `slack_post_message`

Future examples:
- `discord_post_message`
- `telegram_send_message`
- email/webhook tools

## Provider context injection

During interactive conversations, Meso injects a hidden provider context block.

Example today:

```text
<slack_context>
channel_id: C12345678
thread_ts: 1712345678.1234
user_id: U12345678
</slack_context>
```

This helps the agent turn vague requests like:
- "send this here every day"

into explicit self-contained scheduled prompts.

## Conversation handling

For Slack, Meso now borrows a few durable runtime ideas from Mom:
- direct-message conversations can stay on one continuous session key
- work is serialized per conversation so overlapping Slack messages do not race the same runtime
- transcripts are written to agent-local channel logs under `logs/channels/`

## Design rule

- channel runner = receives incoming messages/events
- channel tool = sends outgoing messages/actions
- scheduler = triggers agent prompts only

The scheduler should never directly embed provider delivery logic.
