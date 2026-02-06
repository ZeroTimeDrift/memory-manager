#!/usr/bin/env npx ts-node

/**
 * Session summarization script - automatically generate summaries of work sessions
 * Analyzes session logs and generates concise summaries for daily notes
 * 
 * Usage:
 *   session-summary.ts [session-file] [--update-daily]
 *   
 * If no session file provided, analyzes most recent session
 * With --update-daily flag, automatically updates daily notes
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';
const SESSIONS_DIR = path.join(WORKSPACE, 'memory', 'sessions');
const DAILY_DIR = path.join(WORKSPACE, 'memory', 'daily');

interface SessionMetadata {
  startTime: string;
  endTime: string;
  duration: string;
  focus?: string;
  outcome?: string;
}

interface SessionSummary {
  metadata: SessionMetadata;
  keyActions: string[];
  filesModified: string[];
  decisions: string[];
  nextSteps: string[];
  summary: string;
}

function parseSessionFile(sessionPath: string): SessionSummary | null {
  if (!fs.existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    return null;
  }
  
  const content = fs.readFileSync(sessionPath, 'utf-8');
  const lines = content.split('\n');
  
  // Extract YAML frontmatter
  let frontmatter = '';
  let contentStart = 0;
  
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        contentStart = i + 1;
        break;
      }
      frontmatter += lines[i] + '\n';
    }
  }
  
  // Parse metadata from frontmatter
  const metadata: SessionMetadata = {
    startTime: extractMetadata(frontmatter, 'start') || 'Unknown',
    endTime: extractMetadata(frontmatter, 'end') || 'Unknown',
    duration: extractMetadata(frontmatter, 'duration') || 'Unknown',
    focus: extractMetadata(frontmatter, 'focus'),
    outcome: extractMetadata(frontmatter, 'outcome')
  };
  
  // Analyze session content
  const sessionContent = lines.slice(contentStart).join('\n');
  
  // Extract key information from session content
  const keyActions = extractBulletPoints(sessionContent, ['action', 'task', 'work', 'build', 'create', 'update']);
  const filesModified = extractFileReferences(sessionContent);
  const decisions = extractBulletPoints(sessionContent, ['decision', 'chose', 'decided', 'rule']);
  const nextSteps = extractBulletPoints(sessionContent, ['next', 'todo', 'plan', 'continue']);
  
  // Generate summary
  const summary = generateSessionSummary(metadata, keyActions, filesModified, decisions);
  
  return {
    metadata,
    keyActions,
    filesModified,
    decisions,
    nextSteps,
    summary
  };
}

function extractMetadata(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : undefined;
}

function extractBulletPoints(content: string, keywords: string[]): string[] {
  const points: string[] = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Check for bullet points (-, *, +) that contain relevant keywords
    if (/^[-\*\+]\s/.test(trimmed)) {
      const pointText = trimmed.substring(2).trim();
      if (keywords.some(keyword => pointText.toLowerCase().includes(keyword.toLowerCase()))) {
        points.push(pointText);
      }
    }
  }
  
  return points;
}

function extractFileReferences(content: string): string[] {
  const filePattern = /[\w\/\.-]+\.(?:md|qmd|ts|js|json|yaml|yml)/g;
  const matches = content.match(filePattern) || [];
  
  // Filter and deduplicate
  const files = [...new Set(matches.filter(file => 
    !file.includes('YYYY') && 
    !file.includes('XX') &&
    file.length > 3
  ))];
  
  return files;
}

function generateSessionSummary(
  metadata: SessionMetadata, 
  keyActions: string[], 
  filesModified: string[], 
  decisions: string[]
): string {
  const parts: string[] = [];
  
  // Focus and outcome
  if (metadata.focus) {
    parts.push(`Focus: ${metadata.focus}`);
  }
  if (metadata.outcome) {
    parts.push(`Outcome: ${metadata.outcome}`);
  }
  
  // Key work done
  if (keyActions.length > 0) {
    parts.push(`Key work: ${keyActions.slice(0, 2).join(', ')}`);
  }
  
  // Files touched
  if (filesModified.length > 0) {
    const fileCount = filesModified.length;
    const firstFiles = filesModified.slice(0, 2).map(f => path.basename(f)).join(', ');
    if (fileCount > 2) {
      parts.push(`Modified ${fileCount} files (${firstFiles}, +${fileCount - 2} more)`);
    } else {
      parts.push(`Modified: ${firstFiles}`);
    }
  }
  
  // Decisions made
  if (decisions.length > 0) {
    parts.push(`Decisions: ${decisions.slice(0, 1).join('')}`);
  }
  
  return parts.join(' | ');
}

function findMostRecentSession(): string | null {
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error('Sessions directory not found');
    return null;
  }
  
  const sessions = fs.readdirSync(SESSIONS_DIR)
    .filter(file => file.endsWith('.qmd'))
    .map(file => {
      const fullPath = path.join(SESSIONS_DIR, file);
      const stats = fs.statSync(fullPath);
      return { file, mtime: stats.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  
  return sessions.length > 0 ? path.join(SESSIONS_DIR, sessions[0].file) : null;
}

function updateDailyNotes(sessionSummary: SessionSummary): void {
  const today = new Date().toISOString().split('T')[0];
  const dailyFile = path.join(DAILY_DIR, `${today}.qmd`);
  
  // Create daily file if it doesn't exist
  if (!fs.existsSync(dailyFile)) {
    const initialContent = `---
date: ${today}
tags: []
mood: neutral
---

# ${today}

## Sessions

`;
    fs.writeFileSync(dailyFile, initialContent);
  }
  
  // Read existing content
  const content = fs.readFileSync(dailyFile, 'utf-8');
  
  // Find or create Sessions section
  let updatedContent = content;
  
  if (!content.includes('## Sessions')) {
    // Add Sessions section before the end
    updatedContent = content.trimEnd() + '\n\n## Sessions\n\n';
  }
  
  // Add session summary
  const sessionEntry = `### ${sessionSummary.metadata.startTime} - ${sessionSummary.metadata.duration}
${sessionSummary.summary}

`;
  
  // Insert before any other sections that might come after Sessions
  const sessionsIndex = updatedContent.indexOf('## Sessions');
  const nextSectionIndex = updatedContent.indexOf('\n## ', sessionsIndex + 12);
  
  if (nextSectionIndex === -1) {
    // No section after Sessions, append at end
    updatedContent = updatedContent.trimEnd() + '\n\n' + sessionEntry;
  } else {
    // Insert before next section
    updatedContent = 
      updatedContent.substring(0, nextSectionIndex) + 
      '\n' + sessionEntry + 
      updatedContent.substring(nextSectionIndex);
  }
  
  fs.writeFileSync(dailyFile, updatedContent);
  console.log(`📝 Updated daily notes: ${dailyFile}`);
}

// Main execution
const args = process.argv.slice(2);
const sessionFile = args.find(arg => !arg.startsWith('--'));
const updateDaily = args.includes('--update-daily');

let targetSession: string | null = null;

if (sessionFile) {
  targetSession = path.isAbsolute(sessionFile) ? sessionFile : path.join(SESSIONS_DIR, sessionFile);
} else {
  targetSession = findMostRecentSession();
}

if (!targetSession) {
  console.error('No session file found to summarize');
  process.exit(1);
}

console.log('🔍 ANALYZING SESSION');
console.log(`   File: ${path.basename(targetSession)}`);
console.log('');

const summary = parseSessionFile(targetSession);

if (!summary) {
  console.error('Failed to parse session file');
  process.exit(1);
}

console.log('📊 SESSION SUMMARY');
console.log(`   Duration: ${summary.metadata.duration}`);
console.log(`   Focus: ${summary.metadata.focus || 'Not specified'}`);
console.log(`   Outcome: ${summary.metadata.outcome || 'Not specified'}`);
console.log(`   Key actions: ${summary.keyActions.length}`);
console.log(`   Files modified: ${summary.filesModified.length}`);
console.log(`   Decisions: ${summary.decisions.length}`);
console.log('');
console.log('📝 GENERATED SUMMARY:');
console.log(`   ${summary.summary}`);
console.log('');

if (updateDaily) {
  updateDailyNotes(summary);
  console.log('✅ Daily notes updated');
} else {
  console.log('💡 Run with --update-daily to add this summary to daily notes');
}