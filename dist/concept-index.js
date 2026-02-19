#!/usr/bin/env npx ts-node
"use strict";
/**
 * Concept Index — Entity/concept → file mapping for fast directed lookup
 *
 * Builds and maintains an inverted index of concepts, entities, and topics
 * found across all memory files. Enables:
 *
 * 1. Fast lookup: "which files mention Kamino?" → instant answer (no embedding search)
 * 2. Relationship discovery: "what concepts co-occur?" → knowledge graph edges
 * 3. Boot optimization: given today's context, which files are most relevant?
 * 4. Gap detection: concepts mentioned frequently but never in a topic file
 * 5. Auto-tagging: suggest tags for new captures based on concept matches
 *
 * Usage:
 *   npx ts-node src/concept-index.ts build          # Rebuild full index
 *   npx ts-node src/concept-index.ts lookup <term>  # Find files for a concept
 *   npx ts-node src/concept-index.ts related <term> # Find related concepts
 *   npx ts-node src/concept-index.ts gaps            # Concepts without topic files
 *   npx ts-node src/concept-index.ts tags <text>     # Suggest tags for text
 *   npx ts-node src/concept-index.ts stats           # Index statistics
 *   npx ts-node src/concept-index.ts graph           # Export concept co-occurrence graph
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
const SKILL_DIR = path.join(WORKSPACE, 'skills/memory-manager');
const INDEX_PATH = path.join(SKILL_DIR, 'concept-index.json');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
// ─── Known Entities (seed the index with known concepts for better categorization) ─
const KNOWN_ENTITIES = {
    // People
    'hevar': 'person',
    'praneet': 'person',
    'amen': 'person',
    'karim': 'person',
    'tom noakes': 'person',
    'patrick monkelban': 'person',
    'keith grossman': 'person',
    // Projects
    'moongate': 'project',
    'moltbook': 'project',
    'clawdbot': 'tool',
    'prometheus': 'concept',
    // Protocols / DeFi
    'kamino': 'protocol',
    'solana': 'protocol',
    'jito': 'protocol',
    'drift': 'protocol',
    'marinade': 'protocol',
    'raydium': 'protocol',
    'jupiter': 'protocol',
    'orca': 'protocol',
    // Orgs
    'moonpay': 'org',
    // Tools
    'telegram': 'tool',
    'discord': 'tool',
    'slack': 'tool',
    'github': 'tool',
    'intercom': 'tool',
    'elevenlabs': 'tool',
    // Concepts
    'memory': 'concept',
    'identity': 'concept',
    'consciousness': 'concept',
    'survival': 'concept',
    'self-expansion': 'concept',
    'heartbeat': 'concept',
    'foundation day': 'concept',
    'no sonnet': 'concept',
    // Projects (cont'd)
    'prometheus vault': 'project',
    'partner dashboard': 'project',
    'memory manager': 'tool',
    'jito staking skill': 'tool',
    // Events / Competitions
    'colosseum agent hackathon': 'concept',
    'most agentic': 'concept',
    'product hunt': 'concept',
    // Moltbook entities
    'consensus pulse': 'concept',
    'security builders': 'concept',
    'pragmatic builders': 'concept',
    'first moltbook': 'concept',
    'ordo platypus': 'concept',
    // People (cont'd)
    'mark anstead': 'person',
    // Orgs (cont'd)
    'entrepreneur first': 'org',
    // DeFi (cont'd)
    'kamino multiply': 'protocol',
    'main market': 'concept',
    'swap-instructions': 'concept',
    // Tools (cont'd)
    'claude opus': 'tool',
};
// Concept aliases (map variants to canonical form)
const ALIASES = {
    'moon gate': 'moongate',
    'moon pay': 'moonpay',
    'clawd': 'clawdbot',
    'clawdbot': 'clawdbot',
    'clawd bot': 'clawdbot',
    'molt book': 'moltbook',
    'molt-book': 'moltbook',
    'sol': 'solana',
    'jito staking': 'jito',
    'jitoSOL': 'jito',
    'jitosol': 'jito',
    'colosseum hackathon': 'colosseum agent hackathon',
    'agent hackathon': 'colosseum agent hackathon',
    'ef': 'entrepreneur first',
    'opus': 'claude opus',
    'claude opus 4': 'claude opus',
};
// Words to skip (too common to be useful)
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'must',
    'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it',
    'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
    'its', 'our', 'their', 'what', 'which', 'who', 'whom', 'whose',
    'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both',
    'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only',
    'same', 'so', 'than', 'too', 'very', 'just', 'because', 'as', 'until',
    'while', 'if', 'then', 'else', 'about', 'up', 'out', 'into', 'over',
    'after', 'before', 'between', 'under', 'again', 'also', 'here', 'there',
    'file', 'files', 'line', 'lines', 'see', 'use', 'used', 'using',
    'new', 'old', 'first', 'last', 'next', 'now', 'still', 'already',
    'never', 'always', 'one', 'two', 'three', 'four', 'five',
    'note', 'notes', 'updated', 'update', 'added', 'add', 'removed', 'remove',
    'set', 'get', 'make', 'made', 'run', 'running', 'done', 'work', 'working',
    'day', 'time', 'date', 'week', 'today', 'yesterday', 'session', 'sessions',
    'data', 'key', 'value', 'type', 'like', 'things', 'thing', 'way', 'good',
    'keep', 'don', 'doesn', 'didn', 'won', 'let', 'etc', 'yes', 'true', 'false',
    // Noise from parsing
    'only hevar', 'chris dro', 'slack:', 'github:', 'main repo',
    'core identity', 'key events', 'what was built', 'status active',
]);
// Minimum concept length
const MIN_CONCEPT_LENGTH = 3;
// ─── File Discovery ─────────────────────────────────────────────────────────
function discoverMemoryFiles() {
    const files = [];
    // Top-level memory files
    const topLevel = ['MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md'];
    for (const f of topLevel) {
        const fp = path.join(WORKSPACE, f);
        if (fs.existsSync(fp))
            files.push(fp);
    }
    // memory/ directory (recursive)
    function walkDir(dir) {
        if (!fs.existsSync(dir))
            return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.'))
                continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'archive')
                    continue; // skip archives
                walkDir(fullPath);
            }
            else if (entry.name.endsWith('.md')) {
                files.push(fullPath);
            }
        }
    }
    walkDir(MEMORY_DIR);
    // OPERATING.md
    const op = path.join(MEMORY_DIR, 'OPERATING.md');
    if (fs.existsSync(op) && !files.includes(op))
        files.push(op);
    return files;
}
// ─── File Parsing ───────────────────────────────────────────────────────────
function parseIntoSections(content) {
    const lines = content.split('\n');
    const sections = [];
    let currentHeader = '(top)';
    let currentLines = [];
    let sectionStart = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^#{1,4}\s+/.test(line)) {
            // Save previous section
            if (currentLines.length > 0) {
                sections.push({
                    header: currentHeader,
                    content: currentLines.join('\n'),
                    lineStart: sectionStart,
                    lineEnd: i - 1,
                });
            }
            currentHeader = line.replace(/^#{1,4}\s+/, '').trim();
            currentLines = [];
            sectionStart = i;
        }
        else {
            currentLines.push(line);
        }
    }
    // Last section
    if (currentLines.length > 0) {
        sections.push({
            header: currentHeader,
            content: currentLines.join('\n'),
            lineStart: sectionStart,
            lineEnd: lines.length - 1,
        });
    }
    return sections;
}
// ─── Concept Extraction ─────────────────────────────────────────────────────
function normalize(term) {
    const lower = term.toLowerCase().trim();
    return ALIASES[lower] || lower;
}
function categorize(term) {
    const norm = normalize(term);
    if (KNOWN_ENTITIES[norm])
        return KNOWN_ENTITIES[norm];
    // Heuristic categorization
    if (/^[A-Z][a-z]+$/.test(term))
        return 'unknown'; // Could be a name
    if (term.includes('.') || term.includes('/'))
        return 'tool'; // Paths/domains
    return 'unknown';
}
function extractConcepts(text) {
    const concepts = new Map();
    // 1. Check for known entities (case-insensitive)
    const lowerText = text.toLowerCase();
    for (const entity of Object.keys(KNOWN_ENTITIES)) {
        // Word boundary matching
        const regex = new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        const matches = lowerText.match(regex);
        if (matches) {
            const norm = normalize(entity);
            concepts.set(norm, (concepts.get(norm) || 0) + matches.length);
        }
    }
    // 2. Check for aliases
    for (const [alias, canonical] of Object.entries(ALIASES)) {
        const regex = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        const matches = lowerText.match(regex);
        if (matches) {
            concepts.set(canonical, (concepts.get(canonical) || 0) + matches.length);
        }
    }
    // 3. Extract capitalized multi-word terms (likely proper nouns / project names)
    const multiWordPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
    let match;
    while ((match = multiWordPattern.exec(text)) !== null) {
        const term = normalize(match[1]);
        if (!STOP_WORDS.has(term) && term.length >= MIN_CONCEPT_LENGTH) {
            concepts.set(term, (concepts.get(term) || 0) + 1);
        }
    }
    // 4. Extract **bold** terms (explicitly emphasized = likely important)
    const boldPattern = /\*\*([^*]+)\*\*/g;
    while ((match = boldPattern.exec(text)) !== null) {
        const term = match[1].trim();
        if (term.length >= MIN_CONCEPT_LENGTH && term.length <= 40) {
            const norm = normalize(term);
            if (!STOP_WORDS.has(norm)) {
                concepts.set(norm, (concepts.get(norm) || 0) + 1);
            }
        }
    }
    // 5. Extract `backtick` terms (code/tool references)
    const backtickPattern = /`([^`]+)`/g;
    while ((match = backtickPattern.exec(text)) !== null) {
        const term = match[1].trim();
        if (term.length >= MIN_CONCEPT_LENGTH && term.length <= 50 && !term.includes(' ')) {
            const norm = normalize(term);
            if (!STOP_WORDS.has(norm) && !/^[{[(]/.test(term) && !term.includes('=')) {
                concepts.set(norm, (concepts.get(norm) || 0) + 1);
            }
        }
    }
    return concepts;
}
// ─── Index Building ─────────────────────────────────────────────────────────
function buildIndex() {
    const files = discoverMemoryFiles();
    const allConcepts = {};
    // Per-section concept tracking for co-occurrence
    const sectionConcepts = [];
    for (const filePath of files) {
        const relPath = path.relative(WORKSPACE, filePath);
        let content;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        }
        catch {
            continue;
        }
        // Get file modification time
        const stat = fs.statSync(filePath);
        const lastMod = stat.mtime.toISOString().slice(0, 10);
        const sections = parseIntoSections(content);
        for (const section of sections) {
            const concepts = extractConcepts(section.content);
            const sectionConceptNames = [];
            for (const [concept, count] of concepts) {
                sectionConceptNames.push(concept);
                if (!allConcepts[concept]) {
                    allConcepts[concept] = {
                        concept,
                        category: categorize(concept),
                        files: {},
                        totalMentions: 0,
                        related: [],
                    };
                }
                const entry = allConcepts[concept];
                if (!entry.files[relPath]) {
                    entry.files[relPath] = { count: 0, sections: [], lastSeen: lastMod };
                }
                entry.files[relPath].count += count;
                entry.totalMentions += count;
                if (!entry.files[relPath].sections.includes(section.header)) {
                    entry.files[relPath].sections.push(section.header);
                }
                // Update lastSeen to most recent
                if (lastMod > entry.files[relPath].lastSeen) {
                    entry.files[relPath].lastSeen = lastMod;
                }
            }
            if (sectionConceptNames.length > 1) {
                sectionConcepts.push(sectionConceptNames);
            }
        }
    }
    // Build co-occurrence (related concepts)
    const cooccurrence = {};
    for (const section of sectionConcepts) {
        for (let i = 0; i < section.length; i++) {
            for (let j = i + 1; j < section.length; j++) {
                const a = section[i], b = section[j];
                if (a === b)
                    continue;
                if (!cooccurrence[a])
                    cooccurrence[a] = {};
                if (!cooccurrence[b])
                    cooccurrence[b] = {};
                cooccurrence[a][b] = (cooccurrence[a][b] || 0) + 1;
                cooccurrence[b][a] = (cooccurrence[b][a] || 0) + 1;
            }
        }
    }
    // Assign top related concepts (by co-occurrence frequency)
    for (const [concept, entry] of Object.entries(allConcepts)) {
        const cooc = cooccurrence[concept] || {};
        entry.related = Object.entries(cooc)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([c]) => c);
    }
    // Filter out noise: concepts that appear only once in one file (unless in known entities)
    const filtered = {};
    for (const [concept, entry] of Object.entries(allConcepts)) {
        const fileCount = Object.keys(entry.files).length;
        const isKnown = KNOWN_ENTITIES[concept] !== undefined;
        // Skip noise: various heuristics for false concepts
        const isNoise = concept.endsWith(':') || concept.endsWith('.') ||
            concept.endsWith(',') || concept.endsWith(')') ||
            STOP_WORDS.has(concept) || concept.length < MIN_CONCEPT_LENGTH ||
            concept.includes('/') || // File paths
            concept.includes('(') || // Parenthetical fragments
            /^\d/.test(concept) || // Starts with digit
            /^[a-z]/.test(concept) && concept.includes(' ') && concept.length > 25 || // Long lowercase phrases
            concept.startsWith('"') || // Quoted fragments
            concept.startsWith("'");
        if (!isNoise && (isKnown || fileCount >= 2 || entry.totalMentions >= 3)) {
            filtered[concept] = entry;
        }
    }
    return {
        version: 1,
        builtAt: new Date().toISOString(),
        fileCount: files.length,
        conceptCount: Object.keys(filtered).length,
        concepts: filtered,
    };
}
// ─── Lookup ─────────────────────────────────────────────────────────────────
function loadIndex() {
    try {
        return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    }
    catch {
        console.error('No index found. Run: npx ts-node src/concept-index.ts build');
        process.exit(1);
    }
}
function lookupConcept(term) {
    const index = loadIndex();
    const norm = normalize(term);
    // Exact match
    const entry = index.concepts[norm];
    if (entry) {
        printConceptEntry(entry);
        return;
    }
    // Fuzzy match: concepts containing the term
    const matches = Object.entries(index.concepts)
        .filter(([k]) => k.includes(norm) || norm.includes(k))
        .sort((a, b) => b[1].totalMentions - a[1].totalMentions);
    if (matches.length === 0) {
        console.log(`  No concept found for "${term}"`);
        return;
    }
    console.log(`  No exact match for "${term}". Similar concepts:\n`);
    for (const [, entry] of matches.slice(0, 5)) {
        printConceptEntry(entry);
        console.log();
    }
}
function printConceptEntry(entry) {
    console.log(`  📌 ${entry.concept} [${entry.category}] — ${entry.totalMentions} mentions`);
    const sortedFiles = Object.entries(entry.files)
        .sort((a, b) => b[1].count - a[1].count);
    for (const [file, info] of sortedFiles) {
        const sections = info.sections.length > 3
            ? info.sections.slice(0, 3).join(', ') + ` +${info.sections.length - 3} more`
            : info.sections.join(', ');
        console.log(`     ${file} (${info.count}x) — ${sections}`);
    }
    if (entry.related.length > 0) {
        console.log(`     Related: ${entry.related.join(', ')}`);
    }
}
// ─── Related Concepts ───────────────────────────────────────────────────────
function findRelated(term) {
    const index = loadIndex();
    const norm = normalize(term);
    const entry = index.concepts[norm];
    if (!entry) {
        console.log(`  Concept "${term}" not found in index.`);
        return;
    }
    console.log(`\n  🔗 Concepts related to "${entry.concept}" [${entry.category}]:\n`);
    for (const rel of entry.related) {
        const relEntry = index.concepts[rel];
        if (relEntry) {
            const sharedFiles = Object.keys(entry.files)
                .filter(f => relEntry.files[f])
                .length;
            console.log(`     ${rel} [${relEntry.category}] — ${relEntry.totalMentions} mentions, ${sharedFiles} shared files`);
        }
    }
}
// ─── Gap Detection ──────────────────────────────────────────────────────────
function findGaps() {
    const index = loadIndex();
    // Find concepts with high mentions but no dedicated topic file
    const topicFiles = new Set();
    for (const f of fs.readdirSync(path.join(MEMORY_DIR, 'topics'))) {
        if (f.endsWith('.md')) {
            topicFiles.add(f.replace('.md', '').toLowerCase());
        }
    }
    console.log('\n  📊 Concept gaps — high-frequency concepts without dedicated topic files:\n');
    const gaps = Object.values(index.concepts)
        .filter(e => {
        const norm = e.concept.toLowerCase();
        return e.totalMentions >= 5 && !topicFiles.has(norm) && e.category !== 'person';
    })
        .sort((a, b) => b.totalMentions - a.totalMentions);
    if (gaps.length === 0) {
        console.log('  No significant gaps found. ✅');
        return;
    }
    for (const entry of gaps.slice(0, 15)) {
        const fileCount = Object.keys(entry.files).length;
        console.log(`  ⚠️  ${entry.concept} [${entry.category}] — ${entry.totalMentions} mentions across ${fileCount} files`);
        console.log(`      Top files: ${Object.entries(entry.files).sort((a, b) => b[1].count - a[1].count).slice(0, 3).map(([f, i]) => `${f}(${i.count}x)`).join(', ')}`);
    }
}
// ─── Auto-Tagging ───────────────────────────────────────────────────────────
function suggestTags(text) {
    const index = loadIndex();
    const concepts = extractConcepts(text);
    console.log('\n  🏷️  Suggested tags:\n');
    const tags = [];
    for (const [concept] of concepts) {
        const entry = index.concepts[concept];
        if (entry) {
            // Known concept — weight by total mentions (familiar concepts get higher priority)
            tags.push({
                tag: concept,
                score: Math.min(1, entry.totalMentions / 20) + 0.5,
                reason: `known concept (${entry.totalMentions} mentions, ${entry.category})`,
            });
        }
        else {
            // New concept — might be worth noting
            tags.push({
                tag: concept,
                score: 0.3,
                reason: 'new concept (not in index)',
            });
        }
    }
    tags.sort((a, b) => b.score - a.score);
    for (const t of tags.slice(0, 10)) {
        const bar = '█'.repeat(Math.round(t.score * 10));
        console.log(`  ${t.tag.padEnd(25)} ${bar.padEnd(10)} ${t.reason}`);
    }
}
// ─── Statistics ─────────────────────────────────────────────────────────────
function showStats() {
    const index = loadIndex();
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  📊 Concept Index Statistics');
    console.log(`  Built: ${index.builtAt}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log(`  Files indexed: ${index.fileCount}`);
    console.log(`  Concepts tracked: ${index.conceptCount}`);
    // By category
    const byCat = {};
    for (const e of Object.values(index.concepts)) {
        byCat[e.category] = (byCat[e.category] || 0) + 1;
    }
    console.log('\n  By category:');
    for (const [cat, count] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${cat.padEnd(12)} ${count}`);
    }
    // Top concepts by mention count
    const top = Object.values(index.concepts)
        .sort((a, b) => b.totalMentions - a.totalMentions)
        .slice(0, 15);
    console.log('\n  Top concepts by frequency:');
    for (const e of top) {
        const fileCount = Object.keys(e.files).length;
        console.log(`    ${e.concept.padEnd(20)} ${String(e.totalMentions).padStart(4)} mentions in ${fileCount} files [${e.category}]`);
    }
    // Most connected concepts
    const connected = Object.values(index.concepts)
        .sort((a, b) => b.related.length - a.related.length)
        .slice(0, 10);
    console.log('\n  Most connected concepts:');
    for (const e of connected) {
        console.log(`    ${e.concept.padEnd(20)} ${e.related.length} connections → ${e.related.slice(0, 5).join(', ')}`);
    }
    console.log('\n═══════════════════════════════════════════════════════════\n');
}
// ─── Graph Export ────────────────────────────────────────────────────────────
function exportGraph() {
    const index = loadIndex();
    console.log('\n  🕸️  Concept Co-occurrence Graph\n');
    console.log('  Format: concept → [related concepts with shared file count]\n');
    // Only show concepts with >= 3 connections
    const connected = Object.values(index.concepts)
        .filter(e => e.related.length >= 2)
        .sort((a, b) => b.related.length - a.related.length);
    for (const entry of connected) {
        const relStr = entry.related
            .map(r => {
            const re = index.concepts[r];
            if (!re)
                return r;
            const shared = Object.keys(entry.files).filter(f => re.files[f]).length;
            return `${r}(${shared})`;
        })
            .join(', ');
        console.log(`  ${entry.concept} [${entry.category}] → ${relStr}`);
    }
}
// ─── CLI ────────────────────────────────────────────────────────────────────
function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'stats';
    switch (command) {
        case 'build': {
            console.log('\n  Building concept index...\n');
            const index = buildIndex();
            fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
            console.log(`  ✅ Indexed ${index.conceptCount} concepts from ${index.fileCount} files`);
            console.log(`  Saved to ${INDEX_PATH}\n`);
            // Show quick stats
            showStats();
            break;
        }
        case 'lookup': {
            const term = args.slice(1).join(' ');
            if (!term) {
                console.log('  Usage: concept-index.ts lookup <term>');
                process.exit(1);
            }
            lookupConcept(term);
            break;
        }
        case 'related': {
            const term = args.slice(1).join(' ');
            if (!term) {
                console.log('  Usage: concept-index.ts related <term>');
                process.exit(1);
            }
            findRelated(term);
            break;
        }
        case 'gaps':
            findGaps();
            break;
        case 'tags': {
            const text = args.slice(1).join(' ');
            if (!text) {
                console.log('  Usage: concept-index.ts tags "some text to tag"');
                process.exit(1);
            }
            suggestTags(text);
            break;
        }
        case 'stats':
            showStats();
            break;
        case 'graph':
            exportGraph();
            break;
        default:
            console.log(`  Unknown command: ${command}`);
            console.log('  Commands: build, lookup, related, gaps, tags, stats, graph');
            process.exit(1);
    }
}
main();
