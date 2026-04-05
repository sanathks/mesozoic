# Scheduler

## Purpose

The scheduler is the background process that makes agents proactive.

It is responsible for:
- loading internal runtime jobs
- loading user jobs from `jobs.json`
- loading immediate events from `events/`
- detecting when jobs are due
- triggering the main agent with the saved job prompt
- recording run status

It is **not** responsible for sending messages directly.
Delivery belongs to the agent via tools.

## Process model

Typical pm2 setup:

- `meso-<agent>` - channel runner
- `meso-<agent>-scheduler` - background scheduler

## Internal jobs vs user jobs

### Internal jobs
Defined in runtime code.
Users cannot edit them.

This is where maintenance tasks like dream/memory consolidation live.

### User jobs
Stored in:

```text
~/.meso/agents/<agent>/jobs.json
```

User jobs are prompt-driven and self-contained.

## Execution model

When a user job is due, the scheduler does:

1. create scheduled agent runtime
2. run `runtime.prompt(job.prompt)`
3. store success/error metadata

The scheduler does not:
- post to Slack directly
- know channel-specific delivery logic
- interpret the job beyond schedule/due checks

## Reliability protections

Current protections include:
- no overlapping scheduler ticks
- duplicate-run suppression per job
- timeout protection for scheduled runs

## Supported user schedule shapes

- daily at `HH:MM`
- selected weekdays at `HH:MM`
- weekly on one day at `HH:MM`
- interval every N minutes
- one-time at ISO timestamp

## Immediate event inbox

External/reactive triggers live in:

```text
~/.meso/agents/<agent>/events/
```

Each event is a JSON file with type `immediate` and a self-contained prompt.
The scheduler processes immediate events before durable jobs.
Processed dedupe state is tracked in:

```text
~/.meso/agents/<agent>/logs/event-state.json
```

## Job metadata

User jobs track:
- `lastRunAt`
- `nextRunAt`
- `lastStatus`
- `lastError`

## Design rule

The scheduler should stay dumb.
It decides **when** to run a job, not **how** to do the work.
The agent decides how to execute the prompt using tools.
