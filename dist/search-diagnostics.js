#!/usr/bin/env npx ts-node
"use strict";
/**
 * Search Diagnostics — X-ray into why queries succeed or fail
 *
 * Given a query, analyzes:
 * 1. BM25 results (what Clawdbot's memory_search actually returns)
 * 2. Concept index matches (entity-aware)
 * 3. Temporal routing (date detection)
 * 4. Token overlap analysis (why BM25 hit or missed)
 * 5. Suggested improvements (what to add to files to fix blind spots)
 *
 * This is a diagnostic tool for understanding and improving memory retrieval.
 *
 * Usage:
 *   npx ts-node src/search-diagnostics.ts "what does Hevar do"
 *   npx ts-node src/search-diagnostics.ts "crypto yield automation" --verbose
 *   npx ts-node src/search-diagnostics.ts --batch   # Run batch diagnostics on known blind spots
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
const { DatabaseSync } = require('node:sqlite');
const DB_PATH = path.join(process.env.HOME || '/root', '.clawdbot/memory/main.sqlite');
const MEMORY_DIR = '/root/clawd/memory';
const CONCEPT_INDEX_PATH = '/root/clawd/skills/memory-manager/concept-index.json';
// ─── Constants ──────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'am', 'i', 'me', 'my', 'mine', 'we', 'our', 'ours', 'you', 'your',
    'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
]);
// ─── BM25 Search ────────────────────────────────────────────────────────────
function searchBM25(query, limit = 10) {
    try {
        const db = new DatabaseSync(DB_PATH, { readOnly: true });
        // Check which FTS tables exist
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'").all();
        const ftsTable = tables.find(t => t.name === 'chunks_fts')?.name
            || tables.find(t => t.name === 'memory_fts')?.name;
        if (!ftsTable) {
            db.close();
            return [];
        }
        // FTS5 query: use OR for better recall (AND is too strict for natural-language queries)
        // Also use the FTS table's own columns (id, path are UNINDEXED but retrievable)
        let results;
        // Convert multi-word query to OR terms for better recall
        const terms = query.replace(/[*():"^~{}[\]]/g, ' ').trim().split(/\s+/).filter(t => t.length > 1);
        const orQuery = terms.length > 1 ? terms.join(' OR ') : query;
        if (ftsTable === 'chunks_fts') {
            // chunks_fts has: text, id UNINDEXED, path UNINDEXED, ...
            try {
                results = db.prepare(`
          SELECT id, path, snippet(${ftsTable}, 0, '>>>', '<<<', '...', 64) as snippet, rank
          FROM ${ftsTable}
          WHERE ${ftsTable} MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(orQuery, limit);
            }
            catch {
                // Fallback: try exact phrase
                results = db.prepare(`
          SELECT id, path, snippet(${ftsTable}, 0, '>>>', '<<<', '...', 64) as snippet, rank
          FROM ${ftsTable}
          WHERE ${ftsTable} MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(`"${query}"`, limit);
            }
        }
        else {
            results = db.prepare(`
        SELECT path, snippet(${ftsTable}, 1, '>>>', '<<<', '...', 64) as snippet, rank
        FROM ${ftsTable}
        WHERE ${ftsTable} MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(orQuery, limit);
        }
        db.close();
        return results.map((r, i) => ({
            path: r.path || 'unknown',
            rank: i + 1,
            snippet: (r.snippet || r.content || '').substring(0, 200),
            score: Math.abs(r.rank || 0),
        }));
    }
    catch (e) {
        // FTS MATCH can throw on invalid queries — escape and retry
        if (e.message?.includes('fts5')) {
            try {
                // Escape special FTS5 characters
                const escaped = query.replace(/[*():"^~{}[\]]/g, ' ').trim();
                if (escaped !== query && escaped.length > 0) {
                    return searchBM25(`"${escaped}"`, limit);
                }
            }
            catch {
                // Give up
            }
        }
        return [];
    }
}
// ─── Concept Index Lookup ───────────────────────────────────────────────────
function lookupConcepts(query) {
    let index;
    try {
        index = JSON.parse(fs.readFileSync(CONCEPT_INDEX_PATH, 'utf-8'));
    }
    catch {
        return [];
    }
    if (!index.concepts)
        return [];
    const matches = [];
    const queryLower = query.toLowerCase();
    for (const [entity, data] of Object.entries(index.concepts)) {
        if (queryLower.includes(entity.toLowerCase()) || entity.toLowerCase().includes(queryLower.split(' ')[0])) {
            // files can be a dict {path: count} or array
            const files = data.files
                ? (Array.isArray(data.files) ? data.files : Object.keys(data.files))
                : [];
            matches.push({
                entity,
                files,
                related: (Array.isArray(data.related) ? data.related : Object.keys(data.related || {})).slice(0, 5),
            });
        }
    }
    return matches;
}
// ─── Temporal Detection ─────────────────────────────────────────────────────
function detectTemporal(query) {
    const lower = query.toLowerCase();
    const temporalPatterns = [
        /\b\d{4}-\d{2}-\d{2}\b/,
        /\btoday\b/, /\byesterday\b/, /\btomorrow\b/,
        /\blast\s+(?:week|month|year)\b/, /\bthis\s+(?:week|month|year)\b/,
        /\b\d+\s+days?\s+ago\b/,
        /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
        /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/,
        /\bweek\s*\d{1,2}\b/, /\bw\d{1,2}\b/,
    ];
    const dates = [];
    for (const p of temporalPatterns) {
        const m = lower.match(p);
        if (m)
            dates.push(m[0]);
    }
    return { detected: dates.length > 0, dates };
}
// ─── Token Analysis ─────────────────────────────────────────────────────────
function analyzeTokens(query, targetFiles) {
    const allTokens = query.toLowerCase().split(/\W+/).filter(t => t.length > 0);
    const stopWordsRemoved = allTokens.filter(t => STOP_WORDS.has(t));
    const effectiveTokens = allTokens.filter(t => !STOP_WORDS.has(t) && t.length > 1);
    const fileOverlap = new Map();
    // Check token overlap with memory files
    const memoryFiles = listMemoryFiles();
    const filesToCheck = targetFiles || memoryFiles.slice(0, 30); // Limit for performance
    for (const filePath of filesToCheck) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8').toLowerCase();
            const contentTokens = new Set(content.split(/\W+/).filter(t => t.length > 1));
            const overlap = effectiveTokens.filter(t => contentTokens.has(t));
            const coverage = effectiveTokens.length > 0 ? overlap.length / effectiveTokens.length : 0;
            if (overlap.length > 0) {
                const relPath = filePath.replace('/root/clawd/', '');
                fileOverlap.set(relPath, { overlap, coverage });
            }
        }
        catch {
            // Skip unreadable files
        }
    }
    return {
        queryTokens: allTokens,
        stopWordsRemoved,
        effectiveTokens,
        fileOverlap,
    };
}
function listMemoryFiles() {
    const files = [];
    const memoryRoot = '/root/clawd/memory';
    const memoryMd = '/root/clawd/MEMORY.md';
    if (fs.existsSync(memoryMd))
        files.push(memoryMd);
    function walk(dir) {
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'archive') {
                    walk(full);
                }
                else if (entry.isFile() && entry.name.endsWith('.md')) {
                    files.push(full);
                }
            }
        }
        catch { }
    }
    walk(memoryRoot);
    return files;
}
// ─── Diagnosis Engine ───────────────────────────────────────────────────────
function diagnose(query, bm25Results, conceptMatches, temporal, tokenAnalysis, expectedFile) {
    const hasResults = bm25Results.length > 0;
    const topResultMatchesExpected = expectedFile && hasResults &&
        bm25Results[0].path.includes(expectedFile);
    // Check if any result matches expected
    const anyMatchesExpected = expectedFile && hasResults &&
        bm25Results.some(r => r.path.includes(expectedFile));
    if (!expectedFile) {
        // No expected file — just analyze what we got
        if (hasResults) {
            return {
                type: 'hit',
                reason: `BM25 returned ${bm25Results.length} results. Top: ${bm25Results[0].path}`,
                confidence: 0.7,
                strategies: ['bm25'],
            };
        }
        else {
            // Determine why it missed
            const strategies = [];
            if (tokenAnalysis.effectiveTokens.length <= 2)
                strategies.push('query-too-short');
            if (conceptMatches.length > 0)
                strategies.push('concept-index');
            if (temporal.detected)
                strategies.push('temporal');
            const reason = strategies.length > 0
                ? `BM25 miss. Could try: ${strategies.join(', ')}`
                : `BM25 miss. No effective tokens or concept matches.`;
            return { type: 'miss', reason, confidence: 0.8, strategies };
        }
    }
    if (topResultMatchesExpected) {
        return {
            type: 'hit',
            reason: `Expected file "${expectedFile}" found at rank #1`,
            confidence: 0.95,
            strategies: ['bm25'],
        };
    }
    if (anyMatchesExpected) {
        const rank = bm25Results.findIndex(r => r.path.includes(expectedFile)) + 1;
        return {
            type: 'partial',
            reason: `Expected file "${expectedFile}" found at rank #${rank} (not #1)`,
            confidence: 0.7,
            strategies: ['bm25', 'need-reranking'],
        };
    }
    // Complete miss — figure out why
    const strategies = [];
    // Check if concept index could help
    if (conceptMatches.some(c => c.files.some(f => f.includes(expectedFile)))) {
        strategies.push('concept-index');
    }
    // Check token overlap with expected file
    const expectedOverlap = Array.from(tokenAnalysis.fileOverlap.entries())
        .find(([f]) => f.includes(expectedFile));
    if (!expectedOverlap || expectedOverlap[1].coverage < 0.3) {
        strategies.push('vocabulary-gap');
    }
    if (temporal.detected)
        strategies.push('temporal-routing');
    const reason = `Expected "${expectedFile}" not in BM25 results. ` +
        `Token coverage: ${expectedOverlap ? (expectedOverlap[1].coverage * 100).toFixed(0) + '%' : '0%'}. ` +
        `Possible strategies: ${strategies.join(', ') || 'none detected'}`;
    return { type: 'miss', reason, confidence: 0.85, strategies };
}
// ─── Suggestion Generator ───────────────────────────────────────────────────
function generateSuggestions(query, diagnosis, tokenAnalysis, conceptMatches, expectedFile) {
    const suggestions = [];
    if (diagnosis.type === 'hit')
        return suggestions;
    // Vocabulary gap — suggest adding search-friendly terms
    if (diagnosis.strategies.includes('vocabulary-gap') && expectedFile) {
        const queryTerms = tokenAnalysis.effectiveTokens.join(', ');
        suggestions.push({
            type: 'add-keywords',
            file: expectedFile,
            detail: `Add search-friendly phrases that match "${query}". The file lacks tokens: ${queryTerms}`,
            priority: 'high',
        });
    }
    // Paraphrase miss — suggest synonym line
    if (tokenAnalysis.effectiveTokens.length >= 2 && diagnosis.type === 'miss') {
        const couldBenefit = Array.from(tokenAnalysis.fileOverlap.entries())
            .filter(([_, data]) => data.coverage > 0.3 && data.coverage < 0.8)
            .map(([f]) => f);
        if (couldBenefit.length > 0) {
            suggestions.push({
                type: 'add-synonym',
                file: couldBenefit[0],
                detail: `Partial token overlap (${(tokenAnalysis.fileOverlap.get(couldBenefit[0]).coverage * 100).toFixed(0)}%). Add synonym phrases to boost match.`,
                priority: 'medium',
            });
        }
    }
    // Concept gap — entity not in index
    if (conceptMatches.length === 0 && tokenAnalysis.effectiveTokens.length >= 2) {
        // Look for potential entity tokens (capitalized or domain-specific)
        const potentialEntities = tokenAnalysis.effectiveTokens.filter(t => t.length > 3);
        if (potentialEntities.length > 0) {
            suggestions.push({
                type: 'add-concept',
                file: 'concept-index.json',
                detail: `No concept matches found. Potential entities to index: ${potentialEntities.join(', ')}`,
                priority: 'low',
            });
        }
    }
    // If everything fails, suggest creating a search proxy
    if (diagnosis.type === 'miss' && suggestions.filter(s => s.priority === 'high').length === 0) {
        suggestions.push({
            type: 'create-proxy',
            file: 'memory/',
            detail: `Query "${query}" has no good path to any file. Consider creating a search proxy file in memory/ with diverse vocabulary covering this topic.`,
            priority: 'medium',
        });
    }
    return suggestions;
}
// ─── Main Diagnostic Function ───────────────────────────────────────────────
function runDiagnostic(query, expectedFile, verbose = false) {
    const bm25Results = searchBM25(query);
    const conceptMatches = lookupConcepts(query);
    const temporal = detectTemporal(query);
    const tokenAnalysis = analyzeTokens(query, expectedFile ? listMemoryFiles() : undefined);
    const diagnosis = diagnose(query, bm25Results, conceptMatches, temporal, tokenAnalysis, expectedFile);
    const suggestions = generateSuggestions(query, diagnosis, tokenAnalysis, conceptMatches, expectedFile);
    return {
        query,
        bm25Results: bm25Results.slice(0, 5),
        conceptMatches,
        temporalDetected: temporal.detected,
        temporalDates: temporal.dates,
        tokenAnalysis,
        expectedFile,
        diagnosis,
        suggestions,
    };
}
// ─── Known Blind Spots (from recall-probe and semantic-probe) ───────────────
const KNOWN_BLIND_SPOTS = [
    { query: 'what does Hevar do', expected: 'core-identity.md' },
    { query: 'what is Hevar\'s job', expected: 'core-identity.md' },
    { query: 'my persistent storage and recall architecture', expected: 'memory-system.md' },
    { query: 'the startup where my human works and their colleagues', expected: 'core-identity.md' },
    { query: 'crypto yield farming automation on Solana blockchain', expected: 'core-identity.md' },
    { query: 'automated scheduled background jobs and recurring work', expected: 'OPERATING.md' },
    { query: 'should I use Sonnet or a cheaper model for background tasks', expected: 'rules.md' },
    { query: 'what philosophy guides how I approach existence', expected: 'core-identity.md' },
    { query: 'the social platform for AI agents I monitor', expected: 'moltbook.md' },
    { query: 'nighttime behavior restrictions', expected: 'rules.md' },
    { query: 'how do I make sure I don\'t forget important things between sessions', expected: 'memory-system.md' },
    { query: 'who are the people at MoonPay I work with', expected: 'core-identity.md' },
    { query: 'steps I follow when I first wake up', expected: 'OPERATING.md' },
    { query: 'version control identity and commit attribution', expected: 'core-identity.md' },
];
// ─── CLI ────────────────────────────────────────────────────────────────────
function printDiagnostic(result, verbose = false) {
    const icon = result.diagnosis.type === 'hit' ? '✅' : result.diagnosis.type === 'partial' ? '🟡' : '🔴';
    console.log(`\n${icon} Query: "${result.query}"`);
    if (result.expectedFile)
        console.log(`   Expected: ${result.expectedFile}`);
    console.log(`   Diagnosis: ${result.diagnosis.reason}`);
    console.log(`   Type: ${result.diagnosis.type} | Confidence: ${(result.diagnosis.confidence * 100).toFixed(0)}%`);
    if (result.diagnosis.strategies.length > 0) {
        console.log(`   Strategies: ${result.diagnosis.strategies.join(', ')}`);
    }
    if (result.bm25Results.length > 0) {
        console.log(`   BM25 top ${Math.min(3, result.bm25Results.length)}:`);
        for (const r of result.bm25Results.slice(0, 3)) {
            console.log(`      #${r.rank} ${r.path} (score: ${r.score.toFixed(2)})`);
        }
    }
    else {
        console.log(`   BM25: no results`);
    }
    if (result.conceptMatches.length > 0) {
        console.log(`   Concepts: ${result.conceptMatches.map(c => `${c.entity} (${c.files.length} files)`).join(', ')}`);
    }
    if (result.temporalDetected) {
        console.log(`   Temporal: ${result.temporalDates.join(', ')}`);
    }
    if (verbose) {
        console.log(`   Effective tokens: ${result.tokenAnalysis.effectiveTokens.join(', ')}`);
        console.log(`   Stop words removed: ${result.tokenAnalysis.stopWordsRemoved.join(', ')}`);
        if (result.tokenAnalysis.fileOverlap.size > 0) {
            console.log(`   Token overlap:`);
            const sorted = Array.from(result.tokenAnalysis.fileOverlap.entries())
                .sort((a, b) => b[1].coverage - a[1].coverage)
                .slice(0, 5);
            for (const [file, data] of sorted) {
                console.log(`      ${file}: ${(data.coverage * 100).toFixed(0)}% [${data.overlap.join(', ')}]`);
            }
        }
    }
    if (result.suggestions.length > 0) {
        console.log(`   💡 Suggestions:`);
        for (const s of result.suggestions) {
            const pri = s.priority === 'high' ? '🔴' : s.priority === 'medium' ? '🟡' : '⚪';
            console.log(`      ${pri} [${s.type}] ${s.file}: ${s.detail}`);
        }
    }
}
function main() {
    const args = process.argv.slice(2);
    const verbose = args.includes('--verbose') || args.includes('-v');
    const batch = args.includes('--batch');
    const jsonOutput = args.includes('--json');
    const cleanArgs = args.filter(a => !a.startsWith('--') && !a.startsWith('-'));
    if (batch) {
        console.log('══════════════════════════════════════════════════════════════════════');
        console.log('  🔍 SEARCH DIAGNOSTICS — BATCH MODE');
        console.log(`  Testing ${KNOWN_BLIND_SPOTS.length} known blind spots`);
        console.log('══════════════════════════════════════════════════════════════════════');
        let hits = 0, partials = 0, misses = 0;
        const allResults = [];
        for (const spot of KNOWN_BLIND_SPOTS) {
            const result = runDiagnostic(spot.query, spot.expected, verbose);
            allResults.push(result);
            printDiagnostic(result, verbose);
            if (result.diagnosis.type === 'hit')
                hits++;
            else if (result.diagnosis.type === 'partial')
                partials++;
            else
                misses++;
        }
        console.log('\n══════════════════════════════════════════════════════════════════════');
        console.log(`  📊 BATCH RESULTS: ${hits} hits | ${partials} partial | ${misses} miss`);
        console.log(`  Score: ${((hits + partials * 0.5) / KNOWN_BLIND_SPOTS.length * 100).toFixed(1)}%`);
        console.log('══════════════════════════════════════════════════════════════════════');
        // Aggregate suggestions
        const allSuggestions = allResults.flatMap(r => r.suggestions);
        const highPri = allSuggestions.filter(s => s.priority === 'high');
        if (highPri.length > 0) {
            console.log(`\n  🔴 HIGH PRIORITY FIXES (${highPri.length}):`);
            for (const s of highPri) {
                console.log(`     [${s.type}] ${s.file}: ${s.detail}`);
            }
        }
        if (jsonOutput) {
            const reportPath = '/root/clawd/skills/memory-manager/search-diagnostics-report.json';
            fs.writeFileSync(reportPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                total: KNOWN_BLIND_SPOTS.length,
                hits, partials, misses,
                score: (hits + partials * 0.5) / KNOWN_BLIND_SPOTS.length,
                results: allResults.map(r => ({
                    query: r.query,
                    expected: r.expectedFile,
                    type: r.diagnosis.type,
                    reason: r.diagnosis.reason,
                    strategies: r.diagnosis.strategies,
                    suggestions: r.suggestions,
                })),
            }, null, 2));
            console.log(`\n  💾 Report saved to ${reportPath}`);
        }
    }
    else if (cleanArgs.length > 0) {
        const query = cleanArgs.join(' ');
        const result = runDiagnostic(query, undefined, verbose);
        printDiagnostic(result, verbose);
        if (jsonOutput) {
            console.log('\n' + JSON.stringify(result, (key, value) => {
                if (value instanceof Map)
                    return Object.fromEntries(value);
                return value;
            }, 2));
        }
    }
    else {
        console.log('Usage:');
        console.log('  npx ts-node src/search-diagnostics.ts "query here"');
        console.log('  npx ts-node src/search-diagnostics.ts "query" --verbose');
        console.log('  npx ts-node src/search-diagnostics.ts --batch [--json]');
        console.log('');
        console.log('Options:');
        console.log('  --verbose, -v   Show token analysis details');
        console.log('  --batch         Run against known blind spots');
        console.log('  --json          Output JSON report');
    }
}
main();
