# Jobs

## User jobs

User-defined proactive jobs live in:

```text
~/.meso/agents/<agent>/jobs.json
```

Each user job should be fully self-contained.

## Job shape

A typical job contains:
- `id`
- `enabled`
- `kind`
- `schedule`
- `prompt`
- `lastRunAt`
- `nextRunAt`
- `lastStatus`
- `lastError`

## Prompt-first design

The job prompt should contain everything needed to execute the task later.

A good prompt answers:
1. what to do
2. what sources/tools to use
3. how to format the result
4. where to send the result

## Good example

```text
Gather the most important German news from the last 24 hours.
Use web search.
Summarize it in 5 concise bullets with links.
Then post it to Slack channel C12345678 in thread 1712345678.1234 using slack_post_message.
```

## Bad example

```text
Send the update here later.
```

Why bad:
- ambiguous destination
- missing format expectations
- missing source/tool instructions

## Supported schedules

### Daily
```json
{
  "type": "daily",
  "time": "09:00"
}
```

### Weekdays
```json
{
  "type": "weekdays",
  "time": "09:00",
  "days": ["mon", "tue", "wed", "thu", "fri"]
}
```

### Weekly
```json
{
  "type": "weekly",
  "day": "mon",
  "time": "09:00"
}
```

### Interval
```json
{
  "type": "interval",
  "everyMinutes": 15
}
```

### One-time
```json
{
  "type": "once",
  "at": "2026-04-10T09:00:00.000Z"
}
```

One-shot jobs can also carry a staleness policy. If they are missed while the scheduler is down and become too old, they are marked expired instead of being run blindly.

## Job management tools

The agent can manage jobs using:
- `schedule_job`
- `list_jobs`
- `pause_job`
- `resume_job`
- `remove_job`
- `trigger_event`
- `list_events`
- `remove_event`

## Immediate events

External/reactive triggers live in:

```text
~/.meso/agents/<agent>/events/
```

These are separate from durable jobs in `jobs.json`.
Use immediate events for machine-triggered wakeups such as webhooks, watchers, or local scripts.

## Internal jobs

Internal jobs are not stored in `jobs.json` and are not user-editable.
They are defined by the runtime.
