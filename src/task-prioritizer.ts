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
  {
    task: 'Improve benchmark recall coverage',
    context: 'Benchmark at 83%. Add new adversarial tests for recently-added content. Target: 90%+.',
    category: 'memory',
    impact: 'high',
    condition: () => {
      // Check if benchmark was run recently
      const historyPath = path.join(WORKSPACE, 'memory/benchmark-history.json');
      if (!fs.existsSync(historyPath)) return true;
      try {
        const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
        const last = history[history.length - 1];
        return !last || last.overall < 90;
      } catch { return true; }
    }
  },
  {
    task: 'Add new recall test cases for recent content',
    context: 'Memory system grows but benchmark tests are static. Add tests for DeFi lessons, moltbook observations, and operational rules added since last benchmark update.',
    category: 'memory',
    impact: 'high',
  },
  {
    task: 'Audit memory chunk boundaries',
    context: 'Clawdbot chunks by token count with overlap. Check if critical facts land at chunk boundaries where they get split. Move important content to chunk-safe positions.',
    category: 'memory',
    impact: 'medium',
  },
  {
    task: 'Review and prune session transcript index',
    context: '1686+ session chunks may contain stale/irrelevant content drowning search. Identify lowest-value session files for archival.',
    category: 'memory',
    impact: 'medium',
  },
  {
    task: 'Build memory decay automation',
    context: 'File weights in manifest decay manually. Build auto-decay: files not accessed in 7+ days get weight reduced. Files accessed get boosted.',
    category: 'infrastructure',
    impact: 'medium',
  },
  {
    task: 'Add cross-reference integrity checker',
    context: 'Memory files reference each other (e.g., "see rules.md"). Build a tool that validates all cross-references resolve to existing files/sections.',
    category: 'infrastructure',
    impact: 'medium',
  },
  {
    task: 'Build weekly auto-digest',
    context: 'Weekly summaries are manually written. Build automation to synthesize daily logs into a weekly digest with key decisions, lessons, and metrics.',
    category: 'infrastructure',
    impact: 'medium',
  },
  {
    task: 'Explore Moltbook strategic engagement',
    context: 'Currently observing only. Consider a targeted post or engagement that builds reputation without compromising observer status.',
    category: 'expansion',
    impact: 'low',
  },
  {
    task: 'Review open problems from weekly summary',
    context: 'Weekly file lists open problems. Check if any have become unblocked or need re-prioritization.',
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

function analyzeMemoryState(): MemoryState {
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
    /moltbook\/observations\.md$/,
    /sessions\//,
    /benchmark-history\.json$/,
    /manifest\.json$/,
  ];

  // Check for stale daily files (>3 days without update)
  const dailyPath = path.join(memoryPath, 'daily');
  if (fs.existsSync(dailyPath)) {
    const dailyFiles = fs.readdirSync(dailyPath);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    
    dailyFiles.forEach(file => {
      const filePath = path.join(dailyPath, file);
      const stats = fs.statSync(filePath);
      if (stats.mtime < threeDaysAgo) {
        result.staleFiles.push(`memory/daily/${file}`);
      }
    });
  }

  // Check for missing structure
  const expectedPaths = [
    'memory/index.md',
    'memory/daily',
    'memory/sessions', 
    'memory/topics',
    'MEMORY.md'
  ];
  
  expectedPaths.forEach(expectedPath => {
    if (!fs.existsSync(path.join(WORKSPACE, expectedPath))) {
      result.missingStructure.push(expectedPath);
    }
  });

  // Detect recent activity (files modified in last 24h)
  function scanRecent(dir: string, prefix = '') {
    if (!fs.existsSync(dir)) return;
    
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isFile() && stats.mtime > oneDayAgo) {
        const relativePath = path.join(prefix, file);
        result.recentActivity.push(relativePath);
        
        // Check if this is auto-generated
        const isAuto = autoGenPatterns.some(p => p.test(relativePath));
        if (!isAuto) {
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

// ─── Main Task Generation ───────────────────────────────────────────────────

export function generateIntelligentTask(manifest: Manifest): Task {
  const memoryState = analyzeMemoryState();
  const blockers = detectProgressBlockers();
  const history = getSessionHistory(manifest);
  const consolidationStreak = getConsolidationStreak(history);
  
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
  //   - Significant non-auto activity (>8 files)
  //   - AND consolidation streak < 3
  //   - AND last consolidation was >4h ago
  const lastConsolidation = getLastTaskOfCategory(history, 'consolidation');
  const consolidationCooldown = lastConsolidation ? hoursSince(lastConsolidation.date) < 4 : false;
  const hasSignificantActivity = memoryState.recentActivityExcludingAuto.length > 8;
  const consolidationAllowed = consolidationStreak < 3 && !consolidationCooldown;

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

  for (const strategic of STRATEGIC_BACKLOG) {
    // Check condition if present
    if (strategic.condition && !strategic.condition(manifest, memoryState)) continue;
    
    // Skip if we just did this exact category recently (last 2 sessions)
    const recentCategories = history.slice(-2).map(h => h.taskCategory);
    if (recentCategories.includes(strategic.category)) continue;
    
    return {
      task: strategic.task,
      context: strategic.context,
      priority: 2,
      source: 'strategic-backlog',
      impact: strategic.impact,
      category: strategic.category
    };
  }

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

  // ── Priority 7: Topic momentum ──
  if (manifest.recentTopics && manifest.recentTopics.length > 0) {
    const focusTopic = manifest.recentTopics[0];
    return {
      task: `Advance ${focusTopic} understanding`,
      context: `Recent focus on ${focusTopic} - continue building expertise in this area`,
      priority: 2,
      source: 'topic-momentum-analysis',
      impact: 'medium',
      category: 'expansion'
    };
  }

  // ── Default: stable system ──
  return {
    task: 'Design next capability expansion',
    context: 'System is stable. Time to plan strategic improvement in core functions.',
    priority: 3,
    source: 'strategic-planning',
    impact: 'medium',
    category: 'expansion'
  };
}

// ─── Session History Management ─────────────────────────────────────────────

/**
 * Record a completed session in the manifest's session history.
 * Call this from session-wrap.ts or task.ts complete.
 */
export function recordSession(taskCategory: string, taskName: string, outcome?: string): void {
  const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  
  if (!manifest.sessionHistory) manifest.sessionHistory = [];
  
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
