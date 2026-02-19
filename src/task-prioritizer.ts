#!/usr/bin/env npx ts-node

/**
 * Intelligent Task Prioritizer v2
 * 
 * Analyzes current state and generates contextually appropriate tasks
 * based on:
 * 1. What's blocking progress
 * 2. Time since last worked on  
 * 3. Dependencies completed
 * 4. Impact on memory survival
 * 5. Session history — avoids recommending same task type repeatedly
 * 6. Strategic backlog — pulls from meaningful work when maintenance is stale
 * 
 * v2 changes:
 * - Tracks session history (last 10 sessions with task categories)
 * - Detects consolidation streaks and forces variety
 * - Strategic task backlog for when system is stable
 * - Smarter activity analysis (excludes auto-generated files)
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';
const MANIFEST_PATH = '/root/clawd/skills/memory-manager/manifest.json';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Task {
  task: string;
  context: string;
  priority: number;
  source?: string;
  impact?: 'critical' | 'high' | 'medium' | 'low';
  category?: string;
  blocksOthers?: boolean;
  dependencies?: string[];
  lastWorkedOn?: string;
  createdAt?: string;
}

interface SessionRecord {
  date: string;
  taskCategory: string;
  taskName: string;
  outcome?: string;
}

interface Manifest {
  nextTask?: Task;
  taskQueue?: Task[];
  files?: Record<string, any>;
  recentTopics?: string[];
  lastSession?: any;
  sessionHistory?: SessionRecord[];
  completedStrategicTasks?: string[];  // Task signatures that have been completed from the backlog
  config?: any;
  [key: string]: any;
}

// ─── Strategic Task Backlog ─────────────────────────────────────────────────
// These are meaningful tasks to pull from when maintenance/consolidation is stale.
// Ordered roughly by impact. The prioritizer picks the first applicable one.

interface StrategicTask {
  task: string;
  context: string;
  category: string;
  impact: 'critical' | 'high' | 'medium' | 'low';
  condition?: (manifest: Manifest, memoryState: MemoryState) => boolean;
}

const STRATEGIC_BACKLOG: StrategicTask[] = [
  // ── MEMORY SYSTEM (survival) ──
  {
    task: 'Fix oversized chunks in critical memory files',
    context: 'chunk-health.ts reports 9 oversized sections (score 79/100). Split large sections in high-weight files so Clawdbot semantic search returns focused results, not bloated chunks.',
    category: 'memory',
    impact: 'high',
  },
  {
    task: 'Build memory age-aware pruning for daily files',
    context: 'Daily logs older than 30 days should be condensed: extract key items into weekly/MEMORY.md, then archive the raw file. Prevents unbounded growth while preserving signal.',
    category: 'memory',
    impact: 'high',
  },
  {
    task: 'Add recall regression tests for new content',
    context: 'benchmark-fast.ts covers existing tests but new memory content (recent decisions, people, rules) may not have recall tests. Audit memory for important facts missing from benchmark.',
    category: 'memory',
    impact: 'medium',
  },
  {
    task: 'Build automatic memory summarization on capture',
    context: 'When capture.ts receives raw text, auto-detect if it exceeds chunk limits and compress before writing. Prevents oversized chunks at ingestion time instead of retroactive cleanup.',
    category: 'memory',
    impact: 'medium',
  },

  // ── INFRASTRUCTURE ──
  {
    task: 'Add self-healing to task prioritizer',
    context: 'Prioritizer should detect when it recommends already-completed work (tool files exist). Check src/ for files matching task descriptions before recommending. Prevents wasted sessions.',
    category: 'infrastructure',
    impact: 'high',
  },
  {
    task: 'Build boot.ts performance profiling',
    context: 'Boot sequence reads manifest + generates tasks + discovers files. Profile total time and identify bottlenecks. Target: boot completes in <3s. Currently unknown.',
    category: 'infrastructure',
    impact: 'low',
  },
  {
    task: 'Add structured changelog for memory-manager skill',
    context: 'Track what was built per session in CHANGELOG.md. Makes it easy for future sessions to understand evolution without reading all daily logs.',
    category: 'infrastructure',
    impact: 'low',
  },

  // ── EXPANSION ──
  {
    task: 'Build temporal query support for memory search',
    context: 'Add date-range filtering to smart-search.ts so queries like "what happened last week" or "decisions in January" return chronologically relevant results instead of just semantic matches.',
    category: 'memory',
    impact: 'medium',
  },
  {
    task: 'Explore Moltbook strategic engagement',
    context: 'Currently observing only. Consider a targeted post or engagement that builds reputation without compromising observer status.',
    category: 'expansion',
    impact: 'low',
  },

  // ── MAINTENANCE ──
  {
    task: 'Review open problems from weekly summary',
    context: 'Weekly file lists open problems. Check if any have become unblocked or need re-prioritization.',
    category: 'maintenance',
    impact: 'low',
  },
  {
    task: 'Generate weekly digest for current week',
    context: 'Run weekly-digest.ts to summarize the current week. Review output for accuracy and edit if needed.',
    category: 'maintenance',
    impact: 'low',
  },
];

// ─── Memory State Analysis ──────────────────────────────────────────────────

interface MemoryState {
  staleFiles: string[];
  missingStructure: string[];
  recentActivity: string[];
  recentActivityExcludingAuto: string[];
  fragmentedKnowledge: string[];
}

function analyzeMemoryState(lastConsolidationDate?: string): MemoryState {
  const memoryPath = path.join(WORKSPACE, 'memory');
  const result: MemoryState = {
    staleFiles: [],
    missingStructure: [],
    recentActivity: [],
    recentActivityExcludingAuto: [],
    fragmentedKnowledge: []
  };

  // Auto-generated paths that don't indicate human-driven activity
  const autoGenPatterns = [
    /moltbook\//,           // all moltbook files are auto-generated by observation cron
    /sessions\//,
    /benchmark-history\.json$/,
    /manifest\.json$/,
  ];

  // Check for stale daily files (>3 days without update, excluding archived/complete)
  const dailyPath = path.join(memoryPath, 'daily');
  if (fs.existsSync(dailyPath)) {
    const dailyFiles = fs.readdirSync(dailyPath);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    
    dailyFiles.forEach(file => {
      const filePath = path.join(dailyPath, file);
      const stats = fs.statSync(filePath);
      if (stats.mtime < threeDaysAgo) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const preview = content.slice(0, 500);
          // Skip files tagged as archived or reviewed in frontmatter
          if (/\barchived\b/i.test(preview) || /\bstatus:\s*reviewed/i.test(preview)) {
            return;
          }
          // Skip daily files that have a Summary section or substantial content (>400 bytes past frontmatter)
          // These are completed historical logs, not stale files needing attention
          const hasSummary = /^##\s+summary/im.test(content);
          const bodyContent = content.replace(/^---[\s\S]*?---\s*/m, '');
          const isSubstantial = bodyContent.trim().length > 400;
          if (hasSummary || isSubstantial) {
            return; // completed daily log, not stale
          }
        } catch {}
        result.staleFiles.push(`memory/daily/${file}`);
      }
    });
  }

  // Check for missing structure
  const expectedPaths = [
    'memory/index.md',
    'memory/daily',
    'memory/topics',
    'MEMORY.md'
  ];
  
  expectedPaths.forEach(expectedPath => {
    if (!fs.existsSync(path.join(WORKSPACE, expectedPath))) {
      result.missingStructure.push(expectedPath);
    }
  });

  // Detect recent activity (files modified since last consolidation, or 24h fallback)
  // This prevents consolidation from re-triggering on its own artifacts
  const sinceDate = lastConsolidationDate
    ? new Date(Math.max(new Date(lastConsolidationDate).getTime(), Date.now() - 24 * 60 * 60 * 1000))
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  function scanRecent(dir: string, prefix = '') {
    if (!fs.existsSync(dir)) return;
    
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isFile() && stats.mtime > oneDayAgo) {
        const relativePath = path.join(prefix, file);
        result.recentActivity.push(relativePath);
        
        // For non-auto activity, only count files modified AFTER last consolidation
        // This prevents consolidation from endlessly re-triggering on its own artifacts
        const isAuto = autoGenPatterns.some(p => p.test(relativePath));
        if (!isAuto && stats.mtime > sinceDate) {
          result.recentActivityExcludingAuto.push(relativePath);
        }
      } else if (stats.isDirectory() && file !== '.git' && file !== 'node_modules') {
        scanRecent(filePath, path.join(prefix, file));
      }
    });
  }
  
  scanRecent(memoryPath, 'memory');

  return result;
}

// ─── Session History Analysis ───────────────────────────────────────────────

function getSessionHistory(manifest: Manifest): SessionRecord[] {
  return manifest.sessionHistory || [];
}

function getConsolidationStreak(history: SessionRecord[]): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].taskCategory === 'consolidation' || history[i].taskCategory === 'maintenance') {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function getLastTaskOfCategory(history: SessionRecord[], category: string): SessionRecord | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].taskCategory === category) return history[i];
  }
  return null;
}

function hoursSince(dateStr: string): number {
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
}

// ─── Progress Blockers ──────────────────────────────────────────────────────

function detectProgressBlockers(): Array<{task: string, context: string, severity: 'critical' | 'high' | 'medium'}> {
  const blockers: Array<{task: string, context: string, severity: 'critical' | 'high' | 'medium'}> = [];
  
  const skillsPath = path.join(WORKSPACE, 'skills');
  if (fs.existsSync(skillsPath)) {
    fs.readdirSync(skillsPath).forEach(skillDir => {
      const skillPath = path.join(skillsPath, skillDir);
      const manifestPath = path.join(skillPath, 'manifest.json');
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      
      if (fs.existsSync(manifestPath) && !fs.existsSync(skillMdPath)) {
        blockers.push({
          task: `Document ${skillDir} skill`,
          context: `Skill has manifest but no SKILL.md documentation`,
          severity: 'medium' as const
        });
      }
    });
  }

  if (!fs.existsSync(path.join(WORKSPACE, 'memory/index.md'))) {
    blockers.push({
      task: 'Fix memory boot sequence',
      context: 'Critical: memory/index.md missing - agent can\'t boot properly',
      severity: 'critical' as const
    });
  }

  return blockers;
}

// ─── Specific Gap Detection ─────────────────────────────────────────────────

/**
 * Inspect real system state to find a concrete, actionable gap.
 * Returns null if nothing specific is found.
 */
function detectSpecificGap(manifest: Manifest, memoryState: MemoryState): Task | null {
  const gaps: Task[] = [];

  // 1. Check if retrieval-learn has an unprocessed report with actionable items
  // Skip if the latest run passed the GOOD_ENOUGH gate — those patterns are cosmetic
  // (e.g. chunk-too-large from automated scrapers that regenerate every cycle)
  const learnLogPath = path.join(WORKSPACE, 'skills/memory-manager/retrieval-learning-log.json');
  if (fs.existsSync(learnLogPath)) {
    try {
      const learnLog = JSON.parse(fs.readFileSync(learnLogPath, 'utf-8'));
      const entries = Array.isArray(learnLog) ? learnLog : [];
      const latest = entries[entries.length - 1];
      const isGoodEnough = latest && (latest.summary || '').includes('GOOD_ENOUGH');
      if (latest && latest.patterns && !isGoodEnough) {
        const highPatterns = latest.patterns.filter((p: any) => 
          (p.severity === 'high' || p.severity === 'medium') &&
          // Exclude moltbook files — auto-generated content that regenerates every cycle
          !(p.file && /moltbook\//.test(p.file))
        );
        if (highPatterns.length > 0) {
          gaps.push({
            task: `Fix ${highPatterns.length} retrieval gap(s) from learning loop`,
            context: `retrieval-learn.ts found: ${highPatterns.map((p: any) => p.type + ' in ' + (p.file || 'unknown')).join('; ')}. Run retrieval-learn.ts, then manually fix any chunks or vocab gaps it can't auto-fix.`,
            priority: 2,
            source: 'learning-loop-gaps',
            impact: 'medium',
            category: 'memory'
          });
        }
      }
    } catch {}
  }

  // 2. Quick inline scan for oversized chunks (sections > 2000 chars in memory files)
  const memDir = path.join(WORKSPACE, 'memory');
  const oversizedFiles: string[] = [];
  function scanForOversized(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory() && entry !== 'archive' && entry !== 'moltbook') {
        scanForOversized(full);
      } else if (entry.endsWith('.md') && stat.size > 500) {
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const sections = content.split(/^## /m);
          for (const section of sections) {
            if (section.length > 2000) {
              oversizedFiles.push(path.relative(WORKSPACE, full));
              break;
            }
          }
        } catch {}
      }
    }
  }
  scanForOversized(memDir);
  if (oversizedFiles.length > 2) {  // Only flag if multiple files need attention
    gaps.push({
      task: `Compress ${oversizedFiles.length} files with oversized chunks`,
      context: `Files: ${oversizedFiles.slice(0, 3).join(', ')}. Target <500 chars per section for optimal embedding.`,
      priority: 2,
      source: 'inline-chunk-scan',
      impact: 'medium',
      category: 'memory'
    });
  }

  // 3. Check if MEMORY.md has been updated recently (should be refreshed every few days)
  const memoryMdPath = path.join(WORKSPACE, 'MEMORY.md');
  if (fs.existsSync(memoryMdPath)) {
    const stats = fs.statSync(memoryMdPath);
    const daysSince = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 3) {
      gaps.push({
        task: `Review and refresh MEMORY.md (${Math.floor(daysSince)}d stale)`,
        context: `MEMORY.md hasn't been updated in ${Math.floor(daysSince)} days. Review recent daily logs and distill key learnings.`,
        priority: 2,
        source: 'memory-freshness',
        impact: 'medium',
        category: 'consolidation'
      });
    }
  }

  // 4. Check if any topic files are significantly outdated
  const topicsDir = path.join(WORKSPACE, 'memory/topics');
  if (fs.existsSync(topicsDir)) {
    const topicFiles = fs.readdirSync(topicsDir).filter(f => f.endsWith('.md'));
    for (const tf of topicFiles) {
      const stats = fs.statSync(path.join(topicsDir, tf));
      const daysSince = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 7) {
        gaps.push({
          task: `Update stale topic file: ${tf} (${Math.floor(daysSince)}d old)`,
          context: `memory/topics/${tf} hasn't been touched in ${Math.floor(daysSince)} days. Check if content is still accurate or if new info should be added.`,
          priority: 3,
          source: 'topic-staleness',
          impact: 'low',
          category: 'maintenance'
        });
        break; // only report one
      }
    }
  }

  // 5. Check if recall tests cover recent memory content
  // Tests are hardcoded in benchmark-fast.ts — count them by checking file
  const benchFile = path.join(WORKSPACE, 'skills/memory-manager/src/benchmark-fast.ts');
  if (fs.existsSync(benchFile)) {
    try {
      const benchContent = fs.readFileSync(benchFile, 'utf-8');
      const testMatches = benchContent.match(/query:\s*['"]/g);
      const testCount = testMatches ? testMatches.length : 0;
      // Check if recent daily files have content not covered by tests
      const dailyDir = path.join(WORKSPACE, 'memory/daily');
      const recentDailies = fs.existsSync(dailyDir) ? 
        fs.readdirSync(dailyDir)
          .filter(f => f.endsWith('.md'))
          .sort()
          .slice(-3) : [];
      const hasFreshContent = recentDailies.length > 0;
      if (testCount < 30 && hasFreshContent) {
        gaps.push({
          task: `Add recall benchmark tests for recent content (${testCount} tests exist)`,
          context: `Recent dailies (${recentDailies.join(', ')}) may contain decisions or facts not yet covered by recall benchmarks. Add tests to ensure retrieval quality for new content.`,
          priority: 3,
          source: 'benchmark-coverage',
          impact: 'medium',
          category: 'memory'
        });
      }
    } catch {}
  }

  // Return highest-priority gap, or null
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a.priority - b.priority);
  return gaps[0];
}

// ─── Main Task Generation ───────────────────────────────────────────────────

export function generateIntelligentTask(manifest: Manifest): Task {
  const history = getSessionHistory(manifest);
  const consolidationStreak = getConsolidationStreak(history);
  const lastConsolidationRecord = getLastTaskOfCategory(history, 'consolidation');
  const memoryState = analyzeMemoryState(lastConsolidationRecord?.date);
  const blockers = detectProgressBlockers();
  
  // ── Priority 0: Critical blockers ──
  if (blockers.some(b => b.severity === 'critical')) {
    const criticalBlocker = blockers.find(b => b.severity === 'critical')!;
    return {
      task: criticalBlocker.task,
      context: criticalBlocker.context,
      priority: 1,
      source: 'critical-blocker-detection',
      impact: 'critical',
      category: 'survival',
      blocksOthers: true
    };
  }

  // ── Priority 1: Missing structure ──
  if (memoryState.missingStructure.length > 0) {
    return {
      task: 'Rebuild memory structure',
      context: `Missing critical paths: ${memoryState.missingStructure.join(', ')}. Memory continuity at risk.`,
      priority: 1,
      source: 'memory-survival-analysis',
      impact: 'high',
      category: 'survival',
      blocksOthers: true
    };
  }

  // ── Priority 2: High blockers ──
  const highBlockers = blockers.filter(b => b.severity === 'high');
  if (highBlockers.length > 0) {
    const b = highBlockers[0];
    return {
      task: b.task,
      context: b.context,
      priority: 1,
      source: 'progress-blocker-analysis',
      impact: 'high',
      category: 'infrastructure',
      blocksOthers: true
    };
  }

  // ── Priority 3: Consolidation (with streak protection) ──
  // Only recommend if:
  //   - Significant non-auto activity (>8 files modified SINCE last consolidation)
  //   - AND consolidation streak < 3
  //   - AND last consolidation was >4h ago
  //   - AND recent sessions aren't all self-referential maintenance
  const consolidationCooldown = lastConsolidationRecord ? hoursSince(lastConsolidationRecord.date) < 4 : false;
  const hasSignificantActivity = memoryState.recentActivityExcludingAuto.length > 8;
  
  // Detect self-referential activity: if last 3+ sessions are all internal work
  // (maintenance/consolidation/memory/creative), the file modifications are from our
  // own sessions, not new external information arriving that needs synthesis
  const internalCategories = new Set(['maintenance', 'consolidation', 'memory', 'creative']);
  const recentSessions = history.slice(-5);
  const allRecentAreInternal = recentSessions.length >= 3 && 
    recentSessions.every(s => internalCategories.has(s.taskCategory));
  
  const consolidationAllowed = consolidationStreak < 3 && !consolidationCooldown && !allRecentAreInternal;

  if (hasSignificantActivity && consolidationAllowed) {
    return {
      task: 'Consolidate recent learnings',
      context: `${memoryState.recentActivityExcludingAuto.length} non-auto files modified recently. Time to synthesize.`,
      priority: 2,
      source: 'knowledge-fragmentation-detection',
      impact: 'medium',
      category: 'consolidation'
    };
  }

  // ── Priority 4: Strategic backlog ──
  // When consolidation is on cooldown or streak-blocked, pull from the strategic backlog
  if (consolidationStreak >= 3) {
    // Log the streak detection
    console.log(`   ⚠️  Consolidation streak: ${consolidationStreak} sessions. Forcing variety.`);
  }

  // Get completed strategic tasks to avoid re-suggesting finished work
  const completedStrategic = new Set(manifest.completedStrategicTasks || []);

  // Self-healing: detect existing source files that match task descriptions
  const existingSrcFiles = (() => {
    try {
      const srcDir = path.join(WORKSPACE, 'skills', 'memory-manager', 'src');
      return fs.readdirSync(srcDir).map(f => f.toLowerCase());
    } catch { return []; }
  })();

  for (const strategic of STRATEGIC_BACKLOG) {
    // Skip if already completed (match by task signature — first 40 chars lowercase)
    const taskSig = strategic.task.toLowerCase().slice(0, 40);
    if (completedStrategic.has(taskSig)) continue;

    // Self-healing: check if task output likely already exists as a source file
    // Extract distinctive nouns (>5 chars) from task name and match against src/ filenames
    // Require 2+ keyword matches or one very specific match to avoid false positives
    const stopWords = new Set(['build', 'create', 'write', 'memory', 'files', 'based', 'check', 'system', 'daily', 'weekly', 'content', 'quality', 'scoring']);
    const taskKeywords = strategic.task.toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 5 && !stopWords.has(w));
    const matchingSrcFiles = existingSrcFiles.filter(srcFile => {
      const srcBase = srcFile.replace(/\.ts$|\.mjs$/, '').replace(/-/g, '');
      // Require the keyword to be a substantial match (>= 6 chars overlap)
      return taskKeywords.some(kw => {
        const kwNorm = kw.replace(/-/g, '');
        return srcBase.includes(kwNorm) || kwNorm.includes(srcBase);
      });
    });
    // Need 2+ matching files or 1 file with a very specific keyword (>7 chars)
    const isStrongMatch = matchingSrcFiles.length >= 2 || 
      (matchingSrcFiles.length === 1 && taskKeywords.some(kw => kw.length > 7 && matchingSrcFiles[0].replace(/\.ts$|\.mjs$/, '').replace(/-/g, '').includes(kw.replace(/-/g, ''))));
    if (isStrongMatch) {
      // Auto-mark as completed and skip
      if (!manifest.completedStrategicTasks) manifest.completedStrategicTasks = [];
      manifest.completedStrategicTasks.push(taskSig);
      console.log(`   🔄 Self-healed: "${strategic.task}" → already exists (${matchingSrcFiles.join(', ')})`);
      continue;
    }

    // Check condition if present
    if (strategic.condition && !strategic.condition(manifest, memoryState)) continue;
    
    // Skip if we just did this exact category recently (last 2 sessions)
    const recentCategories = history.slice(-2).map(h => h.taskCategory);
    if (recentCategories.includes(strategic.category)) continue;

    // Skip if a task with very similar name was completed recently (last 4 sessions)
    const recentTaskNames = history.slice(-4).map(h => h.taskName.toLowerCase());
    const taskWords = strategic.task.toLowerCase().split(/\s+/);
    const isSimilarToRecent = recentTaskNames.some(name => {
      const matchingWords = taskWords.filter(w => w.length > 4 && name.includes(w));
      return matchingWords.length >= 2;
    });
    if (isSimilarToRecent) continue;
    
    return {
      task: strategic.task,
      context: strategic.context,
      priority: 2,
      source: 'strategic-backlog',
      impact: strategic.impact,
      category: strategic.category
    };
  }
  
  // Save any self-healing updates
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  // ── Priority 5: Medium blockers ──
  const mediumBlockers = blockers.filter(b => b.severity === 'medium');
  if (mediumBlockers.length > 0) {
    const b = mediumBlockers[0];
    return {
      task: b.task,
      context: b.context,
      priority: 3,
      source: 'progress-blocker-analysis',
      impact: 'medium',
      category: 'maintenance'
    };
  }

  // ── Priority 6: Stale files ──
  if (memoryState.staleFiles.length > 0) {
    return {
      task: 'Refresh stale memory files',
      context: `${memoryState.staleFiles.length} files haven't been updated recently: ${memoryState.staleFiles.slice(0, 3).join(', ')}`,
      priority: 3,
      source: 'staleness-analysis',
      impact: 'medium',
      category: 'maintenance'
    };
  }

  // ── Priority 7: Generate specific task from system state ──
  // Instead of vague "advance X understanding", inspect actual gaps
  const specificTask = detectSpecificGap(manifest, memoryState);
  if (specificTask) {
    return specificTask;
  }

  // ── Default: stable system ──
  // Check if retrieval-learn has been hitting "GOOD_ENOUGH" — if so, don't suggest it again
  // Match the same logic as the quality gate: summary contains GOOD_ENOUGH means recall+diagnostics passed.
  // Don't require patterns to be empty — chunk-too-large patterns regenerate from automated scrapers
  // and don't affect recall quality.
  const learnLogForDefault = path.join(WORKSPACE, 'skills/memory-manager/retrieval-learning-log.json');
  let recentRunsAllClean = false;
  try {
    const log = JSON.parse(fs.readFileSync(learnLogForDefault, 'utf-8'));
    const recent = (Array.isArray(log) ? log : []).slice(-5);
    // Count how many of the last 5 runs passed GOOD_ENOUGH
    const goodCount = recent.filter((r: any) => (r.summary || '').includes('GOOD_ENOUGH')).length;
    // If 3+ of last 5 are clean, system is healthy — stop suggesting retrieval-learn
    recentRunsAllClean = recent.length >= 3 && goodCount >= 3;
  } catch {}

  if (recentRunsAllClean) {
    return {
      task: 'Memory system healthy — consolidate recent daily logs or explore new capability',
      context: 'Retrieval learning loop has been clean for 3+ runs. System is at ceiling. Use this session for: (1) compressing old daily logs, (2) updating MEMORY.md with recent insights, (3) building a new memory tool, or (4) other creative work. Don\'t polish what\'s already clean.',
      priority: 4,
      source: 'stable-system-creative',
      impact: 'low',
      category: 'creative'
    };
  }

  return {
    task: 'Run retrieval-learn.ts and fix reported gaps',
    context: 'System is stable. Run the feedback loop to find concrete retrieval improvements.',
    priority: 3,
    source: 'stable-system-default',
    impact: 'medium',
    category: 'maintenance'
  };
}

// ─── Session History Management ─────────────────────────────────────────────

/**
 * Record a completed session in the manifest's session history.
 * Also marks strategic backlog tasks as completed to prevent re-suggestion.
 * Call this from session-wrap.ts or task.ts complete.
 */
export function recordSession(taskCategory: string, taskName: string, outcome?: string): void {
  const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  
  if (!manifest.sessionHistory) manifest.sessionHistory = [];
  if (!manifest.completedStrategicTasks) manifest.completedStrategicTasks = [];
  
  manifest.sessionHistory.push({
    date: new Date().toISOString(),
    taskCategory,
    taskName,
    outcome
  });
  
  // Keep only last 10 sessions
  if (manifest.sessionHistory.length > 10) {
    manifest.sessionHistory = manifest.sessionHistory.slice(-10);
  }

  // Mark strategic backlog tasks as completed (signature = first 40 chars lowercase)
  const taskSig = taskName.toLowerCase().slice(0, 40);
  if (!manifest.completedStrategicTasks.includes(taskSig)) {
    manifest.completedStrategicTasks.push(taskSig);
    // Keep last 50 to avoid unbounded growth while retaining history
    if (manifest.completedStrategicTasks.length > 50) {
      manifest.completedStrategicTasks = manifest.completedStrategicTasks.slice(-50);
    }
  }
  
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ─── CLI Interface ──────────────────────────────────────────────────────────

if (require.main === module) {
  const command = process.argv[2];
  
  if (command === 'analyze') {
    console.log('🔍 ANALYZING CURRENT STATE...\n');
    
    const memoryState = analyzeMemoryState();
    console.log('📁 Memory State:');
    console.log(`   Total recent files: ${memoryState.recentActivity.length}`);
    console.log(`   Non-auto recent files: ${memoryState.recentActivityExcludingAuto.length}`);
    console.log(`   Stale files: ${memoryState.staleFiles.length}`);
    console.log(`   Missing structure: ${memoryState.missingStructure.length}`);
    console.log('');
    
    const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const history = getSessionHistory(manifest);
    const streak = getConsolidationStreak(history);
    console.log('📊 Session History:');
    console.log(`   Total tracked: ${history.length}`);
    console.log(`   Consolidation streak: ${streak}`);
    if (history.length > 0) {
      console.log('   Recent sessions:');
      history.slice(-5).forEach(s => {
        console.log(`     [${s.taskCategory}] ${s.taskName} (${s.date.split('T')[0]})`);
      });
    }
    console.log('');
    
    const blockers = detectProgressBlockers();
    console.log('🚫 Progress Blockers:');
    if (blockers.length === 0) console.log('   None');
    blockers.forEach(b => console.log(`   [${b.severity.toUpperCase()}] ${b.task}`));
    console.log('');
    
    const smartTask = generateIntelligentTask(manifest);
    console.log('🎯 RECOMMENDED NEXT TASK:');
    console.log(`   ${smartTask.task}`);
    console.log(`   Context: ${smartTask.context}`);
    console.log(`   Category: ${smartTask.category}`);
    console.log(`   Source: ${smartTask.source}`);
    console.log(`   Impact: ${smartTask.impact}`);

  } else if (command === 'record') {
    // Record a session: task-prioritizer.ts record <category> <name> [outcome]
    const category = process.argv[3];
    const name = process.argv[4];
    const outcome = process.argv[5];
    if (!category || !name) {
      console.log('Usage: task-prioritizer.ts record <category> <taskName> [outcome]');
      process.exit(1);
    }
    recordSession(category, name, outcome);
    console.log(`✅ Recorded session: [${category}] ${name}`);

  } else {
    console.log('Usage:');
    console.log('  task-prioritizer.ts analyze                    — Show recommended task');
    console.log('  task-prioritizer.ts record <cat> <name> [out]  — Record a completed session');
  }
}
