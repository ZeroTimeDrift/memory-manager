# Memory Manager — Changelog

Evolution log for the self-management engine. Each entry captures what was built, why, and what it changed.

---

## 2026-02-12 — Temporal Query System + Task Queue Bug Fixes

### New: `src/temporal.ts` — Temporal Query Enhancement

**Problem:** Memory system had 100% factual recall (68/68) but 31% temporal recall. Queries like "what did I do on Feb 11" or "what happened yesterday" failed because BM25 keyword matching can't route to date-specific files when query words are generic.

**Solution:** Built a temporal query pre/post-processor:
- **Date parser** (9/9 tests): Handles explicit dates ("Feb 5"), relative dates ("yesterday", "3 days ago"), day names ("last Monday"), ranges ("this week", "last week"), week numbers ("W06"), and month-only ("in February"). 
- **Temporal search** (13/13 tests): Detects date references → resolves to daily/weekly files → injects matching chunks at top rank → falls back to BM25 for content keywords.
- Content-aware scoring within temporal files: "DeFi on Feb 10" finds the Kamino chunks in the Feb 10 daily, not just any chunk.

**Before:** 31% temporal coverage, most date queries returned wrong files (rules.md, contacts.md)
**After:** 100% temporal coverage, all queries at rank #1

### Sessions (chronological)
| Time (CET) | Category | Task | Outcome |
|---|---|---|---|
| 03:37 | memory | Build memory search quality scoring (regression/compare modes) | completed |
| 05:36 | consolidation | Consolidate recent learnings | completed |
| 07:30 | infrastructure | Fix task recycling bugs in prioritizer | completed |

### Bug Fixes

**1. `completedStrategicTasks` clobbered on task completion** (critical)
- In `task.ts complete`, after `recordSession()` writes the manifest (including the new completed task signature), the code reloaded only `sessionHistory` but not `completedStrategicTasks`
- When `saveManifest()` ran afterward, it overwrote with the stale manifest copy, losing the completed task marker
- Result: tasks like "Add structured changelog" kept reappearing despite being done days ago
- Fix: reload `completedStrategicTasks` alongside `sessionHistory` after `recordSession()` call

**2. Stale file detector triggering on archived files** (minor)
- Files tagged `archived` or `status: reviewed` in frontmatter were counted as stale based on filesystem mtime alone
- This generated false "Refresh stale memory files" tasks for properly archived content
- Fix: check frontmatter for `archived` tag or `status: reviewed` before counting as stale
- Reduced false stale count: 6 → 3

### Key Observation
The task recycling bug was the root cause of the duplicate task issue noted in the Feb 10 changelog observations. The "self-healing" src-file detection couldn't catch it because CHANGELOG.md isn't a `.ts` file, and the signature comparison failed due to the clobbering race condition.

---

## 2026-02-11 — Benchmark Expansion & Quality Scoring

Third day of autonomous operation. Focus shifted to measurement and consolidation.

### Sessions (chronological)
| Time (CET) | Category | Task | Outcome |
|---|---|---|---|
| 04:32 | consolidation | 13-file synthesis, health/index/operating updates | completed |
| 08:32 | memory | Expanded benchmark 25→48 recall tests | completed |
| 10:32 | maintenance | Reviewed W07 open problems, resolved stale update | completed |
| 12:33 | consolidation | Moltbook observations compression (261→109 lines) | completed |
| 14:30 | memory | Search quality scoring tool, changelog update | completed |

### New Files
- `src/search-quality.ts` — Search quality scoring with P@K, MRR, per-category breakdown
- `memory/search-quality-report.md` — First quality baseline report

### Key Metrics
- Recall benchmark: 48/48 (100%) — up from 25 tests
- Search P@1: 70% | P@3: 84% | P@5: 92% | MRR: 0.782
- Critical queries: 90% P@1 (strong)
- Adversarial queries: 38% P@1 (weak — target for improvement)
- Health score: 71/100 (chunk health improved 68→77)

### Observations
- Adversarial/paraphrase queries are the weakest category — semantic search struggles with negation and indirect phrasing
- `moltbook-architecture-post.md` keeps appearing as noise in unrelated searches — needs semantic isolation or chunking fix
- One complete failure: "task queue repeating same job" — the answer lives only in CHANGELOG.md which may not be indexed

---

## 2026-02-10 — Autonomous Expansion Day

First full day of self-directed 2-hour cycle operation. 10 sessions executed.

### Sessions (chronological)
| Time (CET) | Category | Task | Outcome |
|---|---|---|---|
| 07:30 | infrastructure | Cross-reference integrity checker | completed |
| 09:37 | expansion | Conversation importance scoring | completed |
| 11:33 | consolidation | Consolidate recent learnings | completed |
| 13:33 | memory | Memory file auto-discovery | completed |
| 15:35 | infrastructure | Weekly digest extraction quality | completed |
| 17:35 | consolidation | Consolidate recent learnings | completed |
| 19:34 | memory | Audit memory chunk boundaries | completed |
| 21:30 | infrastructure | Cross-reference integrity checker | completed |
| 21:30 | expansion | Importance scoring (re-run) | completed |
| 21:34 | memory | Auto-discovery (re-run) | completed |
| 22:30 | infrastructure | **Add structured changelog** | completed |

### New Files
- `src/xref-check.ts` — Cross-reference integrity checker
- `src/importance.ts` — Conversation importance scoring for real-time capture
- `src/auto-discover.ts` — Memory file auto-discovery for new content
- `src/chunk-health.ts` — Chunk boundary audit tool
- `CHANGELOG.md` — This file

### Observations
- Session history showed duplicate task names (cross-ref checker, importance scoring, auto-discovery ran twice). Likely the task queue re-generated completed items. Worth investigating dedup in task generation.
- Consolidation ran twice — system correctly detected expansion streaks and inserted consolidation breaks.

---

## 2026-02-08 — Benchmark & Stability

### Committed
- `d456fc9` — Expanded recall tests 80→116, priority tests 17→21
- `c66be30` — Fixed session history being clobbered by saveManifest after recordSession
- `a509fa9` — v2 task prioritizer: session history tracking, consolidation streak detection, strategic backlog

### Impact
- Session recording now persists correctly across saves
- Task prioritizer gained awareness of what was recently done (prevents re-running completed work)
- Strategic backlog introduced as low-priority task source when queue empties

---

## 2026-02-07 — Semantic Density Fix

### Committed
- `d23fffd` — Semantic density improvements for 3 adversarial recall failures

### Impact
- Memory chunks that split facts across boundaries now handled better
- 3 previously-failing recall benchmarks now pass

---

## 2026-02-06 — Major Overhaul & Foundation

### Committed (chronological)
- `eb80e4a` — Smart task prioritization system (initial)
- `6647b50` — README documentation
- `4c3e829` — Refactored from custom search to Self-Management Engine (Clawdbot's built-in search handles recall)
- `2886c09` — Rebalanced scoring: impact over urgency
- `951e64b` — Conversation capture and session-wrap pipeline
- `324a1ee` — Manifest update after session capture
- `ba0979e` — Major memory system overhaul: benchmark suite, capture fixes, priority tuning
- `c5b7565` — 17 adversarial recall + 6 priority benchmark tests (Echo directive)

### New Capabilities
- `src/capture.ts` — Structured conversation capture (DECISION/FACT/TASK/TOPIC/PERSON/QUOTE prefixes)
- `src/session-wrap.ts` — End-of-session pipeline (daily log + capture + weights + re-index)
- `src/prioritize.ts` — Smart scoring with category rotation, recency penalty, impact weighting
- `src/task-prioritizer.ts` — Task prioritization utilities
- `src/benchmark.ts` / `src/benchmark-fast.ts` — Recall and priority test suites
- `src/boot.ts` — Context-weighted boot sequence

### Architecture Decision
Removed custom semantic search. Clawdbot's built-in `memory_search` (Gemini embeddings) handles recall. This skill focuses on orchestration: boot sequencing, task management, weight tracking, session lifecycle.

---

## Pre-history

### Core Files (always existed)
- `manifest.json` — Brain state: weights, session history, task queue
- `src/decay.ts` — Time-based weight decay
- `src/weekly-digest.ts` — Weekly summary generation
- `src/session-summary.ts` — Session summarization
- `src/session-update.ts` — Post-session weight updates

---

*Updated automatically during session-wrap. Future sessions: append new entries at the top.*
