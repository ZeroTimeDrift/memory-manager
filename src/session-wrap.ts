#!/usr/bin/env npx ts-node

/**
 * Session Wrap — End-of-session summary generator
 * 
 * Called at the end of a conversation session to:
 * 1. Generate structured session entry for daily log
 * 2. Trigger capture.ts for fact extraction
 * 3. Update file weights via session-update.ts
 * 4. Re-index memory via `clawdbot memory index`
 * 
 * Usage:
 *   npx ts-node src/session-wrap.ts "Brief description of what happened"
 *   npx ts-node src/session-wrap.ts "Built capture system, discussed memory arch" --files MEMORY.md SKILL.md
 *   npx ts-node src/session-wrap.ts "Quick chat about deploy" --mood productive --tags deploy,infra
 * 
 * Input can also be piped for richer capture:
 *   echo "DECISION: Ship Friday\nFACT: New API key\nTASK: Update docs" | npx ts-node src/session-wrap.ts "Major session"
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

const WORKSPACE = '/root/clawd';
const DAILY_DIR = path.join(WORKSPACE, 'memory', 'daily');
const SKILL_DIR = path.join(WORKSPACE, 'skills', 'memory-manager');

// ─── Helpers ────────────────────────────────────────────────────────────────

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function getTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Dubai'
  });
}

function getDubaiHour(): number {
  const dubaiTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai', hour: 'numeric', hour12: false });
  return parseInt(dubaiTime, 10);
}

function ensureDailyFile(): string {
  if (!fs.existsSync(DAILY_DIR)) {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
  }
  
  const today = getToday();
  const dailyFile = path.join(DAILY_DIR, `${today}.md`);
  
  if (!fs.existsSync(dailyFile)) {
    const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    fs.writeFileSync(dailyFile, `---
date: "${today}"
day: "${dayName}"
tags: []
mood: "neutral"
---

# ${today}

`);
  }
  
  return dailyFile;
}

function parseArgs(): { description: string; files: string[]; mood: string; tags: string[] } {
  const args = process.argv.slice(2);
  let description = '';
  const files: string[] = [];
  let mood = '';
  const tags: string[] = [];
  let mode: 'default' | 'files' | 'mood' | 'tags' = 'default';

  for (const arg of args) {
    if (arg === '--files') { mode = 'files'; continue; }
    if (arg === '--mood') { mode = 'mood'; continue; }
    if (arg === '--tags') { mode = 'tags'; continue; }
    if (arg.startsWith('--')) { mode = 'default'; continue; }

    switch (mode) {
      case 'files': files.push(arg); break;
      case 'mood': mood = arg; mode = 'default'; break;
      case 'tags': tags.push(...arg.split(',')); mode = 'default'; break;
      default: description = description ? `${description} ${arg}` : arg;
    }
  }

  return { description, files, mood, tags };
}

// ─── Session Entry ──────────────────────────────────────────────────────────

function writeSessionEntry(description: string, mood: string, tags: string[]): void {
  const dailyFile = ensureDailyFile();
  const timestamp = getTimestamp();
  const today = getToday();
  
  // Build the session entry
  const sessionType = detectSessionType(description);
  const intensityMarker = detectIntensity(description);
  
  const entry = `
## ${timestamp} — ${sessionType} ${intensityMarker}

${description}

`;

  // Append to daily file
  const existing = fs.readFileSync(dailyFile, 'utf-8');
  fs.writeFileSync(dailyFile, existing.trimEnd() + '\n' + entry);
  
  // Update frontmatter tags and mood if provided
  if (tags.length > 0 || mood) {
    let content = fs.readFileSync(dailyFile, 'utf-8');
    
    if (tags.length > 0) {
      // Merge tags with existing
      const existingTagsMatch = content.match(/^tags:\s*\[([^\]]*)\]/m);
      const existingTags = existingTagsMatch 
        ? existingTagsMatch[1].split(',').map(t => t.trim().replace(/"/g, '')).filter(t => t)
        : [];
      const allTags = [...new Set([...existingTags, ...tags])];
      const tagStr = allTags.map(t => `"${t}"`).join(', ');
      content = content.replace(/^tags:\s*\[.*\]/m, `tags: [${tagStr}]`);
    }
    
    if (mood) {
      content = content.replace(/^mood:\s*".*"/m, `mood: "${mood}"`);
    }
    
    fs.writeFileSync(dailyFile, content);
  }
  
  console.log(`📝 Session entry → daily/${today}.md`);
}

function detectSessionType(desc: string): string {
  const d = desc.toLowerCase();
  if (/hevar|main session|direct chat/.test(d)) return 'Main Session with Hevar';
  if (/cron|self-expansion|auto/.test(d)) return 'Self-Expansion Session';
  if (/slack|discord|group/.test(d)) return 'Group Chat Session';
  if (/debug|fix|bug/.test(d)) return 'Debug Session';
  return 'Session';
}

function detectIntensity(desc: string): string {
  const d = desc.toLowerCase();
  const wordCount = desc.split(/\s+/).length;
  
  if (/major|breakthrough|critical|huge/.test(d) || wordCount > 30) return '(MAJOR)';
  if (/quick|brief|minor|small/.test(d) || wordCount < 10) return '(quick)';
  return '';
}

// ─── Pipeline Steps ─────────────────────────────────────────────────────────

function runCapture(stdinData: string | null): void {
  if (!stdinData || stdinData.trim().length === 0) {
    console.log('⏭️  No structured capture data — skipping capture.ts');
    return;
  }
  
  console.log('\n🔍 Running conversation capture...');
  try {
    const result = child_process.execSync(
      `npx ts-node ${path.join(SKILL_DIR, 'src', 'capture.ts')}`,
      {
        cwd: SKILL_DIR,
        input: stdinData,
        encoding: 'utf-8',
        timeout: 30000,
      }
    );
    console.log(result);
  } catch (e) {
    console.error(`⚠️  Capture failed: ${(e as Error).message}`);
  }
}

function runSessionUpdate(files: string[]): void {
  console.log('\n📊 Updating file weights...');
  try {
    const fileArgs = files.length > 0 ? files.join(' ') : '';
    const result = child_process.execSync(
      `npx ts-node ${path.join(SKILL_DIR, 'src', 'session-update.ts')} ${fileArgs}`,
      {
        cwd: SKILL_DIR,
        encoding: 'utf-8',
        timeout: 30000,
      }
    );
    console.log(result);
  } catch (e) {
    console.error(`⚠️  Weight update failed: ${(e as Error).message}`);
  }
}

function runMemoryIndex(): void {
  console.log('\n🔄 Re-indexing memory...');
  try {
    const result = child_process.execSync(
      'clawdbot memory index',
      {
        cwd: WORKSPACE,
        encoding: 'utf-8',
        timeout: 60000,
      }
    );
    // Only show last few lines
    const lines = result.trim().split('\n');
    const summary = lines.slice(-3).join('\n');
    console.log(`   ${summary}`);
  } catch (e) {
    console.error(`⚠️  Memory index failed: ${(e as Error).message}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { description, files, mood, tags } = parseArgs();

  if (!description) {
    console.log('Usage: npx ts-node src/session-wrap.ts "What happened this session"');
    console.log('');
    console.log('Options:');
    console.log('  --files FILE1 FILE2     Files accessed this session');
    console.log('  --mood productive       Session mood for daily log');
    console.log('  --tags tag1,tag2        Tags for daily log frontmatter');
    console.log('');
    console.log('Pipe structured data for capture:');
    console.log('  echo "DECISION: X\\nFACT: Y" | npx ts-node src/session-wrap.ts "Description"');
    process.exit(1);
  }

  // Read stdin if available (for structured capture data)
  let stdinData: string | null = null;
  if (!process.stdin.isTTY) {
    stdinData = await new Promise<string>((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { resolve(data); });
      setTimeout(() => resolve(data), 2000);
    });
  }

  const timestamp = getTimestamp();
  const today = getToday();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🏁 SESSION WRAP');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Time: ${timestamp} (Dubai)`);
  console.log(`   Date: ${today}`);
  console.log(`   Summary: ${description}`);
  console.log('═══════════════════════════════════════════════════════════');

  // Step 1: Write session entry to daily log
  writeSessionEntry(description, mood, tags);

  // Step 2: Run capture.ts if there's structured data
  runCapture(stdinData);

  // Step 3: Update file weights
  runSessionUpdate(files);

  // Step 4: Re-index memory
  runMemoryIndex();

  // Done
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   ✅ SESSION WRAPPED');
  console.log(`   📝 Daily log: memory/daily/${today}.md`);
  if (stdinData && stdinData.trim()) {
    console.log('   📥 Capture: processed');
  }
  console.log('   📊 Weights: updated');
  console.log('   🔄 Index: refreshed');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(e => {
  console.error('❌ Session wrap failed:', e.message);
  process.exit(1);
});
