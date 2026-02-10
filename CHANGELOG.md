# Memory Manager — Changelog

Evolution log for the self-management engine. Each entry captures what was built, why, and what it changed.

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
