#!/usr/bin/env npx ts-node

/**
 * Context Briefing Generator
 * 
 * Given a topic, question, or upcoming task, assembles a concise briefing
 * from multiple memory sources. Unlike smart-search (returns ranked snippets),
 * this produces a structured document organized by relevance and recency.
 * 
 * Use cases:
 *   - "Brief me on MoonGate" → pulls company context, recent activity, decisions
 *   - "Brief me on the DeFi strategy" → portfolio state, recent changes, open issues
 *   - "What do I need to know about Moltbook?" → observations, mission, activity
 *   - "Prepare context for a meeting with Tom" → person context + recent interactions
 * 
 * Architecture:
 *   1. Smart-search to find relevant chunks (temporal + semantic + concept + expansion)
 *   2. Memory-graph context expansion for related files
 *   3. Group results by file/topic (not raw rank)
 *   4. Extract and order: core facts → recent activity → decisions → open items
 *   5. Render as a structured markdown briefing
 * 
 * Output: markdown briefing document (printed to stdout, optionally saved)
 * 
 * Usage:
 *   npx ts-node src/briefing.ts "MoonGate"
 *   npx ts-node src/briefing.ts "DeFi strategy" --save
 *   npx ts-node src/briefing.ts "meeting with Tom Noakes" --save --file briefing-tom.md
 *   npx ts-node src/briefing.ts --list                # List recent briefings
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

const { DatabaseSync } = require('node:sqlite');
const DB_PATH = path.join(process.env.HOME || '/root', '.clawdbot/memory/main.sqlite');

const WORKSPACE = '/root/clawd';
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const SKILL_DIR = path.join(WORKSPACE, 'skills/memory-manager');
const BRIEFINGS_DIR = path.join(SKILL_DIR, 'briefings');
const MANIFEST_PATH = path.join(SKILL_DIR, 'manifest.json');
const CONCEPT_INDEX_PATH = path.join(SKILL_DIR, 'concept-index.json');
const GRAPH_PATH = path.join(SKILL_DIR, 'memory-graph.json');

// ─── Types ──────────────────────────────────────────────────────────────────

interface BriefingSection {
  heading: string;
  items: BriefingItem[];
  priority: number;   // lower = higher priority (rendered first)
}

interface BriefingItem {
  text: string;
  source: string;      // file path
  date?: string;       // YYYY-MM-DD if temporal
  type: 'fact' | 'decision' | 'event' | 'insight' | 'open' | 'context';
  relevance: number;   // 0-1
}

interface ChunkResult {
  path: string;
  text: string;
  rank: number;
  source: string;
}

// ─── Search Layer ───────────────────────────────────────────────────────────

/**
 * Multi-strategy search: BM25 + temporal file routing + concept index lookup
 * Simplified from smart-search.ts — we just need ranked chunks, not full RRF
 */
function searchChunks(query: string, limit: number = 30): ChunkResult[] {
  const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  const results: ChunkResult[] = [];
  const seenTexts = new Set<string>();

  // Strategy 1: BM25 keyword search
  const tokens = query.match(/[A-Za-z0-9_]+/g)?.filter(t => t.length > 2) ?? [];
  const stopwords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what',
    'how', 'was', 'were', 'are', 'has', 'had', 'have', 'been', 'about', 'need',
    'know', 'brief', 'prepare', 'context', 'meeting', 'tell', 'give', 'update']);
  const cleanTokens = tokens.filter(t => !stopwords.has(t.toLowerCase()));

  if (cleanTokens.length > 0) {
    const ftsQuery = cleanTokens.map(t => `"${t}"`).join(' OR ');
    try {
      const rows = db.prepare(
        `SELECT path, source, bm25(chunks_fts) AS rank, text
         FROM chunks_fts
         WHERE chunks_fts MATCH ? AND source='memory'
         ORDER BY rank ASC
         LIMIT ?`
      ).all(ftsQuery, limit * 2);

      for (const row of rows) {
        const key = row.text?.substring(0, 80);
        if (seenTexts.has(key)) continue;
        seenTexts.add(key);
        results.push({
          path: row.path,
          text: row.text || '',
          rank: row.rank,
          source: 'bm25',
        });
      }
    } catch {}
  }

  // Strategy 2: Concept index — direct file lookup for known entities
  // Only pull chunks from concept-matched files that actually contain the topic keywords
  try {
    const conceptIndex = JSON.parse(fs.readFileSync(CONCEPT_INDEX_PATH, 'utf-8'));
    const queryLower = query.toLowerCase();
    const queryTokens = cleanTokens.map(t => t.toLowerCase());

    for (const [entity, files] of Object.entries(conceptIndex)) {
      if (queryLower.includes(entity.toLowerCase())) {
        for (const filePath of (files as string[])) {
          try {
            const fileChunks = db.prepare(
              `SELECT path, source, text FROM chunks WHERE path = ? AND source='memory' ORDER BY start_line ASC`
            ).all(filePath);

            for (const chunk of fileChunks) {
              const key = chunk.text?.substring(0, 80);
              if (seenTexts.has(key)) continue;
              
              // Check chunk actually contains query-relevant content
              const chunkLower = (chunk.text || '').toLowerCase();
              const tokenHits = queryTokens.filter(t => chunkLower.includes(t)).length;
              if (queryTokens.length > 0 && tokenHits === 0) continue; // skip irrelevant chunks
              
              seenTexts.add(key);
              // Score based on how many query tokens hit
              const conceptRank = -50 * (tokenHits / Math.max(queryTokens.length, 1));
              results.push({
                path: chunk.path,
                text: chunk.text || '',
                rank: conceptRank,
                source: 'concept',
              });
            }
          } catch {}
        }
      }
    }
  } catch {}

  // Strategy 3: Graph-based context expansion
  try {
    if (fs.existsSync(GRAPH_PATH)) {
      const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
      // Find files already in results
      const hitFiles = new Set(results.map(r => r.path));
      const neighborFiles = new Set<string>();

      for (const edge of (graph.edges || [])) {
        if (hitFiles.has(edge.source) && !hitFiles.has(edge.target) && edge.weight > 0.3) {
          neighborFiles.add(edge.target);
        }
        if (hitFiles.has(edge.target) && !hitFiles.has(edge.source) && edge.weight > 0.3) {
          neighborFiles.add(edge.source);
        }
      }

      // Add top neighbor chunks (lower priority)
      for (const nf of [...neighborFiles].slice(0, 5)) {
        try {
          const fileChunks = db.prepare(
            `SELECT path, source, text FROM chunks WHERE path = ? AND source='memory' ORDER BY start_line ASC LIMIT 3`
          ).all(nf);

          for (const chunk of fileChunks) {
            const key = chunk.text?.substring(0, 80);
            if (seenTexts.has(key)) continue;
            seenTexts.add(key);
            results.push({
              path: chunk.path,
              text: chunk.text || '',
              rank: 10, // neighbors are supplementary
              source: 'graph',
            });
          }
        } catch {}
      }
    }
  } catch {}

  db.close();

  // Sort by rank (lower = better for BM25)
  results.sort((a, b) => a.rank - b.rank);
  return results.slice(0, limit);
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Classify a text chunk into a briefing item type
 */
function classifyChunk(text: string): BriefingItem['type'] {
  const lower = text.toLowerCase();

  if (/\b(decided|decision|chose|going with|switched to|will use|pivoted)\b/.test(lower)) {
    return 'decision';
  }
  if (/\b(built|created|shipped|launched|deployed|completed|established|published)\b/.test(lower)) {
    return 'event';
  }
  if (/\b(learned|realized|insight|lesson|takeaway|anti-pattern|key finding)\b/.test(lower)) {
    return 'insight';
  }
  if (/\b(todo|pending|blocked|need to|open problem|unresolved|next step)\b/.test(lower)) {
    return 'open';
  }
  // Check if it looks like a factual/definitional statement
  if (/\b(is a|are the|was the|defined as|refers to|means|consists of)\b/.test(lower)) {
    return 'fact';
  }
  return 'context';
}

/**
 * Check if a chunk is actually relevant to the topic (not just a tangential BM25 hit)
 * Returns a relevance score 0-1
 * 
 * Strategy: requires the most distinctive token to be present,
 * then scores by overall coverage. Generic words ("strategy", "system", "work")
 * alone don't count.
 */
function topicRelevance(text: string, topic: string): number {
  const genericWords = new Set([
    'strategy', 'system', 'work', 'project', 'update', 'status', 'plan',
    'current', 'recent', 'overview', 'summary', 'context', 'setup',
    'progress', 'notes', 'meeting', 'review', 'analysis', 'report',
  ]);
  
  const topicTokens = topic.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const textLower = text.toLowerCase();
  
  if (topicTokens.length === 0) return 0.5;
  
  // Separate distinctive tokens from generic ones
  const distinctive = topicTokens.filter(t => !genericWords.has(t));
  const generic = topicTokens.filter(t => genericWords.has(t));
  
  // If we have distinctive tokens, at least one MUST be present
  if (distinctive.length > 0) {
    const hasDistinctive = distinctive.some(t => textLower.includes(t));
    if (!hasDistinctive) return 0; // hard fail — no distinctive match
  }
  
  // Score by total coverage
  let matches = 0;
  for (const token of topicTokens) {
    if (textLower.includes(token)) matches++;
  }
  
  return matches / topicTokens.length;
}

/**
 * Strip frontmatter and metadata noise from chunk text
 */
function cleanChunkText(text: string): string {
  return text
    // Strip YAML frontmatter blocks
    .replace(/^---\n[\s\S]*?\n---\n?/m, '')
    // Strip lines that are just frontmatter-like key-value
    .replace(/^(date|tags|mood|status|week|year|date-range|day|updated|title):.*$/gm, '')
    // Strip search context comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Collapse excessive whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract a date from a file path if it's a daily/weekly file
 */
function extractDate(filePath: string): string | undefined {
  const dailyMatch = filePath.match(/(\d{4}-\d{2}-\d{2})\.md/);
  if (dailyMatch) return dailyMatch[1];
  const weeklyMatch = filePath.match(/(\d{4}-W\d{2})\.md/);
  if (weeklyMatch) return weeklyMatch[1];
  return undefined;
}

/**
 * Get the relative file label for display
 */
function fileLabel(filePath: string): string {
  // Convert to relative path
  const rel = filePath.replace(/^(memory\/|\/root\/clawd\/)/, '');
  // Shorten common prefixes
  return rel
    .replace('daily/', '📅 ')
    .replace('weekly/', '📆 ')
    .replace('topics/', '📚 ')
    .replace('people/', '👤 ')
    .replace('moltbook/', '🔬 ');
}

// ─── Briefing Assembly ──────────────────────────────────────────────────────

interface Briefing {
  topic: string;
  generated: string;   // ISO timestamp
  sections: BriefingSection[];
  sources: string[];   // unique file paths used
  stats: {
    chunksProcessed: number;
    filesReferenced: number;
    searchStrategies: string[];
  };
}

function assembleBriefing(topic: string, chunks: ChunkResult[]): Briefing {
  const items: BriefingItem[] = [];
  const sourceSet = new Set<string>();
  const strategySet = new Set<string>();

  // Pre-pass: identify "primary" files — topic files whose names match the query
  const topicDistinctive = topic.toLowerCase().split(/\W+/).filter(t => 
    t.length > 2 && !new Set(['strategy', 'system', 'work', 'project', 'update',
      'status', 'plan', 'current', 'recent', 'overview', 'summary', 'context']).has(t)
  );
  const primaryFiles = new Set<string>();
  for (const chunk of chunks) {
    const pathLower = chunk.path.toLowerCase();
    if (topicDistinctive.some(t => pathLower.includes(t))) {
      primaryFiles.add(chunk.path);
    }
  }

  for (const [i, chunk] of chunks.entries()) {
    sourceSet.add(chunk.path);
    strategySet.add(chunk.source);

    // Clean the text first (strip frontmatter, metadata)
    const text = cleanChunkText(chunk.text);
    if (text.length < 30) continue; // skip tiny fragments

    // Check topic relevance — filter out tangential hits
    const topicRel = topicRelevance(text, topic);
    if (topicRel < 0.3) continue; // too tangential — applies to ALL sources including concept

    // If from a primary topic file (filename matches query), always classify as 'fact' for core context
    const isPrimaryFile = primaryFiles.has(chunk.path);
    const type = isPrimaryFile ? 'fact' : classifyChunk(text);
    const date = extractDate(chunk.path);

    // Relevance: combine rank position with source boost and topic relevance
    const positionScore = 1 - (i / chunks.length); // 1.0 for first, 0.0 for last
    const sourceBoost = chunk.source === 'concept' ? 0.3 : chunk.source === 'bm25' ? 0.2 : 0.1;
    const primaryBoost = isPrimaryFile ? 0.3 : 0;
    const relevance = Math.min(1.0, positionScore * 0.5 + sourceBoost + topicRel * 0.3 + primaryBoost);

    items.push({
      text: truncateClean(text, 300),
      source: chunk.path,
      date,
      type,
      relevance,
    });
  }

  // Group items into sections
  const sections: BriefingSection[] = [];

  // Section 1: Core Facts (high-relevance facts and context from topic files)
  // Strongly prefer items from files whose name matches the topic
  const topicTokensLower = topic.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const genericWordsSet = new Set([
    'strategy', 'system', 'work', 'project', 'update', 'status', 'plan',
    'current', 'recent', 'overview', 'summary', 'context', 'setup',
  ]);
  const distinctiveTokens = topicTokensLower.filter(t => !genericWordsSet.has(t));
  
  const coreFacts = items.filter(
    i => (i.type === 'fact' || i.type === 'context') &&
         i.relevance > 0.5 &&
         !i.date // prefer non-daily files for core facts
  ).sort((a, b) => {
    // Strong boost for files whose name contains a distinctive topic token
    const aPathLower = a.source.toLowerCase();
    const bPathLower = b.source.toLowerCase();
    const aNameMatch = distinctiveTokens.some(t => aPathLower.includes(t)) ? 2 : 0;
    const bNameMatch = distinctiveTokens.some(t => bPathLower.includes(t)) ? 2 : 0;
    if (bNameMatch !== aNameMatch) return bNameMatch - aNameMatch;
    return b.relevance - a.relevance;
  });
  if (coreFacts.length > 0) {
    // Further filter: if we have filename-matching items, drop the rest from core context
    const nameMatching = coreFacts.filter(i => 
      distinctiveTokens.some(t => i.source.toLowerCase().includes(t))
    );
    const finalCore = nameMatching.length >= 2 ? nameMatching : coreFacts;
    
    sections.push({
      heading: 'Core Context',
      items: dedup(finalCore).slice(0, 6),
      priority: 1,
    });
  }

  // Section 2: Recent Activity (dated items, sorted by recency)
  const recentItems = items
    .filter(i => i.date)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (recentItems.length > 0) {
    sections.push({
      heading: 'Recent Activity',
      items: dedup(recentItems).slice(0, 10),
      priority: 2,
    });
  }

  // Section 3: Key Decisions
  const decisions = items.filter(i => i.type === 'decision');
  if (decisions.length > 0) {
    sections.push({
      heading: 'Decisions',
      items: dedup(decisions).slice(0, 6),
      priority: 3,
    });
  }

  // Section 4: Insights & Lessons
  const insights = items.filter(i => i.type === 'insight');
  if (insights.length > 0) {
    sections.push({
      heading: 'Insights & Lessons',
      items: dedup(insights).slice(0, 5),
      priority: 4,
    });
  }

  // Section 5: Open Items
  const openItems = items.filter(i => i.type === 'open');
  if (openItems.length > 0) {
    sections.push({
      heading: 'Open Items',
      items: dedup(openItems).slice(0, 5),
      priority: 5,
    });
  }

  // Section 6: Related Context (lower relevance, graph neighbors)
  const relatedContext = items.filter(
    i => i.relevance <= 0.5 && i.type === 'context' && !i.date
  );
  if (relatedContext.length > 0) {
    sections.push({
      heading: 'Related Context',
      items: dedup(relatedContext).slice(0, 5),
      priority: 6,
    });
  }

  // Sort sections by priority
  sections.sort((a, b) => a.priority - b.priority);

  return {
    topic,
    generated: new Date().toISOString(),
    sections,
    sources: [...sourceSet],
    stats: {
      chunksProcessed: chunks.length,
      filesReferenced: sourceSet.size,
      searchStrategies: [...strategySet],
    },
  };
}

// ─── Dedup ──────────────────────────────────────────────────────────────────

function dedup(items: BriefingItem[]): BriefingItem[] {
  const kept: BriefingItem[] = [];
  const seenKeys = new Set<string>();

  for (const item of items) {
    const key = item.text.substring(0, 60).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seenKeys.has(key)) continue;

    // Check for high overlap with existing items
    const isDuplicate = kept.some(k => {
      const overlap = tokenOverlap(k.text, item.text);
      return overlap > 0.6;
    });
    if (isDuplicate) continue;

    seenKeys.add(key);
    kept.push(item);
  }
  return kept;
}

function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\W+/).filter(t => t.length > 3));
  const tokensB = new Set(b.toLowerCase().split(/\W+/).filter(t => t.length > 3));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const minSize = Math.min(tokensA.size, tokensB.size);
  return intersection / minSize;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderBriefing(briefing: Briefing): string {
  const { topic, generated, sections, sources, stats } = briefing;
  const genDate = new Date(generated);
  const dateStr = genDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  let md = '';
  md += `# Briefing: ${topic}\n\n`;
  md += `*Generated ${dateStr}*\n`;
  md += `*Sources: ${stats.filesReferenced} files, ${stats.chunksProcessed} chunks, strategies: ${stats.searchStrategies.join(', ')}*\n\n`;
  md += `---\n\n`;

  for (const section of sections) {
    if (section.items.length === 0) continue;
    md += `## ${section.heading}\n\n`;

    for (const item of section.items) {
      const dateTag = item.date ? `**[${item.date}]** ` : '';
      const sourceTag = `*(${fileLabel(item.source)})*`;

      if (item.type === 'open') {
        md += `- ⚠️ ${dateTag}${item.text} ${sourceTag}\n`;
      } else if (item.type === 'decision') {
        md += `- 🔹 ${dateTag}${item.text} ${sourceTag}\n`;
      } else if (item.type === 'insight') {
        md += `- 💡 ${dateTag}${item.text} ${sourceTag}\n`;
      } else if (item.type === 'event') {
        md += `- ✅ ${dateTag}${item.text} ${sourceTag}\n`;
      } else {
        md += `- ${dateTag}${item.text} ${sourceTag}\n`;
      }
    }
    md += '\n';
  }

  // Sources footer
  md += `---\n\n`;
  md += `### Sources\n\n`;
  for (const src of sources.slice(0, 15)) {
    md += `- \`${src}\`\n`;
  }
  if (sources.length > 15) {
    md += `- *(${sources.length - 15} more)*\n`;
  }
  md += '\n';

  return md;
}

function renderConsole(briefing: Briefing): void {
  const { topic, sections, stats } = briefing;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`     📋 BRIEFING: ${topic.toUpperCase()}`);
  console.log(`     ${new Date().toISOString()}`);
  console.log(`     ${stats.filesReferenced} files, ${stats.chunksProcessed} chunks`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  for (const section of sections) {
    if (section.items.length === 0) continue;
    console.log(`── ${section.heading} ──`);
    for (const item of section.items) {
      const dateTag = item.date ? `[${item.date}] ` : '';
      const icon = {
        fact: '  ',
        context: '  ',
        decision: '🔹',
        event: '✅',
        insight: '💡',
        open: '⚠️ ',
      }[item.type];
      // Truncate for console
      const text = item.text.length > 120 ? item.text.substring(0, 117) + '…' : item.text;
      console.log(`   ${icon} ${dateTag}${text}`);
    }
    console.log('');
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function truncateClean(text: string, maxLen: number): string {
  // Collapse whitespace and newlines
  let cleaned = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  
  // Cut at sentence boundary
  const sentenceCut = cleaned.substring(0, maxLen).replace(/([.!?])\s+\S.*$/, '$1');
  if (sentenceCut.length > maxLen * 0.5 && sentenceCut !== cleaned.substring(0, maxLen)) {
    return sentenceCut;
  }
  // Fall back to word boundary
  const wordCut = cleaned.substring(0, maxLen).replace(/\s+\S*$/, '');
  return wordCut + '…';
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    listBriefings();
    return;
  }

  if (args.includes('--help') || args.length === 0) {
    console.log('Usage: briefing.ts <topic> [--save] [--file <name>]');
    console.log('');
    console.log('  Generates a context briefing from memory for the given topic.');
    console.log('');
    console.log('Options:');
    console.log('  --save            Save briefing to skills/memory-manager/briefings/');
    console.log('  --file <name>     Custom filename (default: briefing-<topic>.md)');
    console.log('  --list            List saved briefings');
    console.log('  --json            Output raw JSON instead of rendered markdown');
    console.log('');
    console.log('Examples:');
    console.log('  briefing.ts "MoonGate"');
    console.log('  briefing.ts "DeFi strategy" --save');
    console.log('  briefing.ts "meeting with Tom" --save --file tom-prep.md');
    return;
  }

  const save = args.includes('--save');
  const jsonOutput = args.includes('--json');
  const fileIdx = args.indexOf('--file');
  const customFile = fileIdx >= 0 ? args[fileIdx + 1] : null;

  // Topic is all non-flag arguments
  const topic = args.filter(a => !a.startsWith('--') && (fileIdx < 0 || args.indexOf(a) !== fileIdx + 1)).join(' ');

  if (!topic) {
    console.error('Error: no topic provided');
    process.exit(1);
  }

  console.log(`🔍 Searching memory for: "${topic}"...`);

  // Search
  const chunks = searchChunks(topic);

  if (chunks.length === 0) {
    console.log('❌ No relevant memory chunks found for this topic.');
    process.exit(0);
  }

  console.log(`   Found ${chunks.length} relevant chunks from ${new Set(chunks.map(c => c.path)).size} files`);
  console.log('');

  // Assemble
  const briefing = assembleBriefing(topic, chunks);

  // Output
  if (jsonOutput) {
    console.log(JSON.stringify(briefing, null, 2));
  } else {
    renderConsole(briefing);

    if (save) {
      if (!fs.existsSync(BRIEFINGS_DIR)) {
        fs.mkdirSync(BRIEFINGS_DIR, { recursive: true });
      }
      const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const filename = customFile || `briefing-${slug}.md`;
      const filepath = path.join(BRIEFINGS_DIR, filename);
      const rendered = renderBriefing(briefing);
      fs.writeFileSync(filepath, rendered);
      console.log(`💾 Saved to: ${filepath}`);
    }
  }

  // Log to briefing history
  logBriefing(topic, briefing.stats);
}

function listBriefings(): void {
  if (!fs.existsSync(BRIEFINGS_DIR)) {
    console.log('No saved briefings yet.');
    return;
  }
  const files = fs.readdirSync(BRIEFINGS_DIR).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.log('No saved briefings yet.');
    return;
  }
  console.log('📋 Saved briefings:\n');
  for (const f of files) {
    const stat = fs.statSync(path.join(BRIEFINGS_DIR, f));
    const age = Math.round((Date.now() - stat.mtimeMs) / 3600000);
    console.log(`   ${f}  (${age}h ago, ${(stat.size / 1024).toFixed(1)}KB)`);
  }
}

function logBriefing(topic: string, stats: Briefing['stats']): void {
  const historyPath = path.join(SKILL_DIR, 'briefing-history.json');
  let history: any[] = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf-8')); } catch {}
  history.push({
    timestamp: new Date().toISOString(),
    topic,
    ...stats,
  });
  if (history.length > 50) history = history.slice(-50);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

main();
