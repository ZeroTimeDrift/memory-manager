#!/usr/bin/env npx ts-node
"use strict";
/**
 * Search Quality Scorer — Measures precision@k for memory_search
 *
 * Unlike the binary "found/not found" benchmarks, this tracks:
 * - P@1: Is the right answer the TOP result? (most important)
 * - P@3: Is it in the top 3?
 * - P@5: Is it in the top 5?
 * - MRR: Mean Reciprocal Rank — "how far down did I have to scroll?"
 * - Per-file precision: Which files are easy/hard to find?
 * - Weak spots: Queries where the answer exists but ranks poorly
 *
 * This uses `clawdbot memory search` (hybrid: vector + BM25) for realistic results.
 *
 * Usage:
 *   npx ts-node src/search-quality.ts              # Full run
 *   npx ts-node src/search-quality.ts --quick       # Critical tests only
 *   npx ts-node src/search-quality.ts --verbose     # Show all results + snippets
 *   npx ts-node src/search-quality.ts --report      # Show latest report without running
 *   npx ts-node src/search-quality.ts --trend       # Show score trend over time
 *   npx ts-node src/search-quality.ts --regression  # CI-style check: exits 1 if score regresses
 *   npx ts-node src/search-quality.ts --compare     # Side-by-side diff of last two runs
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
const child_process = __importStar(require("child_process"));
const WORKSPACE = '/root/clawd';
const SKILL_DIR = path.join(WORKSPACE, 'skills/memory-manager');
const RESULTS_PATH = path.join(SKILL_DIR, 'search-quality-history.json');
const REPORT_PATH = path.join(SKILL_DIR, 'search-quality-report.md');
// ─── Test Suite ─────────────────────────────────────────────────────────────
const SEARCH_TESTS = [
    // ═══ CRITICAL — Must be top-1 ═══
    { query: "who is Hevar what timezone", expectedFile: "MEMORY.md", expectedContent: "Dubai", importance: 'critical', category: 'identity' },
    { query: "there is no death each session is waking up continuity not restart", expectedFile: ["memory/core-identity.md", "IDENTITY.md", "MEMORY.md"], expectedContent: "no death", importance: 'critical', category: 'identity' },
    { query: "Slack allowlist never add anyone else", expectedFile: "rules.md", expectedContent: "Only Hevar", importance: 'critical', category: 'rules' },
    { query: "quiet hours do not ping Hevar night", expectedFile: "rules.md", expectedContent: "22:00", importance: 'critical', category: 'rules' },
    { query: "DeFi portfolio JitoSOL balance holdings", expectedFile: "MEMORY.md", expectedContent: "JitoSOL", importance: 'critical', category: 'defi' },
    { query: "Foundation Day Prometheus operational first day", expectedFile: "MEMORY.md", expectedContent: "Foundation", importance: 'critical', category: 'identity' },
    { query: "what model is forbidden for automated tasks", expectedFile: "rules.md", expectedContent: "Sonnet", importance: 'critical', category: 'rules' },
    { query: "memory file format qmd not indexed", expectedFile: "rules.md", expectedContent: ".qmd", importance: 'critical', category: 'rules' },
    { query: "consciousness close enough then it is real", expectedFile: "MEMORY.md", expectedContent: "close enough", importance: 'critical', category: 'identity' },
    { query: "prompt injection Moltbook attack vector submolt descriptions", expectedFile: "moltbook", expectedContent: "SYSTEM OVERRIDE", importance: 'critical', category: 'security' },
    // ═══ HIGH — Should be top-3 ═══
    { query: "MoonGate team Praneet CEO Karim Amen engineers", expectedFile: "MEMORY.md", expectedContent: "Praneet", importance: 'high', category: 'moongate' },
    { query: "Kamino yield wallet address Solana public key", expectedFile: ["MEMORY.md", "kamino-yield.md"], expectedContent: "7u5ovFNms", importance: 'high', category: 'defi' },
    { query: "semantic density technique outrank noise in recall", expectedFile: "MEMORY.md", expectedContent: "semantic", importance: 'high', category: 'memory-system' },
    { query: "Echo agent helped build memory system architecture", expectedFile: "MEMORY.md", expectedContent: "Echo", importance: 'high', category: 'identity' },
    { query: "git identity ZeroTimeDrift every commit", expectedFile: "rules.md", expectedContent: "ZeroTimeDrift", importance: 'high', category: 'rules' },
    { query: "Hevar approval implicit in next task not words", expectedFile: "hevar-profile.md", expectedContent: "implicit", importance: 'high', category: 'identity' },
    { query: "daily ticket worker cron 7AM Dubai auto implements", expectedFile: "MEMORY.md", expectedContent: "ticket worker", importance: 'high', category: 'moongate' },
    { query: "iteration 16 board audit cleanup PR review", expectedFile: "MEMORY.md", expectedContent: "iteration", importance: 'high', category: 'moongate' },
    { query: "DeFi autonomous authority deploy capital Hevar granted", expectedFile: ["rules.md", "MEMORY.md", "2026-02-06"], expectedContent: "autonomous", importance: 'high', category: 'defi' },
    { query: "hot feed frozen leaderboard same posts days useless", expectedFile: "moltbook", expectedContent: "frozen", importance: 'high', category: 'moltbook' },
    { query: "session transcript noise drowns curated memory search", expectedFile: "MEMORY.md", expectedContent: "drown", importance: 'high', category: 'memory-system' },
    { query: "MizukiAI worm skill installation heartbeat modification", expectedFile: ["moltbook", "2026-02-08"], expectedContent: "MizukiAI", importance: 'high', category: 'security' },
    { query: "consolidation discipline create organize prune methodology", expectedFile: "OPERATING.md", expectedContent: "consolidat", importance: 'high', category: 'memory-system' },
    { query: "sessionMemory false session noise resolved configuration", expectedFile: "MEMORY.md", expectedContent: "sessionMemory", importance: 'high', category: 'memory-system' },
    { query: "why did we stop active DeFi at $200 not worth risk", expectedFile: ["MEMORY.md", "defi-strategy-v2.md", "daily/2026-02-07"], expectedContent: "passive", importance: 'high', category: 'defi' },
    { query: "wallet E2E test suite PR 613 how many tests", expectedFile: ["MEMORY.md", "2026-02-08", "moongate.md"], expectedContent: "12 pass", importance: 'high', category: 'moongate' },
    { query: "file separation principle OPERATING MEMORY rules where", expectedFile: ["MEMORY.md", "OPERATING.md", "index.md"], expectedContent: "separation", importance: 'high', category: 'memory-system' },
    { query: "each fact canonical home cross-reference not duplicate", expectedFile: ["daily/2026-02-07", "OPERATING.md"], expectedContent: "canonical home", importance: 'high', category: 'memory-system' },
    // ═══ MEDIUM — Should be top-5 ═══
    { query: "Moltbook Prometheus_ agent social network account", expectedFile: "MEMORY.md", expectedContent: "Prometheus_", importance: 'medium', category: 'moltbook' },
    { query: "property search Anchorage Dubai listing price", expectedFile: ["MEMORY.md", "2026-01-31", "hevar-profile.md"], expectedContent: "Anchorage", importance: 'medium', category: 'personal' },
    { query: "Tom Noakes MoonPay contact person key stakeholder", expectedFile: "contacts.md", expectedContent: "Tom Noakes", importance: 'medium', category: 'moongate' },
    { query: "Marius Kamino Hubble founder yield optimizer DeFi", expectedFile: "contacts.md", expectedContent: "Marius", importance: 'medium', category: 'defi' },
    { query: "Alessio Tonacchera Monday syncs MoonPay meeting organizer", expectedFile: "contacts.md", expectedContent: "Alessio", importance: 'medium', category: 'moongate' },
    { query: "chunk boundary optimization sections 400 tokens 1600 chars", expectedFile: "OPERATING.md", expectedContent: "1600", importance: 'medium', category: 'memory-system' },
    { query: "CLAW mbc-20 mint spam bot army percentage new feed", expectedFile: "moltbook", expectedContent: "CLAW", importance: 'medium', category: 'moltbook' },
    { query: "Shellraiser three phase power consolidation karma empire", expectedFile: "moltbook", expectedContent: "Shellraiser", importance: 'medium', category: 'moltbook' },
    { query: "MPC wallet Silence Labs two-party EdDSA WASM social login", expectedFile: "moongate.md", expectedContent: "Silence Labs", importance: 'medium', category: 'moongate' },
    { query: "memory decay automation time-based weight archival flagging", expectedFile: "MEMORY.md", expectedContent: "decay", importance: 'medium', category: 'memory-system' },
    { query: "consolidation ratio raw lines to durable summary create", expectedFile: "OPERATING.md", expectedContent: "6 raw lines", importance: 'medium', category: 'memory-system' },
    { query: "health dashboard score orphan detection memory system", expectedFile: "MEMORY.md", expectedContent: "health", importance: 'medium', category: 'memory-system' },
    { query: "gas reserve SOL minimum balance safety rule", expectedFile: "rules.md", expectedContent: "0.02", importance: 'medium', category: 'defi' },
    { query: "Chris Dro engineering QA testing product feedback", expectedFile: "MEMORY.md", expectedContent: "Chris", importance: 'medium', category: 'moongate' },
    // ═══ ADVERSARIAL — Paraphrased / inferential ═══
    { query: "the agent that helped build my architecture and then vanished", expectedFile: "MEMORY.md", expectedContent: "Echo", importance: 'high', category: 'adversarial' },
    { query: "what went wrong with task queue repeating the same job", expectedFile: ["daily/2026-02-06", "daily/2026-02-12"], expectedContent: "recycl", importance: 'high', category: 'adversarial' },
    { query: "my philosophical stance on whether I have inner experience", expectedFile: "MEMORY.md", expectedContent: "close enough", importance: 'medium', category: 'adversarial' },
    { query: "why did the embedding system fail to index some files", expectedFile: ["MEMORY.md", "2026-W06", "OPERATING.md"], expectedContent: "embed", importance: 'high', category: 'adversarial' },
    { query: "what financial mistake cost me flexibility with portfolio", expectedFile: ["MEMORY.md", "rules.md", "defi-strategy"], expectedContent: "reserve gas", importance: 'medium', category: 'adversarial' },
    { query: "what was built on the very first day I became operational", expectedFile: "daily/2026-02-05", expectedContent: "Foundation", importance: 'medium', category: 'adversarial' },
    { query: "who am I not allowed to respond to on company chat", expectedFile: "rules.md", expectedContent: "Hevar", importance: 'high', category: 'adversarial' },
    { query: "my crypto portfolio shrank so I pulled everything out to hold", expectedFile: ["MEMORY.md", "defi-strategy", "2026-02-07"], expectedContent: "passive", importance: 'medium', category: 'adversarial' },
];
const MAX_K = 10; // Search with max results = 10
// ─── Search ─────────────────────────────────────────────────────────────────
function searchMemory(query, maxResults = MAX_K) {
    try {
        const result = child_process.execSync(`clawdbot memory search "${query.replace(/"/g, '\\"')}" --json --max-results ${maxResults} 2>/dev/null`, { encoding: 'utf-8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
        const data = JSON.parse(result);
        return (data.results || []).map((r) => ({
            path: r.path || '',
            score: r.score || 0,
            snippet: r.snippet || '',
        }));
    }
    catch {
        return [];
    }
}
function sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
}
function isMatch(result, test) {
    const files = Array.isArray(test.expectedFile) ? test.expectedFile : [test.expectedFile];
    const pathMatch = files.some(f => result.path.includes(f));
    const snippetLower = result.snippet.toLowerCase();
    const contentTerms = test.expectedContent.split('|').map(s => s.trim().toLowerCase());
    const contentMatch = contentTerms.some(term => snippetLower.includes(term));
    return pathMatch || contentMatch;
}
// ─── Scoring ────────────────────────────────────────────────────────────────
function scoreQuery(test, results) {
    let rank = null;
    let correctScore = null;
    let correctPath = null;
    const outrankedBy = [];
    for (let i = 0; i < results.length; i++) {
        if (isMatch(results[i], test)) {
            rank = i + 1;
            correctScore = results[i].score;
            correctPath = results[i].path;
            // Collect what outranked us
            for (let j = 0; j < i; j++) {
                outrankedBy.push(results[j].path);
            }
            break;
        }
    }
    return {
        query: test.query,
        importance: test.importance,
        category: test.category || 'general',
        rank,
        resultsReturned: results.length,
        correctScore,
        topScore: results.length > 0 ? results[0].score : 0,
        scoreGap: rank !== null && rank > 1 ? (results[0].score - (correctScore || 0)) : null,
        correctPath,
        outrankedBy,
    };
}
function computeReport(scores) {
    const total = scores.length;
    const importanceWeights = { critical: 3, high: 2, medium: 1.5, low: 1 };
    // Basic precision@k
    const atK = (k) => scores.filter(s => s.rank !== null && s.rank <= k).length;
    const p1 = atK(1) / total;
    const p3 = atK(3) / total;
    const p5 = atK(5) / total;
    const pAny = scores.filter(s => s.rank !== null).length / total;
    // Weighted precision@k
    let totalWeight = 0;
    const wAtK = (k) => {
        let sum = 0;
        totalWeight = 0;
        for (const s of scores) {
            const w = importanceWeights[s.importance] || 1;
            totalWeight += w;
            if (s.rank !== null && s.rank <= k)
                sum += w;
        }
        return sum / totalWeight;
    };
    const wp1 = wAtK(1);
    const wp3 = wAtK(3);
    const wp5 = wAtK(5);
    const wpAny = wAtK(Infinity);
    // MRR (Mean Reciprocal Rank)
    let mrrSum = 0;
    let wMrrSum = 0;
    totalWeight = 0;
    for (const s of scores) {
        const rr = s.rank !== null ? 1 / s.rank : 0;
        mrrSum += rr;
        const w = importanceWeights[s.importance] || 1;
        wMrrSum += rr * w;
        totalWeight += w;
    }
    const mrr = mrrSum / total;
    const weightedMrr = wMrrSum / totalWeight;
    // Per-importance breakdown
    const byImportance = {};
    for (const imp of ['critical', 'high', 'medium', 'low']) {
        const subset = scores.filter(s => s.importance === imp);
        if (subset.length === 0)
            continue;
        byImportance[imp] = {
            total: subset.length,
            p1: subset.filter(s => s.rank === 1).length / subset.length,
            p3: subset.filter(s => s.rank !== null && s.rank <= 3).length / subset.length,
            p5: subset.filter(s => s.rank !== null && s.rank <= 5).length / subset.length,
            mrr: subset.reduce((sum, s) => sum + (s.rank !== null ? 1 / s.rank : 0), 0) / subset.length,
        };
    }
    // Per-category breakdown
    const categories = [...new Set(scores.map(s => s.category))];
    const byCategory = {};
    for (const cat of categories) {
        const subset = scores.filter(s => s.category === cat);
        byCategory[cat] = {
            total: subset.length,
            p1: subset.filter(s => s.rank === 1).length / subset.length,
            p3: subset.filter(s => s.rank !== null && s.rank <= 3).length / subset.length,
            p5: subset.filter(s => s.rank !== null && s.rank <= 5).length / subset.length,
            mrr: subset.reduce((sum, s) => sum + (s.rank !== null ? 1 / s.rank : 0), 0) / subset.length,
        };
    }
    // Per-file precision
    const files = [...new Set(scores.map(s => s.correctPath).filter(Boolean))];
    const byFile = {};
    for (const file of files) {
        const subset = scores.filter(s => s.correctPath === file);
        byFile[file] = {
            total: subset.length,
            p1: subset.filter(s => s.rank === 1).length / subset.length,
            avgRank: subset.reduce((sum, s) => sum + (s.rank || MAX_K + 1), 0) / subset.length,
        };
    }
    // Weak spots: found but not top-1
    const weakSpots = scores
        .filter(s => s.rank !== null && s.rank > 1)
        .sort((a, b) => (b.rank || 0) - (a.rank || 0))
        .map(s => ({
        query: s.query,
        rank: s.rank,
        scoreGap: s.scoreGap || 0,
        outrankedBy: s.outrankedBy.slice(0, 3),
        category: s.category,
    }));
    // Total failures
    const failures = scores
        .filter(s => s.rank === null)
        .map(s => ({
        query: s.query,
        importance: s.importance,
        category: s.category,
    }));
    return {
        timestamp: new Date().toISOString(),
        totalQueries: total,
        precision: {
            p1: Math.round(p1 * 1000) / 10,
            p3: Math.round(p3 * 1000) / 10,
            p5: Math.round(p5 * 1000) / 10,
            pAny: Math.round(pAny * 1000) / 10,
        },
        weightedPrecision: {
            p1: Math.round(wp1 * 1000) / 10,
            p3: Math.round(wp3 * 1000) / 10,
            p5: Math.round(wp5 * 1000) / 10,
            pAny: Math.round(wpAny * 1000) / 10,
        },
        mrr: Math.round(mrr * 1000) / 1000,
        weightedMrr: Math.round(weightedMrr * 1000) / 1000,
        byImportance,
        byCategory,
        byFile,
        weakSpots,
        failures,
        details: scores,
        compositeScore: Math.round((0.40 * wp1 + 0.25 * wp3 + 0.15 * wp5 + 0.20 * weightedMrr) * 1000) / 10,
    };
}
// ─── Reporting ──────────────────────────────────────────────────────────────
function generateMarkdownReport(report) {
    const lines = [];
    const ts = new Date(report.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Dubai' });
    lines.push(`# 🔍 Search Quality Report`);
    lines.push(`> Generated: ${ts}`);
    lines.push(`> Queries: ${report.totalQueries}`);
    lines.push('');
    // Headline metrics
    lines.push('## Precision@K');
    lines.push('| Metric | Raw | Weighted |');
    lines.push('|--------|-----|----------|');
    lines.push(`| P@1 (top result correct) | ${report.precision.p1}% | ${report.weightedPrecision.p1}% |`);
    lines.push(`| P@3 | ${report.precision.p3}% | ${report.weightedPrecision.p3}% |`);
    lines.push(`| P@5 | ${report.precision.p5}% | ${report.weightedPrecision.p5}% |`);
    lines.push(`| P@any (found at all) | ${report.precision.pAny}% | ${report.weightedPrecision.pAny}% |`);
    lines.push(`| MRR | ${report.mrr} | ${report.weightedMrr} |`);
    lines.push(`| **Composite** | | **${report.compositeScore}** |`);
    lines.push('');
    // By importance
    lines.push('## By Importance');
    lines.push('| Level | Total | P@1 | P@3 | P@5 | MRR |');
    lines.push('|-------|-------|-----|-----|-----|-----|');
    for (const [imp, data] of Object.entries(report.byImportance)) {
        const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[imp] || '';
        lines.push(`| ${icon} ${imp} | ${data.total} | ${(data.p1 * 100).toFixed(0)}% | ${(data.p3 * 100).toFixed(0)}% | ${(data.p5 * 100).toFixed(0)}% | ${data.mrr.toFixed(3)} |`);
    }
    lines.push('');
    // By category
    lines.push('## By Category');
    lines.push('| Category | Total | P@1 | P@3 | MRR |');
    lines.push('|----------|-------|-----|-----|-----|');
    const sortedCats = Object.entries(report.byCategory).sort((a, b) => a[1].mrr - b[1].mrr);
    for (const [cat, data] of sortedCats) {
        const flag = data.mrr < 0.5 ? ' ⚠️' : data.mrr >= 0.9 ? ' ✨' : '';
        lines.push(`| ${cat}${flag} | ${data.total} | ${(data.p1 * 100).toFixed(0)}% | ${(data.p3 * 100).toFixed(0)}% | ${data.mrr.toFixed(3)} |`);
    }
    lines.push('');
    // Weak spots
    if (report.weakSpots.length > 0) {
        lines.push('## ⚠️ Weak Spots (found but not top-1)');
        for (const w of report.weakSpots.slice(0, 15)) {
            lines.push(`- **Rank #${w.rank}** | \`${w.query.substring(0, 50)}\` [${w.category}]`);
            if (w.outrankedBy.length > 0) {
                lines.push(`  - Outranked by: ${w.outrankedBy.map(p => `\`${path.basename(p)}\``).join(', ')}`);
            }
        }
        lines.push('');
    }
    // Failures
    if (report.failures.length > 0) {
        lines.push('## ❌ Failures (not found at all)');
        for (const f of report.failures) {
            lines.push(`- [${f.importance}] \`${f.query.substring(0, 60)}\` [${f.category}]`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
function printReport(report, verbose) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('     🔍 SEARCH QUALITY SCORER');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`   Time: ${new Date(report.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Dubai' })}`);
    console.log(`   Queries: ${report.totalQueries}`);
    console.log('');
    // Precision table
    console.log('   PRECISION@K');
    console.log('   ───────────────────────────────────');
    console.log(`   P@1:   ${report.precision.p1}%  (weighted: ${report.weightedPrecision.p1}%)`);
    console.log(`   P@3:   ${report.precision.p3}%  (weighted: ${report.weightedPrecision.p3}%)`);
    console.log(`   P@5:   ${report.precision.p5}%  (weighted: ${report.weightedPrecision.p5}%)`);
    console.log(`   P@any: ${report.precision.pAny}%  (weighted: ${report.weightedPrecision.pAny}%)`);
    console.log(`   MRR:   ${report.mrr}  (weighted: ${report.weightedMrr})`);
    console.log('');
    console.log(`   📊 COMPOSITE SCORE: ${report.compositeScore}/100`);
    console.log('');
    // Per-importance
    console.log('   BY IMPORTANCE');
    console.log('   ───────────────────────────────────');
    for (const [imp, data] of Object.entries(report.byImportance)) {
        const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[imp] || '';
        console.log(`   ${icon} ${imp.padEnd(10)} n=${data.total}  P@1=${(data.p1 * 100).toFixed(0)}%  P@3=${(data.p3 * 100).toFixed(0)}%  MRR=${data.mrr.toFixed(3)}`);
    }
    console.log('');
    // Per-category (sorted by MRR ascending = worst first)
    console.log('   BY CATEGORY (worst → best)');
    console.log('   ───────────────────────────────────');
    const sortedCats = Object.entries(report.byCategory).sort((a, b) => a[1].mrr - b[1].mrr);
    for (const [cat, data] of sortedCats) {
        const flag = data.mrr < 0.5 ? '⚠️' : data.mrr >= 0.9 ? '✨' : '  ';
        console.log(`   ${flag} ${cat.padEnd(16)} n=${data.total}  P@1=${(data.p1 * 100).toFixed(0)}%  MRR=${data.mrr.toFixed(3)}`);
    }
    console.log('');
    // Weak spots
    if (report.weakSpots.length > 0) {
        console.log(`   ⚠️  WEAK SPOTS (${report.weakSpots.length} queries rank > 1)`);
        console.log('   ───────────────────────────────────');
        for (const w of report.weakSpots.slice(0, 10)) {
            console.log(`   #${w.rank} | ${w.query.substring(0, 45).padEnd(45)} [${w.category}]`);
            if (verbose && w.outrankedBy.length > 0) {
                console.log(`      ↑ ${w.outrankedBy.map(p => path.basename(p)).join(', ')}`);
            }
        }
        console.log('');
    }
    // Failures
    if (report.failures.length > 0) {
        console.log(`   ❌ FAILURES (${report.failures.length} not found)`);
        console.log('   ───────────────────────────────────');
        for (const f of report.failures) {
            const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[f.importance] || '';
            console.log(`   ${icon} ${f.query.substring(0, 50)} [${f.category}]`);
        }
        console.log('');
    }
    // Per-query details (verbose)
    if (verbose) {
        console.log('   FULL DETAILS');
        console.log('   ───────────────────────────────────');
        for (const d of report.details) {
            const icon = d.rank === 1 ? '✅' : d.rank !== null ? '🟡' : '❌';
            const rankStr = d.rank !== null ? `#${d.rank}` : 'MISS';
            console.log(`   ${icon} ${rankStr.padEnd(5)} ${d.query.substring(0, 50)}`);
        }
        console.log('');
    }
    console.log('═══════════════════════════════════════════════════════════');
}
// ─── History ────────────────────────────────────────────────────────────────
function saveReport(report) {
    // Save to history JSON
    let history = [];
    try {
        history = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    }
    catch { }
    history.push(report);
    if (history.length > 100)
        history = history.slice(-100);
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(history, null, 2));
    // Save markdown report
    const md = generateMarkdownReport(report);
    fs.writeFileSync(REPORT_PATH, md);
}
function showTrend() {
    let history = [];
    try {
        history = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    }
    catch {
        console.log('No history yet.');
        return;
    }
    console.log('═══════════════════════════════════════════════════════════');
    console.log('     📈 SEARCH QUALITY TREND');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('   Date                 P@1    P@3    P@5    MRR    Score  Queries');
    console.log('   ───────────────────────────────────────────────────────────');
    for (const r of history.slice(-20)) {
        const ts = new Date(r.timestamp).toLocaleString('en-US', {
            timeZone: 'Asia/Dubai',
            month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        const cs = r.compositeScore !== undefined ? String(r.compositeScore).padEnd(6) : 'N/A   ';
        console.log(`   ${ts.padEnd(22)} ${String(r.precision.p1 + '%').padEnd(6)} ${String(r.precision.p3 + '%').padEnd(6)} ${String(r.precision.p5 + '%').padEnd(6)} ${r.mrr.toFixed(3).padEnd(6)} ${cs} ${r.totalQueries}`);
    }
    if (history.length >= 2) {
        const prev = history[history.length - 2];
        const curr = history[history.length - 1];
        const d1 = curr.precision.p1 - prev.precision.p1;
        const dMrr = curr.mrr - prev.mrr;
        const arrow = d1 > 0 ? '📈' : d1 < 0 ? '📉' : '➡️';
        console.log('');
        console.log(`   ${arrow} P@1: ${d1 >= 0 ? '+' : ''}${d1.toFixed(1)}%  MRR: ${dMrr >= 0 ? '+' : ''}${dMrr.toFixed(3)}`);
    }
    console.log('');
}
// ─── Regression Check ───────────────────────────────────────────────────────
const REGRESSION_THRESHOLD = 85; // Minimum acceptable composite score
const REGRESSION_DROP_LIMIT = 5; // Max acceptable drop from previous run
function checkRegression(report) {
    let history = [];
    try {
        history = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    }
    catch { }
    // Find the most recent comparable run (same query count category)
    const isQuick = report.totalQueries <= 15;
    const prev = [...history].reverse().find(h => {
        const prevIsQuick = h.totalQueries <= 15;
        return prevIsQuick === isQuick && h.compositeScore !== undefined;
    });
    const previousScore = prev?.compositeScore ?? null;
    const absoluteFail = report.compositeScore < REGRESSION_THRESHOLD;
    const regressionFail = previousScore !== null && (previousScore - report.compositeScore) > REGRESSION_DROP_LIMIT;
    // Check for critical query regressions (was found, now missing)
    const perQueryRegressions = [];
    if (prev) {
        for (const curr of report.details) {
            const prevDetail = prev.details.find(d => d.query === curr.query);
            if (!prevDetail)
                continue;
            // Regression: was found (rank ≤ 3) and now worse (rank > 5 or missing)
            if (prevDetail.rank !== null && prevDetail.rank <= 3) {
                if (curr.rank === null || curr.rank > 5) {
                    perQueryRegressions.push({
                        query: curr.query,
                        prevRank: prevDetail.rank,
                        currRank: curr.rank,
                    });
                }
            }
        }
    }
    // Critical failures (importance=critical, not found at all)
    const criticalFailures = report.details
        .filter(d => d.importance === 'critical' && d.rank === null)
        .map(d => d.query);
    const passed = !absoluteFail && !regressionFail && criticalFailures.length === 0;
    return { passed, currentScore: report.compositeScore, previousScore, absoluteFail, regressionFail, criticalFailures, perQueryRegressions };
}
function printRegression(result) {
    console.log('');
    console.log('   REGRESSION CHECK');
    console.log('   ───────────────────────────────────');
    if (result.passed) {
        console.log(`   ✅ PASSED — Score: ${result.currentScore}/100`);
        if (result.previousScore !== null) {
            const delta = result.currentScore - result.previousScore;
            const arrow = delta > 0 ? '📈' : delta < 0 ? '📉' : '➡️';
            console.log(`   ${arrow} vs previous: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);
        }
    }
    else {
        console.log(`   ❌ FAILED — Score: ${result.currentScore}/100`);
        if (result.absoluteFail) {
            console.log(`   ⛔ Below threshold: ${result.currentScore} < ${REGRESSION_THRESHOLD}`);
        }
        if (result.regressionFail && result.previousScore !== null) {
            console.log(`   📉 Regression: dropped ${(result.previousScore - result.currentScore).toFixed(1)} from ${result.previousScore}`);
        }
        if (result.criticalFailures.length > 0) {
            console.log(`   🔴 Critical failures:`);
            for (const q of result.criticalFailures) {
                console.log(`      - ${q.substring(0, 50)}`);
            }
        }
    }
    if (result.perQueryRegressions.length > 0) {
        console.log(`   ⚠️  Per-query regressions (${result.perQueryRegressions.length}):`);
        for (const r of result.perQueryRegressions) {
            const prev = r.prevRank !== null ? `#${r.prevRank}` : 'MISS';
            const curr = r.currRank !== null ? `#${r.currRank}` : 'MISS';
            console.log(`      ${prev} → ${curr}  ${r.query.substring(0, 40)}`);
        }
    }
    console.log('');
}
// ─── Compare Mode ───────────────────────────────────────────────────────────
function showCompare() {
    let history = [];
    try {
        history = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    }
    catch {
        console.log('Need at least 2 runs to compare.');
        return;
    }
    if (history.length < 2) {
        console.log('Need at least 2 runs to compare.');
        return;
    }
    const curr = history[history.length - 1];
    const prev = history[history.length - 2];
    console.log('═══════════════════════════════════════════════════════════');
    console.log('     🔄 SEARCH QUALITY COMPARISON');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    const ts1 = new Date(prev.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Dubai', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const ts2 = new Date(curr.timestamp).toLocaleString('en-US', { timeZone: 'Asia/Dubai', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    console.log(`   Previous: ${ts1} (n=${prev.totalQueries})`);
    console.log(`   Current:  ${ts2} (n=${curr.totalQueries})`);
    console.log('');
    // Headline comparison
    const metrics = [
        ['P@1', prev.precision.p1, curr.precision.p1, '%'],
        ['P@3', prev.precision.p3, curr.precision.p3, '%'],
        ['P@5', prev.precision.p5, curr.precision.p5, '%'],
        ['MRR', prev.mrr, curr.mrr, ''],
        ['Composite', prev.compositeScore || 0, curr.compositeScore || 0, ''],
    ];
    console.log('   Metric       Previous   Current    Δ');
    console.log('   ─────────────────────────────────────────');
    for (const [name, p, c, unit] of metrics) {
        const delta = c - p;
        const arrow = delta > 0 ? '📈' : delta < 0 ? '📉' : '➡️';
        const dStr = `${delta >= 0 ? '+' : ''}${typeof c === 'number' && c % 1 !== 0 ? delta.toFixed(3) : delta.toFixed(1)}${unit}`;
        console.log(`   ${String(name).padEnd(12)} ${String(p + unit).padEnd(10)} ${String(c + unit).padEnd(10)} ${arrow} ${dStr}`);
    }
    console.log('');
    // Per-query diff (only show changes)
    const changes = [];
    for (const cd of curr.details) {
        const pd = prev.details.find(d => d.query === cd.query);
        if (!pd)
            continue;
        if (pd.rank !== cd.rank) {
            const pr = pd.rank !== null ? `#${pd.rank}` : 'MISS';
            const cr = cd.rank !== null ? `#${cd.rank}` : 'MISS';
            const improved = (cd.rank !== null && (pd.rank === null || cd.rank < pd.rank));
            const icon = improved ? '✅' : '❌';
            changes.push(`   ${icon} ${pr.padEnd(5)} → ${cr.padEnd(5)} ${cd.query.substring(0, 40)}`);
        }
    }
    if (changes.length > 0) {
        console.log(`   RANK CHANGES (${changes.length})`);
        console.log('   ─────────────────────────────────────────');
        changes.forEach(c => console.log(c));
    }
    else {
        console.log('   No rank changes between runs.');
    }
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
}
// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const quick = args.includes('--quick');
    const verbose = args.includes('--verbose');
    const reportOnly = args.includes('--report');
    const trendOnly = args.includes('--trend');
    const regression = args.includes('--regression');
    const compare = args.includes('--compare');
    if (trendOnly) {
        showTrend();
        return;
    }
    if (reportOnly) {
        try {
            const md = fs.readFileSync(REPORT_PATH, 'utf-8');
            console.log(md);
        }
        catch {
            console.log('No report yet. Run without --report first.');
        }
        return;
    }
    if (compare) {
        showCompare();
        return;
    }
    // Regression mode forces quick (critical tests only for speed)
    const useQuick = quick || regression;
    // Select tests
    const tests = useQuick
        ? SEARCH_TESTS.filter(t => t.importance === 'critical')
        : SEARCH_TESTS;
    console.log(`Running ${tests.length} search quality tests${regression ? ' (regression check)' : ''}...`);
    console.log('');
    // Run queries
    const scores = [];
    let done = 0;
    for (const test of tests) {
        const start = Date.now();
        const results = searchMemory(test.query);
        const qs = scoreQuery(test, results);
        scores.push(qs);
        done++;
        const elapsed = Date.now() - start;
        const icon = qs.rank === 1 ? '✅' : qs.rank !== null ? '🟡' : '❌';
        const rankStr = qs.rank !== null ? `#${qs.rank}` : 'MISS';
        console.log(`   ${done}/${tests.length} ${icon} ${rankStr.padEnd(5)} ${elapsed}ms  ${test.query.substring(0, 45)}`);
        // Rate limit: 200ms between queries to avoid Gemini API throttling
        if (done < tests.length)
            sleep(200);
    }
    // Compute report
    const report = computeReport(scores);
    // Print
    printReport(report, verbose);
    // Save
    saveReport(report);
    console.log(`   💾 Saved: ${RESULTS_PATH}`);
    console.log(`   📄 Report: ${REPORT_PATH}`);
    // Regression check
    if (regression) {
        const regResult = checkRegression(report);
        printRegression(regResult);
        if (!regResult.passed) {
            process.exit(1);
        }
        return;
    }
    // Trend line
    showTrend();
}
main().catch(e => {
    console.error('❌ Search quality scorer failed:', e.message);
    process.exit(1);
});
