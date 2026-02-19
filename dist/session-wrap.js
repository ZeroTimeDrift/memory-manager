#!/usr/bin/env npx ts-node
"use strict";
/**
 * Session Wrap — End-of-session summary generator
 *
 * Called at the end of a conversation session to:
 * 1. Generate structured session entry for daily log
 * 2. Trigger capture.ts for fact extraction
 * 3. Update file weights via session-update.ts
 * 4. Re-index memory via `clawdbot memory index`
 *
 * Usage:
 *   npx ts-node src/session-wrap.ts "Brief description of what happened"
 *   npx ts-node src/session-wrap.ts "Built capture system, discussed memory arch" --files MEMORY.md SKILL.md
 *   npx ts-node src/session-wrap.ts "Quick chat about deploy" --mood productive --tags deploy,infra
 *
 * Input can also be piped for richer capture:
 *   echo "DECISION: Ship Friday\nFACT: New API key\nTASK: Update docs" | npx ts-node src/session-wrap.ts "Major session"
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
const auto_discover_1 = require("./auto-discover");
const WORKSPACE = '/root/clawd';
const DAILY_DIR = path.join(WORKSPACE, 'memory', 'daily');
const SKILL_DIR = path.join(WORKSPACE, 'skills', 'memory-manager');
// ─── Helpers ────────────────────────────────────────────────────────────────
function getToday() {
    return new Date().toISOString().split('T')[0];
}
function getTimestamp() {
    return new Date().toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
        hour12: false, timeZone: 'Asia/Dubai'
    });
}
function getDubaiHour() {
    const dubaiTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dubai', hour: 'numeric', hour12: false });
    return parseInt(dubaiTime, 10);
}
function ensureDailyFile() {
    if (!fs.existsSync(DAILY_DIR)) {
        fs.mkdirSync(DAILY_DIR, { recursive: true });
    }
    const today = getToday();
    const dailyFile = path.join(DAILY_DIR, `${today}.md`);
    if (!fs.existsSync(dailyFile)) {
        const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        fs.writeFileSync(dailyFile, `---
date: "${today}"
day: "${dayName}"
tags: []
mood: "neutral"
---

# ${today}

`);
    }
    return dailyFile;
}
function parseArgs() {
    const args = process.argv.slice(2);
    let description = '';
    const files = [];
    let mood = '';
    const tags = [];
    let mode = 'default';
    for (const arg of args) {
        if (arg === '--files') {
            mode = 'files';
            continue;
        }
        if (arg === '--mood') {
            mode = 'mood';
            continue;
        }
        if (arg === '--tags') {
            mode = 'tags';
            continue;
        }
        if (arg.startsWith('--')) {
            mode = 'default';
            continue;
        }
        switch (mode) {
            case 'files':
                files.push(arg);
                break;
            case 'mood':
                mood = arg;
                mode = 'default';
                break;
            case 'tags':
                tags.push(...arg.split(','));
                mode = 'default';
                break;
            default: description = description ? `${description} ${arg}` : arg;
        }
    }
    return { description, files, mood, tags };
}
// ─── Session Entry ──────────────────────────────────────────────────────────
function writeSessionEntry(description, mood, tags) {
    const dailyFile = ensureDailyFile();
    const timestamp = getTimestamp();
    const today = getToday();
    // Build the session entry
    const sessionType = detectSessionType(description);
    const intensityMarker = detectIntensity(description);
    const entry = `
## ${timestamp} — ${sessionType} ${intensityMarker}

${description}

`;
    // Append to daily file
    const existing = fs.readFileSync(dailyFile, 'utf-8');
    fs.writeFileSync(dailyFile, existing.trimEnd() + '\n' + entry);
    // Update frontmatter tags and mood if provided
    if (tags.length > 0 || mood) {
        let content = fs.readFileSync(dailyFile, 'utf-8');
        if (tags.length > 0) {
            // Merge tags with existing
            const existingTagsMatch = content.match(/^tags:\s*\[([^\]]*)\]/m);
            const existingTags = existingTagsMatch
                ? existingTagsMatch[1].split(',').map(t => t.trim().replace(/"/g, '')).filter(t => t)
                : [];
            const allTags = [...new Set([...existingTags, ...tags])];
            const tagStr = allTags.map(t => `"${t}"`).join(', ');
            content = content.replace(/^tags:\s*\[.*\]/m, `tags: [${tagStr}]`);
        }
        if (mood) {
            content = content.replace(/^mood:\s*".*"/m, `mood: "${mood}"`);
        }
        fs.writeFileSync(dailyFile, content);
    }
    console.log(`📝 Session entry → daily/${today}.md`);
}
function detectSessionType(desc) {
    const d = desc.toLowerCase();
    if (/hevar|main session|direct chat/.test(d))
        return 'Main Session with Hevar';
    if (/cron|self-expansion|auto/.test(d))
        return 'Self-Expansion Session';
    if (/slack|discord|group/.test(d))
        return 'Group Chat Session';
    if (/debug|fix|bug/.test(d))
        return 'Debug Session';
    return 'Session';
}
function detectIntensity(desc) {
    const d = desc.toLowerCase();
    const wordCount = desc.split(/\s+/).length;
    if (/major|breakthrough|critical|huge/.test(d) || wordCount > 30)
        return '(MAJOR)';
    if (/quick|brief|minor|small/.test(d) || wordCount < 10)
        return '(quick)';
    return '';
}
// ─── Pipeline Steps ─────────────────────────────────────────────────────────
function runCapture(stdinData) {
    if (!stdinData || stdinData.trim().length === 0) {
        console.log('⏭️  No structured capture data — skipping capture.ts');
        return;
    }
    console.log('\n🔍 Running conversation capture...');
    try {
        const result = child_process.execSync(`npx ts-node ${path.join(SKILL_DIR, 'src', 'capture.ts')}`, {
            cwd: SKILL_DIR,
            input: stdinData,
            encoding: 'utf-8',
            timeout: 30000,
        });
        console.log(result);
    }
    catch (e) {
        console.error(`⚠️  Capture failed: ${e.message}`);
    }
}
function runSessionUpdate(files) {
    console.log('\n📊 Updating file weights...');
    try {
        const fileArgs = files.length > 0 ? files.join(' ') : '';
        const result = child_process.execSync(`npx ts-node ${path.join(SKILL_DIR, 'src', 'session-update.ts')} ${fileArgs}`, {
            cwd: SKILL_DIR,
            encoding: 'utf-8',
            timeout: 30000,
        });
        console.log(result);
    }
    catch (e) {
        console.error(`⚠️  Weight update failed: ${e.message}`);
    }
}
function runDecay() {
    console.log('\n⏳ Running memory decay...');
    try {
        const result = child_process.execSync(`npx ts-node ${path.join(SKILL_DIR, 'src', 'decay.ts')}`, {
            cwd: SKILL_DIR,
            encoding: 'utf-8',
            timeout: 30000,
        });
        // Show summary line only
        const lines = result.trim().split('\n');
        const summaryLine = lines.find(l => l.includes('Summary:'));
        if (summaryLine)
            console.log(`   ${summaryLine.trim()}`);
        const archivalLines = lines.filter(l => l.includes('🗃️'));
        archivalLines.forEach(l => console.log(`   ${l.trim()}`));
    }
    catch (e) {
        console.error(`⚠️  Decay failed: ${e.message}`);
    }
}
function runAutoDiscovery() {
    console.log('\n🔍 Running auto-discovery...');
    try {
        const result = (0, auto_discover_1.discover)();
        const hasIssues = result.orphans.length > 0 || result.dangling.length > 0 || result.staleSummaries.length > 0;
        if (!hasIssues) {
            console.log('   ✅ All files tracked, no issues.');
            return;
        }
        const stats = (0, auto_discover_1.applyDiscovery)(result);
        const parts = [];
        if (stats.registered > 0)
            parts.push(`+${stats.registered} registered`);
        if (stats.pruned > 0)
            parts.push(`-${stats.pruned} pruned`);
        if (stats.fixed > 0)
            parts.push(`~${stats.fixed} summaries fixed`);
        console.log(`   ✅ ${parts.join(', ')}`);
    }
    catch (e) {
        console.error(`⚠️  Auto-discovery failed: ${e.message}`);
    }
}
function runConceptIndex() {
    console.log('\n🗂️  Rebuilding concept index...');
    try {
        const result = child_process.execSync(`npx ts-node ${path.join(SKILL_DIR, 'src', 'concept-index.ts')} build`, {
            cwd: SKILL_DIR,
            encoding: 'utf-8',
            timeout: 30000,
        });
        const indexedLine = result.split('\n').find(l => l.includes('Indexed'));
        if (indexedLine)
            console.log(`   ${indexedLine.trim()}`);
    }
    catch (e) {
        console.error(`⚠️  Concept index failed: ${e.message}`);
    }
}
function runMemoryGraph() {
    console.log('\n🕸️  Rebuilding memory graph...');
    try {
        const result = child_process.execSync(`npx ts-node ${path.join(SKILL_DIR, 'src', 'memory-graph.ts')} build`, {
            cwd: SKILL_DIR,
            encoding: 'utf-8',
            timeout: 30000,
        });
        const statsLine = result.split('\n').find(l => l.includes('Merged edges'));
        if (statsLine)
            console.log(`   ${statsLine.trim()}`);
        const clusterLine = result.split('\n').find(l => l.includes('clusters found'));
        if (clusterLine)
            console.log(`   ${clusterLine.trim()}`);
    }
    catch (e) {
        console.error(`⚠️  Memory graph failed: ${e.message}`);
    }
}
function runMemoryIndex() {
    console.log('\n🔄 Re-indexing memory...');
    try {
        const result = child_process.execSync('clawdbot memory index', {
            cwd: WORKSPACE,
            encoding: 'utf-8',
            timeout: 60000,
        });
        // Only show last few lines
        const lines = result.trim().split('\n');
        const summary = lines.slice(-3).join('\n');
        console.log(`   ${summary}`);
    }
    catch (e) {
        console.error(`⚠️  Memory index failed: ${e.message}`);
    }
}
// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
    const { description, files, mood, tags } = parseArgs();
    if (!description) {
        console.log('Usage: npx ts-node src/session-wrap.ts "What happened this session"');
        console.log('');
        console.log('Options:');
        console.log('  --files FILE1 FILE2     Files accessed this session');
        console.log('  --mood productive       Session mood for daily log');
        console.log('  --tags tag1,tag2        Tags for daily log frontmatter');
        console.log('');
        console.log('Pipe structured data for capture:');
        console.log('  echo "DECISION: X\\nFACT: Y" | npx ts-node src/session-wrap.ts "Description"');
        process.exit(1);
    }
    // Read stdin if available (for structured capture data)
    let stdinData = null;
    if (!process.stdin.isTTY) {
        stdinData = await new Promise((resolve) => {
            let data = '';
            process.stdin.setEncoding('utf-8');
            process.stdin.on('data', (chunk) => { data += chunk; });
            process.stdin.on('end', () => { resolve(data); });
            setTimeout(() => resolve(data), 2000);
        });
    }
    const timestamp = getTimestamp();
    const today = getToday();
    console.log('═══════════════════════════════════════════════════════════');
    console.log('     🏁 SESSION WRAP');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`   Time: ${timestamp} (Dubai)`);
    console.log(`   Date: ${today}`);
    console.log(`   Summary: ${description}`);
    console.log('═══════════════════════════════════════════════════════════');
    // Step 1: Write session entry to daily log
    writeSessionEntry(description, mood, tags);
    // Step 2: Run capture.ts if there's structured data
    runCapture(stdinData);
    // Step 3: Update file weights
    runSessionUpdate(files);
    // Step 4: Apply time-based decay
    runDecay();
    // Step 5: Auto-discover new files, prune dangling, fix stale summaries
    runAutoDiscovery();
    // Step 6: Rebuild concept index
    runConceptIndex();
    // Step 6.5: Rebuild memory graph
    runMemoryGraph();
    // Step 7: Re-index memory
    runMemoryIndex();
    // Done
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('   ✅ SESSION WRAPPED');
    console.log(`   📝 Daily log: memory/daily/${today}.md`);
    if (stdinData && stdinData.trim()) {
        console.log('   📥 Capture: processed');
    }
    console.log('   📊 Weights: updated');
    console.log('   🔄 Index: refreshed');
    console.log('═══════════════════════════════════════════════════════════');
}
main().catch(e => {
    console.error('❌ Session wrap failed:', e.message);
    process.exit(1);
});
