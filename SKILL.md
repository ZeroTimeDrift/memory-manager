# Memory Manager Skill

Dynamic memory organization for context-limited agents.

## Purpose

Manage the boot process, track file weights, and ensure there's always a clear task on wakeup.

## Core Files

- `manifest.json` — The brain. Tracks weights, recent activity, and next task.
- `src/boot.ts` — Generates boot context based on current weights
- `src/session-update.ts` — Updates weights automatically after sessions
- `src/task.ts` — Task queue management

## Usage

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

### Search Memory
```bash
node src/search.js "query terms" [limit]      # Search all memory files
node src/search.js file "path" "query"        # Search specific file
```
Semantic search across all memory files. Enables "what do I know about X?" queries with context and relevance scoring.

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
3. Call `session-update.ts` to auto-update weights
4. Call `task.ts complete` to queue next task
5. Log session in memory/sessions/
