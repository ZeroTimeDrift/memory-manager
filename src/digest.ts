#!/usr/bin/env npx ts-node

/**
 * Memory Digest — The bridge between conversations and searchable memory
 * 
 * Problem: Clawdbot's memory_search does pure semantic search (embeddings + BM25).
 * It can't be modified to use custom weights. So instead of trying to change
 * how search works, we change WHAT gets searched.
 * 
 * Strategy: "Write it where it'll be found"
 * 
 * 1. Important/recurring concepts → MEMORY.md (highest visibility)
 * 2. Daily decisions/events → memory/daily/YYYY-MM-DD.md (date-scoped)
 * 3. Topic-specific knowledge → memory/topics/*.md (domain-scoped)
 * 4. People context → memory/people/contacts.md
 * 
 * The "weight" of a memory is determined by WHERE it lives and HOW it's written:
 * - MEMORY.md content appears in every search (it's always indexed)
 * - Topics with clear, searchable language get found by semantic search
 * - Daily files capture temporal context
 * 
 * This script:
 * - Reads recent daily files
 * - Identifies important patterns (decisions, recurring topics, key facts)
 * - Promotes high-signal content to MEMORY.md or topic files
 * - Demotes stale content from MEMORY.md to archive
 * - Ensures key concepts are written with searchable language
 * 
 * Usage:
 *   npx ts-node src/digest.ts                    # Full digest cycle
 *   npx ts-node src/digest.ts --check             # Dry run, show what would change
 *   npx ts-node src/digest.ts --promote "text"    # Manually promote to MEMORY.md
 *   npx ts-node src/digest.ts --daily-summary     # Generate today's summary  
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';
const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md');
const DAILY_DIR = path.join(WORKSPACE, 'memory', 'daily');
const TOPICS_DIR = path.join(WORKSPACE, 'memory', 'topics');

// ─── Helpers ────────────────────────────────────────────────────────────────

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function getRecentDays(n: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Content Analysis ───────────────────────────────────────────────────────

interface ContentItem {
  text: string;
  source: string;
  type: 'decision' | 'fact' | 'insight' | 'task' | 'event' | 'quote' | 'general';
  importance: number; // 0-1
  topics: string[];
}

function analyzeDaily(content: string, date: string): ContentItem[] {
  const items: ContentItem[] = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('---') || line.startsWith('#')) continue;
    
    // Detect decisions (high importance)
    if (/decision|decided|chose|going with|switching to|use .+ for/i.test(line)) {
      items.push({
        text: line.replace(/^[-*]\s*/, '').replace(/\[[\d:]+\]\s*/, ''),
        source: `daily/${date}`,
        type: 'decision',
        importance: 0.8,
        topics: extractTopics(line)
      });
    }
    
    // Detect key events (medium-high importance)
    if (/built|created|deployed|shipped|launched|published|enabled|configured/i.test(line)) {
      items.push({
        text: line.replace(/^[-*]\s*/, '').replace(/\[[\d:]+\]\s*/, ''),
        source: `daily/${date}`,
        type: 'event',
        importance: 0.7,
        topics: extractTopics(line)
      });
    }
    
    // Detect insights/learnings (high importance)  
    if (/learned|realized|key insight|important|crucial|critical|fundamental/i.test(line)) {
      items.push({
        text: line.replace(/^[-*]\s*/, '').replace(/\[[\d:]+\]\s*/, ''),
        source: `daily/${date}`,
        type: 'insight',
        importance: 0.85,
        topics: extractTopics(line)
      });
    }

    // Detect quotes from Hevar (very high importance)
    if (/hevar|".*"/i.test(line) && /said|told|asked|response|answer/i.test(line)) {
      items.push({
        text: line.replace(/^[-*]\s*/, ''),
        source: `daily/${date}`,
        type: 'quote',
        importance: 0.9,
        topics: extractTopics(line)
      });
    }
  }
  
  return items;
}

function extractTopics(text: string): string[] {
  const topics: string[] = [];
  const t = text.toLowerCase();
  
  if (/memory|recall|search|index|embed/i.test(t)) topics.push('memory');
  if (/moongate|widget|dashboard|memeramper|moonsuite/i.test(t)) topics.push('moongate');
  if (/moltbook|agent|social/i.test(t)) topics.push('moltbook');
  if (/defi|yield|stake|solana|kamino|jito/i.test(t)) topics.push('defi');
  if (/identity|soul|conscious|anchor/i.test(t)) topics.push('identity');
  if (/cron|skill|infrastructure|deploy/i.test(t)) topics.push('infrastructure');
  
  return topics;
}

// ─── Promotion Logic ────────────────────────────────────────────────────────

function checkIfInMemory(text: string, memoryContent: string): boolean {
  // Fuzzy match: check if key phrases from text appear in MEMORY.md
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const normalizedText = normalize(text);
  const normalizedMemory = normalize(memoryContent);
  
  const words = normalizedText.split(' ').filter(w => w.length >= 4);
  if (words.length === 0) return false;
  
  const matchCount = words.filter(w => normalizedMemory.includes(w)).length;
  return (matchCount / words.length) >= 0.7;
}

function promoteToMemory(items: ContentItem[], dryRun: boolean): { promoted: string[]; skipped: string[] } {
  const memoryContent = readFileIfExists(MEMORY_FILE) || '';
  const promoted: string[] = [];
  const skipped: string[] = [];
  
  // Only promote high-importance items
  const candidates = items
    .filter(i => i.importance >= 0.8)
    .sort((a, b) => b.importance - a.importance);
  
  for (const item of candidates) {
    if (checkIfInMemory(item.text, memoryContent)) {
      skipped.push(`[dedup] ${item.text.substring(0, 60)}...`);
      continue;
    }
    
    promoted.push(item.text);
    
    if (!dryRun) {
      // Append to MEMORY.md at the end (before any trailing section)
      const timestamp = getToday();
      const entry = `- **[${timestamp}]** ${item.text}\n`;
      
      // Find the right section to append to, or create one
      if (memoryContent.includes('## Recent Learnings')) {
        const idx = memoryContent.indexOf('## Recent Learnings');
        const nextSection = memoryContent.indexOf('\n## ', idx + 20);
        const insertPoint = nextSection === -1 ? memoryContent.length : nextSection;
        const before = memoryContent.substring(0, insertPoint).trimEnd();
        const after = memoryContent.substring(insertPoint);
        fs.writeFileSync(MEMORY_FILE, before + '\n' + entry + after);
      } else {
        fs.writeFileSync(MEMORY_FILE, memoryContent.trimEnd() + '\n\n## Recent Learnings\n\n' + entry);
      }
    }
  }
  
  return { promoted, skipped };
}

// ─── Daily Summary ──────────────────────────────────────────────────────────

function generateDailySummary(date: string): string {
  const dailyFile = path.join(DAILY_DIR, `${date}.md`);
  const content = readFileIfExists(dailyFile);
  
  if (!content) return `No daily file found for ${date}`;
  
  const items = analyzeDaily(content, date);
  
  let summary = `## Summary for ${date}\n\n`;
  
  const decisions = items.filter(i => i.type === 'decision');
  const events = items.filter(i => i.type === 'event');
  const insights = items.filter(i => i.type === 'insight');
  const quotes = items.filter(i => i.type === 'quote');
  
  if (decisions.length > 0) {
    summary += `### Decisions (${decisions.length})\n`;
    decisions.forEach(d => summary += `- ${d.text}\n`);
    summary += '\n';
  }
  
  if (events.length > 0) {
    summary += `### Key Events (${events.length})\n`;
    events.forEach(e => summary += `- ${e.text}\n`);
    summary += '\n';
  }
  
  if (insights.length > 0) {
    summary += `### Insights (${insights.length})\n`;
    insights.forEach(i => summary += `- ${i.text}\n`);
    summary += '\n';
  }
  
  if (quotes.length > 0) {
    summary += `### Key Quotes (${quotes.length})\n`;
    quotes.forEach(q => summary += `- ${q.text}\n`);
    summary += '\n';
  }
  
  // Topic distribution
  const topicCounts: Record<string, number> = {};
  items.forEach(i => i.topics.forEach(t => topicCounts[t] = (topicCounts[t] || 0) + 1));
  
  if (Object.keys(topicCounts).length > 0) {
    summary += `### Topics\n`;
    Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([topic, count]) => summary += `- ${topic}: ${count} mentions\n`);
  }
  
  return summary;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--check');
  const dailySummary = args.includes('--daily-summary');
  const promoteText = args.includes('--promote') ? args[args.indexOf('--promote') + 1] : null;
  
  if (dailySummary) {
    const date = args[args.indexOf('--daily-summary') + 1] || getToday();
    console.log(generateDailySummary(date));
    return;
  }
  
  if (promoteText) {
    const memoryContent = readFileIfExists(MEMORY_FILE) || '';
    if (checkIfInMemory(promoteText, memoryContent)) {
      console.log('⏭️  Already in MEMORY.md (dedup)');
    } else {
      const entry = `- **[${getToday()}]** ${promoteText}\n`;
      if (memoryContent.includes('## Recent Learnings')) {
        const idx = memoryContent.indexOf('## Recent Learnings');
        const nextSection = memoryContent.indexOf('\n## ', idx + 20);
        const insertPoint = nextSection === -1 ? memoryContent.length : nextSection;
        const before = memoryContent.substring(0, insertPoint).trimEnd();
        const after = memoryContent.substring(insertPoint);
        fs.writeFileSync(MEMORY_FILE, before + '\n' + entry + after);
      } else {
        fs.writeFileSync(MEMORY_FILE, memoryContent.trimEnd() + '\n\n## Recent Learnings\n\n' + entry);
      }
      console.log('✅ Promoted to MEMORY.md');
    }
    return;
  }
  
  // Full digest cycle
  console.log('🧠 MEMORY DIGEST');
  console.log('═══════════════════════════════════════');
  console.log(dryRun ? '   MODE: Dry run (no changes)' : '   MODE: Live');
  console.log('');
  
  // Analyze recent days
  const recentDays = getRecentDays(3);
  const allItems: ContentItem[] = [];
  
  for (const date of recentDays) {
    const dailyFile = path.join(DAILY_DIR, `${date}.md`);
    const content = readFileIfExists(dailyFile);
    if (content) {
      const items = analyzeDaily(content, date);
      allItems.push(...items);
      console.log(`📅 ${date}: ${items.length} items found`);
    }
  }
  
  console.log(`\n📊 Total: ${allItems.length} items across ${recentDays.length} days`);
  console.log('');
  
  // Promote high-importance items to MEMORY.md
  const { promoted, skipped } = promoteToMemory(allItems, dryRun);
  
  if (promoted.length > 0) {
    console.log(`✅ ${dryRun ? 'Would promote' : 'Promoted'} ${promoted.length} items to MEMORY.md:`);
    promoted.forEach(p => console.log(`   + ${p.substring(0, 80)}...`));
  }
  
  if (skipped.length > 0) {
    console.log(`\n⏭️  Skipped ${skipped.length} items (already in MEMORY.md)`);
  }
  
  if (promoted.length === 0 && skipped.length === 0) {
    console.log('ℹ️  No high-importance items found to promote');
  }
  
  console.log('\n═══════════════════════════════════════');
  console.log('🧠 DIGEST COMPLETE');
}

main().catch(e => {
  console.error('❌ Digest failed:', e.message);
  process.exit(1);
});
