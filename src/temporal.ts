#!/usr/bin/env npx ts-node

/**
 * Temporal Query Enhancement for Memory System
 * 
 * Parses date/time references from natural language queries and provides:
 * 1. Date extraction — "what happened Feb 11" → 2026-02-11
 * 2. Range detection — "last week" → date range
 * 3. File routing — maps dates to daily/weekly files
 * 4. Result boosting — re-ranks search results based on temporal relevance
 * 
 * Works as a pre/post-processor for both BM25 and embedding search.
 * 
 * Usage:
 *   npx ts-node src/temporal.ts parse "what happened on Feb 5"
 *   npx ts-node src/temporal.ts search "what did I do last week"
 *   npx ts-node src/temporal.ts test    # Run temporal benchmark
 */

import * as fs from 'fs';
import * as path from 'path';

const { DatabaseSync } = require('node:sqlite');
const DB_PATH = path.join(process.env.HOME || '/root', '.clawdbot/memory/main.sqlite');
const DAILY_DIR = path.join('/root/clawd/memory/daily');
const WEEKLY_DIR = path.join('/root/clawd/memory/weekly');

// ─── Date Parsing ───────────────────────────────────────────────────────────

interface TemporalRef {
  type: 'exact' | 'range' | 'relative' | 'none';
  dates: string[];           // YYYY-MM-DD format
  range?: { start: string; end: string };
  confidence: number;        // 0-1
  matchedText: string;       // what in the query matched
  files: string[];           // resolved daily/weekly file paths
}

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const DAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * Get the current reference date (defaults to today in Dubai timezone)
 */
function getNow(): Date {
  // Use Dubai time as reference (Hevar's timezone)
  const now = new Date();
  return now;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function getWeekNumber(d: Date): { year: number; week: number } {
  const date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return { year: date.getFullYear(), week: weekNum };
}

function getStartOfWeek(d: Date): Date {
  const date = new Date(d.getTime());
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d.getTime());
  result.setDate(result.getDate() + n);
  return result;
}

/**
 * Parse temporal references from a query string
 */
function parseTemporalQuery(query: string, referenceDate?: Date): TemporalRef {
  const now = referenceDate || getNow();
  const lower = query.toLowerCase().trim();
  const noRef: TemporalRef = { type: 'none', dates: [], confidence: 0, matchedText: '', files: [] };
  
  // Pattern 1: Explicit date — "February 5", "Feb 11", "2026-02-05"
  // ISO format
  const isoMatch = lower.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const date = isoMatch[0];
    return resolveRef({
      type: 'exact',
      dates: [date],
      confidence: 1.0,
      matchedText: isoMatch[0],
      files: [],
    });
  }

  // Month + day: "February 5", "Feb 11th", "11 Feb"
  const monthDayPatterns = [
    // "February 5", "Feb 5th"
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
    // "5 February", "5th Feb"
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/,
  ];
  
  for (const pattern of monthDayPatterns) {
    const match = lower.match(pattern);
    if (match) {
      let month: number, day: number;
      if (isNaN(parseInt(match[1]))) {
        // Month name first
        month = MONTH_MAP[match[1].substring(0, 3)] || 0;
        day = parseInt(match[2]);
      } else {
        // Day first
        day = parseInt(match[1]);
        month = MONTH_MAP[match[2].substring(0, 3)] || 0;
      }
      if (month > 0 && day > 0 && day <= 31) {
        // Default to current year or most recent occurrence
        let year = now.getFullYear();
        const yearMatch = lower.match(/\b(20\d{2})\b/);
        if (yearMatch) year = parseInt(yearMatch[1]);
        
        const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return resolveRef({
          type: 'exact',
          dates: [date],
          confidence: 0.95,
          matchedText: match[0],
          files: [],
        });
      }
    }
  }

  // Pattern 2: Relative dates
  // "today"
  if (/\btoday\b/.test(lower)) {
    return resolveRef({
      type: 'relative',
      dates: [formatDate(now)],
      confidence: 0.9,
      matchedText: 'today',
      files: [],
    });
  }

  // "yesterday"
  if (/\byesterday\b/.test(lower)) {
    return resolveRef({
      type: 'relative',
      dates: [formatDate(addDays(now, -1))],
      confidence: 0.9,
      matchedText: 'yesterday',
      files: [],
    });
  }

  // "X days ago"
  const daysAgoMatch = lower.match(/\b(\d+)\s+days?\s+ago\b/);
  if (daysAgoMatch) {
    const n = parseInt(daysAgoMatch[1]);
    return resolveRef({
      type: 'relative',
      dates: [formatDate(addDays(now, -n))],
      confidence: 0.85,
      matchedText: daysAgoMatch[0],
      files: [],
    });
  }

  // Pattern 3: Day of week — "last Monday", "on Wednesday"
  for (const [dayName, dayNum] of Object.entries(DAY_MAP)) {
    const dayRegex = new RegExp(`\\b(?:last\\s+)?${dayName}\\b`);
    if (dayRegex.test(lower)) {
      const isLast = /\blast\b/.test(lower);
      const currentDay = now.getDay();
      let diff = currentDay - dayNum;
      if (diff <= 0) diff += 7;
      if (isLast && diff < 7) diff += 7;
      const target = addDays(now, -diff);
      return resolveRef({
        type: 'relative',
        dates: [formatDate(target)],
        confidence: 0.8,
        matchedText: lower.match(dayRegex)![0],
        files: [],
      });
    }
  }

  // Pattern 4: Ranges
  // "this week"
  if (/\bthis\s+week\b/.test(lower)) {
    const start = getStartOfWeek(now);
    const end = addDays(start, 6);
    const dates = getDatesInRange(start, end);
    const wn = getWeekNumber(now);
    const ref = resolveRef({
      type: 'range',
      dates,
      range: { start: formatDate(start), end: formatDate(end) },
      confidence: 0.85,
      matchedText: 'this week',
      files: [],
    });
    // Ensure weekly file comes first for "this week" queries
    const weeklyPath = path.join(WEEKLY_DIR, `${wn.year}-W${String(wn.week).padStart(2, '0')}.md`);
    if (fs.existsSync(weeklyPath)) {
      ref.files = [weeklyPath, ...ref.files.filter(f => f !== weeklyPath)];
    }
    return ref;
  }

  // "last week"
  if (/\blast\s+week\b/.test(lower)) {
    const thisWeekStart = getStartOfWeek(now);
    const lastWeekStart = addDays(thisWeekStart, -7);
    const lastWeekEnd = addDays(lastWeekStart, 6);
    const dates = getDatesInRange(lastWeekStart, lastWeekEnd);
    const wn = getWeekNumber(lastWeekStart);
    const ref = resolveRef({
      type: 'range',
      dates,
      range: { start: formatDate(lastWeekStart), end: formatDate(lastWeekEnd) },
      confidence: 0.85,
      matchedText: 'last week',
      files: [],
    });
    // Ensure weekly file comes first
    const weeklyPath = path.join(WEEKLY_DIR, `${wn.year}-W${String(wn.week).padStart(2, '0')}.md`);
    if (fs.existsSync(weeklyPath)) {
      ref.files = [weeklyPath, ...ref.files.filter(f => f !== weeklyPath)];
    }
    return ref;
  }

  // "past N days"
  const pastNMatch = lower.match(/\bpast\s+(\d+)\s+days?\b/);
  if (pastNMatch) {
    const n = parseInt(pastNMatch[1]);
    const start = addDays(now, -(n - 1));
    const dates = getDatesInRange(start, now);
    return resolveRef({
      type: 'range',
      dates,
      range: { start: formatDate(start), end: formatDate(now) },
      confidence: 0.8,
      matchedText: pastNMatch[0],
      files: [],
    });
  }

  // "last N days"
  const lastNMatch = lower.match(/\blast\s+(\d+)\s+days?\b/);
  if (lastNMatch) {
    const n = parseInt(lastNMatch[1]);
    const start = addDays(now, -n);
    const dates = getDatesInRange(start, now);
    return resolveRef({
      type: 'range',
      dates,
      range: { start: formatDate(start), end: formatDate(now) },
      confidence: 0.8,
      matchedText: lastNMatch[0],
      files: [],
    });
  }

  // Pattern 5: Week number — "week 6", "W06"
  const weekNumMatch = lower.match(/\b(?:week|w)\s*(\d{1,2})\b/);
  if (weekNumMatch) {
    const weekNum = parseInt(weekNumMatch[1]);
    // Assume current year
    const year = now.getFullYear();
    const weekFile = `${year}-W${String(weekNum).padStart(2, '0')}.md`;
    const weekPath = path.join(WEEKLY_DIR, weekFile);
    return {
      type: 'exact',
      dates: [],
      confidence: 0.9,
      matchedText: weekNumMatch[0],
      files: fs.existsSync(weekPath) ? [weekPath] : [],
    };
  }

  // Pattern 6: Month names without day — "in February", "during January"
  const monthOnlyMatch = lower.match(/\b(?:in|during)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/);
  if (monthOnlyMatch) {
    const month = MONTH_MAP[monthOnlyMatch[1].substring(0, 3)];
    if (month) {
      let year = now.getFullYear();
      const yearMatch = lower.match(/\b(20\d{2})\b/);
      if (yearMatch) year = parseInt(yearMatch[1]);
      
      // Get all daily files in that month
      const monthStr = String(month).padStart(2, '0');
      const prefix = `${year}-${monthStr}`;
      const dailyFiles = getDailyFilesForPrefix(prefix);
      const dates = dailyFiles.map(f => path.basename(f, '.md'));
      
      return {
        type: 'range',
        dates,
        range: { start: `${prefix}-01`, end: `${prefix}-31` },
        confidence: 0.7,
        matchedText: monthOnlyMatch[0],
        files: dailyFiles,
      };
    }
  }

  return noRef;
}

function getDatesInRange(start: Date, end: Date): string[] {
  const dates: string[] = [];
  const current = new Date(start.getTime());
  while (current <= end) {
    dates.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function getDailyFilesForPrefix(prefix: string): string[] {
  try {
    return fs.readdirSync(DAILY_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.md'))
      .map(f => path.join(DAILY_DIR, f));
  } catch { return []; }
}

/**
 * Resolve temporal ref to actual files on disk
 */
function resolveRef(ref: TemporalRef): TemporalRef {
  const files: string[] = [];
  
  for (const date of ref.dates) {
    const dailyPath = path.join(DAILY_DIR, `${date}.md`);
    if (fs.existsSync(dailyPath)) {
      files.push(dailyPath);
    }
  }

  // Also check weekly files
  if (ref.dates.length > 0) {
    const firstDate = new Date(ref.dates[0] + 'T00:00:00');
    const wn = getWeekNumber(firstDate);
    const weeklyPath = path.join(WEEKLY_DIR, `${wn.year}-W${String(wn.week).padStart(2, '0')}.md`);
    if (fs.existsSync(weeklyPath) && !files.includes(weeklyPath)) {
      files.push(weeklyPath);
    }
  }

  ref.files = files;
  return ref;
}

// ─── Search Enhancement ─────────────────────────────────────────────────────

interface TemporalSearchResult {
  path: string;
  text: string;
  rank: number;
  temporalBoost: number;      // multiplier applied
  originalRank: number;
  source: string;
}

/**
 * Perform temporally-enhanced BM25 search
 * 
 * Strategy:
 * 1. Parse temporal reference from query
 * 2. If temporal ref found → inject chunks from resolved files at top
 * 3. Also run BM25 on cleaned query for content matching
 * 4. Merge: temporal file chunks first, then keyword results (deduped)
 * 
 * For queries with both date and topic ("DeFi on Feb 10"), we get the best
 * of both: temporal routing finds the right file, BM25 finds the right content.
 */
function temporalSearch(query: string, limit: number = 10, referenceDate?: Date): TemporalSearchResult[] {
  const temporal = parseTemporalQuery(query, referenceDate);
  const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });

  const results: TemporalSearchResult[] = [];
  const seenTexts = new Set<string>();

  // STEP 1: If temporal ref detected, get chunks from matching files FIRST
  if (temporal.type !== 'none' && temporal.files.length > 0) {
    const cleanQuery = stripTemporalWords(query);
    const contentTokens = cleanQuery.match(/[A-Za-z0-9_]+/g)?.filter(
      t => t.length > 2 && !['what', 'did', 'the', 'how', 'was', 'were', 'are', 'has', 'had', 'have', 'been', 'being'].includes(t.toLowerCase())
    ) ?? [];

    for (const file of temporal.files) {
      const relPath = file.replace('/root/clawd/', '');
      
      try {
        // Get all chunks from this temporal file
        const allChunks = db.prepare(
          `SELECT path, source, text FROM chunks WHERE path = ? AND source='memory' ORDER BY start_line ASC`
        ).all(relPath);

        for (const chunk of allChunks) {
          const textKey = chunk.text?.substring(0, 100);
          if (seenTexts.has(textKey)) continue;
          seenTexts.add(textKey);
          
          // Score by content relevance within the temporal file
          let contentScore = 0;
          if (contentTokens.length > 0) {
            const lowerText = chunk.text?.toLowerCase() || '';
            for (const token of contentTokens) {
              if (lowerText.includes(token.toLowerCase())) {
                contentScore += 1;
              }
            }
            // Normalize: 0 to 1
            contentScore = contentScore / contentTokens.length;
          } else {
            // Pure temporal query — all chunks from file are equally relevant
            contentScore = 0.5;
          }
          
          results.push({
            path: chunk.path,
            text: chunk.text,
            // Use a very negative rank (good in BM25 terms) for temporal matches
            // Boost by both temporal confidence and content relevance
            rank: -100 * temporal.confidence * (0.5 + contentScore),
            temporalBoost: temporal.confidence * (1 + contentScore * 2),
            originalRank: 0,
            source: chunk.source,
          });
        }
      } catch {}
    }

    // Sort temporal results by content relevance (most relevant content first)
    results.sort((a, b) => a.rank - b.rank);
  }

  // STEP 2: Also run BM25 for keyword matching (catches non-temporal content)
  const cleanQuery = stripTemporalWords(query);
  const tokens = cleanQuery.match(/[A-Za-z0-9_]+/g)?.filter(Boolean) ?? [];
  
  if (tokens.length > 0) {
    const ftsQuery = tokens.map(t => `"${t}"`).join(' OR ');
    try {
      const ftsRows = db.prepare(
        `SELECT path, source, bm25(chunks_fts) AS rank, text
         FROM chunks_fts
         WHERE chunks_fts MATCH ? AND source='memory'
         ORDER BY rank ASC
         LIMIT ?`
      ).all(ftsQuery, limit * 2);

      for (const row of ftsRows) {
        const textKey = row.text?.substring(0, 100);
        if (seenTexts.has(textKey)) continue;
        seenTexts.add(textKey);
        
        // Check if this result is from a temporal file (boost it slightly)
        let boost = 1.0;
        if (temporal.type !== 'none' && temporal.files.length > 0) {
          const matchesTemporal = temporal.files.some(f => {
            const relPath = f.replace('/root/clawd/', '');
            return row.path === relPath;
          });
          if (matchesTemporal) boost = 2.0;
        }
        
        results.push({
          path: row.path,
          text: row.text,
          rank: row.rank / boost,
          temporalBoost: boost,
          originalRank: row.rank,
          source: row.source,
        });
      }
    } catch {}
  }

  db.close();

  // Final sort: temporal results naturally float to top due to very negative rank
  results.sort((a, b) => a.rank - b.rank);

  return results.slice(0, limit);
}

/**
 * Strip temporal words from query so remaining keywords get better BM25 matches
 */
function stripTemporalWords(query: string): string {
  const temporalWords = [
    'today', 'yesterday', 'tomorrow',
    'last', 'this', 'next', 'past',
    'week', 'month', 'day', 'days',
    'ago', 'recent', 'recently',
    'when', 'what time', 'date',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  ];
  
  let cleaned = query.toLowerCase();
  // Don't strip month names as they're often part of file names
  for (const word of temporalWords) {
    cleaned = cleaned.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

// ─── Benchmark ──────────────────────────────────────────────────────────────

interface TemporalTest {
  query: string;
  expectedFile: string;       // partial match on filename
  expectedContent: string;    // content that should appear
  importance: 'critical' | 'high' | 'medium';
  description: string;
}

const TEMPORAL_TESTS: TemporalTest[] = [
  // Exact date queries
  {
    query: "what happened on February 5",
    expectedFile: "2026-02-05.md",
    expectedContent: "Foundation",
    importance: 'critical',
    description: 'Exact date lookup — Foundation Day'
  },
  {
    query: "what did I do on February 11",
    expectedFile: "2026-02-11.md",
    expectedContent: "Consolidation",
    importance: 'critical',
    description: 'Exact date lookup — recent day'
  },
  {
    query: "February 6 breakthrough",
    expectedFile: "2026-02-06.md",
    expectedContent: "memory",
    importance: 'critical',
    description: 'Date + keyword combo'
  },
  {
    query: "events on Feb 8",
    expectedFile: "2026-02-08.md",
    expectedContent: "Infrastructure",
    importance: 'high',
    description: 'Abbreviated month + day'
  },
  {
    query: "what happened Feb 10",
    expectedFile: "2026-02-10.md",
    expectedContent: "Kamino",
    importance: 'high',
    description: 'Recent date lookup'
  },

  // Relative date queries  
  {
    query: "what did I do today",
    expectedFile: "2026-02-12.md",
    expectedContent: "",
    importance: 'high',
    description: 'Today reference'
  },
  {
    query: "what happened yesterday",
    expectedFile: "2026-02-11.md",
    expectedContent: "",
    importance: 'high',
    description: 'Yesterday reference'
  },

  // Range queries
  {
    query: "what did I do this week",
    expectedFile: "2026-W07",
    expectedContent: "",
    importance: 'high',
    description: 'This week range query'
  },
  {
    query: "last week summary",
    expectedFile: "2026-W06",
    expectedContent: "",
    importance: 'high',
    description: 'Last week range'
  },

  // Week number
  {
    query: "week 6 summary",
    expectedFile: "2026-W06",
    expectedContent: "Foundation",
    importance: 'medium',
    description: 'Explicit week number'
  },

  // Date + topic combos (hardest)
  {
    query: "DeFi work on February 10",
    expectedFile: "2026-02-10.md",
    expectedContent: "Kamino",
    importance: 'critical',
    description: 'Date + topic intersection'
  },
  {
    query: "memory work on Feb 11",
    expectedFile: "2026-02-11.md",
    expectedContent: "benchmark",
    importance: 'critical',
    description: 'Date + topic intersection — memory'
  },
  {
    query: "decisions made on February 12",
    expectedFile: "2026-02-12.md",
    expectedContent: "Regression",
    importance: 'high',
    description: 'Date + decision query'
  },
];

function runBenchmark(referenceDate?: Date): void {
  const refDate = referenceDate || new Date('2026-02-12T12:30:00Z');
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🕐 TEMPORAL MEMORY BENCHMARK');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Reference date: ${formatDate(refDate)}`);
  console.log(`   Tests: ${TEMPORAL_TESTS.length}`);
  console.log('');

  // First: test date parsing
  console.log('── Date Parser Tests ──');
  let parsePass = 0;
  let parseTotal = 0;
  
  const parserTests = [
    { input: 'what happened on February 5', expect: '2026-02-05' },
    { input: 'events Feb 11th', expect: '2026-02-11' },
    { input: 'on 5th February', expect: '2026-02-05' },
    { input: 'today', expect: formatDate(refDate) },
    { input: 'yesterday', expect: formatDate(addDays(refDate, -1)) },
    { input: '3 days ago', expect: formatDate(addDays(refDate, -3)) },
    { input: 'this week', expect: 'range' },
    { input: 'last week', expect: 'range' },
    { input: 'week 6', expect: 'W06' },
  ];

  for (const pt of parserTests) {
    parseTotal++;
    const ref = parseTemporalQuery(pt.input, refDate);
    let pass = false;
    if (pt.expect === 'range') {
      pass = ref.type === 'range';
    } else if (pt.expect.startsWith('W')) {
      pass = ref.files.some(f => f.includes(pt.expect));
    } else {
      pass = ref.dates.includes(pt.expect);
    }
    if (pass) parsePass++;
    console.log(`   ${pass ? '✅' : '❌'} "${pt.input}" → ${ref.dates.length > 0 ? ref.dates[0] : ref.type} (${ref.type}, conf=${ref.confidence})`);
  }
  console.log(`   Parser: ${parsePass}/${parseTotal} passed`);
  console.log('');

  // Then: test temporal search
  console.log('── Temporal Search Tests ──');
  let searchPass = 0;
  
  for (const test of TEMPORAL_TESTS) {
    const results = temporalSearch(test.query, 5, refDate);
    
    const topResult = results[0];
    const matchIdx = results.findIndex(r => 
      r.path.includes(test.expectedFile) ||
      (test.expectedContent && r.text?.toLowerCase().includes(test.expectedContent.toLowerCase()))
    );
    
    const found = matchIdx >= 0;
    const rank = found ? matchIdx + 1 : -1;
    if (found) searchPass++;
    
    const imp = { critical: '🔴', high: '🟠', medium: '🟡' }[test.importance];
    const icon = found ? '✅' : '❌';
    const rankStr = found ? `#${rank}` : 'MISS';
    const boostStr = found ? ` boost=${results[matchIdx].temporalBoost.toFixed(1)}x` : '';
    
    console.log(`   ${icon} ${imp} [${rankStr}] ${test.query}`);
    if (!found && topResult) {
      console.log(`      Expected: ${test.expectedFile}`);
      console.log(`      Got: ${topResult.path} (rank=${topResult.rank.toFixed(2)})`);
    }
    if (found && rank > 1) {
      console.log(`      ⚠️ Not #1 — got ${topResult?.path} first`);
    }
  }
  
  console.log('');
  console.log('───────────────────────────────────────');
  console.log(`   📊 Parser: ${parsePass}/${parseTotal} | Search: ${searchPass}/${TEMPORAL_TESTS.length}`);
  console.log(`   🕐 Temporal coverage: ${Math.round((searchPass / TEMPORAL_TESTS.length) * 100)}%`);
  console.log('═══════════════════════════════════════════════════════════');

  // Save results
  const resultsPath = path.join('/root/clawd/skills/memory-manager', 'temporal-benchmark-history.json');
  let history: any[] = [];
  try { history = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')); } catch {}
  history.push({
    timestamp: new Date().toISOString(),
    referenceDate: formatDate(refDate),
    parser: { passed: parsePass, total: parseTotal },
    search: { passed: searchPass, total: TEMPORAL_TESTS.length },
    score: Math.round((searchPass / TEMPORAL_TESTS.length) * 100),
  });
  if (history.length > 20) history = history.slice(-20);
  fs.writeFileSync(resultsPath, JSON.stringify(history, null, 2));
  console.log(`   💾 Saved to ${resultsPath}`);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'test';
  
  if (cmd === 'parse') {
    const query = args.slice(1).join(' ');
    if (!query) {
      console.log('Usage: temporal.ts parse "query with date reference"');
      process.exit(1);
    }
    const ref = parseTemporalQuery(query);
    console.log(JSON.stringify(ref, null, 2));
  }
  else if (cmd === 'search') {
    const query = args.slice(1).join(' ');
    if (!query) {
      console.log('Usage: temporal.ts search "what happened on Feb 5"');
      process.exit(1);
    }
    const results = temporalSearch(query);
    console.log(`\n🕐 Temporal search: "${query}"\n`);
    const ref = parseTemporalQuery(query);
    if (ref.type !== 'none') {
      console.log(`   Detected: ${ref.type} → ${ref.dates.join(', ') || ref.matchedText}`);
      console.log(`   Files: ${ref.files.map(f => path.basename(f)).join(', ') || 'none found'}`);
      console.log('');
    }
    for (const [i, r] of results.entries()) {
      const boost = r.temporalBoost > 1 ? ` ⏰${r.temporalBoost.toFixed(1)}x` : '';
      console.log(`   #${i + 1} ${path.basename(r.path)}${boost}`);
      console.log(`      ${r.text?.substring(0, 100)}...`);
    }
  }
  else if (cmd === 'test') {
    runBenchmark();
  }
  else {
    console.log('Usage: temporal.ts [parse|search|test] [query]');
  }
}

// Export for use by other modules
export { parseTemporalQuery, temporalSearch, stripTemporalWords, TemporalRef };

main();
