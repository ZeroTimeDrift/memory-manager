#!/usr/bin/env npx ts-node
"use strict";
/**
 * Recall Probe — Generate novel queries from actual memory content and test retrieval
 *
 * Unlike benchmark-fast.ts (which tests known queries), this:
 * 1. Reads actual memory file content
 * 2. Extracts key facts/claims from each file
 * 3. Generates natural-language queries that SHOULD find those facts
 * 4. Tests if memory_search actually retrieves the right file
 * 5. Reports blind spots where content exists but search can't find it
 *
 * Usage:
 *   npx ts-node src/recall-probe.ts                  # Full probe
 *   npx ts-node src/recall-probe.ts --file <path>    # Probe specific file
 *   npx ts-node src/recall-probe.ts --report          # Show last probe results
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
const WORKSPACE = '/root/clawd';
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const SKILL_DIR = path.join(WORKSPACE, 'skills/memory-manager');
const REPORT_PATH = path.join(SKILL_DIR, 'recall-probe-report.json');
// ─── Fact Extraction ────────────────────────────────────────────────────────
/**
 * Extract searchable facts from a markdown file.
 * Uses pattern matching — no LLM needed.
 */
function extractFacts(filePath) {
    const relPath = path.relative(WORKSPACE, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const facts = [];
    let currentSection = '';
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Track section headers
        if (line.startsWith('#')) {
            currentSection = line.replace(/^#+\s*/, '').replace(/[—\-–]\s*/, '');
            continue;
        }
        // Skip empty, frontmatter, code fences
        if (!line || line === '---' || line.startsWith('```') || line.startsWith('|'))
            continue;
        // Pattern: Named entity with property (e.g., "Hevar is ...", "MoonGate was founded...")
        const entityProp = line.match(/^[-*]?\s*\*?\*?([A-Z][a-zA-Z\s]+?)\*?\*?\s*(?:is|was|are|has|runs?|works?|uses?|built|created|founded)\s+(.{15,})/);
        if (entityProp) {
            const entity = entityProp[1].trim();
            const property = entityProp[2].trim().replace(/[*_`]/g, '');
            // Filter out garbage entities: too short, common words, or sentence starters
            const entityBlacklist = new Set([
                'this', 'that', 'the', 'each', 'every', 'when', 'what', 'where',
                'how', 'why', 'which', 'there', 'here', 'some', 'any', 'all',
                'my', 'your', 'our', 'its', 'their', 'such', 'only', 'also',
                'note', 'file', 'section', 'content', 'data', 'info', 'text',
                'it', 'he', 'she', 'we', 'they', 'one', 'set', 'use', 'get',
                'can', 'don', 'keep', 'skip', 'just', 'check', 'think', 'add',
                'these', 'those', 'both', 'same', 'other', 'another', 'many',
                'update', 'first', 'last', 'next', 'most', 'full', 'new', 'old',
            ]);
            // Reject: too short, blacklisted, or contains only common words
            if (entity.length < 4 || entityBlacklist.has(entity.toLowerCase()))
                continue;
            // Multi-word entities: reject if ALL words are short/common
            const entityWords = entity.split(/\s+/);
            if (entityWords.length > 1 && entityWords.every(w => w.length < 4 || entityBlacklist.has(w.toLowerCase())))
                continue;
            facts.push({
                file: relPath,
                section: currentSection,
                fact: `${entity} ${property}`,
                query: `what does ${entity.toLowerCase()} do`,
                specificity: 'high'
            });
            // Also generate a "who" query for people
            if (relPath.includes('people') || relPath.includes('contacts')) {
                facts.push({
                    file: relPath,
                    section: currentSection,
                    fact: `${entity}: ${property}`,
                    query: `who is ${entity.toLowerCase()}`,
                    specificity: 'high'
                });
            }
            continue;
        }
        // Pattern: Key-value pairs (e.g., "- **Name:** Value" or "- Key: Value")
        const kvMatch = line.match(/^[-*]\s*\*?\*?([^:*]+?)\*?\*?:\s*(.{10,})/);
        if (kvMatch) {
            const key = kvMatch[1].trim();
            const value = kvMatch[2].trim().replace(/[*_`]/g, '');
            // Skip generic keys
            if (['date', 'tags', 'mood', 'day', 'time', 'note'].includes(key.toLowerCase()))
                continue;
            facts.push({
                file: relPath,
                section: currentSection,
                fact: `${key}: ${value}`,
                query: generateQueryFromKV(key, value),
                specificity: value.length > 30 ? 'high' : 'medium'
            });
            continue;
        }
        // Pattern: Decision/action markers
        const decisionMatch = line.match(/^[-*]?\s*(?:DECISION|BUILT|LEARNED|RULE|IMPORTANT|KEY):\s*(.{15,})/);
        if (decisionMatch) {
            const decision = decisionMatch[1].trim();
            facts.push({
                file: relPath,
                section: currentSection,
                fact: decision,
                query: `what was decided about ${extractTopicFromText(decision)}`,
                specificity: 'high'
            });
            continue;
        }
        // Pattern: Specific numbers/metrics (e.g., "benchmark 68/68", "14K→6K")
        // Only use if section name is meaningful (>3 chars, not just a number)
        const metricsMatch = line.match(/(\d+[/%→K][\d/→%Kk]*|#\d+|\$[\d,.]+)/);
        if (metricsMatch && line.length > 20 && line.length < 200) {
            const sectionLabel = currentSection && currentSection.length > 5 ? currentSection : null;
            const topicLabel = sectionLabel || extractTopicFromText(line);
            if (topicLabel && topicLabel.length > 3) {
                facts.push({
                    file: relPath,
                    section: currentSection,
                    fact: line.replace(/^[-*]\s*/, ''),
                    query: `what are the numbers for ${topicLabel}`,
                    specificity: 'medium'
                });
            }
        }
        // Pattern: Named tool/protocol mentions with context
        const toolMatch = line.match(/(?:using|with|via|on|through)\s+(?:\*\*)?([A-Z][a-zA-Z]+)(?:\*\*)?/);
        if (toolMatch && line.length > 30 && line.length < 200) {
            const tool = toolMatch[1];
            if (!['The', 'This', 'That', 'What', 'When', 'Where', 'How', 'Each', 'Every'].includes(tool)) {
                facts.push({
                    file: relPath,
                    section: currentSection,
                    fact: line.replace(/^[-*]\s*/, ''),
                    query: `how do we use ${tool.toLowerCase()}`,
                    specificity: 'medium'
                });
            }
        }
    }
    // Deduplicate by query and filter bad queries
    const seen = new Set();
    return facts.filter(f => {
        if (!isUsefulQuery(f.query))
            return false;
        const key = f.query.toLowerCase();
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function generateQueryFromKV(key, value) {
    const keyLower = key.toLowerCase();
    if (keyLower.includes('name') || keyLower.includes('who'))
        return `who is ${value.split(/[,(]/)[0].trim()}`;
    if (keyLower.includes('email'))
        return `what is the email for ${value.split('@')[0]}`;
    if (keyLower.includes('repo') || keyLower.includes('github'))
        return `where is the ${key.toLowerCase()} repository`;
    if (keyLower.includes('address') || keyLower.includes('wallet'))
        return `what is the wallet address for ${value.slice(0, 10)}`;
    if (keyLower.includes('work') || keyLower.includes('role'))
        return `what is ${key.toLowerCase()} about`;
    if (keyLower.includes('company') || keyLower.includes('org'))
        return `what company is ${value}`;
    // Skip very generic keys that produce bad queries
    if (key.length < 4)
        return '';
    return `${key.toLowerCase()} ${value.split(/[.,(]/)[0].trim().toLowerCase()}`.trim();
}
function isUsefulQuery(query) {
    if (!query || query.length < 10)
        return false;
    // Skip queries that are just stopwords
    const stopwords = new Set(['what', 'who', 'where', 'when', 'how', 'is', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'with', 'by', 'from', 'do', 'does', 'did', 'about', 'that', 'this', 'are', 'was', 'were']);
    const words = query.replace(/[^a-z\s]/gi, '').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w.toLowerCase()));
    if (words.length < 1)
        return false;
    // At least one content word must be 4+ chars (rejects garbled fragments)
    return words.some(w => w.length >= 4);
}
function extractTopicFromText(text) {
    // Extract the most likely topic noun from a sentence
    const cleaned = text.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
    // Try to find capitalized nouns
    const caps = cleaned.match(/[A-Z][a-z]{2,}/g);
    if (caps && caps.length > 0)
        return caps[0].toLowerCase();
    // Fall back to first few words
    return cleaned.split(' ').slice(0, 3).join(' ').toLowerCase();
}
// ─── Search Testing ─────────────────────────────────────────────────────────
// Singleton DB connection
let _db = null;
let _stmt = null;
function getDb() {
    if (!_db) {
        const { DatabaseSync } = require('node:sqlite');
        const DB_PATH = path.join(process.env.HOME || '/root', '.clawdbot/memory/main.sqlite');
        if (!fs.existsSync(DB_PATH)) {
            throw new Error('Memory DB not found at ' + DB_PATH);
        }
        _db = new DatabaseSync(DB_PATH);
        _stmt = _db.prepare(`
      SELECT c.path, snippet(chunks_fts, 0, '>>>', '<<<', '...', 40) as snippet,
             bm25(chunks_fts) as score
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `);
    }
    return { db: _db, stmt: _stmt };
}
function closeDb() {
    if (_db) {
        _db.close();
        _db = null;
        _stmt = null;
    }
}
function searchMemory(query, limit = 5) {
    try {
        const { stmt } = getDb();
        const tokenized = tokenizeQuery(query);
        if (!tokenized)
            return [];
        const results = stmt.all(tokenized, limit);
        return results.map((r) => ({
            path: r.path,
            score: Math.abs(r.score),
            snippet: r.snippet
        }));
    }
    catch (e) {
        return [];
    }
}
function tokenizeQuery(query) {
    // Convert natural query to FTS5 tokens
    const stopwords = new Set(['what', 'who', 'where', 'when', 'how', 'is', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'with', 'by', 'from', 'was', 'were', 'are', 'do', 'does', 'did', 'about', 'that', 'this']);
    const words = query.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 1 && !stopwords.has(w));
    return words.join(' OR ');
}
// ─── Probe Runner ───────────────────────────────────────────────────────────
function runProbe(targetFile) {
    // Gather files to probe
    const files = [];
    if (targetFile) {
        const fullPath = path.resolve(WORKSPACE, targetFile);
        if (fs.existsSync(fullPath))
            files.push(fullPath);
        else {
            console.error(`File not found: ${targetFile}`);
            process.exit(1);
        }
    }
    else {
        // Probe all memory files
        const walkDir = (dir) => {
            if (!fs.existsSync(dir))
                return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'archive') {
                    walkDir(full);
                }
                else if (entry.name.endsWith('.md') && !entry.name.startsWith('.')) {
                    files.push(full);
                }
            }
        };
        walkDir(MEMORY_DIR);
        // Also check root-level memory files
        for (const f of ['MEMORY.md', 'IDENTITY.md', 'USER.md']) {
            const full = path.join(WORKSPACE, f);
            if (fs.existsSync(full))
                files.push(full);
        }
    }
    // Extract facts from all files
    let allFacts = [];
    for (const file of files) {
        const facts = extractFacts(file);
        allFacts = allFacts.concat(facts);
    }
    // Sample if too many (cap at 50 for speed)
    if (allFacts.length > 50) {
        // Prioritize high specificity
        const high = allFacts.filter(f => f.specificity === 'high');
        const medium = allFacts.filter(f => f.specificity === 'medium');
        const low = allFacts.filter(f => f.specificity === 'low');
        allFacts = [
            ...high.slice(0, 30),
            ...medium.slice(0, 15),
            ...low.slice(0, 5)
        ];
    }
    console.log(`\n🔍 Probing ${allFacts.length} facts across ${files.length} files...\n`);
    // Test each fact
    const results = [];
    let found = 0;
    let missed = 0;
    let totalRank = 0;
    for (const fact of allFacts) {
        const searchResults = searchMemory(fact.query);
        // Check if the source file appears in results
        const sourceFile = fact.file;
        const matchIndex = searchResults.findIndex(r => {
            const rPath = r.path.replace(/^\/root\/clawd\//, '');
            return rPath === sourceFile || sourceFile.includes(rPath) || rPath.includes(sourceFile);
        });
        const isFound = matchIndex >= 0;
        const rank = isFound ? matchIndex + 1 : null;
        if (isFound) {
            found++;
            totalRank += rank;
        }
        else {
            missed++;
        }
        const result = {
            fact,
            found: isFound,
            rank,
            topResult: searchResults[0]?.path || 'no results',
            score: searchResults[0]?.score || 0
        };
        results.push(result);
        // Show progress
        const icon = isFound ? (rank === 1 ? '✅' : '🟡') : '❌';
        const rankStr = rank ? `#${rank}` : 'MISS';
        console.log(`${icon} [${rankStr}] "${fact.query}"`);
        if (!isFound) {
            console.log(`   Expected: ${fact.file}`);
            console.log(`   Got: ${searchResults[0]?.path || 'nothing'}`);
        }
    }
    const avgRank = found > 0 ? totalRank / found : 0;
    const blindSpots = results.filter(r => !r.found).map(r => r.fact);
    const report = {
        timestamp: new Date().toISOString(),
        totalFacts: allFacts.length,
        found,
        missed,
        avgRank,
        blindSpots,
        results
    };
    // Print summary
    console.log('\n' + '═'.repeat(60));
    console.log(`📊 RECALL PROBE RESULTS`);
    console.log('═'.repeat(60));
    console.log(`   Total facts probed: ${allFacts.length}`);
    console.log(`   Found: ${found} (${(found / allFacts.length * 100).toFixed(1)}%)`);
    console.log(`   Missed: ${missed} (${(missed / allFacts.length * 100).toFixed(1)}%)`);
    console.log(`   Avg rank when found: #${avgRank.toFixed(1)}`);
    if (blindSpots.length > 0) {
        console.log(`\n   🔴 BLIND SPOTS (${blindSpots.length}):`);
        for (const spot of blindSpots.slice(0, 10)) {
            console.log(`      • "${spot.query}" → ${spot.file} [${spot.section || 'root'}]`);
        }
        if (blindSpots.length > 10) {
            console.log(`      ... and ${blindSpots.length - 10} more`);
        }
    }
    console.log('═'.repeat(60));
    // Save report
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\n💾 Report saved to ${REPORT_PATH}`);
    // Cleanup DB
    closeDb();
    return report;
}
function showReport() {
    if (!fs.existsSync(REPORT_PATH)) {
        console.log('No previous probe report found. Run without --report first.');
        return;
    }
    const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'));
    console.log(`\n📊 Last probe: ${report.timestamp}`);
    console.log(`   Found: ${report.found}/${report.totalFacts} (${(report.found / report.totalFacts * 100).toFixed(1)}%)`);
    console.log(`   Avg rank: #${report.avgRank.toFixed(1)}`);
    if (report.blindSpots.length > 0) {
        console.log(`\n   Blind spots:`);
        for (const spot of report.blindSpots) {
            console.log(`   • "${spot.query}" → ${spot.file}`);
        }
    }
}
// ─── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--report')) {
    showReport();
}
else if (args.includes('--file')) {
    const idx = args.indexOf('--file');
    const targetFile = args[idx + 1];
    runProbe(targetFile);
}
else {
    runProbe();
}
