#!/usr/bin/env npx ts-node
"use strict";
/**
 * Semantic Deduplication for Memory Captures
 *
 * Prevents the same information from being written multiple times across
 * daily logs, MEMORY.md, and topic files. Uses character trigram similarity
 * (Jaccard index) which handles paraphrases better than keyword matching.
 *
 * Three similarity tiers:
 *   - EXACT:    normalized strings match           → always skip
 *   - HIGH:     trigram similarity >= 0.65          → skip (likely same info)
 *   - MODERATE: trigram similarity >= 0.45          → warn (possible dupe)
 *
 * Usage (programmatic):
 *   import { checkDuplicate, DedupResult } from './dedup';
 *   const result = checkDuplicate("Built health dashboard with scoring");
 *   if (result.isDuplicate) console.log(`Dupe of: ${result.bestMatch.source}`);
 *
 * Usage (CLI):
 *   echo "Built health dashboard" | npx ts-node src/dedup.ts
 *   npx ts-node src/dedup.ts "Some text to check"
 *   npx ts-node src/dedup.ts --scan          # Scan all recent captures for dupes
 *   npx ts-node src/dedup.ts --json "text"   # Machine-readable output
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
exports.checkDuplicate = checkDuplicate;
exports.scanForDuplicates = scanForDuplicates;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const WORKSPACE = '/root/clawd';
const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md');
const DAILY_DIR = path.join(WORKSPACE, 'memory', 'daily');
const TOPICS_DIR = path.join(WORKSPACE, 'memory', 'topics');
// ─── Config ─────────────────────────────────────────────────────────────────
const THRESHOLDS = {
    exact: 0.92, // Normalized near-exact match
    high: 0.60, // Strong semantic overlap — skip capture
    moderate: 0.42, // Possible dupe — warn but don't block
};
// How many recent daily files to check (performance bound)
const MAX_DAILY_FILES = 7;
// Minimum line length to consider for comparison (skip headers, dates, etc.)
const MIN_LINE_LENGTH = 20;
// ─── Similarity Engine ──────────────────────────────────────────────────────
/**
 * Normalize text for comparison: lowercase, strip markdown, collapse whitespace
 */
function normalize(text) {
    return text
        .toLowerCase()
        .replace(/^[-*>#\d.]+\s*/gm, '') // Strip list markers, headers, blockquotes
        .replace(/\*\*|__|\*|_|`|~~/g, '') // Strip inline markdown
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Links → text
        .replace(/\b\d{2}:\d{2}\b/g, '') // Strip timestamps
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '') // Strip dates
        .replace(/\([^)]*\)/g, '') // Strip parentheticals (paths, scores, etc.)
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Generate character trigrams from text
 */
function trigrams(text) {
    const result = new Set();
    const normalized = normalize(text);
    if (normalized.length < 3)
        return result;
    for (let i = 0; i <= normalized.length - 3; i++) {
        result.add(normalized.substring(i, i + 3));
    }
    return result;
}
/**
 * Extract significant words (4+ chars) from text
 */
function significantWords(text) {
    return new Set(normalize(text)
        .split(/\s+/)
        .filter(w => w.length >= 4 && !/^\d+$/.test(w)));
}
/**
 * Multi-signal similarity: combines trigram similarity with word containment.
 *
 * Handles the key weakness of pure Jaccard: when texts differ in length,
 * Jaccard penalizes because the union is large. We use:
 * - Trigram Jaccard (captures character-level structure)
 * - Trigram containment (shorter text's trigrams found in longer)
 * - Word containment (significant words from shorter found in longer)
 *
 * Final score: weighted blend that handles paraphrases and length asymmetry.
 */
function combinedSimilarity(a, aWords, b, bWords) {
    if (a.size === 0 && b.size === 0)
        return 1.0;
    if (a.size === 0 || b.size === 0)
        return 0.0;
    // Trigram intersection
    let trigramInt = 0;
    for (const gram of a) {
        if (b.has(gram))
            trigramInt++;
    }
    // Trigram Jaccard
    const trigramJaccard = trigramInt / (a.size + b.size - trigramInt);
    // Trigram containment (max direction)
    const trigramContAB = a.size > 0 ? trigramInt / a.size : 0;
    const trigramContBA = b.size > 0 ? trigramInt / b.size : 0;
    const trigramCont = Math.max(trigramContAB, trigramContBA);
    // Word containment (max direction)
    let wordInt = 0;
    for (const w of aWords) {
        if (bWords.has(w))
            wordInt++;
    }
    const wordContAB = aWords.size > 0 ? wordInt / aWords.size : 0;
    const wordContBA = bWords.size > 0 ? wordInt / bWords.size : 0;
    const wordCont = Math.max(wordContAB, wordContBA);
    // Weighted blend: 25% Jaccard + 35% trigram containment + 40% word containment
    // Word containment is weighted highest because it captures semantic paraphrases best
    return 0.25 * trigramJaccard + 0.35 * trigramCont + 0.40 * wordCont;
}
/**
 * Quick normalized string equality (handles formatting differences)
 */
function normalizedEqual(a, b) {
    return normalize(a) === normalize(b);
}
/**
 * Extract meaningful lines from a markdown file.
 * Skips frontmatter, headers, empty lines, and very short lines.
 */
function extractLines(content, source) {
    const lines = [];
    let inFrontmatter = false;
    for (const raw of content.split('\n')) {
        const trimmed = raw.trim();
        // Skip YAML frontmatter
        if (trimmed === '---') {
            inFrontmatter = !inFrontmatter;
            continue;
        }
        if (inFrontmatter)
            continue;
        // Skip empty, headers, and short lines
        if (!trimmed)
            continue;
        if (trimmed.startsWith('#'))
            continue;
        // Strip list markers for length check
        const clean = trimmed.replace(/^[-*>]+\s*/, '').replace(/^\d+\.\s*/, '');
        if (clean.length < MIN_LINE_LENGTH)
            continue;
        lines.push({ text: clean, source });
    }
    return lines;
}
/**
 * Load the comparison corpus: recent daily files + MEMORY.md + topic files
 */
function loadCorpus(options) {
    const corpus = [];
    // 1. MEMORY.md
    if (fs.existsSync(MEMORY_FILE)) {
        const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
        corpus.push(...extractLines(content, 'MEMORY.md'));
    }
    // 2. Recent daily files (last N days)
    if (fs.existsSync(DAILY_DIR)) {
        const files = fs.readdirSync(DAILY_DIR)
            .filter(f => f.endsWith('.md'))
            .sort()
            .reverse()
            .slice(0, MAX_DAILY_FILES);
        for (const file of files) {
            const filePath = path.join(DAILY_DIR, file);
            if (options?.skipFile && filePath === options.skipFile)
                continue;
            const content = fs.readFileSync(filePath, 'utf-8');
            corpus.push(...extractLines(content, `daily/${file}`));
        }
    }
    // 3. Topic files
    if (fs.existsSync(TOPICS_DIR)) {
        const files = fs.readdirSync(TOPICS_DIR)
            .filter(f => f.endsWith('.md'));
        for (const file of files) {
            const filePath = path.join(TOPICS_DIR, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            corpus.push(...extractLines(content, `topics/${file}`));
        }
    }
    return corpus;
}
// ─── Public API ─────────────────────────────────────────────────────────────
/**
 * Check if a piece of text is a duplicate of existing memory content.
 *
 * @param text - The text to check
 * @param options - Optional: skipFile (don't check this file path)
 * @returns DedupResult with match details
 */
function checkDuplicate(text, options) {
    const startTime = Date.now();
    const normalizedInput = normalize(text);
    if (normalizedInput.length < MIN_LINE_LENGTH) {
        return {
            isDuplicate: false,
            isWarning: false,
            bestMatch: null,
            allMatches: [],
            checkedLines: 0,
            checkedFiles: 0,
            elapsedMs: Date.now() - startTime,
        };
    }
    const inputTrigrams = trigrams(text);
    const inputWords = significantWords(text);
    const corpus = loadCorpus(options);
    const allMatches = [];
    const seenFiles = new Set();
    for (const line of corpus) {
        seenFiles.add(line.source);
        // Quick exact check first
        if (normalizedEqual(text, line.text)) {
            allMatches.push({
                text: line.text,
                source: line.source,
                similarity: 1.0,
                tier: 'exact',
            });
            continue;
        }
        // Multi-signal similarity
        const lineTrigrams = trigrams(line.text);
        const lineWords = significantWords(line.text);
        const sim = combinedSimilarity(inputTrigrams, inputWords, lineTrigrams, lineWords);
        if (sim >= THRESHOLDS.moderate) {
            let tier;
            if (sim >= THRESHOLDS.exact)
                tier = 'exact';
            else if (sim >= THRESHOLDS.high)
                tier = 'high';
            else
                tier = 'moderate';
            allMatches.push({
                text: line.text,
                source: line.source,
                similarity: sim,
                tier,
            });
        }
    }
    // Sort by similarity descending
    allMatches.sort((a, b) => b.similarity - a.similarity);
    const bestMatch = allMatches.length > 0 ? allMatches[0] : null;
    const isDuplicate = bestMatch !== null && (bestMatch.tier === 'exact' || bestMatch.tier === 'high');
    const isWarning = !isDuplicate && bestMatch !== null && bestMatch.tier === 'moderate';
    return {
        isDuplicate,
        isWarning,
        bestMatch,
        allMatches,
        checkedLines: corpus.length,
        checkedFiles: seenFiles.size,
        elapsedMs: Date.now() - startTime,
    };
}
/**
 * Batch check: find all duplicates within recent daily files.
 * Useful for auditing existing content.
 */
function scanForDuplicates() {
    const corpus = loadCorpus();
    const duplicates = [];
    // Compare each line against all lines that came BEFORE it (chronological dedup)
    for (let i = 1; i < corpus.length; i++) {
        const current = corpus[i];
        const currentTrigrams = trigrams(current.text);
        const currentWords = significantWords(current.text);
        for (let j = 0; j < i; j++) {
            const earlier = corpus[j];
            // Skip self-file comparisons (within same file is fine)
            if (current.source === earlier.source)
                continue;
            const sim = combinedSimilarity(currentTrigrams, currentWords, trigrams(earlier.text), significantWords(earlier.text));
            if (sim >= THRESHOLDS.high) {
                duplicates.push({
                    line: current.text.substring(0, 80),
                    source: current.source,
                    duplicateOf: earlier.text.substring(0, 80),
                    duplicateSource: earlier.source,
                    similarity: sim,
                });
                break; // One match is enough per line
            }
        }
    }
    return {
        duplicates,
        totalLines: corpus.length,
        totalDuplicates: duplicates.length,
    };
}
// ─── CLI ────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const jsonMode = process.argv.includes('--json');
    const scanMode = process.argv.includes('--scan');
    if (scanMode) {
        console.log('🔍 Scanning for duplicates across memory files...\n');
        const result = scanForDuplicates();
        if (jsonMode) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        if (result.duplicates.length === 0) {
            console.log(`✅ No duplicates found across ${result.totalLines} lines.`);
            return;
        }
        console.log(`⚠️  Found ${result.totalDuplicates} duplicates across ${result.totalLines} lines:\n`);
        for (const dupe of result.duplicates) {
            console.log(`  📄 ${dupe.source}: "${dupe.line}"`);
            console.log(`  🔄 ≈${(dupe.similarity * 100).toFixed(0)}% of ${dupe.duplicateSource}: "${dupe.duplicateOf}"`);
            console.log('');
        }
        return;
    }
    // Single text check
    let input = '';
    if (args.length > 0) {
        input = args.join(' ');
    }
    else {
        input = await new Promise((resolve) => {
            let data = '';
            if (process.stdin.isTTY) {
                console.log('⌨️  Enter text to check for duplicates (Ctrl+D to finish):');
            }
            process.stdin.setEncoding('utf-8');
            process.stdin.on('data', (chunk) => { data += chunk; });
            process.stdin.on('end', () => { resolve(data); });
            setTimeout(() => { if (!data)
                resolve(''); }, 5000);
        });
    }
    input = input.trim();
    if (!input) {
        console.log('⚠️  No input provided.');
        console.log('Usage: echo "text" | npx ts-node src/dedup.ts');
        console.log('       npx ts-node src/dedup.ts --scan');
        process.exit(1);
    }
    const result = checkDuplicate(input);
    if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    console.log('');
    if (result.isDuplicate) {
        console.log(`🔄 DUPLICATE DETECTED (${result.bestMatch.tier})`);
        console.log(`   Similarity: ${(result.bestMatch.similarity * 100).toFixed(0)}%`);
        console.log(`   Matches: "${result.bestMatch.text.substring(0, 80)}"`);
        console.log(`   Source: ${result.bestMatch.source}`);
    }
    else if (result.isWarning) {
        console.log(`⚠️  POSSIBLE DUPLICATE (moderate match)`);
        console.log(`   Similarity: ${(result.bestMatch.similarity * 100).toFixed(0)}%`);
        console.log(`   Matches: "${result.bestMatch.text.substring(0, 80)}"`);
        console.log(`   Source: ${result.bestMatch.source}`);
    }
    else {
        console.log(`✅ No duplicates found.`);
    }
    console.log(`   Checked: ${result.checkedLines} lines across ${result.checkedFiles} files (${result.elapsedMs}ms)`);
    if (result.allMatches.length > 1) {
        console.log(`\n   Other matches:`);
        for (const m of result.allMatches.slice(1, 4)) {
            console.log(`     ${(m.similarity * 100).toFixed(0)}% [${m.tier}] ${m.source}: "${m.text.substring(0, 60)}"`);
        }
    }
}
if (require.main === module) {
    main().catch(e => {
        console.error('❌ Error:', e.message);
        process.exit(1);
    });
}
