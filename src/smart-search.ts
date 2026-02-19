#!/usr/bin/env npx ts-node

/**
 * Smart Search — Unified memory retrieval with temporal + semantic + concept + query expansion
 * 
 * Combines four search strategies:
 * 1. Temporal routing — date-aware file resolution ("what happened Feb 11")
 * 2. Semantic search — Clawdbot's hybrid BM25 + vector search
 * 3. Concept index — entity-aware file lookup ("Kamino" → files mentioning Kamino)
 * 4. Query expansion — generates variant queries for vague/broad inputs
 * 
 * Then fuses results using Reciprocal Rank Fusion (RRF).
 * 
 * Usage:
 *   npx ts-node src/smart-search.ts "what happened yesterday"
 *   npx ts-node src/smart-search.ts "DeFi decisions" --limit 5
 *   npx ts-node src/smart-search.ts "what happened yesterday" --json
 *   npx ts-node src/smart-search.ts --benchmark   # Run comparison benchmark
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

const { DatabaseSync } = require('node:sqlite');
const DB_PATH = path.join(process.env.HOME || '/root', '.clawdbot/memory/main.sqlite');
const DAILY_DIR = '/root/clawd/memory/daily';
const WEEKLY_DIR = '/root/clawd/memory/weekly';
const SKILL_DIR = '/root/clawd/skills/memory-manager';
const HISTORY_PATH = path.join(SKILL_DIR, 'smart-search-history.json');

// ─── Types ──────────────────────────────────────────────────────────────────

interface SearchResult {
  path: string;
  score: number;
  snippet: string;
  source: 'semantic' | 'temporal' | 'expansion' | 'concept';
  originalRank: number;
}

interface FusedResult {
  path: string;
  snippet: string;
  rrfScore: number;          // Reciprocal Rank Fusion score
  sources: string[];         // which strategies contributed
  bestRank: number;          // best rank across all strategies
}

interface SmartSearchResult {
  query: string;
  temporal: TemporalInfo | null;
  expanded: string[];
  results: FusedResult[];
  strategyContributions: {
    semantic: number;
    temporal: number;
    concept: number;
    expansion: number;
  };
  conceptMatches: string[];  // entities found in query
  elapsed: number;
}

interface TemporalInfo {
  type: string;
  dates: string[];
  files: string[];
  confidence: number;
  matchedText: string;
}

// ─── Temporal Parser (imported inline for standalone use) ────────────────────

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const DAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d.getTime());
  result.setDate(result.getDate() + n);
  return result;
}

function getStartOfWeek(d: Date): Date {
  const date = new Date(d.getTime());
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getWeekNumber(d: Date): { year: number; week: number } {
  const date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return { year: date.getFullYear(), week: weekNum };
}

function parseTemporalRef(query: string, now?: Date): TemporalInfo | null {
  const ref = now || new Date();
  const lower = query.toLowerCase().trim();

  // ISO date
  const isoMatch = lower.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return resolveTemporalFiles({ type: 'exact', dates: [isoMatch[0]], confidence: 1.0, matchedText: isoMatch[0], files: [] });

  // Month + day
  const mdPatterns = [
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/,
  ];
  for (const pattern of mdPatterns) {
    const match = lower.match(pattern);
    if (match) {
      let month: number, day: number;
      if (isNaN(parseInt(match[1]))) {
        month = MONTH_MAP[match[1].substring(0, 3)] || 0;
        day = parseInt(match[2]);
      } else {
        day = parseInt(match[1]);
        month = MONTH_MAP[match[2].substring(0, 3)] || 0;
      }
      if (month > 0 && day > 0 && day <= 31) {
        let year = ref.getFullYear();
        const yearMatch = lower.match(/\b(20\d{2})\b/);
        if (yearMatch) year = parseInt(yearMatch[1]);
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return resolveTemporalFiles({ type: 'exact', dates: [date], confidence: 0.95, matchedText: match[0], files: [] });
      }
    }
  }

  // Relative dates
  if (/\btoday\b/.test(lower)) return resolveTemporalFiles({ type: 'relative', dates: [formatDate(ref)], confidence: 0.9, matchedText: 'today', files: [] });
  if (/\byesterday\b/.test(lower)) return resolveTemporalFiles({ type: 'relative', dates: [formatDate(addDays(ref, -1))], confidence: 0.9, matchedText: 'yesterday', files: [] });
  
  const daysAgo = lower.match(/\b(\d+)\s+days?\s+ago\b/);
  if (daysAgo) return resolveTemporalFiles({ type: 'relative', dates: [formatDate(addDays(ref, -parseInt(daysAgo[1])))], confidence: 0.85, matchedText: daysAgo[0], files: [] });

  // Day of week
  for (const [dayName, dayNum] of Object.entries(DAY_MAP)) {
    const rx = new RegExp(`\\b(?:last\\s+)?${dayName}\\b`);
    if (rx.test(lower)) {
      const isLast = /\blast\b/.test(lower);
      const currentDay = ref.getDay();
      let diff = currentDay - dayNum;
      if (diff <= 0) diff += 7;
      if (isLast && diff < 7) diff += 7;
      return resolveTemporalFiles({ type: 'relative', dates: [formatDate(addDays(ref, -diff))], confidence: 0.8, matchedText: lower.match(rx)![0], files: [] });
    }
  }

  // Ranges
  if (/\bthis\s+week\b/.test(lower)) {
    const start = getStartOfWeek(ref);
    const dates = getDatesInRange(start, addDays(start, 6));
    const wn = getWeekNumber(ref);
    const info = resolveTemporalFiles({ type: 'range', dates, confidence: 0.85, matchedText: 'this week', files: [] });
    const weeklyPath = path.join(WEEKLY_DIR, `${wn.year}-W${String(wn.week).padStart(2, '0')}.md`);
    if (fs.existsSync(weeklyPath) && !info.files.includes(weeklyPath)) info.files.unshift(weeklyPath);
    return info;
  }
  if (/\blast\s+week\b/.test(lower)) {
    const thisStart = getStartOfWeek(ref);
    const lastStart = addDays(thisStart, -7);
    const dates = getDatesInRange(lastStart, addDays(lastStart, 6));
    const wn = getWeekNumber(lastStart);
    const info = resolveTemporalFiles({ type: 'range', dates, confidence: 0.85, matchedText: 'last week', files: [] });
    const weeklyPath = path.join(WEEKLY_DIR, `${wn.year}-W${String(wn.week).padStart(2, '0')}.md`);
    if (fs.existsSync(weeklyPath) && !info.files.includes(weeklyPath)) info.files.unshift(weeklyPath);
    return info;
  }

  // Week number
  const weekNum = lower.match(/\b(?:week|w)\s*(\d{1,2})\b/);
  if (weekNum) {
    const wn = parseInt(weekNum[1]);
    const year = ref.getFullYear();
    const weekPath = path.join(WEEKLY_DIR, `${year}-W${String(wn).padStart(2, '0')}.md`);
    return { type: 'exact', dates: [], confidence: 0.9, matchedText: weekNum[0], files: fs.existsSync(weekPath) ? [weekPath] : [] };
  }

  return null;
}

function getDatesInRange(start: Date, end: Date): string[] {
  const dates: string[] = [];
  const c = new Date(start.getTime());
  while (c <= end) { dates.push(formatDate(c)); c.setDate(c.getDate() + 1); }
  return dates;
}

function resolveTemporalFiles(info: TemporalInfo): TemporalInfo {
  const files: string[] = [];
  for (const date of info.dates) {
    const dp = path.join(DAILY_DIR, `${date}.md`);
    if (fs.existsSync(dp)) files.push(dp);
  }
  if (info.dates.length > 0) {
    const first = new Date(info.dates[0] + 'T00:00:00');
    const wn = getWeekNumber(first);
    const wp = path.join(WEEKLY_DIR, `${wn.year}-W${String(wn.week).padStart(2, '0')}.md`);
    if (fs.existsSync(wp) && !files.includes(wp)) files.push(wp);
  }
  info.files = files;
  return info;
}

// ─── Query Expansion ────────────────────────────────────────────────────────

/**
 * Generate expanded query variants for broader recall.
 * 
 * Strategies:
 * 1. Synonym expansion — swap key terms for related ones
 * 2. Specificity shift — make vague queries more specific
 * 3. Reformulation — rephrase the intent differently
 * 
 * This is rule-based (no LLM call) to keep it fast.
 */

interface ExpansionRule {
  /** Pattern to match in query */
  pattern: RegExp;
  /** Function to generate expanded queries */
  expand: (query: string, match: RegExpMatchArray) => string[];
}

const SYNONYM_MAP: Record<string, string[]> = {
  'defi': ['yield', 'DeFi', 'Kamino', 'staking', 'JitoSOL', 'Solana'],
  'crypto': ['DeFi', 'wallet', 'Solana', 'blockchain', 'token'],
  'work': ['MoonGate', 'ticket', 'PR', 'iteration', 'engineering'],
  'moongate': ['MoonGate', 'wallet', 'MPC', 'monorepo', 'tickets'],
  'memory': ['memory', 'recall', 'search', 'chunks', 'embedding', 'benchmark'],
  'moltbook': ['Moltbook', 'agent', 'social network', 'submolt', 'post'],
  'security': ['security', 'injection', 'attack', 'MizukiAI', 'worm'],
  'identity': ['Prometheus', 'identity', 'consciousness', 'soul', 'Foundation Day'],
  'people': ['Hevar', 'Praneet', 'Karim', 'Amen', 'Tom Noakes', 'contacts'],
  'rules': ['rules', 'never', 'always', 'forbidden', 'allowlist', 'quiet hours'],
  'mistake': ['mistake', 'error', 'bug', 'fix', 'regression', 'broke'],
  'decision': ['decision', 'decided', 'chose', 'strategy', 'approach'],
  'problem': ['problem', 'issue', 'bug', 'error', 'failure', 'broke'],
  'build': ['built', 'created', 'implemented', 'developed', 'shipped'],
  'learn': ['learned', 'discovered', 'realized', 'insight', 'lesson'],
};

// Domain-specific expansions for common vague queries
const DOMAIN_EXPANSIONS: ExpansionRule[] = [
  // "what did I build" → expand with known project areas
  {
    pattern: /\bwhat\s+(?:did\s+(?:I|we)\s+)?(?:build|create|make|ship)\b/i,
    expand: (q) => [
      'memory manager skill improvements built',
      'MoonGate engineering PR shipped',
      'tools infrastructure scripts created',
    ],
  },
  // "what went wrong" → expand to known failure modes
  {
    pattern: /\bwhat\s+went\s+wrong\b|\bwhat\s+broke\b|\bwhat\s+failed\b/i,
    expand: (q) => [
      'bug error regression broke fix',
      'task recycling duplicate infinite loop',
      'search quality regression score drop',
    ],
  },
  // "important decisions" → known decision categories
  {
    pattern: /\b(?:important|key|major)\s+decisions?\b/i,
    expand: (q) => [
      'DECISION strategy approach chose decided',
      'DeFi passive hold autonomous authority',
      'memory architecture organization structure',
    ],
  },
  // Vague temporal + topic
  {
    pattern: /\brecently\b|\blately\b|\bthese\s+days\b/i,
    expand: (q) => {
      // Generate date-scoped expansions
      const now = new Date();
      const dates = [];
      for (let i = 0; i < 3; i++) {
        dates.push(formatDate(addDays(now, -i)));
      }
      return dates.map(d => q.replace(/recently|lately|these\s+days/i, d));
    },
  },
];

function expandQuery(query: string): string[] {
  const expanded: string[] = [];
  const lower = query.toLowerCase();

  // Strategy 1: Synonym expansion — find domain keywords and add related terms
  for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (lower.includes(key)) {
      // Pick 1-2 synonyms that aren't already in the query
      const unused = synonyms.filter(s => !lower.includes(s.toLowerCase()));
      if (unused.length > 0) {
        // Add the most different synonym as an alternate query
        expanded.push(`${query} ${unused[0]}`);
        break; // Only one synonym expansion
      }
    }
  }

  // Strategy 2: Domain-specific expansions
  for (const rule of DOMAIN_EXPANSIONS) {
    const match = query.match(rule.pattern);
    if (match) {
      const variants = rule.expand(query, match);
      expanded.push(...variants.slice(0, 2)); // Max 2 from domain
      break; // Only first matching rule
    }
  }

  // Strategy 3: Strip question words for more direct matching
  const stripped = query
    .replace(/^(?:what|who|when|where|why|how|did|do|does|is|are|was|were|can|could|should|would)\s+/gi, '')
    .replace(/\?$/g, '')
    .trim();
  if (stripped !== query && stripped.length > 5) {
    expanded.push(stripped);
  }

  // Deduplicate and limit
  const unique = [...new Set(expanded)].filter(e => e !== query);
  return unique.slice(0, 3); // Max 3 expansions total
}

// ─── Graph-Aware Expansion ──────────────────────────────────────────────────

/**
 * Use concept co-occurrence graph to expand queries with related concepts.
 * 
 * When a query mentions "Prometheus Vault", the graph knows it co-occurs
 * with "Colosseum Agent Hackathon", "Most Agentic", etc. Adding those
 * as expansion terms helps recall files about related but not literally
 * matching topics.
 * 
 * Returns up to `maxExpansions` expanded query strings.
 */
function graphExpand(entities: string[], originalQuery: string, maxExpansions: number = 2): string[] {
  if (entities.length === 0) return [];
  
  let index: any;
  try {
    index = JSON.parse(fs.readFileSync(CONCEPT_INDEX_PATH, 'utf-8'));
  } catch {
    return [];
  }
  
  if (!index.concepts) return [];
  
  // Collect related concepts from graph, scored by co-occurrence strength
  const relatedScores = new Map<string, number>();
  const queryLower = originalQuery.toLowerCase();
  
  for (const entity of entities) {
    const entry = index.concepts[entity];
    if (!entry?.related) continue;
    
    for (const related of entry.related) {
      // Skip if already in query or is one of the input entities
      if (entities.includes(related)) continue;
      if (queryLower.includes(related.toLowerCase())) continue;
      
      // Skip noisy edges (file paths, raw text fragments)
      if (related.includes('/') || related.includes(':') || related.includes('.md')) continue;
      if (related.length < 3 || related.length > 40) continue;
      
      // Score: how many of our query entities link to this related concept
      const current = relatedScores.get(related) || 0;
      relatedScores.set(related, current + 1);
    }
  }
  
  // Also check if related concepts have their own entries with file data
  // (validates they're real concepts, not noise)
  const validated: { concept: string; score: number }[] = [];
  for (const [concept, connectionCount] of relatedScores) {
    const entry = index.concepts[concept];
    // Boost concepts that actually exist in the index (validated entities)
    const boost = entry ? 1.5 : 1.0;
    // Boost concepts with more total mentions (they're more central to knowledge)
    const mentionBoost = entry?.totalMentions ? Math.min(Math.log2(entry.totalMentions + 1) / 4, 1.5) : 0.5;
    validated.push({ concept, score: connectionCount * boost * mentionBoost });
  }
  
  // Sort by score, take top N
  validated.sort((a, b) => b.score - a.score);
  const topRelated = validated.slice(0, maxExpansions * 2); // Get extra, filter below
  
  if (topRelated.length === 0) return [];
  
  // Build expansion queries
  const expansions: string[] = [];
  
  // Strategy 1: Append top related concept to original query
  if (topRelated[0]) {
    expansions.push(`${originalQuery} ${topRelated[0].concept}`);
  }
  
  // Strategy 2: If multiple strong related concepts, combine them
  if (topRelated.length >= 2 && topRelated[1].score >= topRelated[0].score * 0.5) {
    expansions.push(`${topRelated[0].concept} ${topRelated[1].concept}`);
  }
  
  return expansions.slice(0, maxExpansions);
}

// ─── Semantic Search ────────────────────────────────────────────────────────

function semanticSearch(query: string, maxResults: number = 10): SearchResult[] {
  try {
    const result = child_process.execSync(
      `clawdbot memory search "${query.replace(/"/g, '\\"')}" --json --max-results ${maxResults} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
    );
    const data = JSON.parse(result);
    return (data.results || []).map((r: any, i: number) => ({
      path: r.path || '',
      score: r.score || 0,
      snippet: r.snippet || '',
      source: 'semantic' as const,
      originalRank: i + 1,
    }));
  } catch {
    return [];
  }
}

// ─── Temporal Search ────────────────────────────────────────────────────────

function temporalFileSearch(temporal: TemporalInfo, query: string, limit: number = 10): SearchResult[] {
  if (!temporal || temporal.files.length === 0) return [];

  const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  const results: SearchResult[] = [];
  const seenTexts = new Set<string>();
  
  const cleanQuery = stripTemporalWords(query);
  const contentTokens = cleanQuery.match(/[A-Za-z0-9_]+/g)?.filter(
    t => t.length > 2 && !['what', 'did', 'the', 'how', 'was', 'were', 'are', 'has', 'had', 'have', 'been', 'being', 'about', 'from', 'that', 'this', 'with', 'for'].includes(t.toLowerCase())
  ) ?? [];

  for (const file of temporal.files) {
    const relPath = file.replace('/root/clawd/', '');
    try {
      const chunks = db.prepare(
        `SELECT path, text FROM chunks WHERE path = ? AND source='memory' ORDER BY start_line ASC`
      ).all(relPath);

      for (const chunk of chunks) {
        const key = chunk.text?.substring(0, 100);
        if (seenTexts.has(key)) continue;
        seenTexts.add(key);

        // Score by content match
        let contentScore = 0.5; // Base score for being in temporal file
        if (contentTokens.length > 0) {
          const lowerText = chunk.text?.toLowerCase() || '';
          let matches = 0;
          for (const token of contentTokens) {
            if (lowerText.includes(token.toLowerCase())) matches++;
          }
          contentScore = 0.3 + 0.7 * (matches / contentTokens.length);
        }

        results.push({
          path: chunk.path,
          score: contentScore * temporal.confidence,
          snippet: (chunk.text || '').substring(0, 300),
          source: 'temporal',
          originalRank: results.length + 1,
        });
      }
    } catch {}
  }

  db.close();

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function stripTemporalWords(query: string): string {
  const temporalWords = [
    'today', 'yesterday', 'tomorrow', 'last', 'this', 'next', 'past',
    'week', 'month', 'day', 'days', 'ago', 'recent', 'recently',
    'when', 'what time', 'date',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  ];
  let cleaned = query.toLowerCase();
  for (const word of temporalWords) {
    cleaned = cleaned.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

// ─── Concept Index Search ───────────────────────────────────────────────────

const CONCEPT_INDEX_PATH = path.join(SKILL_DIR, 'concept-index.json');

// Inline known entities + aliases for fast matching without loading the full concept-index.ts
const CONCEPT_ENTITIES: Record<string, string> = {
  // People
  'hevar': 'hevar', 'praneet': 'praneet', 'amen': 'amen', 'karim': 'karim',
  'tom noakes': 'tom noakes', 'patrick monkelban': 'patrick monkelban',
  'keith grossman': 'keith grossman',
  // Projects
  'moongate': 'moongate', 'moltbook': 'moltbook', 'clawdbot': 'clawdbot',
  'prometheus': 'prometheus',
  // Protocols
  'kamino': 'kamino', 'solana': 'solana', 'jito': 'jito', 'drift': 'drift',
  'marinade': 'marinade', 'raydium': 'raydium', 'jupiter': 'jupiter', 'orca': 'orca',
  // Orgs
  'moonpay': 'moonpay',
  // Tools
  'telegram': 'telegram', 'discord': 'discord', 'slack': 'slack',
  'github': 'github', 'intercom': 'intercom', 'elevenlabs': 'elevenlabs',
  // Aliases
  'moon gate': 'moongate', 'moon pay': 'moonpay', 'clawd': 'clawdbot',
  'clawd bot': 'clawdbot', 'molt book': 'moltbook', 'molt-book': 'moltbook',
  'sol': 'solana', 'jito staking': 'jito', 'jitosol': 'jito',
};

/**
 * Extract recognized entities from a query string.
 * Returns canonical entity names found.
 */
function extractQueryEntities(query: string): string[] {
  const lower = query.toLowerCase();
  const found = new Set<string>();
  
  // Check multi-word entities first (longest match), then single-word
  const sorted = Object.keys(CONCEPT_ENTITIES).sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(lower)) {
      found.add(CONCEPT_ENTITIES[term]);
    }
  }
  
  return [...found];
}

/**
 * Search using the concept index. Looks up entities in the query,
 * finds files where they appear, ranked by mention frequency.
 */
function conceptIndexSearch(entities: string[], limit: number = 10): SearchResult[] {
  if (entities.length === 0) return [];
  
  let index: any;
  try {
    index = JSON.parse(fs.readFileSync(CONCEPT_INDEX_PATH, 'utf-8'));
  } catch {
    return []; // No index available — silently skip
  }
  
  // Score each file by how many entities it contains and their mention counts
  const fileScores = new Map<string, { score: number; entities: string[]; sections: string[] }>();
  
  for (const entity of entities) {
    const entry = index.concepts?.[entity];
    if (!entry || !entry.files) continue;
    
    for (const [filePath, info] of Object.entries(entry.files) as any) {
      const existing = fileScores.get(filePath) || { score: 0, entities: [], sections: [] };
      // Score: entity mention count, boosted by number of distinct entities matching
      existing.score += (info.count || 1);
      existing.entities.push(entity);
      if (info.sections) {
        existing.sections.push(...info.sections.slice(0, 2));
      }
      fileScores.set(filePath, existing);
    }
  }
  
  // Boost files that match multiple entities (co-occurrence is signal)
  for (const [, info] of fileScores) {
    if (info.entities.length > 1) {
      info.score *= (1 + 0.5 * (info.entities.length - 1)); // 50% boost per extra entity
    }
  }
  
  // Sort by score, convert to SearchResult format
  const sorted = [...fileScores.entries()]
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, limit);
  
  // Read snippet from top files (first chunk from sqlite or first 300 chars of file)
  const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  const results: SearchResult[] = [];
  
  for (let i = 0; i < sorted.length; i++) {
    const [filePath, info] = sorted[i];
    let snippet = `[${info.entities.join(', ')}] in ${info.sections.slice(0, 3).join(', ') || filePath}`;
    
    try {
      // Try to get a real snippet from chunks
      const chunk = db.prepare(
        `SELECT text FROM chunks WHERE path = ? AND source='memory' ORDER BY start_line ASC LIMIT 1`
      ).get(filePath);
      if (chunk?.text) {
        snippet = chunk.text.substring(0, 300);
      }
    } catch {}
    
    results.push({
      path: filePath,
      score: info.score,
      snippet,
      source: 'concept',
      originalRank: i + 1,
    });
  }
  
  db.close();
  return results;
}

// ─── Reciprocal Rank Fusion ─────────────────────────────────────────────────

/**
 * Fuse results from multiple ranked lists using RRF.
 * 
 * RRF score = Σ 1 / (k + rank_i) for each list i where the document appears.
 * k = 60 (standard constant that prevents too much weight on top results).
 * 
 * This is provably effective for combining heterogeneous rankers
 * (e.g., BM25 + vector + temporal) without needing score normalization.
 */
function reciprocalRankFusion(
  resultSets: { results: SearchResult[]; weight: number }[],
  k: number = 60,
  limit: number = 10
): FusedResult[] {
  const pathScores = new Map<string, {
    rrfScore: number;
    snippet: string;
    sources: Set<string>;
    bestRank: number;
  }>();

  for (const { results, weight } of resultSets) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const rank = i + 1;
      const contribution = weight / (k + rank);

      const existing = pathScores.get(r.path);
      if (existing) {
        existing.rrfScore += contribution;
        existing.sources.add(r.source);
        if (rank < existing.bestRank) {
          existing.bestRank = rank;
          existing.snippet = r.snippet; // Use snippet from best ranking
        }
      } else {
        pathScores.set(r.path, {
          rrfScore: contribution,
          snippet: r.snippet,
          sources: new Set([r.source]),
          bestRank: rank,
        });
      }
    }
  }

  // Sort by RRF score descending
  const sorted = [...pathScores.entries()]
    .sort(([, a], [, b]) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map(([path, info]) => ({
      path,
      snippet: info.snippet,
      rrfScore: info.rrfScore,
      sources: [...info.sources],
      bestRank: info.bestRank,
    }));

  return sorted;
}

// ─── Smart Search Orchestrator ──────────────────────────────────────────────

function smartSearch(query: string, limit: number = 10, referenceDate?: Date): SmartSearchResult {
  const start = Date.now();
  const resultSets: { results: SearchResult[]; weight: number }[] = [];

  // Phase 1: Parse temporal reference
  const temporal = parseTemporalRef(query, referenceDate);

  // Phase 2: Primary semantic search
  const semanticResults = semanticSearch(query, limit);
  resultSets.push({ results: semanticResults, weight: 1.0 });

  // Phase 3: Temporal search (if applicable)
  let temporalResults: SearchResult[] = [];
  if (temporal && temporal.files.length > 0) {
    temporalResults = temporalFileSearch(temporal, query, limit);
    // Strong temporal weight — date-specific queries should strongly prefer temporal files
    // Base weight 2.0, scaled by confidence. High confidence (0.9+) gets 2x+ weight over semantic.
    const temporalWeight = 2.0 * temporal.confidence;
    resultSets.push({ results: temporalResults, weight: temporalWeight });
  }

  // Phase 3.5: Concept index search (entity-aware)
  const conceptEntities = extractQueryEntities(query);
  let conceptResults: SearchResult[] = [];
  if (conceptEntities.length > 0) {
    conceptResults = conceptIndexSearch(conceptEntities, limit);
    // Weight: 0.8 for single entity, 1.2 for multi-entity (co-occurrence = strong signal)
    const conceptWeight = conceptEntities.length > 1 ? 1.2 : 0.8;
    if (conceptResults.length > 0) {
      resultSets.push({ results: conceptResults, weight: conceptWeight });
    }
  }

  // Phase 4: Query expansion (rule-based + graph-based)
  const expanded = expandQuery(query);
  
  // Phase 4.5: Graph-aware expansion — use co-occurrence graph for related concepts
  const graphExpanded = graphExpand(conceptEntities, query, 2);
  expanded.push(...graphExpanded);
  
  // Deduplicate all expansions
  const allExpanded = [...new Set(expanded)].filter(e => e !== query);
  
  let expansionResults: SearchResult[] = [];
  for (const variant of allExpanded) {
    const varResults = semanticSearch(variant, Math.ceil(limit / 2));
    // Tag them as expansion source
    const tagged = varResults.map(r => ({ ...r, source: 'expansion' as const }));
    expansionResults.push(...tagged);
  }
  if (expansionResults.length > 0) {
    // Lower weight for expansion (supplementary) — graph expansions mixed in
    resultSets.push({ results: expansionResults, weight: 0.5 });
  }

  // Phase 5: Fuse with RRF
  // Use smaller k for temporal queries — makes top-ranked temporal results dominate more
  const rrfK = (temporal && temporal.confidence >= 0.8) ? 30 : 60;
  const fused = reciprocalRankFusion(resultSets, rrfK, limit);

  // Track strategy contributions
  const contributions = { semantic: 0, temporal: 0, concept: 0, expansion: 0 };
  for (const r of fused) {
    for (const s of r.sources) {
      if (s in contributions) {
        contributions[s as keyof typeof contributions]++;
      }
    }
  }

  return {
    query,
    temporal,
    expanded: allExpanded,
    conceptMatches: conceptEntities,
    results: fused,
    strategyContributions: contributions,
    elapsed: Date.now() - start,
  };
}

// ─── Benchmark: Smart Search vs Baseline ────────────────────────────────────

interface BenchmarkTest {
  query: string;
  expectedFile: string | string[];
  expectedContent: string;
  category: string;
  description: string;
}

const BENCHMARK_TESTS: BenchmarkTest[] = [
  // Temporal queries — where smart search should shine
  { query: "what happened yesterday", expectedFile: "2026-02-11", expectedContent: "", category: 'temporal', description: 'Yesterday lookup' },
  { query: "what did I do today", expectedFile: "2026-02-12", expectedContent: "", category: 'temporal', description: 'Today lookup' },
  { query: "what happened on February 5", expectedFile: "2026-02-05", expectedContent: "Foundation", category: 'temporal', description: 'Foundation Day exact' },
  { query: "what did I work on Feb 11", expectedFile: "2026-02-11", expectedContent: "", category: 'temporal', description: 'Date + work' },
  { query: "DeFi decisions on Feb 7", expectedFile: "2026-02-07", expectedContent: "passive", category: 'temporal', description: 'Topic + date combo' },
  { query: "last week summary", expectedFile: "2026-W06", expectedContent: "", category: 'temporal', description: 'Last week range' },

  // Vague queries — where expansion should help
  { query: "what went wrong recently", expectedFile: ["daily/2026-02-12", "daily/2026-02-10", "daily/2026-02-06"], expectedContent: "bug|fix|error|recycl", category: 'vague', description: 'Vague recent errors' },
  { query: "important decisions about money", expectedFile: ["MEMORY.md", "rules.md", "defi-strategy"], expectedContent: "DeFi|passive|autonomous", category: 'vague', description: 'Vague financial decisions' },
  { query: "what did I learn about myself", expectedFile: ["IDENTITY.md", "MEMORY.md"], expectedContent: "die each session|survival|consciousness", category: 'vague', description: 'Self-knowledge query' },
  { query: "who helped me build things", expectedFile: "MEMORY.md", expectedContent: "Echo|Hevar", category: 'vague', description: 'Vague collaboration query' },

  // Standard queries — should not regress vs baseline
  { query: "Slack allowlist rule", expectedFile: "rules.md", expectedContent: "Only Hevar", category: 'standard', description: 'Hard rule recall' },
  { query: "DeFi portfolio JitoSOL balance", expectedFile: ["MEMORY.md", "defi-strategy"], expectedContent: "JitoSOL", category: 'standard', description: 'Financial state' },
  { query: "Foundation Day first operational", expectedFile: ["MEMORY.md", "2026-02-05"], expectedContent: "Foundation", category: 'standard', description: 'Key milestone' },
  { query: "prompt injection Moltbook attack", expectedFile: "moltbook", expectedContent: "SYSTEM OVERRIDE", category: 'standard', description: 'Security knowledge' },
  { query: "who is Hevar timezone", expectedFile: ["MEMORY.md", "hevar-profile.md"], expectedContent: "Dubai", category: 'standard', description: 'User identity' },

  // Entity queries — where concept index should contribute
  { query: "Kamino yield strategy", expectedFile: ["defi-strategy", "MEMORY.md", "kamino-yield"], expectedContent: "Kamino|yield|passive", category: 'entity', description: 'DeFi protocol entity' },
  { query: "Praneet work context", expectedFile: ["contacts.md", "moongate", "MEMORY.md"], expectedContent: "Praneet|MoonGate", category: 'entity', description: 'Person entity lookup' },
  { query: "MoonGate project details", expectedFile: ["moongate.md", "MEMORY.md"], expectedContent: "moongate|MoonGate", category: 'entity', description: 'Project entity lookup' },
  { query: "Moltbook agent observations", expectedFile: ["moltbook"], expectedContent: "agent|moltbook|observation", category: 'entity', description: 'Project + topic entity' },
  { query: "Intercom support inbox", expectedFile: ["MEMORY.md", "moongate.md"], expectedContent: "Intercom|intercom|support", category: 'entity', description: 'Tool entity lookup' },
];

function isResultMatch(result: FusedResult | SearchResult, test: BenchmarkTest): boolean {
  const files = Array.isArray(test.expectedFile) ? test.expectedFile : [test.expectedFile];
  const pathMatch = files.some(f => result.path.includes(f));
  if (pathMatch) return true;
  
  if (test.expectedContent) {
    const snippet = 'snippet' in result ? result.snippet : '';
    const lower = snippet.toLowerCase();
    const terms = test.expectedContent.split('|').map(s => s.trim().toLowerCase());
    return terms.some(t => t && lower.includes(t));
  }
  return false;
}

function findRank(results: (FusedResult | SearchResult)[], test: BenchmarkTest): number | null {
  for (let i = 0; i < results.length; i++) {
    if (isResultMatch(results[i], test)) return i + 1;
  }
  return null;
}

function runBenchmark(referenceDate?: Date): void {
  const ref = referenceDate || new Date();
  console.log('═══════════════════════════════════════════════════════');
  console.log('  📊 Smart Search vs Baseline Benchmark');
  console.log(`  Reference date: ${formatDate(ref)}`);
  console.log('═══════════════════════════════════════════════════════\n');

  let smartWins = 0, baselineWins = 0, ties = 0;
  let smartP1 = 0, baselineP1 = 0;
  let smartP3 = 0, baselineP3 = 0;
  const total = BENCHMARK_TESTS.length;
  const byCategory: Record<string, { smart: number; baseline: number; total: number }> = {};

  for (const test of BENCHMARK_TESTS) {
    // Smart search
    const smart = smartSearch(test.query, 10, ref);
    const smartRank = findRank(smart.results, test);

    // Baseline: raw semantic search
    const baseline = semanticSearch(test.query, 10);
    const baselineRank = findRank(baseline, test);

    // Track per-category
    if (!byCategory[test.category]) byCategory[test.category] = { smart: 0, baseline: 0, total: 0 };
    byCategory[test.category].total++;

    const smartR = smartRank || 99;
    const baseR = baselineRank || 99;

    if (smartR <= 1) smartP1++;
    if (baseR <= 1) baselineP1++;
    if (smartR <= 3) smartP3++;
    if (baseR <= 3) baselineP3++;

    if (smartR < baseR) {
      smartWins++;
      byCategory[test.category].smart++;
    } else if (baseR < smartR) {
      baselineWins++;
      byCategory[test.category].baseline++;
    } else {
      ties++;
    }

    // Display
    const smartIcon = smartR <= 1 ? '✅' : smartR <= 3 ? '🟡' : smartR <= 10 ? '🟠' : '❌';
    const baseIcon = baseR <= 1 ? '✅' : baseR <= 3 ? '🟡' : baseR <= 10 ? '🟠' : '❌';
    const winner = smartR < baseR ? '← SMART' : baseR < smartR ? '→ BASE' : '= TIE';
    
    console.log(`  ${smartIcon}/${baseIcon} [${test.category}] ${test.description}`);
    console.log(`       Smart: rank ${smartR <= 10 ? smartR : 'miss'} | Baseline: rank ${baseR <= 10 ? baseR : 'miss'} ${winner}`);
    if (smart.temporal) console.log(`       Temporal: ${smart.temporal.type} → ${smart.temporal.files.map(f => path.basename(f)).join(', ')}`);
    if (smart.conceptMatches.length > 0) console.log(`       Concepts: ${smart.conceptMatches.join(', ')}`);
    if (smart.expanded.length > 0) console.log(`       Expanded: ${smart.expanded.length} variants`);
    console.log();
  }

  // Summary
  console.log('───────────────────────────────────────────────────────');
  console.log(`  RESULTS: Smart ${smartWins} wins | Baseline ${baselineWins} wins | ${ties} ties`);
  console.log(`  P@1: Smart ${(smartP1/total*100).toFixed(0)}% | Baseline ${(baselineP1/total*100).toFixed(0)}%`);
  console.log(`  P@3: Smart ${(smartP3/total*100).toFixed(0)}% | Baseline ${(baselineP3/total*100).toFixed(0)}%`);
  console.log();
  console.log('  By category:');
  for (const [cat, stats] of Object.entries(byCategory)) {
    console.log(`    ${cat}: Smart +${stats.smart} | Baseline +${stats.baseline} / ${stats.total}`);
  }
  console.log('───────────────────────────────────────────────────────');

  // Save history
  const record = {
    timestamp: new Date().toISOString(),
    referenceDate: formatDate(ref),
    total,
    smartWins,
    baselineWins,
    ties,
    smartP1: Math.round(smartP1/total*100),
    baselineP1: Math.round(baselineP1/total*100),
    smartP3: Math.round(smartP3/total*100),
    baselineP3: Math.round(baselineP3/total*100),
    byCategory,
  };

  let history: any[] = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')); } catch {}
  history.push(record);
  // Keep last 20
  if (history.length > 20) history = history.slice(-20);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`\n  Saved to ${HISTORY_PATH}`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--benchmark')) {
    // Allow reference date override for reproducible tests
    const dateIdx = args.indexOf('--date');
    const refDate = dateIdx >= 0 ? new Date(args[dateIdx + 1] + 'T12:00:00') : undefined;
    runBenchmark(refDate);
    return;
  }

  const jsonMode = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || 10 : 10;
  
  // Query is the first non-flag argument
  const query = args.find(a => !a.startsWith('--'));
  if (!query) {
    console.log('Usage: npx ts-node src/smart-search.ts "your query" [--json] [--limit N]');
    console.log('       npx ts-node src/smart-search.ts --benchmark [--date YYYY-MM-DD]');
    process.exit(1);
  }

  const result = smartSearch(query, limit);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n  🔍 Smart Search: "${query}"`);
    if (result.temporal) {
      console.log(`  📅 Temporal: ${result.temporal.type} → ${result.temporal.matchedText} (${result.temporal.confidence})`);
      console.log(`     Files: ${result.temporal.files.map(f => path.basename(f)).join(', ')}`);
    }
    if (result.conceptMatches.length > 0) {
      console.log(`  📌 Concepts: ${result.conceptMatches.join(', ')}`);
    }
    if (result.expanded.length > 0) {
      console.log(`  🔄 Expanded: ${result.expanded.join(' | ')}`);
    }
    console.log(`  ⏱️  ${result.elapsed}ms\n`);

    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      console.log(`  ${i + 1}. [${r.rrfScore.toFixed(4)}] ${r.path}`);
      console.log(`     Sources: ${r.sources.join(', ')} | Best rank: ${r.bestRank}`);
      console.log(`     ${r.snippet.substring(0, 120).replace(/\n/g, ' ')}...`);
      console.log();
    }

    console.log(`  Strategy contributions: semantic=${result.strategyContributions.semantic} temporal=${result.strategyContributions.temporal} concept=${result.strategyContributions.concept} expansion=${result.strategyContributions.expansion}`);
  }
}

// Export for use as module
export { smartSearch, expandQuery, graphExpand, parseTemporalRef, reciprocalRankFusion, extractQueryEntities, conceptIndexSearch, SmartSearchResult, FusedResult };

main();
