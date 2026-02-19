#!/usr/bin/env npx ts-node

/**
 * Daily File Age-Aware Pruning
 * 
 * Manages daily log lifecycle:
 * 1. Files < 7 days old: untouched (active context)
 * 2. Files 7-30 days old: kept as-is (recent history)
 * 3. Files > 30 days old: condensed → key items extracted to weekly digest
 *    and MEMORY.md, then archived to memory/archive/daily/
 * 
 * The goal: daily/ stays lean (recent context only), while long-term
 * signal is preserved in weekly digests and MEMORY.md.
 * 
 * Usage:
 *   npx ts-node src/prune-daily.ts                # Dry-run (preview)
 *   npx ts-node src/prune-daily.ts --execute      # Actually prune
 *   npx ts-node src/prune-daily.ts --days 14      # Custom threshold (default 30)
 *   npx ts-node src/prune-daily.ts --verbose      # Show extraction details
 *   npx ts-node src/prune-daily.ts --json         # Machine-readable output
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';
const DAILY_DIR = path.join(WORKSPACE, 'memory', 'daily');
const ARCHIVE_DIR = path.join(WORKSPACE, 'memory', 'archive', 'daily');
const WEEKLY_DIR = path.join(WORKSPACE, 'memory', 'weekly');
const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md');

// ─── Types ──────────────────────────────────────────────────────────────────

interface DailyFileInfo {
  filename: string;
  date: string;          // YYYY-MM-DD
  ageInDays: number;
  sizeBytes: number;
  lineCount: number;
  sections: string[];
  hasDecisions: boolean;
  hasFacts: boolean;
  hasTasks: boolean;
  keyItems: ExtractedItem[];
}

interface ExtractedItem {
  type: 'decision' | 'fact' | 'lesson' | 'milestone' | 'quote' | 'note';
  text: string;
  section: string;
}

interface PruneResult {
  scanned: number;
  eligible: number;       // Files old enough to prune
  pruned: number;         // Files actually archived
  extracted: number;      // Key items extracted
  skipped: number;        // Files skipped (too young or empty)
  details: PruneDetail[];
}

interface PruneDetail {
  filename: string;
  ageInDays: number;
  action: 'keep' | 'prune' | 'skip';
  reason: string;
  itemsExtracted: number;
}

// ─── Key Item Extraction ────────────────────────────────────────────────────

/**
 * Extract high-value items from a daily log.
 * These are the things worth preserving in weekly digests / MEMORY.md.
 */
function extractKeyItems(content: string, filename: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const lines = content.split('\n');
  let currentSection = 'General';

  for (const line of lines) {
    const trimmed = line.trim();

    // Track section headers
    const headerMatch = trimmed.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      currentSection = headerMatch[1];
      continue;
    }

    // Skip frontmatter
    if (trimmed === '---') continue;
    if (/^(date|day|tags|mood):/.test(trimmed)) continue;

    // Skip empty lines
    if (!trimmed) continue;

    // Detect decisions
    if (/\b(DECISION|decided|decision|switched to|moved to|going with|chose|chosen)\b/i.test(trimmed)) {
      items.push({ type: 'decision', text: cleanBullet(trimmed), section: currentSection });
      continue;
    }

    // Detect lessons/learnings
    if (/\b(lesson|learned|insight|realize[ds]?|important:|key takeaway|never again|always remember)\b/i.test(trimmed)) {
      items.push({ type: 'lesson', text: cleanBullet(trimmed), section: currentSection });
      continue;
    }

    // Detect milestones/achievements
    if (/\b(shipped|launched|deployed|completed|built|created|published|reached|achieved|milestone)\b/i.test(trimmed)) {
      items.push({ type: 'milestone', text: cleanBullet(trimmed), section: currentSection });
      continue;
    }

    // Detect explicit facts
    if (/^-?\s*(FACT|fact):/i.test(trimmed)) {
      items.push({ type: 'fact', text: cleanBullet(trimmed), section: currentSection });
      continue;
    }

    // Detect quotes worth keeping
    if (/^>\s*"/.test(trimmed) || /\bquote:/i.test(trimmed)) {
      items.push({ type: 'quote', text: cleanBullet(trimmed), section: currentSection });
      continue;
    }

    // Skip routine operational entries (timestamps, status updates, heartbeats)
    if (/^\d{2}:\d{2}/.test(trimmed)) continue;          // Pure timestamps
    if (/heartbeat|HEARTBEAT_OK/i.test(trimmed)) continue;
    if (/^-\s*\[[\sx]\]/.test(trimmed)) continue;         // Checkboxes (tasks tracked elsewhere)
  }

  return items;
}

function cleanBullet(text: string): string {
  return text.replace(/^[-*]\s*/, '').replace(/^\[.*?\]\s*/, '').trim();
}

// ─── Weekly Digest Integration ──────────────────────────────────────────────

/**
 * Ensure extracted items are captured in the appropriate weekly digest.
 */
function ensureWeeklyDigest(date: string, items: ExtractedItem[]): boolean {
  if (items.length === 0) return false;

  // Calculate ISO week
  const d = new Date(date + 'T00:00:00Z');
  const dayOfYear = Math.floor((d.getTime() - new Date(d.getUTCFullYear(), 0, 1).getTime()) / 86400000);
  const weekNum = Math.ceil((dayOfYear + new Date(d.getUTCFullYear(), 0, 1).getUTCDay() + 1) / 7);
  const weekStr = `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
  const weeklyFile = path.join(WEEKLY_DIR, `${weekStr}.md`);

  if (!fs.existsSync(WEEKLY_DIR)) {
    fs.mkdirSync(WEEKLY_DIR, { recursive: true });
  }

  let content = '';
  if (fs.existsSync(weeklyFile)) {
    content = fs.readFileSync(weeklyFile, 'utf-8');
  } else {
    content = `# Week ${weekStr}\n\n## Summary\n\n`;
  }

  // Check if this date is already summarized in the weekly
  if (content.includes(date)) {
    return false; // Already included
  }

  // Append condensed items under the date
  const condensed = items.map(item => {
    const prefix = item.type === 'decision' ? '📋' :
                   item.type === 'lesson' ? '💡' :
                   item.type === 'milestone' ? '🏆' :
                   item.type === 'fact' ? '📌' :
                   item.type === 'quote' ? '💬' : '•';
    return `  ${prefix} ${item.text}`;
  }).join('\n');

  const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
  const newSection = `\n**${dayName} ${date}** (archived from daily)\n${condensed}\n`;

  content = content.trimEnd() + '\n' + newSection;
  fs.writeFileSync(weeklyFile, content);
  return true;
}

// ─── Archive ────────────────────────────────────────────────────────────────

function archiveFile(filename: string): void {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const src = path.join(DAILY_DIR, filename);
  const dst = path.join(ARCHIVE_DIR, filename);

  // Copy to archive (don't delete — recoverable)
  fs.copyFileSync(src, dst);
  fs.unlinkSync(src);
}

// ─── Main Pruning Logic ────────────────────────────────────────────────────

function scanDailyFiles(maxAgeDays: number): DailyFileInfo[] {
  if (!fs.existsSync(DAILY_DIR)) return [];

  const files = fs.readdirSync(DAILY_DIR)
    .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();

  const now = new Date();
  const infos: DailyFileInfo[] = [];

  for (const filename of files) {
    const dateStr = filename.replace('.md', '');
    const fileDate = new Date(dateStr + 'T00:00:00Z');
    const ageMs = now.getTime() - fileDate.getTime();
    const ageInDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    const filePath = path.join(DAILY_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Extract sections
    const sections = lines
      .filter(l => /^#{1,3}\s/.test(l))
      .map(l => l.replace(/^#+\s*/, '').trim());

    const keyItems = extractKeyItems(content, filename);

    infos.push({
      filename,
      date: dateStr,
      ageInDays,
      sizeBytes: Buffer.byteLength(content),
      lineCount: lines.length,
      sections,
      hasDecisions: keyItems.some(i => i.type === 'decision'),
      hasFacts: keyItems.some(i => i.type === 'fact'),
      hasTasks: content.includes('TASK:'),
      keyItems,
    });
  }

  return infos;
}

function pruneDaily(maxAgeDays: number, execute: boolean, verbose: boolean): PruneResult {
  const files = scanDailyFiles(maxAgeDays);
  const result: PruneResult = {
    scanned: files.length,
    eligible: 0,
    pruned: 0,
    extracted: 0,
    skipped: 0,
    details: [],
  };

  for (const file of files) {
    if (file.ageInDays < maxAgeDays) {
      result.skipped++;
      result.details.push({
        filename: file.filename,
        ageInDays: file.ageInDays,
        action: 'keep',
        reason: `${file.ageInDays}d old (threshold: ${maxAgeDays}d)`,
        itemsExtracted: 0,
      });
      continue;
    }

    result.eligible++;

    // Check if there are any key items worth extracting
    if (file.keyItems.length === 0 && file.lineCount < 10) {
      // Near-empty file, nothing to extract — just archive
      if (execute) {
        archiveFile(file.filename);
      }
      result.pruned++;
      result.details.push({
        filename: file.filename,
        ageInDays: file.ageInDays,
        action: 'prune',
        reason: 'Empty/minimal — archived directly',
        itemsExtracted: 0,
      });
      continue;
    }

    // Extract key items to weekly digest
    if (execute) {
      ensureWeeklyDigest(file.date, file.keyItems);
      archiveFile(file.filename);
    }

    result.extracted += file.keyItems.length;
    result.pruned++;
    result.details.push({
      filename: file.filename,
      ageInDays: file.ageInDays,
      action: 'prune',
      reason: `${file.keyItems.length} key items → weekly digest, file → archive`,
      itemsExtracted: file.keyItems.length,
    });
  }

  return result;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const verbose = args.includes('--verbose');
const jsonOutput = args.includes('--json');

// Parse --days
let maxAgeDays = 30;
const daysIdx = args.indexOf('--days');
if (daysIdx !== -1 && args[daysIdx + 1]) {
  maxAgeDays = parseInt(args[daysIdx + 1], 10);
  if (isNaN(maxAgeDays) || maxAgeDays < 1) {
    console.error('❌ --days must be a positive integer');
    process.exit(1);
  }
}

const result = pruneDaily(maxAgeDays, execute, verbose);

if (jsonOutput) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log(`     🗂️  DAILY FILE PRUNING ${execute ? '(LIVE)' : '(DRY RUN)'}`);
console.log('═══════════════════════════════════════════════════════════');
console.log('');
console.log(`📁 Scanned:   ${result.scanned} daily files`);
console.log(`⏰ Threshold: ${maxAgeDays} days`);
console.log('');

if (result.details.length > 0) {
  // Group by action
  const kept = result.details.filter(d => d.action === 'keep');
  const pruned = result.details.filter(d => d.action === 'prune');

  if (pruned.length > 0) {
    console.log(`🗑️  PRUNE (${pruned.length}):`);
    for (const d of pruned) {
      console.log(`   📄 ${d.filename} — ${d.ageInDays}d old`);
      console.log(`      ${d.reason}`);
      if (verbose && d.itemsExtracted > 0) {
        // Show extracted items
        const file = scanDailyFiles(maxAgeDays).find(f => f.filename === d.filename);
        if (file) {
          for (const item of file.keyItems) {
            const icon = item.type === 'decision' ? '📋' :
                         item.type === 'lesson' ? '💡' :
                         item.type === 'milestone' ? '🏆' : '•';
            console.log(`      ${icon} [${item.type}] ${item.text.substring(0, 70)}${item.text.length > 70 ? '...' : ''}`);
          }
        }
      }
    }
    console.log('');
  }

  if (verbose && kept.length > 0) {
    console.log(`✅ KEEP (${kept.length}):`);
    for (const d of kept) {
      console.log(`   📄 ${d.filename} — ${d.ageInDays}d old`);
    }
    console.log('');
  }
}

console.log('─────────────────────────────────────────');
console.log(`📊 Summary:`);
console.log(`   Kept:       ${result.skipped}`);
console.log(`   Eligible:   ${result.eligible}`);
console.log(`   Pruned:     ${result.pruned}`);
console.log(`   Extracted:  ${result.extracted} key items`);

if (!execute && result.eligible > 0) {
  console.log('');
  console.log('🔸 DRY RUN — nothing was changed. Use --execute to prune.');
} else if (execute && result.pruned > 0) {
  console.log('');
  console.log(`📦 Archived ${result.pruned} file(s) to memory/archive/daily/`);
  console.log('   Key items preserved in weekly digests.');
}

console.log('');
