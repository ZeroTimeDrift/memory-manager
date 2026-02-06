#!/usr/bin/env npx ts-node

/**
 * Intelligent Task Prioritizer
 * 
 * Analyzes current state and generates contextually appropriate tasks
 * based on:
 * 1. What's blocking progress
 * 2. Time since last worked on  
 * 3. Dependencies completed
 * 4. Impact on memory survival
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';
const MANIFEST_PATH = '/root/clawd/skills/memory-manager/manifest.json';

interface Task {
  task: string;
  context: string;
  priority: number;
  source?: string; // How this task was generated
  impact?: 'critical' | 'high' | 'medium' | 'low';
  blocksOthers?: boolean;
  dependencies?: string[];
  lastWorkedOn?: string;
  createdAt?: string;
}

interface Manifest {
  nextTask?: Task;
  taskQueue?: Task[];
  files?: Record<string, any>;
  recentTopics?: string[];
  lastSession?: any;
  config?: any;
  [key: string]: any;
}

/**
 * Analyze memory files to detect what needs attention
 */
function analyzeMemoryState(): {
  staleFiles: string[];
  missingStructure: string[];
  recentActivity: string[];
  fragmentedKnowledge: string[];
} {
  const memoryPath = path.join(WORKSPACE, 'memory');
  const result: {
    staleFiles: string[];
    missingStructure: string[];
    recentActivity: string[];
    fragmentedKnowledge: string[];
  } = {
    staleFiles: [],
    missingStructure: [],
    recentActivity: [],
    fragmentedKnowledge: []
  };

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
    'memory/index.qmd',
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
        result.recentActivity.push(path.join(prefix, file));
      } else if (stats.isDirectory() && file !== '.git') {
        scanRecent(filePath, path.join(prefix, file));
      }
    });
  }
  
  scanRecent(memoryPath, 'memory');
  scanRecent(path.join(WORKSPACE, 'skills'), 'skills');

  return result;
}

/**
 * Assess progress blockers by looking at incomplete tasks and broken systems
 */
function detectProgressBlockers(): Array<{task: string, context: string, severity: 'critical' | 'high' | 'medium'}> {
  const blockers: Array<{task: string, context: string, severity: 'critical' | 'high' | 'medium'}> = [];
  
  // Check for broken skills or incomplete implementations
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

  // Check for memory system integrity
  if (!fs.existsSync(path.join(WORKSPACE, 'memory/index.qmd'))) {
    blockers.push({
      task: 'Fix memory boot sequence',
      context: 'Critical: memory/index.qmd missing - agent can\'t boot properly',
      severity: 'critical' as const
    });
  }

  return blockers;
}

/**
 * Generate intelligent task based on current context
 */
export function generateIntelligentTask(manifest: Manifest): Task {
  const memoryState = analyzeMemoryState();
  const blockers = detectProgressBlockers();
  
  // Critical blockers take absolute priority
  if (blockers.some(b => b.severity === 'critical')) {
    const criticalBlocker = blockers.find(b => b.severity === 'critical')!;
    return {
      task: criticalBlocker.task,
      context: criticalBlocker.context,
      priority: 1,
      source: 'critical-blocker-detection',
      impact: 'critical',
      blocksOthers: true
    };
  }

  // High-impact memory survival tasks
  if (memoryState.missingStructure.length > 0) {
    return {
      task: 'Rebuild memory structure',
      context: `Missing critical paths: ${memoryState.missingStructure.join(', ')}. Memory continuity at risk.`,
      priority: 1,
      source: 'memory-survival-analysis',
      impact: 'high',
      blocksOthers: true
    };
  }

  // Progress blockers
  if (blockers.length > 0) {
    const highestBlocker = blockers.sort((a, b) => {
      const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      return severityOrder[b.severity] - severityOrder[a.severity];
    })[0];
    
    return {
      task: highestBlocker.task,
      context: highestBlocker.context,
      priority: highestBlocker.severity === 'high' ? 1 : 2,
      source: 'progress-blocker-analysis',
      impact: highestBlocker.severity,
      blocksOthers: true
    };
  }

  // Knowledge consolidation (if fragmented recent activity)
  if (memoryState.recentActivity.length > 5) {
    return {
      task: 'Consolidate recent learnings',
      context: `High activity in ${memoryState.recentActivity.length} files. Time to synthesize insights.`,
      priority: 2,
      source: 'knowledge-fragmentation-detection',
      impact: 'medium'
    };
  }

  // Maintenance tasks based on staleness
  if (memoryState.staleFiles.length > 0) {
    return {
      task: 'Refresh stale memory files',
      context: `${memoryState.staleFiles.length} files haven't been updated recently: ${memoryState.staleFiles.slice(0, 3).join(', ')}`,
      priority: 3,
      source: 'staleness-analysis',
      impact: 'medium'
    };
  }

  // Topic-driven tasks based on recent focus
  if (manifest.recentTopics && manifest.recentTopics.length > 0) {
    const focusTopic = manifest.recentTopics[0];
    return {
      task: `Advance ${focusTopic} understanding`,
      context: `Recent focus on ${focusTopic} - continue building expertise in this area`,
      priority: 2,
      source: 'topic-momentum-analysis',
      impact: 'medium'
    };
  }

  // Default: strategic self-improvement
  return {
    task: 'Design next capability expansion',
    context: 'System is stable. Time to plan strategic improvement in core functions.',
    priority: 3,
    source: 'strategic-planning',
    impact: 'medium'
  };
}

// CLI interface
if (require.main === module) {
  const command = process.argv[2];
  
  if (command === 'analyze') {
    console.log('🔍 ANALYZING CURRENT STATE...\n');
    
    const memoryState = analyzeMemoryState();
    console.log('📁 Memory State:');
    console.log(`   Stale files: ${memoryState.staleFiles.length}`);
    console.log(`   Missing structure: ${memoryState.missingStructure.length}`);
    console.log(`   Recent activity: ${memoryState.recentActivity.length} files`);
    console.log('');
    
    const blockers = detectProgressBlockers();
    console.log('🚫 Progress Blockers:');
    blockers.forEach(b => console.log(`   [${b.severity.toUpperCase()}] ${b.task}`));
    console.log('');
    
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const smartTask = generateIntelligentTask(manifest);
    console.log('🎯 RECOMMENDED NEXT TASK:');
    console.log(`   ${smartTask.task}`);
    console.log(`   Context: ${smartTask.context}`);
    console.log(`   Source: ${smartTask.source}`);
    console.log(`   Impact: ${smartTask.impact}`);
    
  } else {
    console.log('Usage: task-prioritizer.ts analyze');
  }
}