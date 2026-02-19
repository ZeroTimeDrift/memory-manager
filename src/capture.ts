#!/usr/bin/env npx ts-node

/**
 * Conversation Capture — Extract and file structured information from sessions
 * 
 * The agent distills conversation into structured notes, then pipes them here.
 * This script parses the input and files items to the correct locations.
 * 
 * Input format (stdin or args): Free-form text with optional section markers:
 *   DECISION: <text>        → appended to daily log
 *   FACT: <text>            → added to MEMORY.md Quick Reference (if new)
 *   TASK: <text>            → added to task queue via task.ts
 *   TOPIC:<name>: <text>    → appended to memory/topics/<name>.md
 *   PERSON:<name>: <text>   → appended to contacts.md
 *   QUOTE: <text>           → preserved in daily log
 *   <anything else>         → treated as general session notes → daily log
 * 
 * Usage:
 *   echo "DECISION: Use Opus 4.6 for main sessions" | npx ts-node src/capture.ts
 *   echo "FACT: Hevar timezone is Asia/Dubai" | npx ts-node src/capture.ts
 *   npx ts-node src/capture.ts "DECISION: Ship on Friday\nTASK: Update deploy script"
 *   npx ts-node src/capture.ts --raw "Just some general notes about the session"
 *   npx ts-node src/capture.ts --score "Unstructured text scored for importance"
 *   npx ts-node src/capture.ts --score --threshold 0.4 "Only capture if score >= 0.4"
 */

import * as fs from 'fs';
import * as path from 'path';
import { scoreImportance, type ImportanceResult } from './importance';
import { checkDuplicate } from './dedup';

const WORKSPACE = '/root/clawd';
const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md');
const DAILY_DIR = path.join(WORKSPACE, 'memory', 'daily');
const TOPICS_DIR = path.join(WORKSPACE, 'memory', 'topics');
const CONTACTS_FILE = path.join(WORKSPACE, 'memory', 'people', 'contacts.md');
const MANIFEST_PATH = path.join(WORKSPACE, 'skills', 'memory-manager', 'manifest.json');

// ─── Types ──────────────────────────────────────────────────────────────────

interface CapturedItem {
  type: 'decision' | 'fact' | 'task' | 'topic' | 'person' | 'quote' | 'note' | 'preference' | 'reaction';
  content: string;
  target?: string; // topic name or person name
}

interface CaptureResult {
  decisions: string[];
  facts: string[];
  tasks: string[];
  topics: Map<string, string[]>;
  people: Map<string, string[]>;
  quotes: string[];
  notes: string[];
  preferences: string[];
  reactions: string[];
  filed: string[];    // summary of where things were filed
  skipped: string[];  // items that were deduped
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function parseInput(input: string): CapturedItem[] {
  const items: CapturedItem[] = [];
  const lines = input.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  for (const line of lines) {
    // Try to match structured prefixes
    const decisionMatch = line.match(/^DECISION:\s*(.+)/i);
    const factMatch = line.match(/^FACT:\s*(.+)/i);
    const taskMatch = line.match(/^TASK:\s*(.+)/i);
    const topicMatch = line.match(/^TOPIC:(\w[\w-]*):\s*(.+)/i);
    const personMatch = line.match(/^PERSON:(\w[\w\s-]*):\s*(.+)/i);
    const quoteMatch = line.match(/^QUOTE:\s*(.+)/i);
    const preferenceMatch = line.match(/^PREFERENCE:\s*(.+)/i);
    const reactionMatch = line.match(/^REACTION:\s*(.+)/i);

    if (decisionMatch) {
      items.push({ type: 'decision', content: decisionMatch[1].trim() });
    } else if (factMatch) {
      items.push({ type: 'fact', content: factMatch[1].trim() });
    } else if (taskMatch) {
      items.push({ type: 'task', content: taskMatch[1].trim() });
    } else if (topicMatch) {
      items.push({ type: 'topic', content: topicMatch[2].trim(), target: topicMatch[1].trim().toLowerCase() });
    } else if (personMatch) {
      items.push({ type: 'person', content: personMatch[2].trim(), target: personMatch[1].trim() });
    } else if (quoteMatch) {
      items.push({ type: 'quote', content: quoteMatch[1].trim() });
    } else if (preferenceMatch) {
      items.push({ type: 'preference', content: preferenceMatch[1].trim() });
    } else if (reactionMatch) {
      items.push({ type: 'reaction', content: reactionMatch[1].trim() });
    } else {
      // Unstructured — treat as general note
      items.push({ type: 'note', content: line });
    }
  }

  return items;
}

// ─── Dedup (Semantic) ───────────────────────────────────────────────────────

/**
 * Check if content is a duplicate using multi-signal similarity.
 * Checks MEMORY.md, recent daily files, and topic files.
 * Returns { isDupe, isWarning, matchInfo }
 */
function semanticDedupCheck(content: string): { isDupe: boolean; isWarning: boolean; matchInfo: string } {
  const result = checkDuplicate(content);
  
  if (result.isDuplicate) {
    const m = result.bestMatch!;
    return {
      isDupe: true,
      isWarning: false,
      matchInfo: `${(m.similarity * 100).toFixed(0)}% match in ${m.source}: "${m.text.substring(0, 50)}..."`,
    };
  }
  
  if (result.isWarning) {
    const m = result.bestMatch!;
    return {
      isDupe: false,
      isWarning: true,
      matchInfo: `${(m.similarity * 100).toFixed(0)}% possible match in ${m.source}: "${m.text.substring(0, 50)}..."`,
    };
  }
  
  return { isDupe: false, isWarning: false, matchInfo: '' };
}

// ─── Filing Functions ───────────────────────────────────────────────────────

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function getTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', { 
    hour: '2-digit', minute: '2-digit', 
    hour12: false, timeZone: 'Asia/Dubai' 
  });
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureDailyFile(): string {
  ensureDir(DAILY_DIR);
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

function appendToDaily(section: string, content: string): void {
  const dailyFile = ensureDailyFile();
  const existing = fs.readFileSync(dailyFile, 'utf-8');
  const timestamp = getTimestamp();
  
  // Check if the section header already exists
  const sectionHeader = `## ${section}`;
  if (existing.includes(sectionHeader)) {
    // Append under existing section
    const sectionIndex = existing.indexOf(sectionHeader);
    const nextSectionIndex = existing.indexOf('\n## ', sectionIndex + sectionHeader.length);
    
    const insertPoint = nextSectionIndex === -1 ? existing.length : nextSectionIndex;
    const before = existing.substring(0, insertPoint).trimEnd();
    const after = nextSectionIndex === -1 ? '' : existing.substring(nextSectionIndex);
    
    fs.writeFileSync(dailyFile, before + '\n' + content + '\n' + after);
  } else {
    // Add new section at end
    fs.writeFileSync(dailyFile, existing.trimEnd() + '\n\n' + sectionHeader + '\n\n' + content + '\n');
  }
}

function appendToMemory(fact: string): void {
  if (!fs.existsSync(MEMORY_FILE)) return;
  
  const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
  
  // Find the Quick Reference section and append there
  const qrMarker = '## Quick Reference';
  const qrIndex = content.indexOf(qrMarker);
  
  if (qrIndex !== -1) {
    // Find the end of the Quick Reference section (next ## or end of file)
    const nextSection = content.indexOf('\n## ', qrIndex + qrMarker.length);
    const insertPoint = nextSection === -1 ? content.length : nextSection;
    
    const before = content.substring(0, insertPoint).trimEnd();
    const after = nextSection === -1 ? '' : content.substring(nextSection);
    
    fs.writeFileSync(MEMORY_FILE, before + '\n- ' + fact + '\n' + after);
  } else {
    // No Quick Reference section — append at end
    fs.writeFileSync(MEMORY_FILE, content.trimEnd() + '\n\n- ' + fact + '\n');
  }
}

function appendToTopic(topicName: string, content: string): void {
  ensureDir(TOPICS_DIR);
  const topicFile = path.join(TOPICS_DIR, `${topicName}.md`);
  const timestamp = getTimestamp();
  const today = getToday();
  
  if (!fs.existsSync(topicFile)) {
    // Create new topic file
    fs.writeFileSync(topicFile, `# ${topicName}\n\n## Notes\n\n### ${today} ${timestamp}\n- ${content}\n`);
  } else {
    const existing = fs.readFileSync(topicFile, 'utf-8');
    fs.writeFileSync(topicFile, existing.trimEnd() + `\n\n### ${today} ${timestamp}\n- ${content}\n`);
  }
}

function appendToContacts(personName: string, info: string): void {
  if (!fs.existsSync(CONTACTS_FILE)) {
    ensureDir(path.dirname(CONTACTS_FILE));
    fs.writeFileSync(CONTACTS_FILE, `---\ntitle: Key Contacts\nupdated: ${getToday()}\n---\n\n# Key Contacts\n\n`);
  }
  
  const content = fs.readFileSync(CONTACTS_FILE, 'utf-8');
  
  // Check if person section exists (case-insensitive)
  const personRegex = new RegExp(`^### ${personName}`, 'im');
  const personMatch = content.match(personRegex);
  
  if (personMatch) {
    // Find the person's section and append the new info
    const personIndex = content.indexOf(personMatch[0]);
    const nextPersonIndex = content.indexOf('\n### ', personIndex + personMatch[0].length);
    const nextSectionIndex = content.indexOf('\n## ', personIndex + personMatch[0].length);
    const insertPoint = Math.min(
      nextPersonIndex === -1 ? content.length : nextPersonIndex,
      nextSectionIndex === -1 ? content.length : nextSectionIndex
    );
    
    const before = content.substring(0, insertPoint).trimEnd();
    const after = content.substring(insertPoint);
    
    fs.writeFileSync(CONTACTS_FILE, before + `\n- **Update (${getToday()}):** ` + info + '\n' + after);
  } else {
    // Add new person at end
    fs.writeFileSync(CONTACTS_FILE, content.trimEnd() + `\n\n### ${personName}\n- ${info}\n`);
  }
  
  // Update the "updated" date in frontmatter
  const updatedContent = fs.readFileSync(CONTACTS_FILE, 'utf-8');
  fs.writeFileSync(CONTACTS_FILE, updatedContent.replace(/^updated:.*$/m, `updated: ${getToday()}`));
}

function appendToHevarProfile(type: 'preference' | 'reaction', content: string): void {
  const profilePath = path.join(WORKSPACE, 'memory', 'people', 'hevar-profile.md');
  const timestamp = getTimestamp();
  const today = getToday();
  
  if (!fs.existsSync(profilePath)) {
    ensureDir(path.dirname(profilePath));
    fs.writeFileSync(profilePath, `---
title: Hevar — Personal Context
updated: ${today}
description: Preferences, reactions, emotional signals — who Hevar IS, not just what he wants done
---

# Hevar — Personal Context

This file captures who Hevar is as a person: preferences, reactions, frustrations, excitement, opinions.
Not operational rules — those go in MEMORY.md. This is about understanding the human.

## Preferences

## Reactions & Emotions

## Communication Style

## Opinions

`);
  }
  
  const existing = fs.readFileSync(profilePath, 'utf-8');
  const sectionMap: Record<string, string> = {
    'preference': '## Preferences',
    'reaction': '## Reactions & Emotions',
  };
  
  const sectionHeader = sectionMap[type];
  const entry = `- [${today} ${timestamp}] ${content}`;
  
  if (existing.includes(sectionHeader)) {
    const idx = existing.indexOf(sectionHeader);
    const nextSection = existing.indexOf('\n## ', idx + sectionHeader.length);
    const insertPoint = nextSection === -1 ? existing.length : nextSection;
    const before = existing.substring(0, insertPoint).trimEnd();
    const after = existing.substring(insertPoint);
    fs.writeFileSync(profilePath, before + '\n' + entry + '\n' + after);
  } else {
    fs.writeFileSync(profilePath, existing.trimEnd() + '\n\n' + sectionHeader + '\n\n' + entry + '\n');
  }
  
  // Update frontmatter date
  const updated = fs.readFileSync(profilePath, 'utf-8');
  fs.writeFileSync(profilePath, updated.replace(/^updated:.*$/m, `updated: ${today}`));
}

function addTask(taskText: string): void {
  // Parse task text — may include context after a pipe or dash
  const parts = taskText.split(/\s*[|—]\s*/);
  const task = parts[0].trim();
  const context = parts.length > 1 ? parts.slice(1).join(' ').trim() : '';
  
  try {
    // Load manifest directly and add task
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    
    manifest.taskQueue.push({
      task,
      context,
      priority: 2,
      category: inferCategory(task),
      impact: 'medium',
      tags: [inferCategory(task)],
      createdAt: new Date().toISOString(),
      skipCount: 0,
      source: 'conversation-capture'
    });
    
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  } catch (e) {
    console.error(`   ⚠️  Failed to add task: ${(e as Error).message}`);
  }
}

// Simple category inference (matches prioritize.ts logic)
function inferCategory(text: string): string {
  const t = text.toLowerCase();
  if (/memory|boot|survival|core|identity/.test(t)) return 'survival';
  if (/organiz|consolidat|index|weight/.test(t)) return 'memory';
  if (/build|skill|tool|infra|deploy/.test(t)) return 'infrastructure';
  if (/research|investigat|analyz|scout/.test(t)) return 'research';
  if (/clean|refactor|fix|minor/.test(t)) return 'maintenance';
  if (/nice|cool|optional|wish/.test(t)) return 'nice-to-have';
  return 'expansion';
}

// ─── Main Capture Logic ─────────────────────────────────────────────────────

function capture(input: string): CaptureResult {
  const result: CaptureResult = {
    decisions: [], facts: [], tasks: [],
    topics: new Map(), people: new Map(),
    quotes: [], notes: [], preferences: [], reactions: [],
    filed: [], skipped: []
  };

  const items = parseInput(input);
  const timestamp = getTimestamp();
  const today = getToday();

  if (items.length === 0) {
    console.log('⚠️  No input to capture.');
    return result;
  }

  console.log(`📥 CAPTURING ${items.length} items...`);
  console.log('');

  for (const item of items) {
    // Run semantic dedup for all substantive types
    const dedupTypes = new Set(['decision', 'fact', 'topic', 'note', 'preference', 'reaction']);
    if (dedupTypes.has(item.type) && item.content.length >= 20) {
      const dedup = semanticDedupCheck(item.content);
      if (dedup.isDupe) {
        result.skipped.push(`🔄 ${item.type.toUpperCase()} duplicate (${dedup.matchInfo})`);
        continue; // Skip this item entirely
      }
      if (dedup.isWarning) {
        // Log warning but still capture (moderate matches may be different enough)
        result.filed.push(`⚠️  ${item.type}: possible dupe — ${dedup.matchInfo}`);
      }
    }

    switch (item.type) {
      case 'decision':
        result.decisions.push(item.content);
        appendToDaily('Decisions', `- [${timestamp}] ${item.content}`);
        result.filed.push(`📋 Decision → daily/${today}.md`);
        break;

      case 'fact':
        result.facts.push(item.content);
        appendToMemory(item.content);
        result.filed.push(`🧠 Fact → MEMORY.md`);
        break;

      case 'task':
        result.tasks.push(item.content);
        addTask(item.content);
        result.filed.push(`✅ Task → task queue`);
        break;

      case 'topic':
        const topicName = item.target!;
        if (!result.topics.has(topicName)) result.topics.set(topicName, []);
        result.topics.get(topicName)!.push(item.content);
        appendToTopic(topicName, item.content);
        result.filed.push(`📁 Topic → topics/${topicName}.md`);
        break;

      case 'person':
        const personName = item.target!;
        if (!result.people.has(personName)) result.people.set(personName, []);
        result.people.get(personName)!.push(item.content);
        appendToContacts(personName, item.content);
        result.filed.push(`👤 Person → contacts.md (${personName})`);
        break;

      case 'quote':
        result.quotes.push(item.content);
        appendToDaily('Key Quotes', `- [${timestamp}] > "${item.content}"`);
        result.filed.push(`💬 Quote → daily/${today}.md`);
        break;

      case 'preference':
        result.preferences.push(item.content);
        appendToHevarProfile('preference', item.content);
        result.filed.push(`💡 Preference → memory/people/hevar-profile.md`);
        break;

      case 'reaction':
        result.reactions.push(item.content);
        appendToHevarProfile('reaction', item.content);
        result.filed.push(`😊 Reaction → memory/people/hevar-profile.md`);
        break;

      case 'note':
        result.notes.push(item.content);
        // Notes are batched and written together below
        break;
    }
  }

  // Write batched notes to daily log
  if (result.notes.length > 0) {
    const notesBlock = result.notes.map(n => `- ${n}`).join('\n');
    appendToDaily(`Capture — ${timestamp}`, notesBlock);
    result.filed.push(`📝 ${result.notes.length} notes → daily/${today}.md`);
  }

  return result;
}

function printResult(result: CaptureResult): void {
  console.log('─────────────────────────────────────────');
  console.log('📦 CAPTURE COMPLETE');
  console.log('─────────────────────────────────────────');
  
  if (result.filed.length > 0) {
    console.log('\n✅ Filed:');
    result.filed.forEach(f => console.log(`   ${f}`));
  }
  
  if (result.skipped.length > 0) {
    console.log('\n⏭️  Skipped (dedup):');
    result.skipped.forEach(s => console.log(`   ${s}`));
  }
  
  const total = result.decisions.length + result.facts.length + result.tasks.length + 
    result.quotes.length + result.notes.length + result.preferences.length + result.reactions.length +
    Array.from(result.topics.values()).reduce((a, b) => a + b.length, 0) +
    Array.from(result.people.values()).reduce((a, b) => a + b.length, 0);
  
  console.log(`\n📊 Total: ${total} items captured, ${result.skipped.length} deduped`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let input = '';

  // Check for arg input first
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const isRaw = process.argv.includes('--raw');

  if (args.length > 0) {
    input = args.join(' ');
  } else {
    // Read from stdin
    input = await new Promise<string>((resolve) => {
      let data = '';
      
      if (process.stdin.isTTY) {
        console.log('⌨️  Enter capture notes (Ctrl+D to finish):');
      }
      
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { resolve(data); });
      
      // Timeout after 5s if no stdin (non-interactive mode)
      setTimeout(() => {
        if (data.length === 0) {
          resolve('');
        }
      }, 5000);
    });
  }

  input = input.trim();
  
  if (!input) {
    console.log('⚠️  No input provided.');
    console.log('');
    console.log('Usage:');
    console.log('  echo "DECISION: Use Opus 4.6" | npx ts-node src/capture.ts');
    console.log('  npx ts-node src/capture.ts "FACT: Key is AIza..."');
    console.log('  npx ts-node src/capture.ts --raw "General session notes"');
    process.exit(1);
  }

  // --score mode: run importance scoring on unstructured text
  const isScore = process.argv.includes('--score');
  const thresholdArg = process.argv.find(a => a.startsWith('--threshold'));
  const threshold = thresholdArg ? parseFloat(thresholdArg.split('=')[1] || process.argv[process.argv.indexOf(thresholdArg) + 1] || '0.3') : 0.3;

  if (isScore) {
    // Score each line and auto-classify based on importance
    const lines = input.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const scored: string[] = [];
    const dropped: string[] = [];

    for (const line of lines) {
      // Skip lines that already have structured prefixes — pass through as-is
      if (/^(DECISION|FACT|TASK|TOPIC|PERSON|QUOTE|PREFERENCE|REACTION):/i.test(line)) {
        scored.push(line);
        continue;
      }

      const result = scoreImportance(line);
      if (result.score < threshold) {
        dropped.push(`   ⬛ ${result.score.toFixed(2)} "${line.substring(0, 50)}${line.length > 50 ? '...' : ''}"`);
        continue;
      }

      // Auto-classify based on suggested type
      const typeMap: Record<string, string> = {
        'decision': 'DECISION',
        'fact': 'FACT',
        'preference': 'PREFERENCE',
        'reaction': 'REACTION',
        'task': 'TASK',
        'quote': 'QUOTE',
      };

      const prefix = typeMap[result.suggestedType];
      if (prefix && result.score >= 0.5) {
        scored.push(`${prefix}: ${line}`);
      } else {
        scored.push(line); // Keep as general note
      }
    }

    if (dropped.length > 0) {
      console.log(`⏭️  Filtered out ${dropped.length} low-importance items (threshold ${threshold}):`);
      dropped.forEach(d => console.log(d));
      console.log('');
    }

    if (scored.length === 0) {
      console.log('📊 All items below threshold — nothing to capture.');
      process.exit(0);
    }

    input = scored.join('\n');
  }

  // If --raw flag, treat everything as notes
  if (isRaw) {
    input = input.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n');
    // Don't add prefixes — parseInput will treat unprefixed lines as notes
  }

  const result = capture(input);
  printResult(result);
}

main().catch(e => {
  console.error('❌ Capture failed:', e.message);
  process.exit(1);
});
