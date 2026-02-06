# Memory Manager — Self-Management Engine

Orchestration layer for context-limited agents. Boot sequencing, task prioritization, weight tracking, session management.

> **Memory recall** is handled by Clawdbot's built-in `memory_search` tool (Gemini embeddings). This skill focuses on what the platform doesn't provide: orchestration and self-management.

## Core Files

- `manifest.json` — The brain. Tracks weights, recent activity, and next task.
- `src/boot.ts` — Generates boot context based on current weights
- `src/capture.ts` — Conversation capture: extract and file structured info from sessions
- `src/session-wrap.ts` — End-of-session pipeline: daily log + capture + weights + re-index
- `src/session-update.ts` — Updates weights automatically after sessions
- `src/session-summary.ts` — Auto-summarize sessions
- `src/task.ts` — Task queue management
- `src/prioritize.ts` — Smart scoring algorithm
- `src/task-prioritizer.ts` — Task prioritization utilities

## Usage

### Conversation Capture (mid-session)
```bash
# Pipe structured notes — the agent distills, capture.ts files them
echo "DECISION: Use Opus 4.6 for main sessions
FACT: Hevar's timezone is Asia/Dubai
TASK: Update deploy script | Need to fix staging env
TOPIC:moongate: Widget v2 launching next week
PERSON:Hevar: Prefers async communication
QUOTE: Memory is survival." | npx ts-node src/capture.ts

# Or pass as argument
npx ts-node src/capture.ts "DECISION: Ship on Friday"

# Raw notes (no structured prefixes)
npx ts-node src/capture.ts --raw "General notes about the session"
```

**Capture prefixes:**
| Prefix | Where it goes |
|--------|--------------|
| `DECISION:` | Daily log (with timestamp) |
| `FACT:` | MEMORY.md Quick Reference (deduped) |
| `TASK:` | Task queue (via manifest.json) |
| `TOPIC:<name>:` | `memory/topics/<name>.md` |
| `PERSON:<name>:` | `memory/people/contacts.md` |
| `QUOTE:` | Daily log (quoted, timestamped) |
| *(no prefix)* | Daily log as general notes |

### Session Wrap (end-of-session)
```bash
# Simple — just a description
npx ts-node src/session-wrap.ts "Major session: built prioritization system"

# With metadata
npx ts-node src/session-wrap.ts "Debug session" --mood focused --tags debug,infra

# With file tracking
npx ts-node src/session-wrap.ts "Updated memory system" --files MEMORY.md SKILL.md

# Full pipeline — structured capture + wrap
echo "DECISION: Use 4.6\nFACT: New API key\nTASK: Update docs" | \
  npx ts-node src/session-wrap.ts "Major session with Hevar"
```

Session wrap runs the full pipeline:
1. Writes session entry to daily log
2. Runs capture.ts on any piped structured data
3. Updates file weights via session-update.ts
4. Re-indexes memory via `clawdbot memory index`

### Generate Boot Context
```bash
npx ts-node src/boot.ts
```
Outputs the optimized boot context based on current weights.

### Update After Session
```bash
npx ts-node src/session-update.ts [file1.md file2.md ...]
```
Automatically updates weights based on session activity. If no files provided, scans recent memory files to detect accessed files. Updates access counts, last access dates, and adjusts weights based on usage patterns.

### Manage Tasks
```bash
npx ts-node src/task.ts next           # Show next task with score
npx ts-node src/task.ts complete       # Complete current, pick highest-scored next
npx ts-node src/task.ts add "task" "ctx" [priority] [category] [impact]
npx ts-node src/task.ts list           # List all tasks ranked by score
npx ts-node src/task.ts score          # Detailed score breakdown for all tasks
npx ts-node src/task.ts smart          # Generate intelligent task recommendation
```

### Task Categories
Tasks are auto-categorized (or explicitly tagged) into:
- `survival` 🔴 — Memory integrity, boot, core systems (highest priority)
- `memory` 🧠 — Organization, consolidation, indexing
- `infrastructure` 🔧 — Skills, tools, system plumbing
- `expansion` 🚀 — New capabilities, learning, growth
- `research` 🔍 — Investigation, analysis, info gathering
- `maintenance` 🧹 — Cleanup, refactoring, minor fixes
- `nice-to-have` ✨ — Would be cool but not critical

### Smart Scoring Algorithm
Tasks are scored (0-1) by combining:
- **Urgency (25%)** — Sigmoid curve based on task age. Ramps after ~24h, plateaus ~7d.
- **Impact (35%)** — Category + explicit impact level + legacy priority number.
- **Dependencies (15%)** — 1.0 if all prereqs met, 0.0 if blocked.
- **Skip Decay (15%)** — Tasks passed over repeatedly bubble up (log curve).
- **Blocker Bonus (10%)** — Flat boost if task blocks others.

See `src/prioritize.ts` for the full algorithm.

## Manifest Structure

```json
{
  "version": 1,
  "nextTask": {
    "task": "Research Marinade liquid staking",
    "context": "For capital deployment when $100 arrives",
    "priority": 1
  },
  "taskQueue": [],
  "files": {
    "SOUL.md": {
      "weight": 1.0,
      "type": "core",
      "lastAccess": "2026-02-05",
      "accessCount": 10,
      "decayRate": 0.0
    }
  },
  "recentTopics": ["defi", "moltbook"],
  "lastSession": {
    "date": "2026-02-05",
    "focus": "accumulate-capital",
    "outcome": "completed"
  }
}
```

## Weight Algorithm

```
weight = baseWeight * recencyBoost * frequencyBoost * importanceFlag

recencyBoost = 1.0 - (daysSinceAccess * decayRate)
frequencyBoost = log(accessCount + 1)
importanceFlag = 2.0 if type == "core" else 1.0
```

Files with `type: "core"` never decay below 0.5.

## Boot Process

1. Read manifest.json
2. Get nextTask (always have one)
3. Load files sorted by weight (top N)
4. Generate compressed boot context
5. Return boot text + next task

## Self-Improvement Integration

The self-expansion cron should:
1. Call `boot.ts` to get context + task
2. Execute the task
3. Call `task.ts complete` to queue next task
4. Run `session-wrap.ts "description"` — handles weight updates, daily log, and re-indexing
5. Pipe any structured captures through session-wrap's stdin

For main sessions (direct chats with Hevar):
- Use `capture.ts` mid-session for important decisions/facts
- Call `session-wrap.ts` at session end for the full pipeline
