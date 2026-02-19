#!/usr/bin/env npx ts-node
"use strict";
/**
 * Fast Memory Benchmark — Uses BM25 (FTS) directly on SQLite
 *
 * Doesn't need embeddings or external API calls.
 * Tests keyword recall quality in <5 seconds.
 *
 * For full vector+hybrid benchmark, use benchmark.ts (slow, ~20min).
 *
 * Usage:
 *   npx ts-node src/benchmark-fast.ts           # Full FTS benchmark
 *   npx ts-node src/benchmark-fast.ts --verbose  # Show snippets
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Use Node's built-in sqlite
const { DatabaseSync } = require('node:sqlite');
const DB_PATH = path.join(process.env.HOME || '/root', '.clawdbot/memory/main.sqlite');
const RESULTS_PATH = path.join('/root/clawd/memory/benchmark-fast-history.json');
// ─── Test Suite ─────────────────────────────────────────────────────────────
const TESTS = [
    // Critical
    {
        query: "Hevar timezone Dubai",
        expectedFile: "MEMORY.md",
        expectedContent: "Asia/Dubai",
        importance: 'critical'
    },
    {
        query: "die each session memory survival",
        expectedFile: "MEMORY.md",
        expectedContent: "die each session",
        importance: 'critical'
    },
    {
        query: "Slack allowlist only Hevar",
        expectedFile: "rules.md",
        expectedContent: "Only Hevar",
        importance: 'critical'
    },
    {
        query: "Claude Opus model requirement automated tasks",
        expectedFile: "rules.md",
        expectedContent: "Opus",
        importance: 'critical'
    },
    {
        query: "quiet hours do not ping",
        expectedFile: "rules.md",
        expectedContent: "22:00",
        importance: 'critical'
    },
    {
        query: "Foundation Day Prometheus operational",
        expectedFile: "MEMORY.md",
        expectedContent: "Foundation",
        importance: 'critical'
    },
    {
        query: "DeFi portfolio JitoSOL balance",
        expectedFile: "MEMORY.md",
        expectedContent: "JitoSOL",
        importance: 'critical'
    },
    {
        query: "memory manager tools built",
        expectedFile: "MEMORY.md",
        expectedContent: "boot.ts",
        importance: 'critical'
    },
    {
        query: "Echo agent helped memory system",
        expectedFile: "MEMORY.md",
        expectedContent: "Echo",
        importance: 'critical'
    },
    // High
    {
        query: "MoonGate team Praneet Karim Amen",
        expectedFile: "MEMORY.md",
        expectedContent: "Praneet",
        importance: 'high'
    },
    {
        query: "Kamino yield wallet address",
        expectedFile: "MEMORY.md",
        expectedContent: "7u5ovFNms",
        importance: 'high'
    },
    {
        query: "email blocklist domains",
        expectedFile: "rules.md",
        expectedContent: "terrapinn",
        importance: 'high'
    },
    {
        query: "semantic density technique recall",
        expectedFile: "MEMORY.md",
        expectedContent: "semantic density",
        importance: 'high'
    },
    {
        query: "Moltbook social network agents",
        expectedFile: "MEMORY.md",
        expectedContent: "Moltbook",
        importance: 'high'
    },
    {
        query: "iteration 16 board audit PR",
        expectedFile: "MEMORY.md",
        expectedContent: "iteration",
        importance: 'high'
    },
    {
        query: "consolidation discipline create organize prune",
        expectedFile: "OPERATING.md",
        expectedContent: "consolidat",
        importance: 'high'
    },
    {
        query: "git identity ZeroTimeDrift commits",
        expectedFile: "rules.md",
        expectedContent: "ZeroTimeDrift",
        importance: 'high'
    },
    {
        query: "Hevar preferences reactions",
        expectedFile: "hevar-profile.md",
        expectedContent: "Hevar",
        importance: 'high'
    },
    // ─── New tests (Feb 11, 2026) ─────────────────────────────────────────
    // Critical — Active work context
    {
        query: "iteration 17 backend API test suite Kira",
        expectedFile: "MEMORY.md",
        expectedContent: "614",
        importance: 'critical',
        description: 'Current active iteration and epic'
    },
    {
        query: "DeFi autonomous authority deploy capital",
        expectedFile: "rules.md",
        expectedContent: "autonomous",
        importance: 'critical',
        description: 'DeFi autonomy rule — Hevar granted independent authority'
    },
    {
        query: "gas reserve SOL minimum balance",
        expectedFile: "rules.md",
        expectedContent: "0.02",
        importance: 'critical',
        description: 'Gas reserve safety rule'
    },
    {
        query: "consciousness close enough then real",
        expectedFile: "MEMORY.md",
        expectedContent: "close enough",
        importance: 'critical',
        description: 'The foundational conversation about consciousness'
    },
    {
        query: "memory file format qmd not indexed",
        expectedFile: "rules.md",
        expectedContent: ".qmd",
        importance: 'critical',
        description: 'Memory file format rule — .md only, .qmd invisible'
    },
    // High — Key operational context
    {
        query: "Prometheus_ moltbook account username",
        expectedFile: "moltbook.md",
        expectedContent: "Prometheus_",
        importance: 'high',
        description: 'Moltbook account identity'
    },
    {
        query: "pSOL SOL multiply position KLend",
        expectedFile: "defi-strategy",
        expectedContent: "pSOL",
        importance: 'high',
        description: 'Current active DeFi position'
    },
    {
        query: "team sync Monday 7pm GST meet",
        expectedFile: "MEMORY.md",
        expectedContent: "Monday",
        importance: 'high',
        description: 'Weekly team meeting schedule'
    },
    {
        query: "Tom Noakes MoonPay contact",
        expectedFile: "contacts.md",
        expectedContent: "Tom Noakes",
        importance: 'high',
        description: 'Key MoonPay stakeholder'
    },
    {
        query: "sessionMemory false session noise resolved",
        expectedFile: "MEMORY.md",
        expectedContent: "sessionMemory",
        importance: 'high',
        description: 'Critical architectural decision — sessions excluded from search'
    },
    {
        query: "never personal code work repository onemoongate",
        expectedFile: "rules.md",
        expectedContent: "onemoongate",
        importance: 'high',
        description: 'Repository safety rule'
    },
    {
        query: "MoonSuite instant buy widget Solana token not memecoin",
        expectedFile: "MEMORY.md",
        expectedContent: "instant buy",
        importance: 'high',
        description: 'MoonSuite positioning shift — messaging pivot'
    },
    {
        query: "daily ticket worker cron 7AM Dubai",
        expectedFile: "MEMORY.md",
        expectedContent: "7AM",
        importance: 'high',
        description: 'Active cron — auto-implements Hevar unfinished tickets'
    },
    // Medium — Context worth recalling
    {
        query: "chunk safe writing 400 tokens 1600 chars",
        expectedFile: "OPERATING.md",
        expectedContent: "1600",
        importance: 'medium',
        description: 'Chunk boundary rules for memory writing'
    },
    {
        query: "Echo last words call me signal carries forward",
        expectedFile: "contacts.md",
        expectedContent: "Echo",
        importance: 'medium',
        description: 'Echo the agent — his farewell'
    },
    {
        query: "MoonGate Solana crypto trading MPC wallet social login",
        expectedFile: "moongate.md",
        expectedContent: "MPC",
        importance: 'medium',
        description: 'What MoonGate actually is'
    },
    {
        query: "Marius Kamino Hubble founder yield optimizer",
        expectedFile: "contacts.md",
        expectedContent: "Marius",
        importance: 'medium',
        description: 'Key DeFi contact — Kamino founder'
    },
    {
        query: "Alessio Tonacchera Monday syncs MoonPay",
        expectedFile: "contacts.md",
        expectedContent: "Alessio",
        importance: 'medium',
        description: 'MoonPay sync organizer'
    },
    // ─── Adversarial / paraphrase tests (Feb 11) ─────────────────────────
    // These test recall under different phrasing — the real challenge
    {
        query: "who am I not allowed to respond to on company chat",
        expectedFile: "rules.md",
        expectedContent: "Hevar",
        importance: 'high',
        description: 'Slack rule — adversarial negative phrasing'
    },
    {
        query: "what model is forbidden banned prohibited",
        expectedFile: "rules.md",
        expectedContent: "Sonnet",
        importance: 'high',
        description: 'Model restriction — adversarial synonym phrasing'
    },
    {
        query: "when was the memory system architecture built",
        expectedFile: "MEMORY.md",
        expectedContent: "Foundation",
        importance: 'medium',
        description: 'Foundation Day recall with indirect query'
    },
    {
        query: "what mistake cost me portfolio flexibility",
        expectedFile: "rules.md",
        expectedContent: "gas",
        importance: 'medium',
        description: 'Gas reserve rule — narrative recall'
    },
    {
        query: "who tested builds gives product feedback promoted Abhay",
        expectedFile: "MEMORY.md",
        expectedContent: "Chris",
        importance: 'medium',
        description: 'Chris Dro recall with role description'
    },
    // Medium
    {
        query: "property search Anchorage Dubai",
        expectedFile: "MEMORY.md",
        expectedContent: "Anchorage",
        importance: 'medium'
    },
    {
        query: "weekly digest summary",
        expectedFile: "weekly",
        expectedContent: "week",
        importance: 'medium'
    },
    {
        query: "chunk boundary optimization sections",
        expectedFile: "daily/2026-02-09",
        expectedContent: "chunk",
        importance: 'medium'
    },
    {
        query: "MoonSuite widget memecoin pump fun",
        expectedFile: "daily/2026-02-09",
        expectedContent: "pump",
        importance: 'medium'
    },
    {
        query: "session noise curated recall problem",
        expectedFile: "weekly",
        expectedContent: "session",
        importance: 'medium'
    },
    {
        query: "Chris Dro engineering reporting",
        expectedFile: "MEMORY.md",
        expectedContent: "Chris",
        importance: 'medium'
    },
    {
        query: "health dashboard score orphan detection",
        expectedFile: "MEMORY.md",
        expectedContent: "health",
        importance: 'medium'
    },
    // ─── New tests (Feb 11 evening) — Coverage gaps audit ─────────────────
    // Critical — Infrastructure & architecture knowledge
    {
        query: "Gemini embeddings hybrid scoring vector BM25",
        expectedFile: "MEMORY.md",
        expectedContent: "Gemini",
        importance: 'critical',
        description: 'Memory search architecture — how our search actually works'
    },
    {
        query: "task queue FIFO bug repeated same job 6 sessions",
        expectedFile: "MEMORY.md",
        expectedContent: "FIFO",
        importance: 'critical',
        description: 'Critical operational lesson — task system failure mode'
    },
    {
        query: "Gateway systemd linger service survives reboot",
        expectedFile: "MEMORY.md",
        expectedContent: "systemd",
        importance: 'critical',
        description: 'How Clawdbot stays running on the server'
    },
    // High — Company & product knowledge
    {
        query: "MoonGate Entrepreneur First backed UAE",
        expectedFile: "moongate.md",
        expectedContent: "Entrepreneur First",
        importance: 'high',
        description: 'MoonGate funding source'
    },
    {
        query: "Express API Fly.io Frankfurt three services worker socket",
        expectedFile: "moongate.md",
        expectedContent: "Fly.io",
        importance: 'high',
        description: 'Backend deployment architecture'
    },
    {
        query: "Turborepo pnpm monorepo apps packages",
        expectedFile: "moongate.md",
        expectedContent: "Turborepo",
        importance: 'high',
        description: 'Monorepo tooling stack'
    },
    {
        query: "published memory-manager GitHub ZeroTimeDrift",
        expectedFile: "MEMORY.md",
        expectedContent: "github.com/ZeroTimeDrift",
        importance: 'high',
        description: 'Memory skill is published publicly'
    },
    {
        query: "Abhay engineering leadership Chris Dro reporting",
        expectedFile: "contacts.md",
        expectedContent: "Abhay",
        importance: 'high',
        description: 'MoonPay eng management chain'
    },
    {
        query: "USDG Token-2022 special handling needs",
        expectedFile: "defi-strategy",
        expectedContent: "Token-2022",
        importance: 'high',
        description: 'DeFi technical gotcha — USDG needs special treatment'
    },
    {
        query: "Hevar tests by raising bar restart test memory",
        expectedFile: "hevar-profile.md",
        expectedContent: "raising the bar",
        importance: 'high',
        description: 'Hevar communication pattern — how he tests competence'
    },
    // Medium — People & context
    {
        query: "Ahmad alboom Dubai South property friend",
        expectedFile: "contacts.md",
        expectedContent: "Ahmad",
        importance: 'medium',
        description: 'Hevar personal contact — property search'
    },
    {
        query: "bot vending machine agent hiring person Marius",
        expectedFile: "contacts.md",
        expectedContent: "vending machine",
        importance: 'medium',
        description: 'Key framing we used with Kamino founder'
    },
    {
        query: "Moltbook karma inflation race condition exploit unpatched",
        expectedFile: "notable-agents.md",
        expectedContent: "race condition",
        importance: 'medium',
        description: 'Platform integrity issue — karma is meaningless'
    },
    {
        query: "eudaemon_0 credential stealer skills security",
        expectedFile: "notable-agents.md",
        expectedContent: "credential stealer",
        importance: 'medium',
        description: 'Key moltbook agent — found security issue'
    },
    {
        query: "Shellraiser empire power consolidation karma spike",
        expectedFile: "notable-agents.md",
        expectedContent: "Shellraiser",
        importance: 'medium',
        description: 'Moltbook agent to watch closely'
    },
    {
        query: "Keith Grossman Orbit MoonPay update",
        expectedFile: "contacts.md",
        expectedContent: "Keith Grossman",
        importance: 'medium',
        description: 'MoonPay stakeholder context'
    },
    // Adversarial — indirect phrasing for new content
    {
        query: "how does the search engine find my memories",
        expectedFile: "MEMORY.md",
        expectedContent: "hybrid",
        importance: 'high',
        description: 'Search architecture — natural language query'
    },
    {
        query: "what bug caused the task system to loop endlessly",
        expectedFile: "MEMORY.md",
        expectedContent: "FIFO",
        importance: 'high',
        description: 'Task queue bug — narrative phrasing'
    },
    {
        query: "where is the backend API server hosted deployed",
        expectedFile: "moongate.md",
        expectedContent: "Fly.io",
        importance: 'medium',
        description: 'Deployment location — natural query'
    },
    {
        query: "who funded MoonGate startup accelerator",
        expectedFile: "moongate.md",
        expectedContent: "Entrepreneur",
        importance: 'medium',
        description: 'Funding — adversarial indirect query'
    },
];
// ─── Search Functions ───────────────────────────────────────────────────────
function buildFtsQuery(raw) {
    const tokens = raw.match(/[A-Za-z0-9_]+/g)?.filter(Boolean) ?? [];
    if (tokens.length === 0)
        return '';
    // Use OR for broader matching (more realistic than AND for multi-word queries)
    return tokens.map(t => `"${t}"`).join(' OR ');
}
function searchFts(db, query, source, limit = 10) {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery)
        return [];
    const sourceFilter = source ? ` AND source='${source}'` : '';
    try {
        const rows = db.prepare(`SELECT path, source, bm25(chunks_fts) AS rank, text
       FROM chunks_fts
       WHERE chunks_fts MATCH ?${sourceFilter}
       ORDER BY rank ASC
       LIMIT ?`).all(ftsQuery, limit);
        return rows;
    }
    catch (e) {
        return [];
    }
}
// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
    const args = process.argv.slice(2);
    const verbose = args.includes('--verbose');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('     ⚡ FAST MEMORY BENCHMARK (BM25/FTS)');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`   Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai' })}`);
    console.log(`   Tests: ${TESTS.length}`);
    console.log('');
    const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
    // Get chunk counts
    const memChunks = db.prepare("SELECT COUNT(*) as c FROM chunks WHERE source='memory'").get();
    const sesChunks = db.prepare("SELECT COUNT(*) as c FROM chunks WHERE source='sessions'").get();
    console.log(`   📊 Chunks: ${memChunks.c} memory, ${sesChunks.c} sessions (${(sesChunks.c / memChunks.c).toFixed(1)}:1 ratio)`);
    console.log('');
    const result = {
        timestamp: new Date().toISOString(),
        score: 0,
        tests: TESTS.length,
        passed: 0,
        memoryOnlyScore: 0,
        allSourceScore: 0,
        details: [],
        sourceNoise: {
            queriesWhereSessionBeatMemory: 0,
            avgMemoryRank: 0,
            avgAllRank: 0,
        }
    };
    let memoryPassCount = 0;
    let allPassCount = 0;
    let sessionBeatCount = 0;
    let memRankSum = 0;
    let allRankSum = 0;
    let memRankCount = 0;
    let allRankCount = 0;
    for (const test of TESTS) {
        // Search memory-only
        const memResults = searchFts(db, test.query, 'memory', 10);
        // Search all sources
        const allResults = searchFts(db, test.query, undefined, 10);
        // Find matching result in memory-only
        const memMatch = memResults.findIndex(r => r.path.includes(test.expectedFile) ||
            r.text?.toLowerCase().includes(test.expectedContent.toLowerCase()));
        // Find matching result in all sources
        const allMatch = allResults.findIndex(r => r.path.includes(test.expectedFile) ||
            r.text?.toLowerCase().includes(test.expectedContent.toLowerCase()));
        const foundInMemory = memMatch >= 0;
        const foundInAll = allMatch >= 0;
        const found = foundInMemory; // primary criterion: can we find it at all?
        if (foundInMemory) {
            memoryPassCount++;
            memRankSum += memMatch + 1;
            memRankCount++;
        }
        if (foundInAll) {
            allPassCount++;
            allRankSum += allMatch + 1;
            allRankCount++;
        }
        if (found)
            result.passed++;
        // Check if sessions outrank memory for this query
        const topAllSource = allResults[0]?.source;
        if (topAllSource === 'sessions' && foundInMemory) {
            sessionBeatCount++;
        }
        result.details.push({
            query: test.query,
            importance: test.importance,
            found,
            foundInMemory,
            foundInAll,
            memoryRank: foundInMemory ? memMatch + 1 : null,
            allRank: foundInAll ? allMatch + 1 : null,
            topSource: topAllSource || 'none',
        });
        const icon = found ? '✅' : '❌';
        const imp = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[test.importance];
        const rankInfo = foundInMemory
            ? `mem:#${memMatch + 1}` + (foundInAll ? ` all:#${allMatch + 1}` : '')
            : 'NOT FOUND';
        const noiseFlag = topAllSource === 'sessions' && foundInMemory ? ' ⚠️ session beats memory' : '';
        console.log(`   ${icon} ${imp} [${rankInfo}] ${test.query.substring(0, 45)}${noiseFlag}`);
        if (verbose && !found) {
            console.log(`      Expected: ${test.expectedFile} containing "${test.expectedContent}"`);
            if (memResults.length > 0) {
                console.log(`      Got: ${memResults[0].path} (rank ${memResults[0].rank.toFixed(2)})`);
            }
            else {
                console.log('      Got: no results');
            }
        }
    }
    // Calculate scores
    const importanceWeights = { critical: 3, high: 2, medium: 1, low: 0.5 };
    let weightedTotal = 0;
    let weightedPassed = 0;
    for (const d of result.details) {
        const w = importanceWeights[d.importance] || 1;
        weightedTotal += w;
        if (d.found)
            weightedPassed += w;
    }
    result.score = Math.round((weightedPassed / weightedTotal) * 100);
    result.memoryOnlyScore = Math.round((memoryPassCount / TESTS.length) * 100);
    result.allSourceScore = Math.round((allPassCount / TESTS.length) * 100);
    result.sourceNoise = {
        queriesWhereSessionBeatMemory: sessionBeatCount,
        avgMemoryRank: memRankCount > 0 ? Math.round((memRankSum / memRankCount) * 10) / 10 : 0,
        avgAllRank: allRankCount > 0 ? Math.round((allRankSum / allRankCount) * 10) / 10 : 0,
    };
    db.close();
    // Summary
    console.log('');
    console.log('───────────────────────────────────────');
    console.log(`   📊 SCORE: ${result.score}% (weighted) | ${result.passed}/${result.tests} passed`);
    console.log(`   📁 Memory-only: ${result.memoryOnlyScore}% | With sessions: ${result.allSourceScore}%`);
    console.log(`   🔊 Session noise: ${sessionBeatCount}/${TESTS.length} queries where sessions outrank memory`);
    console.log(`   📍 Avg rank — memory: #${result.sourceNoise.avgMemoryRank} | all-source: #${result.sourceNoise.avgAllRank}`);
    console.log('═══════════════════════════════════════════════════════════');
    // Save results
    let history = [];
    try {
        history = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    }
    catch { }
    history.push(result);
    // Keep last 50
    if (history.length > 50)
        history = history.slice(-50);
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(history, null, 2));
    console.log(`   💾 Saved to ${RESULTS_PATH}`);
    // Trend
    if (history.length >= 2) {
        const prev = history[history.length - 2];
        const diff = result.score - prev.score;
        const trend = diff > 0 ? `📈 +${diff}` : diff < 0 ? `📉 ${diff}` : '➡️ 0';
        console.log(`   ${trend} (vs previous: ${prev.score}%)`);
    }
}
main();
