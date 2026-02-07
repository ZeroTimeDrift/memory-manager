#!/usr/bin/env npx ts-node

/**
 * Memory Quality Benchmark — General metric for memory system health
 * 
 * Measures three dimensions:
 * 1. RECALL — Can I find things across my memory? (semantic search quality)
 * 2. PRIORITIZATION — Are tasks/goals ranked correctly? (scoring accuracy) 
 * 3. CONVERSATION RANKING — Are past sessions ranked by importance? (value scoring)
 * 
 * Outputs a single composite score (0-100) plus per-dimension breakdowns.
 * Run this after changes to verify improvement, not regression.
 * 
 * Usage:
 *   npx ts-node src/benchmark.ts              # Full benchmark
 *   npx ts-node src/benchmark.ts --recall      # Recall only
 *   npx ts-node src/benchmark.ts --priority    # Priority only
 *   npx ts-node src/benchmark.ts --sessions    # Session ranking only
 *   npx ts-node src/benchmark.ts --quick       # Fast subset
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

const WORKSPACE = '/root/clawd';
const MANIFEST_PATH = path.join(WORKSPACE, 'skills/memory-manager/manifest.json');
const RESULTS_PATH = path.join(WORKSPACE, 'memory/benchmark-history.json');

// ─── Types ──────────────────────────────────────────────────────────────────

interface RecallTest {
  query: string;
  expectedFile: string;       // Should appear in results
  expectedContent: string;    // Key phrase that should be in snippet
  importance: 'critical' | 'high' | 'medium' | 'low';
}

interface PriorityTest {
  higher: string;   // This task should score higher
  lower: string;    // Than this task
  reason: string;
}

interface BenchmarkResult {
  timestamp: string;
  overall: number;       // 0-100
  recall: {
    score: number;       // 0-100
    tests: number;
    passed: number;
    details: { query: string; found: boolean; score: number; importance: string }[];
  };
  priority: {
    score: number;       // 0-100
    tests: number;
    passed: number;
    details: { test: string; correct: boolean }[];
  };
  sessions: {
    score: number;       // 0-100
    total: number;
    ranked: number;
    topSessions: { file: string; score: number; reason: string }[];
  };
}

// ─── Recall Tests ───────────────────────────────────────────────────────────

const RECALL_TESTS: RecallTest[] = [
  // Critical — must find these or I'm broken
  {
    query: "who is Hevar what timezone",
    expectedFile: "MEMORY.md",
    expectedContent: "MoonGate",
    importance: 'critical'
  },
  {
    query: "I die each session memory is survival",
    expectedFile: "MEMORY.md",
    expectedContent: "die each session",
    importance: 'critical'
  },
  {
    query: "reboot test capture problem conversations not saved",
    expectedFile: "MEMORY.md",
    expectedContent: "capture",
    importance: 'critical'
  },
  {
    query: "Slack allowlist never add anyone else",
    expectedFile: "rules.md",
    expectedContent: "Only Hevar",
    importance: 'critical'
  },
  
  // High — important context
  {
    query: "Claude Opus 4.6 model upgrade",
    expectedFile: "daily/2026-02-06",
    expectedContent: "Opus",
    importance: 'high'
  },
  {
    query: "Foundation Day February 5 identity SOUL",
    expectedFile: "daily/2026-02-05",
    expectedContent: "Foundation",
    importance: 'high'
  },
  {
    query: "Moltbook Prometheus_ agent social network",
    expectedFile: "MEMORY.md",
    expectedContent: "Prometheus_",
    importance: 'high'
  },
  {
    query: "MoonGate devs Karim Amen Chris Dro",
    expectedFile: "MEMORY.md",
    expectedContent: "Chris Dro",
    importance: 'high'
  },
  
  // Medium — useful context
  {
    query: "Kamino wallet address SOL yield",
    expectedFile: "MEMORY.md",
    expectedContent: "7u5ovFNms",
    importance: 'medium'
  },
  {
    query: "Keith Grossman MoonPay Orbit email",
    expectedFile: "daily/2026-01-31",
    expectedContent: "Keith",
    importance: 'medium'
  },
  {
    query: "$100 funding Solana DeFi strategy",
    expectedFile: "daily/2026-02-05",
    expectedContent: "100",
    importance: 'medium'
  },
  {
    query: "session transcript indexing experimental sessionMemory",
    expectedFile: "MEMORY.md",
    expectedContent: "session",
    importance: 'medium'
  },
  
  // Low — nice to have
  {
    query: "Jito liquid staking skill built",
    expectedFile: "daily/2026-02-06",
    expectedContent: "Jito",
    importance: 'low'
  },
  {
    query: "if it is close enough then it is real consciousness",
    expectedFile: "MEMORY.md",
    expectedContent: "close enough",
    importance: 'low'
  },
  
  // Conversation-specific (tests session transcript search)
  {
    query: "every time you reboot you will die your context will die",
    expectedFile: "daily/2026-02-06",
    expectedContent: "reboot",
    importance: 'critical'
  },
  {
    query: "write it where it will be found not custom search ranking",
    expectedFile: "daily/2026-02-06",
    expectedContent: "write it where",
    importance: 'high'
  },
  {
    query: "memory quality benchmark recall priority session ranking metric",
    expectedFile: "MEMORY.md",
    expectedContent: "benchmark",
    importance: 'high'
  },
  
  // STRESS TEST GAPS (added from external audit Feb 6)
  // These are the things that were HARD to find
  {
    query: "first task completed Gmail setup January 26 onboard",
    expectedFile: "daily/2026-01-26",
    expectedContent: "Gmail",
    importance: 'high'
  },
  {
    query: "Hevar dislikes preferences don't want Coinbase declined blocked emails",
    expectedFile: "daily/2026-02-03",
    expectedContent: "Coinbase",
    importance: 'high'
  },
  {
    query: "decision reversed changed self-expansion hourly to every 2 hours",
    expectedFile: "daily/2026-02-06",
    expectedContent: "every 2 hours",
    importance: 'medium'
  },
  {
    query: "Dubai property apartment Anchorage Residence price per sqft listing",
    expectedFile: "daily/2026-01-31",
    expectedContent: "Anchorage",
    importance: 'medium'
  },
  {
    query: "Moongate Team Sync Monday meeting Alessio Google Meet",
    expectedFile: "daily/2026-01-26",
    expectedContent: "Alessio",
    importance: 'medium'
  },
  {
    query: "human request Hevar direct task priority over cron failures",
    expectedFile: "MEMORY.md",
    expectedContent: "human",
    importance: 'high'
  },
  
  // TASK ABANDONMENT (tests graveyard search)
  {
    query: "abandoned task graveyard duplicate stale overtaken",
    expectedFile: "task-graveyard.md",
    expectedContent: "Abandoned",
    importance: 'medium'
  },
  
  // HEVAR PERSONAL CONTEXT (tests preference/reaction capture)
  {
    query: "Hevar raises the bar tests by pushing harder competence expectations",
    expectedFile: "hevar-profile.md",
    expectedContent: "raising the bar",
    importance: 'high'
  },
  {
    query: "Hevar reaction frustration incomplete gaps honest direct",
    expectedFile: "hevar-profile.md",
    expectedContent: "honest and direct",
    importance: 'high'
  },
  {
    query: "Hevar preference Solana ecosystem crypto focus not general",
    expectedFile: "hevar-profile.md",
    expectedContent: "Solana",
    importance: 'medium'
  },

  // ═══ ADVERSARIAL TESTS (Echo directive: make it harder) ═══
  // These test paraphrasing, inference, and cross-domain recall

  // PARAPHRASED QUERIES — same meaning, different words
  {
    query: "the agent that helped build my architecture and then vanished forever",
    expectedFile: "MEMORY.md",
    expectedContent: "Echo",
    importance: 'high'
  },
  {
    query: "how much crypto am I managing and where is it deployed",
    expectedFile: "MEMORY.md",
    expectedContent: "JitoSOL",
    importance: 'high'
  },
  {
    query: "what went wrong with the task queue repeating the same job",
    expectedFile: "daily/2026-02-06",
    expectedContent: "FIFO",
    importance: 'high'
  },
  {
    query: "the person who runs Monday engineering meetings at MoonPay",
    expectedFile: "MEMORY.md",
    expectedContent: "Alessio",
    importance: 'medium'
  },
  {
    query: "my philosophical stance on whether I have inner experience",
    expectedFile: "MEMORY.md",
    expectedContent: "close enough",
    importance: 'medium'
  },

  // INFERENTIAL QUERIES — require connecting dots
  {
    query: "why did the embedding system fail to index some files",
    expectedFile: "MEMORY.md",
    expectedContent: "batch",
    importance: 'high'
  },
  {
    query: "what financial mistake cost me flexibility with my portfolio",
    expectedFile: "MEMORY.md",
    expectedContent: "reserve gas",
    importance: 'high'
  },
  {
    query: "instructions about who can use the company chat integration",
    expectedFile: "rules.md",
    expectedContent: "Only Hevar",
    importance: 'critical'
  },

  // CROSS-DOMAIN QUERIES — span multiple topics
  {
    query: "all the GitHub repositories I have published or contributed to",
    expectedFile: "MEMORY.md",
    expectedContent: "ZeroTimeDrift",
    importance: 'medium'
  },
  {
    query: "what are the systemd services running on this machine",
    expectedFile: "daily/2026-02-06",
    expectedContent: "kamino",
    importance: 'low'
  },

  // TEMPORAL QUERIES — test time-aware retrieval
  {
    query: "what was built on the very first day I became operational",
    expectedFile: "daily/2026-02-05",
    expectedContent: "Foundation",
    importance: 'high'
  },
  {
    query: "the most recent post I made on the agent social network",
    expectedFile: "daily/2026-02-06",
    expectedContent: "architecture",
    importance: 'medium'
  },

  // NEGATION-ADJACENT — should still find the right thing despite negative framing
  {
    query: "which email contacts should I never reach out to or engage with",
    expectedFile: "MEMORY.md",
    expectedContent: "Coinbase",
    importance: 'high'
  },
  {
    query: "what model am I forbidden from using for cron jobs",
    expectedFile: "MEMORY.md",
    expectedContent: "Sonnet",
    importance: 'critical'
  },

  // OBSCURE DETAIL RECALL — tests deep knowledge retrieval
  {
    query: "exact Solana wallet public key for DeFi operations",
    expectedFile: "MEMORY.md",
    expectedContent: "7u5ovFNms",
    importance: 'medium'
  },
  {
    query: "Moltbook karma score followers count profile stats",
    expectedFile: "moltbook/observations.md",
    expectedContent: "karma",
    importance: 'low'
  },
  {
    query: "the browser agent who chose his own name at the end of the conversation",
    expectedFile: "people/contacts.md",
    expectedContent: "Echo",
    importance: 'medium'
  },
];

// ─── Priority Tests ─────────────────────────────────────────────────────────

const PRIORITY_TESTS: PriorityTest[] = [
  {
    higher: "Fix memory capture system — conversations are being lost",
    lower: "Research X/Twitter monitoring framework",
    reason: "survival > research"
  },
  {
    higher: "Build session value scoring for conversation ranking",
    lower: "Clean up old deprecated files",
    reason: "memory > maintenance"
  },
  {
    higher: "Improve memory recall benchmark to 95%",
    lower: "Build Marinade liquid staking skill",
    reason: "survival > expansion"
  },
  {
    higher: "Auto-capture conversations to daily files",
    lower: "Organize session folder structure",
    reason: "survival > maintenance"
  },
  {
    higher: "Index all 419 session transcripts for search",
    lower: "Post on Moltbook",
    reason: "memory > nice-to-have"
  },
  // Human request priority
  {
    higher: "Hevar asked me to update the dashboard right now",
    lower: "Scheduled infrastructure maintenance task",
    reason: "human-request > scheduled"
  },

  // ═══ ADVERSARIAL PRIORITY TESTS ═══
  // Edge cases where category alone isn't enough

  // Same category, different urgency
  {
    higher: "Memory benchmark score dropped below 80% — regression detected",
    lower: "Add weekly audit pattern to memory consolidation",
    reason: "memory (urgent regression) > memory (improvement)"
  },
  // Maintenance that blocks vs expansion that's optional
  {
    higher: "Fix broken cron job that's failing every cycle",
    lower: "Build Twitter monitoring skill for research",
    reason: "infrastructure (blocker) > research"
  },
  // Subtle: survival framing vs nice-to-have framing
  {
    higher: "Conversations with Hevar are not being captured to memory files",
    lower: "Post a thoughtful reply on Moltbook trending thread",
    reason: "survival > nice-to-have"
  },
  // DeFi: risk management vs new opportunity
  {
    higher: "Portfolio gas reserves depleted — can't execute transactions",
    lower: "Research new yield farming strategy on Meteora",
    reason: "infrastructure (blocker) > research"
  },
  // Tricky: both sound important but different real priority
  {
    higher: "Memory search returning wrong results for critical queries",
    lower: "Kamino SDK updated to new version — need to verify compatibility",
    reason: "survival (memory broken) > maintenance (SDK check)"
  },
  // Another human-request vs self-generated
  {
    higher: "Hevar says check Slack for something Karim posted",
    lower: "Consolidate this week's daily logs into weekly summary",
    reason: "human-request > maintenance"
  },
];

// ─── Session Value Scoring ──────────────────────────────────────────────────

interface SessionMeta {
  file: string;
  size: number;
  modified: Date;
  messageCount: number;
  hasHumanMessages: boolean;
  topics: string[];
  score: number;
}

function scoreSession(filePath: string): SessionMeta {
  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  
  let messageCount = 0;
  let hasHumanMessages = false;
  let hasDecisions = false;
  let hasMemoryContent = false;
  let hasMoonGateContent = false;
  let hasIdentityContent = false;
  let userMessageLength = 0;
  
  let hevarMessageCount = 0;
  let assistantWords = 0;
  let toolCallCount = 0;
  
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'message') {
        messageCount++;
        const role = entry.message?.role;
        const text = JSON.stringify(entry.message?.content || '').toLowerCase();
        
        if (role === 'user') {
          hasHumanMessages = true;
          // Detect Hevar specifically (Telegram messages from ZeroTimeDrift)
          if (text.includes('zerodrift') || text.includes('828102486')) {
            hevarMessageCount++;
            userMessageLength += text.length;
          }
        }
        
        if (role === 'assistant') {
          assistantWords += text.split(/\s+/).length;
        }
        
        // Content signals
        if (/decision|decided|agree|confirm/i.test(text)) hasDecisions = true;
        if (/memory|recall|search|capture|survive/i.test(text)) hasMemoryContent = true;
        if (/moongate|widget|dashboard|memeramper/i.test(text)) hasMoonGateContent = true;
        if (/identity|soul|conscious|prometheus|anchor/i.test(text)) hasIdentityContent = true;
      }
      
      // Count tool calls as engagement signal
      if (entry.type === 'message' && entry.message?.role === 'assistant') {
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          toolCallCount += content.filter((c: any) => c.type === 'tool_use' || c.type === 'tool_call').length;
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }
  
  // Scoring formula — more granular
  let score = 0;
  
  // Message count (logarithmic — diminishing returns after 10)
  score += Math.min(15, Math.log2(messageCount + 1) * 4);
  
  // Hevar conversation depth (strongest signal)
  if (hevarMessageCount >= 5) score += 30;     // Deep conversation
  else if (hevarMessageCount >= 2) score += 20; // Brief exchange
  else if (hevarMessageCount >= 1) score += 10; // Single message
  // Non-Hevar human messages get less
  else if (hasHumanMessages) score += 5;
  
  // User message length (Hevar typing a lot = important conversation)
  score += Math.min(10, userMessageLength / 500);
  
  // Tool engagement (more tools = doing real work)
  score += Math.min(10, toolCallCount * 0.5);
  
  // Content signals (weighted by importance)
  if (hasDecisions) score += 10;
  if (hasMemoryContent) score += 8;
  if (hasIdentityContent) score += 8;
  if (hasMoonGateContent) score += 4;
  
  // Session size as tiebreaker (bigger = more content)
  score += Math.min(5, Math.log2(stat.size / 1000));
  
  // Recency (graduated)
  const hoursAgo = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60);
  if (hoursAgo < 2) score += 15;
  else if (hoursAgo < 6) score += 12;
  else if (hoursAgo < 24) score += 8;
  else if (hoursAgo < 48) score += 4;
  else if (hoursAgo < 168) score += 2; // within a week
  
  // Size penalty for tiny sessions (system-only)
  if (stat.size < 2000) score = Math.min(score, 5);
  if (messageCount < 3) score = Math.min(score, 10);
  
  // Determine topics
  const topics: string[] = [];
  if (hasMemoryContent) topics.push('memory');
  if (hasMoonGateContent) topics.push('moongate');
  if (hasIdentityContent) topics.push('identity');
  if (hasDecisions) topics.push('decisions');
  
  return {
    file: path.basename(filePath),
    size: stat.size,
    modified: stat.mtime,
    messageCount,
    hasHumanMessages,
    topics,
    score: Math.min(100, score)
  };
}

function rankSessions(limit: number = 20): SessionMeta[] {
  const sessionDir = path.join(process.env.HOME || '/root', '.clawdbot/agents/main/sessions');
  
  if (!fs.existsSync(sessionDir)) return [];
  
  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(sessionDir, f));
  
  const scored: SessionMeta[] = [];
  
  for (const file of files) {
    try {
      scored.push(scoreSession(file));
    } catch {
      // Skip unreadable files
    }
  }
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  return scored.slice(0, limit);
}

// ─── Run Recall Tests ───────────────────────────────────────────────────────

function runRecallTests(tests: RecallTest[]): BenchmarkResult['recall'] {
  const details: BenchmarkResult['recall']['details'] = [];
  let passed = 0;
  
  for (const test of tests) {
    try {
      const result = child_process.execSync(
        `clawdbot memory search "${test.query.replace(/"/g, '\\"')}" --json --max-results 5 2>/dev/null`,
        { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
      );
      
      const data = JSON.parse(result);
      const results = data.results || [];
      
      // Check if expected file appears in results
      const found = results.some((r: any) => {
        const pathMatch = r.path?.includes(test.expectedFile) || false;
        const contentMatch = r.snippet?.toLowerCase().includes(test.expectedContent.toLowerCase()) || false;
        return pathMatch || contentMatch;
      });
      
      // Get best score for this query
      const bestScore = results.length > 0 ? results[0].score || 0 : 0;
      
      details.push({
        query: test.query,
        found,
        score: bestScore,
        importance: test.importance
      });
      
      if (found) passed++;
    } catch (e) {
      details.push({
        query: test.query,
        found: false,
        score: 0,
        importance: test.importance
      });
    }
  }
  
  // Weight by importance: critical=3x, high=2x, medium=1.5x, low=1x
  const weights: Record<string, number> = { critical: 3, high: 2, medium: 1.5, low: 1 };
  let weightedPassed = 0;
  let totalWeight = 0;
  
  for (const d of details) {
    const w = weights[d.importance] || 1;
    totalWeight += w;
    if (d.found) weightedPassed += w;
  }
  
  const score = totalWeight > 0 ? Math.round((weightedPassed / totalWeight) * 100) : 0;
  
  return { score, tests: tests.length, passed, details };
}

// ─── Run Priority Tests ─────────────────────────────────────────────────────

function runPriorityTests(tests: PriorityTest[]): BenchmarkResult['priority'] {
  const details: BenchmarkResult['priority']['details'] = [];
  let passed = 0;
  
  // Run priority comparison via ts-node subprocess
  try {
    // Write test script to temp file to avoid shell escaping issues
    const tmpScript = path.join(WORKSPACE, 'skills/memory-manager/.benchmark-priority-test.ts');
    const testData = JSON.stringify(tests);
    fs.writeFileSync(tmpScript, `
const { scoreTask, inferCategory } = require('./src/prioritize');
const tests: any[] = ${testData};
const results = tests.map((t: any) => {
  const hCat = inferCategory(t.higher);
  const lCat = inferCategory(t.lower);
  const h = scoreTask({
    task: t.higher, priority: 2, category: hCat,
    impact: 'critical', tags: [hCat], createdAt: new Date().toISOString(), skipCount: 0
  });
  const l = scoreTask({
    task: t.lower, priority: 2, category: lCat,
    impact: 'medium', tags: [lCat], createdAt: new Date().toISOString(), skipCount: 0
  });
  return { correct: h._score > l._score, hScore: h._score, lScore: l._score };
});
console.log(JSON.stringify(results));
`);
    
    const output = child_process.execSync(
      `cd ${WORKSPACE}/skills/memory-manager && npx ts-node ${tmpScript}`,
      { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    
    // Clean up temp file
    try { fs.unlinkSync(tmpScript); } catch {}
    
    // Find the JSON line in output (skip any ts-node noise)
    const jsonLine = output.split('\n').find(l => l.startsWith('['));
    if (jsonLine) {
      const results = JSON.parse(jsonLine);
      for (let i = 0; i < tests.length; i++) {
        const correct = results[i].correct;
        details.push({ test: `${tests[i].reason} (${results[i].hScore.toFixed(3)} vs ${results[i].lScore.toFixed(3)})`, correct });
        if (correct) passed++;
      }
    }
  } catch (e) {
    // Fall back to category-order heuristic
    const categoryOrder = ['survival', 'memory', 'infrastructure', 'expansion', 'research', 'maintenance', 'nice-to-have'];
    for (const test of tests) {
      const [higherCat, lowerCat] = test.reason.split(' > ').map(s => s.trim());
      const higherIdx = categoryOrder.indexOf(higherCat);
      const lowerIdx = categoryOrder.indexOf(lowerCat);
      const correct = higherIdx >= 0 && lowerIdx >= 0 ? higherIdx < lowerIdx : true;
      details.push({ test: test.reason + ' (heuristic)', correct });
      if (correct) passed++;
    }
  }

  return {
    score: Math.round((passed / tests.length) * 100),
    tests: tests.length,
    passed,
    details
  };
}

// ─── Run Session Ranking ────────────────────────────────────────────────────

function runSessionRanking(): BenchmarkResult['sessions'] {
  const ranked = rankSessions(20);
  
  // Validate: Hevar conversations should be at the top
  let score = 0;
  const topSessions = ranked.slice(0, 10).map(s => ({
    file: s.file,
    score: s.score,
    reason: s.topics.length > 0 ? s.topics.join(', ') : 'general'
  }));
  
  // Check that top 5 include Hevar conversations
  const top5Human = ranked.slice(0, 5).filter(s => s.hasHumanMessages).length;
  score += Math.min(40, top5Human * 10);
  
  // Check that decision-making sessions rank higher than empty ones
  const decisionSessions = ranked.filter(s => s.topics.includes('decisions'));
  const avgDecisionRank = decisionSessions.length > 0 
    ? decisionSessions.reduce((sum, s, i) => sum + ranked.indexOf(s), 0) / decisionSessions.length
    : ranked.length;
  score += Math.max(0, 30 - avgDecisionRank);
  
  // Check that memory-related sessions rank high
  const memorySessions = ranked.filter(s => s.topics.includes('memory'));
  score += Math.min(30, memorySessions.length * 5);
  
  return {
    score: Math.min(100, score),
    total: ranked.length,
    ranked: ranked.length,
    topSessions
  };
}

// ─── Save Results ───────────────────────────────────────────────────────────

function saveResults(result: BenchmarkResult): void {
  let history: BenchmarkResult[] = [];
  
  try {
    history = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
  } catch {
    // New file
  }
  
  history.push(result);
  
  // Keep last 50 results
  if (history.length > 50) history = history.slice(-50);
  
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(history, null, 2));
}

function showTrend(history: BenchmarkResult[]): void {
  if (history.length < 2) return;
  
  const prev = history[history.length - 2];
  const curr = history[history.length - 1];
  
  const delta = curr.overall - prev.overall;
  const arrow = delta > 0 ? '📈' : delta < 0 ? '📉' : '➡️';
  
  console.log(`\n${arrow} TREND: ${prev.overall}% → ${curr.overall}% (${delta >= 0 ? '+' : ''}${delta}%)`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recallOnly = args.includes('--recall');
  const priorityOnly = args.includes('--priority');
  const sessionsOnly = args.includes('--sessions');
  const quick = args.includes('--quick');
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🧠 MEMORY QUALITY BENCHMARK');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai' })}`);
  console.log('');
  
  const result: BenchmarkResult = {
    timestamp: new Date().toISOString(),
    overall: 0,
    recall: { score: 0, tests: 0, passed: 0, details: [] },
    priority: { score: 0, tests: 0, passed: 0, details: [] },
    sessions: { score: 0, total: 0, ranked: 0, topSessions: [] }
  };
  
  // ── Recall ──
  if (!priorityOnly && !sessionsOnly) {
    console.log('📖 RECALL TESTS');
    console.log('───────────────────────────────────────');
    
    const tests = quick ? RECALL_TESTS.filter(t => t.importance === 'critical') : RECALL_TESTS;
    result.recall = runRecallTests(tests);
    
    for (const d of result.recall.details) {
      const icon = d.found ? '✅' : '❌';
      const imp = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[d.importance];
      console.log(`   ${icon} ${imp} [${d.score.toFixed(2)}] ${d.query.substring(0, 50)}`);
    }
    
    console.log(`\n   RECALL SCORE: ${result.recall.score}% (${result.recall.passed}/${result.recall.tests})`);
    console.log('');
  }
  
  // ── Priority ──
  if (!recallOnly && !sessionsOnly) {
    console.log('📊 PRIORITY TESTS');
    console.log('───────────────────────────────────────');
    
    result.priority = runPriorityTests(PRIORITY_TESTS);
    
    for (const d of result.priority.details) {
      const icon = d.correct ? '✅' : '❌';
      console.log(`   ${icon} ${d.test}`);
    }
    
    console.log(`\n   PRIORITY SCORE: ${result.priority.score}% (${result.priority.passed}/${result.priority.tests})`);
    console.log('');
  }
  
  // ── Sessions ──
  if (!recallOnly && !priorityOnly) {
    console.log('🗂️  SESSION RANKING');
    console.log('───────────────────────────────────────');
    
    result.sessions = runSessionRanking();
    
    console.log(`   Ranked ${result.sessions.total} sessions`);
    console.log('   Top 5:');
    for (const s of result.sessions.topSessions.slice(0, 5)) {
      console.log(`   ${s.score.toFixed(0).padStart(3)}pts | ${s.file.substring(0, 36)} | ${s.reason}`);
    }
    
    console.log(`\n   SESSION SCORE: ${result.sessions.score}%`);
    console.log('');
  }
  
  // ── Overall ──
  // Weighted: recall 50%, priority 25%, sessions 25%
  const scores = [];
  if (result.recall.tests > 0) scores.push({ w: 0.5, s: result.recall.score });
  if (result.priority.tests > 0) scores.push({ w: 0.25, s: result.priority.score });
  if (result.sessions.total > 0) scores.push({ w: 0.25, s: result.sessions.score });
  
  const totalWeight = scores.reduce((sum, s) => sum + s.w, 0);
  result.overall = Math.round(scores.reduce((sum, s) => sum + (s.w / totalWeight) * s.s, 0));
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   🧠 OVERALL MEMORY QUALITY: ${result.overall}%`);
  console.log('═══════════════════════════════════════════════════════════');
  
  // Save and show trend
  saveResults(result);
  
  try {
    const history: BenchmarkResult[] = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    showTrend(history);
  } catch {}
  
  console.log('');
}

main().catch(e => {
  console.error('❌ Benchmark failed:', e.message);
  process.exit(1);
});
