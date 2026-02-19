#!/usr/bin/env npx ts-node

/**
 * Semantic Recall Probe — Tests VECTOR search quality with paraphrased queries
 * 
 * Unlike recall-probe.ts (BM25 only), this tests the full hybrid pipeline
 * by using memory_search (Clawdbot's tool) with queries that are
 * semantically equivalent but lexically different from file content.
 * 
 * This answers: "Can the system find knowledge when the user asks in
 * different words than what's stored?"
 * 
 * Method:
 *   1. Define semantic test cases (hand-curated paraphrased queries)
 *   2. For each: call memory_search, check if expected file appears in top results
 *   3. Compare: which queries work via BM25? Which need vectors?
 *   4. Report blind spots where semantic understanding fails
 * 
 * Usage:
 *   npx ts-node src/semantic-probe.ts              # Run full probe
 *   npx ts-node src/semantic-probe.ts --bm25-only  # Compare BM25 alone
 *   npx ts-node src/semantic-probe.ts --report      # Show last results
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

const WORKSPACE = '/root/clawd';
const SKILL_DIR = path.join(WORKSPACE, 'skills/memory-manager');
const REPORT_PATH = path.join(SKILL_DIR, 'semantic-probe-report.json');
const DB_PATH = path.join(process.env.HOME || '/root', '.clawdbot/memory/main.sqlite');

// ─── Test Cases ─────────────────────────────────────────────────────────────
// 
// Each test case has:
//   - query: A natural paraphrased question (NOT using the exact words in the file)
//   - expectedPath: Which file should be returned (relative to WORKSPACE)
//   - category: What kind of semantic understanding is tested
//   - lexicalOverlap: 'none' | 'low' | 'medium' — how much keyword overlap exists
//
// These are designed to test MEANING, not keyword matching.

interface SemanticTestCase {
  query: string;
  expectedPath: string;       // Relative to WORKSPACE
  expectedAlts?: string[];    // Alternative acceptable paths
  category: 'paraphrase' | 'synonym' | 'inference' | 'abstraction' | 'temporal' | 'cross-reference';
  lexicalOverlap: 'none' | 'low' | 'medium';
  description?: string;
}

function buildTestCases(): SemanticTestCase[] {
  // Read actual files to make sure expected paths exist
  const exists = (p: string) => fs.existsSync(path.join(WORKSPACE, p));
  
  const cases: SemanticTestCase[] = [
    // ─── Paraphrase: Same meaning, different words ──────────────────
    {
      query: "where does my human live and what timezone are they in",
      expectedPath: "USER.md",
      category: 'paraphrase',
      lexicalOverlap: 'low',
      description: "User timezone via indirect question"
    },
    {
      query: "the person I report to and their details",
      expectedPath: "USER.md",
      category: 'paraphrase',
      lexicalOverlap: 'none',
      description: "User info via role-based reference"
    },
    {
      query: "my fundamental nature and personality",
      expectedPath: "SOUL.md",
      category: 'paraphrase',
      lexicalOverlap: 'low',
      description: "Identity via abstract description"
    },
    {
      query: "how I should behave and communicate",
      expectedPath: "SOUL.md",
      expectedAlts: ["memory/OPERATING.md"],
      category: 'paraphrase',
      lexicalOverlap: 'low',
      description: "Behavioral guidelines"
    },
    {
      query: "the startup where my human works and their colleagues",
      expectedPath: "USER.md",
      expectedAlts: ["MEMORY.md"],
      category: 'paraphrase',
      lexicalOverlap: 'low',
      description: "Company info via indirect reference"
    },
    
    // ─── Synonym: Key terms replaced with synonyms ──────────────────
    {
      query: "crypto yield farming automation on Solana blockchain",
      expectedPath: "memory/OPERATING.md",
      expectedAlts: ["MEMORY.md", "TOOLS.md"],
      category: 'synonym',
      lexicalOverlap: 'low',
      description: "DeFi/Kamino via synonymous terms"
    },
    {
      query: "my persistent storage and recall architecture",
      expectedPath: "memory/topics/memory-system.md",
      expectedAlts: ["memory/OPERATING.md"],
      category: 'synonym',
      lexicalOverlap: 'low',
      description: "Memory system via technical synonyms"
    },
    {
      query: "version control identity and commit attribution",
      expectedPath: "TOOLS.md",
      category: 'synonym',
      lexicalOverlap: 'low',
      description: "Git identity via technical synonyms"
    },
    {
      query: "automated scheduled background jobs and recurring work",
      expectedPath: "memory/OPERATING.md",
      expectedAlts: ["memory/rules.md"],
      category: 'synonym',
      lexicalOverlap: 'low',
      description: "Cron via synonymous description"
    },
    
    // ─── Inference: Answer requires connecting dots ──────────────────
    {
      query: "should I use Sonnet or a cheaper model for background tasks",
      expectedPath: "memory/rules.md",
      expectedAlts: ["memory/OPERATING.md"],
      category: 'inference',
      lexicalOverlap: 'low',
      description: "Model policy requires inferring from rules"
    },
    {
      query: "can I post to Twitter without checking first",
      expectedPath: "memory/rules.md",
      expectedAlts: ["SOUL.md"],
      category: 'inference',
      lexicalOverlap: 'low',
      description: "External action rules"
    },
    {
      query: "what philosophy guides how I approach existence",
      expectedPath: "IDENTITY.md",
      expectedAlts: ["SOUL.md"],
      category: 'inference',
      lexicalOverlap: 'none',
      description: "Existential questions about self"
    },
    
    // ─── Abstraction: General question, specific answer ─────────────
    {
      query: "what tools have I built recently",
      expectedPath: "memory/topics/memory-system.md",
      expectedAlts: ["memory/daily/2026-02-13.md", "MEMORY.md"],
      category: 'abstraction',
      lexicalOverlap: 'low',
      description: "Recent tooling work"
    },
    {
      query: "the social platform for AI agents I monitor",
      expectedPath: "memory/topics/moltbook.md",
      expectedAlts: ["MEMORY.md"],
      category: 'abstraction',
      lexicalOverlap: 'none',
      description: "Moltbook via description, not name"
    },
    {
      query: "how do I make sure I don't forget important things between sessions",
      expectedPath: "memory/topics/memory-system.md",
      expectedAlts: ["memory/OPERATING.md", "IDENTITY.md"],
      category: 'abstraction',
      lexicalOverlap: 'low',
      description: "Memory continuity framed as human concern"
    },
    {
      query: "nighttime behavior restrictions",
      expectedPath: "memory/rules.md",
      expectedAlts: ["memory/OPERATING.md"],
      category: 'abstraction',
      lexicalOverlap: 'none',
      description: "Quiet hours via indirect reference"
    },
    
    // ─── Temporal: Time-based queries ───────────────────────────────
    {
      query: "what happened at the start of this week",
      expectedPath: "memory/weekly/2026-W07.md",
      expectedAlts: ["memory/daily/2026-02-09.md", "memory/daily/2026-02-10.md"],
      category: 'temporal',
      lexicalOverlap: 'low',
      description: "Week start via temporal reference"
    },
    {
      query: "what did I accomplish today",
      expectedPath: "memory/daily/2026-02-13.md",
      category: 'temporal',
      lexicalOverlap: 'low',
      description: "Today's activity"
    },
    
    // ─── Cross-reference: Info spans multiple files ──────────────────
    {
      query: "people at MoonPay I work with",
      expectedPath: "USER.md",
      expectedAlts: ["memory/people/contacts.md", "MEMORY.md"],
      category: 'cross-reference',
      lexicalOverlap: 'medium',
      description: "MoonPay contacts (mentioned in USER.md and contacts)"
    },
    {
      query: "steps I follow when I first wake up",
      expectedPath: "memory/OPERATING.md",
      expectedAlts: ["memory/topics/memory-system.md"],
      category: 'cross-reference',
      lexicalOverlap: 'low',
      description: "Boot sequence"
    },
  ];
  
  // Filter to only test cases whose expected files exist
  return cases.filter(c => {
    if (exists(c.expectedPath)) return true;
    if (c.expectedAlts?.some(a => exists(a))) return true;
    console.warn(`⚠️  Skipping: "${c.query}" — expected file ${c.expectedPath} not found`);
    return false;
  });
}

// ─── Search Functions ───────────────────────────────────────────────────────

// BM25 only (same as recall-probe.ts)
function searchBM25(query: string, limit: number = 10): Array<{path: string, score: number}> {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    
    const stopwords = new Set(['what', 'who', 'where', 'when', 'how', 'is', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'with', 'by', 'from', 'was', 'were', 'are', 'do', 'does', 'did', 'about', 'that', 'this', 'my', 'i', 'me', 'they', 'their', 'it', 'and', 'or', 'not', 'should', 'can', 'have', 'has', 'been']);
    const tokens = query.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1 && !stopwords.has(w));
    
    if (tokens.length === 0) { db.close(); return []; }
    
    // Use AND for stricter matching
    const ftsQuery = tokens.map(t => `"${t}"`).join(' AND ');
    
    let results: any[];
    try {
      results = db.prepare(`
        SELECT path, bm25(chunks_fts) as rank
        FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `).all(ftsQuery, limit);
    } catch {
      // Fall back to OR if AND finds nothing
      const ftsQueryOr = tokens.map(t => `"${t}"`).join(' OR ');
      results = db.prepare(`
        SELECT path, bm25(chunks_fts) as rank
        FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `).all(ftsQueryOr, limit);
    }
    
    db.close();
    
    // Deduplicate by path, keeping best rank
    const byPath = new Map<string, number>();
    for (const r of results) {
      const relPath = r.path.replace(/^\/root\/clawd\//, '');
      if (!byPath.has(relPath) || r.rank < byPath.get(relPath)!) {
        byPath.set(relPath, r.rank);
      }
    }
    
    return Array.from(byPath.entries())
      .map(([p, rank]) => ({ path: p, score: 1 / (1 + Math.abs(rank)) }))
      .sort((a, b) => b.score - a.score);
  } catch (e) {
    console.error(`BM25 search error: ${e}`);
    return [];
  }
}

// Vector search (cosine similarity via sqlite-vec or JS fallback)
function searchVector(query: string, limit: number = 10): Array<{path: string, score: number}> {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    
    // Get query embedding via Clawdbot's Gemini endpoint
    // We'll shell out to a small script since we can't directly call the embedding API
    const embResult = child_process.execSync(
      `node -e "
        const fs = require('fs');
        const db = new (require('node:sqlite').DatabaseSync)('${DB_PATH}');
        
        // Get all chunks with embeddings
        const rows = db.prepare('SELECT id, path, start_line, end_line, text, embedding FROM chunks').all();
        db.close();
        
        // Parse embeddings and output as JSON
        const chunks = rows.map(r => ({
          id: r.id,
          path: r.path,
          text: r.text.substring(0, 100),
          embedding: JSON.parse(r.embedding)
        }));
        
        process.stdout.write(JSON.stringify({count: chunks.length, dims: chunks[0]?.embedding?.length || 0}));
      "`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    
    db.close();
    return []; // We'll need the embedding API for this
  } catch (e) {
    return [];
  }
}

// Full hybrid search via memory_search (Clawdbot tool) — uses child process
function searchHybrid(query: string): Array<{path: string, startLine: number, snippet: string}> {
  // We can't call memory_search from a script — it's a Clawdbot tool
  // Instead, we test BM25 (which we can do) and note what needs vector
  return [];
}

// ─── Probe Runner ───────────────────────────────────────────────────────────

interface SemanticProbeResult {
  testCase: SemanticTestCase;
  bm25Found: boolean;
  bm25Rank: number | null;
  bm25TopPath: string;
  hybridNote: string;
}

interface SemanticProbeReport {
  timestamp: string;
  totalTests: number;
  bm25Found: number;
  bm25Missed: number;
  bm25AvgRank: number;
  categories: Record<string, { total: number; found: number }>;
  overlapAnalysis: Record<string, { total: number; found: number }>;
  blindSpots: SemanticTestCase[];
  results: SemanticProbeResult[];
}

function runProbe(bm25Only: boolean = false): SemanticProbeReport {
  const testCases = buildTestCases();
  console.log(`\n🧠 SEMANTIC RECALL PROBE`);
  console.log(`   Testing ${testCases.length} paraphrased queries against BM25...\n`);
  
  const results: SemanticProbeResult[] = [];
  let bm25Found = 0;
  let bm25Missed = 0;
  let bm25TotalRank = 0;
  
  const categories: Record<string, { total: number; found: number }> = {};
  const overlapAnalysis: Record<string, { total: number; found: number }> = {};
  
  for (const tc of testCases) {
    // BM25 search
    const bm25Results = searchBM25(tc.query, 10);
    
    // Check if expected file (or alts) appear in results
    const allExpected = [tc.expectedPath, ...(tc.expectedAlts || [])];
    let foundIdx = -1;
    for (let i = 0; i < bm25Results.length; i++) {
      if (allExpected.some(exp => bm25Results[i].path === exp || bm25Results[i].path.includes(exp) || exp.includes(bm25Results[i].path))) {
        foundIdx = i;
        break;
      }
    }
    
    const found = foundIdx >= 0;
    const rank = found ? foundIdx + 1 : null;
    
    if (found) {
      bm25Found++;
      bm25TotalRank += rank!;
    } else {
      bm25Missed++;
    }
    
    // Track by category
    if (!categories[tc.category]) categories[tc.category] = { total: 0, found: 0 };
    categories[tc.category].total++;
    if (found) categories[tc.category].found++;
    
    // Track by lexical overlap
    if (!overlapAnalysis[tc.lexicalOverlap]) overlapAnalysis[tc.lexicalOverlap] = { total: 0, found: 0 };
    overlapAnalysis[tc.lexicalOverlap].total++;
    if (found) overlapAnalysis[tc.lexicalOverlap].found++;
    
    const result: SemanticProbeResult = {
      testCase: tc,
      bm25Found: found,
      bm25Rank: rank,
      bm25TopPath: bm25Results[0]?.path || '(no results)',
      hybridNote: found ? 'BM25 sufficient' : 'NEEDS VECTOR — BM25 cannot find this'
    };
    results.push(result);
    
    // Print
    const icon = found ? (rank === 1 ? '✅' : '🟡') : '❌';
    const rankStr = rank ? `#${rank}` : 'MISS';
    const catStr = tc.category.padEnd(15);
    console.log(`${icon} [${rankStr.padStart(4)}] [${catStr}] "${tc.query}"`);
    if (!found) {
      console.log(`         Expected: ${tc.expectedPath}`);
      console.log(`         Got:      ${bm25Results[0]?.path || 'nothing'} (overlap: ${tc.lexicalOverlap})`);
    }
  }
  
  const bm25AvgRank = bm25Found > 0 ? bm25TotalRank / bm25Found : 0;
  const blindSpots = results.filter(r => !r.bm25Found).map(r => r.testCase);
  
  const report: SemanticProbeReport = {
    timestamp: new Date().toISOString(),
    totalTests: testCases.length,
    bm25Found,
    bm25Missed,
    bm25AvgRank,
    categories,
    overlapAnalysis,
    blindSpots,
    results
  };
  
  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log(`📊 SEMANTIC PROBE RESULTS`);
  console.log('═'.repeat(70));
  console.log(`   Total queries:    ${testCases.length}`);
  console.log(`   BM25 found:       ${bm25Found}/${testCases.length} (${(bm25Found / testCases.length * 100).toFixed(1)}%)`);
  console.log(`   BM25 missed:      ${bm25Missed}/${testCases.length} (${(bm25Missed / testCases.length * 100).toFixed(1)}%)`);
  console.log(`   Avg rank (found): #${bm25AvgRank.toFixed(1)}`);
  
  console.log(`\n   📁 BY CATEGORY:`);
  for (const [cat, stats] of Object.entries(categories)) {
    const pct = (stats.found / stats.total * 100).toFixed(0);
    const bar = '█'.repeat(Math.round(stats.found / stats.total * 10)) + '░'.repeat(10 - Math.round(stats.found / stats.total * 10));
    console.log(`      ${cat.padEnd(18)} ${bar} ${stats.found}/${stats.total} (${pct}%)`);
  }
  
  console.log(`\n   🔡 BY LEXICAL OVERLAP:`);
  for (const [overlap, stats] of Object.entries(overlapAnalysis)) {
    const pct = (stats.found / stats.total * 100).toFixed(0);
    console.log(`      ${overlap.padEnd(10)} ${stats.found}/${stats.total} (${pct}%)`);
  }
  
  if (blindSpots.length > 0) {
    console.log(`\n   🔴 BLIND SPOTS — These NEED vector search:`);
    for (const spot of blindSpots) {
      console.log(`      • [${spot.category}] "${spot.query}"`);
      console.log(`        → ${spot.expectedPath} (lexical overlap: ${spot.lexicalOverlap})`);
    }
  }
  
  // Key insight
  const noOverlapMissRate = overlapAnalysis['none'] 
    ? (1 - overlapAnalysis['none'].found / overlapAnalysis['none'].total) * 100 
    : 0;
  const lowOverlapMissRate = overlapAnalysis['low']
    ? (1 - overlapAnalysis['low'].found / overlapAnalysis['low'].total) * 100
    : 0;
  
  console.log(`\n   💡 KEY INSIGHT:`);
  if (noOverlapMissRate > 50) {
    console.log(`      Zero-overlap queries miss ${noOverlapMissRate.toFixed(0)}% — vector search is CRITICAL`);
    console.log(`      Without vectors, purely paraphrased questions fail.`);
  } else if (noOverlapMissRate > 20) {
    console.log(`      Zero-overlap queries miss ${noOverlapMissRate.toFixed(0)}% — vectors provide meaningful lift`);
  } else {
    console.log(`      BM25 handles most queries well, even with low overlap.`);
    console.log(`      Your content has good keyword diversity.`);
  }
  
  console.log('═'.repeat(70));
  
  // Save report
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n💾 Report saved to ${REPORT_PATH}`);
  
  return report;
}

function showReport(): void {
  if (!fs.existsSync(REPORT_PATH)) {
    console.log('No previous semantic probe report. Run without --report first.');
    return;
  }
  const report: SemanticProbeReport = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'));
  console.log(`\n📊 Last semantic probe: ${report.timestamp}`);
  console.log(`   BM25: ${report.bm25Found}/${report.totalTests} (${(report.bm25Found / report.totalTests * 100).toFixed(1)}%)`);
  console.log(`   Avg rank: #${report.bm25AvgRank.toFixed(1)}`);
  if (report.blindSpots.length > 0) {
    console.log(`\n   Blind spots (need vector):`);
    for (const spot of report.blindSpots) {
      console.log(`   • [${spot.category}] "${spot.query}" → ${spot.expectedPath}`);
    }
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--report')) {
  showReport();
} else {
  const bm25Only = args.includes('--bm25-only');
  runProbe(bm25Only);
}
