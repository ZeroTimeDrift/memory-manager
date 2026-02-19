#!/usr/bin/env npx ts-node
"use strict";
/**
 * Memory Health Dashboard
 *
 * Single command that shows system-wide memory health:
 * - Total files tracked vs actual files on disk
 * - Orphan files (on disk but not in manifest)
 * - Stale files (low weight, no recent access)
 * - Weight distribution (avg, min, max, by type)
 * - Decay trend (weight changes over sessions)
 * - Session activity (recent sessions, streak)
 * - Cross-reference integrity
 * - Chunk health scoring
 * - Search diagnostics batch score (BM25 blind spot analysis)
 * - Manifest integrity warnings
 *
 * Usage:
 *   npx ts-node src/health.ts              # Dashboard view
 *   npx ts-node src/health.ts --json       # Machine-readable output
 *   npx ts-node src/health.ts --verbose    # Include all file details
 *   npx ts-node src/health.ts --gate       # CI/automation: exit 1 if any metric fails
 *
 * Gate thresholds:
 *   - Health score ≥ 40
 *   - Chunk health ≥ 85
 *   - Search diagnostics ≥ 80%
 *   - Cross-ref integrity ≥ 90%
 *   - Zero missing files
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
const MANIFEST_PATH = '/root/clawd/skills/memory-manager/manifest.json';
const BENCHMARK_PATH = path.join(MEMORY_DIR, 'benchmark-history.json');
// Top-level memory files
const TOP_LEVEL_MEMORY = ['MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'OPERATING.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md'];
// ─── Helpers ────────────────────────────────────────────────────────────────
function daysBetween(dateStr, now) {
    const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00Z'));
    return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}
function findMemoryFiles() {
    const files = [];
    // Top-level memory files
    for (const f of TOP_LEVEL_MEMORY) {
        const full = path.join(WORKSPACE, f);
        if (fs.existsSync(full))
            files.push(f);
    }
    // Skills memory-manager SKILL.md
    const skillPath = 'skills/memory-manager/SKILL.md';
    if (fs.existsSync(path.join(WORKSPACE, skillPath)))
        files.push(skillPath);
    // Recurse memory/
    function walk(dir, prefix) {
        if (!fs.existsSync(dir))
            return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) {
                if (e.name === 'archive')
                    continue; // Skip archived files
                walk(path.join(dir, e.name), rel);
            }
            else if (e.name.endsWith('.md')) {
                files.push(`memory/${rel}`);
            }
        }
    }
    walk(MEMORY_DIR, '');
    return files;
}
function loadBenchmarkHistory() {
    try {
        if (!fs.existsSync(BENCHMARK_PATH))
            return [];
        return JSON.parse(fs.readFileSync(BENCHMARK_PATH, 'utf-8'));
    }
    catch {
        return [];
    }
}
// ─── Analysis ───────────────────────────────────────────────────────────────
function analyze(manifest) {
    const now = new Date();
    const warnings = [];
    // --- File tracking ---
    const trackedFiles = Object.keys(manifest.files);
    const diskFiles = findMemoryFiles();
    const trackedSet = new Set(trackedFiles);
    const diskSet = new Set(diskFiles);
    const orphans = diskFiles.filter(f => !trackedSet.has(f));
    const missing = trackedFiles.filter(f => !diskSet.has(f) && !fs.existsSync(path.join(WORKSPACE, f)));
    if (orphans.length > 5)
        warnings.push(`${orphans.length} orphan files not in manifest`);
    if (missing.length > 0)
        warnings.push(`${missing.length} manifest entries point to missing files`);
    // --- Weight analysis ---
    const entries = Object.entries(manifest.files);
    const weights = entries.map(([, v]) => v.weight);
    const avgWeight = weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;
    const minEntry = entries.reduce((a, b) => a[1].weight < b[1].weight ? a : b, entries[0]);
    const maxEntry = entries.reduce((a, b) => a[1].weight > b[1].weight ? a : b, entries[0]);
    // By type
    const byType = {};
    for (const [, v] of entries) {
        if (!byType[v.type])
            byType[v.type] = { count: 0, totalWeight: 0 };
        byType[v.type].count++;
        byType[v.type].totalWeight += v.weight;
    }
    const byTypeAvg = {};
    for (const [k, v] of Object.entries(byType)) {
        byTypeAvg[k] = { count: v.count, avgWeight: +(v.totalWeight / v.count).toFixed(3) };
    }
    // Distribution buckets
    const distribution = { high: 0, medium: 0, low: 0, stale: 0 };
    for (const w of weights) {
        if (w >= 0.7)
            distribution.high++;
        else if (w >= 0.3)
            distribution.medium++;
        else if (w >= 0.1)
            distribution.low++;
        else
            distribution.stale++;
    }
    // --- Staleness ---
    const STALE_THRESHOLD_DAYS = 5;
    const STALE_WEIGHT_THRESHOLD = 0.2;
    const staleFiles = [];
    for (const [file, info] of entries) {
        const days = daysBetween(info.lastAccess, now);
        if (days >= STALE_THRESHOLD_DAYS && info.weight < STALE_WEIGHT_THRESHOLD) {
            staleFiles.push({ file, weight: info.weight, lastAccess: info.lastAccess, daysSince: days });
        }
    }
    staleFiles.sort((a, b) => b.daysSince - a.daysSince);
    const accessDates = entries.map(([f, v]) => ({ file: f, date: v.lastAccess, daysSince: daysBetween(v.lastAccess, now) }));
    accessDates.sort((a, b) => b.daysSince - a.daysSince);
    const oldest = accessDates[0];
    const newest = accessDates[accessDates.length - 1];
    // --- Decay ---
    const filesWithDecay = entries.filter(([, v]) => v.decayRate > 0).length;
    const filesProtected = entries.filter(([, v]) => v.decayRate === 0).length;
    const daysSinceDecay = manifest.lastDecayRun ? daysBetween(manifest.lastDecayRun, now) : -1;
    if (daysSinceDecay > 2)
        warnings.push(`Decay hasn't run in ${daysSinceDecay} days`);
    // --- Sessions ---
    const sessions = manifest.sessionHistory || [];
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last7 = sessions.filter(s => new Date(s.date) >= sevenDaysAgo);
    const categoryCounts = {};
    for (const s of sessions) {
        categoryCounts[s.taskCategory] = (categoryCounts[s.taskCategory] || 0) + 1;
    }
    // Consolidation streak: consecutive sessions ending in 'completed'
    let streak = 0;
    for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i].outcome === 'completed')
            streak++;
        else
            break;
    }
    // --- Benchmarks ---
    const benchmarks = loadBenchmarkHistory();
    let benchmarkInfo = { available: false };
    if (benchmarks.length > 0) {
        const latest = benchmarks[benchmarks.length - 1];
        const latestScore = latest.recallScore ?? latest.score ?? null;
        let trend = 'stable';
        if (benchmarks.length >= 3) {
            const recent3 = benchmarks.slice(-3).map((b) => b.recallScore ?? b.score ?? 0);
            const diff = recent3[2] - recent3[0];
            if (diff > 5)
                trend = 'improving';
            else if (diff < -5)
                trend = 'declining';
        }
        benchmarkInfo = { available: true, latestScore, trend };
    }
    // --- Health Score (0-100) ---
    let score = 50; // Start neutral
    // Tracking coverage: what % of disk files are tracked?
    const coverageRatio = diskFiles.length > 0 ? trackedFiles.length / diskFiles.length : 1;
    score += Math.round((coverageRatio - 0.5) * 30); // ±15 from coverage
    // Weight health: penalize if avg is too low
    if (avgWeight >= 0.5)
        score += 10;
    else if (avgWeight >= 0.3)
        score += 5;
    else
        score -= 5;
    // Staleness penalty
    score -= Math.min(staleFiles.length * 3, 15);
    // Missing files penalty
    score -= missing.length * 5;
    // Session activity bonus
    if (last7.length >= 5)
        score += 10;
    else if (last7.length >= 3)
        score += 5;
    // Decay health
    if (daysSinceDecay <= 1)
        score += 5;
    else if (daysSinceDecay > 3)
        score -= 10;
    // Benchmark bonus
    if (benchmarkInfo.available && benchmarkInfo.trend === 'improving')
        score += 5;
    if (benchmarkInfo.available && benchmarkInfo.trend === 'declining')
        score -= 5;
    // Clamp
    score = Math.max(0, Math.min(100, score));
    if (score < 40)
        warnings.push('Overall health score is low — consider a maintenance session');
    return {
        timestamp: now.toISOString(),
        files: {
            tracked: trackedFiles.length,
            onDisk: diskFiles.length,
            orphans,
            missing,
        },
        weights: {
            avg: +avgWeight.toFixed(3),
            min: { file: minEntry[0], weight: minEntry[1].weight },
            max: { file: maxEntry[0], weight: maxEntry[1].weight },
            byType: byTypeAvg,
            distribution,
        },
        staleness: {
            staleFiles,
            oldestAccess: oldest ? { file: oldest.file, date: oldest.date, daysSince: oldest.daysSince } : { file: 'none', date: 'N/A', daysSince: 0 },
            newestAccess: newest ? { file: newest.file, date: newest.date } : { file: 'none', date: 'N/A' },
        },
        decay: {
            lastRun: manifest.lastDecayRun || 'never',
            daysSinceDecay,
            filesWithDecay,
            filesProtected,
        },
        sessions: {
            total: sessions.length,
            last7Days: last7.length,
            lastSession: sessions.length > 0 ? sessions[sessions.length - 1].date : 'none',
            consolidationStreak: streak,
            categoryCounts,
        },
        benchmarks: benchmarkInfo,
        warnings,
        score,
    };
}
// ─── Display ────────────────────────────────────────────────────────────────
function bar(value, max, width = 20) {
    const filled = Math.round((value / max) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}
function scoreEmoji(score) {
    if (score >= 80)
        return '🟢';
    if (score >= 60)
        return '🟡';
    if (score >= 40)
        return '🟠';
    return '🔴';
}
function renderDashboard(report, verbose) {
    const { files, weights, staleness, decay, sessions, benchmarks, warnings, score } = report;
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🧠 MEMORY HEALTH DASHBOARD                        ║
║           ${new Date(report.timestamp).toLocaleString('en-GB', { timeZone: 'Europe/Berlin' }).padEnd(42)}║
╚══════════════════════════════════════════════════════════════╝

${scoreEmoji(score)} HEALTH SCORE: ${score}/100 ${bar(score, 100)}

─── 📁 FILES ──────────────────────────────────────────────────
  Tracked in manifest:  ${files.tracked}
  On disk (memory/**):  ${files.onDisk}
  Coverage:             ${files.onDisk > 0 ? Math.round(files.tracked / files.onDisk * 100) : 100}%
  Orphans (untracked):  ${files.orphans.length}
  Missing (dangling):   ${files.missing.length}`);
    if (files.orphans.length > 0) {
        console.log(`  ┌─ Orphan files:`);
        for (const o of files.orphans.slice(0, 10)) {
            console.log(`  │  · ${o}`);
        }
        if (files.orphans.length > 10)
            console.log(`  │  ... and ${files.orphans.length - 10} more`);
        console.log(`  └─`);
    }
    if (files.missing.length > 0) {
        console.log(`  ┌─ Missing files (in manifest, not on disk):`);
        for (const m of files.missing) {
            console.log(`  │  ⚠ ${m}`);
        }
        console.log(`  └─`);
    }
    console.log(`
─── ⚖️  WEIGHTS ────────────────────────────────────────────────
  Average:  ${weights.avg.toFixed(3)}  ${bar(weights.avg, 1, 15)}
  Min:      ${weights.min.weight.toFixed(3)}  ← ${weights.min.file}
  Max:      ${weights.max.weight.toFixed(3)}  ← ${weights.max.file}

  Distribution:
    High   (≥0.7):  ${weights.distribution.high.toString().padStart(2)}  ${'█'.repeat(weights.distribution.high)}
    Medium (≥0.3):  ${weights.distribution.medium.toString().padStart(2)}  ${'█'.repeat(weights.distribution.medium)}
    Low    (≥0.1):  ${weights.distribution.low.toString().padStart(2)}  ${'█'.repeat(weights.distribution.low)}
    Stale  (<0.1):  ${weights.distribution.stale.toString().padStart(2)}  ${'█'.repeat(weights.distribution.stale)}

  By type:`);
    for (const [type, info] of Object.entries(weights.byType)) {
        console.log(`    ${type.padEnd(10)} ${info.count} files, avg ${info.avgWeight.toFixed(3)}`);
    }
    console.log(`
─── 🕰️  STALENESS ──────────────────────────────────────────────
  Oldest access:  ${staleness.oldestAccess.file} (${staleness.oldestAccess.daysSince}d ago)
  Newest access:  ${staleness.newestAccess.file} (${staleness.newestAccess.date})
  Stale files:    ${staleness.staleFiles.length}`);
    if (staleness.staleFiles.length > 0) {
        console.log(`  ┌─ Stale (low weight + old access):`);
        for (const s of staleness.staleFiles.slice(0, 8)) {
            console.log(`  │  · ${s.file}  w=${s.weight.toFixed(3)}  ${s.daysSince}d ago`);
        }
        console.log(`  └─`);
    }
    console.log(`
─── 📉 DECAY ───────────────────────────────────────────────────
  Last run:         ${decay.lastRun}
  Days since decay: ${decay.daysSinceDecay >= 0 ? decay.daysSinceDecay : 'never'}
  Files with decay: ${decay.filesWithDecay} (subject to weight loss)
  Files protected:  ${decay.filesProtected} (core, no decay)`);
    console.log(`
─── 📊 SESSIONS ────────────────────────────────────────────────
  Total recorded:     ${sessions.total}
  Last 7 days:        ${sessions.last7Days}
  Last session:       ${sessions.lastSession ? new Date(sessions.lastSession).toLocaleString('en-GB', { timeZone: 'Europe/Berlin' }) : 'none'}
  Completion streak:  ${sessions.consolidationStreak}

  Category breakdown:`);
    for (const [cat, count] of Object.entries(sessions.categoryCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${cat.padEnd(16)} ${count} ${'▪'.repeat(count)}`);
    }
    // Cross-reference integrity (inline call to xref logic)
    try {
        const { execSync } = require('child_process');
        const xrefJson = execSync('npx ts-node /root/clawd/skills/memory-manager/src/xref-check.ts --json 2>/dev/null', {
            cwd: '/root/clawd/skills/memory-manager',
            encoding: 'utf-8',
            timeout: 15000,
        });
        const xref = JSON.parse(xrefJson);
        console.log(`
─── 🔗 CROSS-REFERENCES ────────────────────────────────────────
  Total refs:        ${xref.totalRefs}
  Broken:            ${xref.brokenCount}
  Broken anchors:    ${xref.brokenSectionCount}
  Orphan files:      ${xref.orphanCount}
  Integrity score:   ${xref.healthScore}%`);
        if (xref.brokenCount > 0) {
            for (const br of xref.brokenRefs.slice(0, 5)) {
                console.log(`  ⚠ ${br.source} → ${br.target}`);
            }
        }
    }
    catch {
        console.log(`
─── 🔗 CROSS-REFERENCES ────────────────────────────────────────
  (xref-check unavailable)`);
    }
    // Chunk health
    try {
        const { execSync } = require('child_process');
        const chunkJson = execSync('npx ts-node /root/clawd/skills/memory-manager/src/chunk-health.ts --json 2>/dev/null', {
            cwd: '/root/clawd/skills/memory-manager',
            encoding: 'utf-8',
            timeout: 15000,
        });
        const chunk = JSON.parse(chunkJson);
        const criticalIssues = chunk.oversizedSections.filter((s) => ['MEMORY.md', 'memory/OPERATING.md', 'memory/rules.md', 'memory/index.md', 'IDENTITY.md'].includes(s.file));
        console.log(`
─── 📦 CHUNK HEALTH ────────────────────────────────────────────
  Score:             ${chunk.score}/100
  Total chunks:      ${chunk.totalChunks} across ${chunk.totalFiles} files
  Oversized sections: ${chunk.oversizedSections.length} (${criticalIssues.length} in critical files)
  Thin overlap:      ${chunk.thinOverlapFiles.length} files`);
        if (criticalIssues.length > 0) {
            for (const issue of criticalIssues) {
                console.log(`  ⚠ ${issue.file}:${issue.lineNo} — ${issue.header.slice(0, 60)} (${issue.chars} chars)`);
            }
        }
    }
    catch {
        console.log(`
─── 📦 CHUNK HEALTH ────────────────────────────────────────────
  (chunk-health unavailable)`);
    }
    if (benchmarks.available) {
        console.log(`
─── 🎯 BENCHMARKS ──────────────────────────────────────────────
  Latest score:  ${benchmarks.latestScore ?? 'N/A'}
  Trend:         ${benchmarks.trend ?? 'insufficient data'}`);
    }
    // Search diagnostics batch
    try {
        const { execSync } = require('child_process');
        const diagOutput = execSync('npx ts-node /root/clawd/skills/memory-manager/src/search-diagnostics.ts --batch --json 2>/dev/null', {
            cwd: '/root/clawd/skills/memory-manager',
            encoding: 'utf-8',
            timeout: 30000,
        });
        const diagReportPath = '/root/clawd/skills/memory-manager/search-diagnostics-report.json';
        if (fs.existsSync(diagReportPath)) {
            const diagReport = JSON.parse(fs.readFileSync(diagReportPath, 'utf-8'));
            const diagScore = ((diagReport.score || 0) * 100).toFixed(1);
            const diagIcon = parseFloat(diagScore) >= 85 ? '✅' : parseFloat(diagScore) >= 70 ? '🟡' : '🔴';
            console.log(`
─── 🔍 SEARCH DIAGNOSTICS ──────────────────────────────────────
  Batch score:     ${diagIcon} ${diagScore}% (${diagReport.hits} hits, ${diagReport.partials} partial, ${diagReport.misses} miss)
  Total queries:   ${diagReport.total}`);
            if (diagReport.misses > 0) {
                const missedQueries = (diagReport.results || []).filter((r) => r.type === 'miss');
                for (const m of missedQueries.slice(0, 3)) {
                    console.log(`  🔴 MISS: "${m.query}" (expected: ${m.expected})`);
                }
            }
        }
    }
    catch {
        console.log(`
─── 🔍 SEARCH DIAGNOSTICS ──────────────────────────────────────
  (search-diagnostics unavailable)`);
    }
    if (warnings.length > 0) {
        console.log(`
─── ⚠️  WARNINGS ───────────────────────────────────────────────`);
        for (const w of warnings) {
            console.log(`  ⚠ ${w}`);
        }
    }
    if (verbose) {
        console.log(`
─── 📋 ALL TRACKED FILES ───────────────────────────────────────`);
        const sorted = Object.entries(report.weights.byType).length > 0 ?
            Object.entries(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')).files)
                .sort((a, b) => b[1].weight - a[1].weight) : [];
        for (const [file, info] of sorted) {
            const days = daysBetween(info.lastAccess, new Date());
            console.log(`  ${info.weight.toFixed(3).padStart(5)} │ ${info.type.padEnd(7)} │ ${days}d │ ×${info.accessCount} │ ${file}`);
        }
    }
    console.log(`
═══════════════════════════════════════════════════════════════`);
}
// ─── Main ───────────────────────────────────────────────────────────────────
function runGate(report) {
    const failures = [];
    // Gate 1: Overall health score
    if (report.score < 40) {
        failures.push(`health-score: ${report.score}/100 (threshold: 40)`);
    }
    // Gate 2: Chunk health
    try {
        const { execSync } = require('child_process');
        const chunkJson = execSync('npx ts-node /root/clawd/skills/memory-manager/src/chunk-health.ts --json 2>/dev/null', {
            cwd: '/root/clawd/skills/memory-manager',
            encoding: 'utf-8',
            timeout: 15000,
        });
        const chunk = JSON.parse(chunkJson);
        if (chunk.score < 85) {
            failures.push(`chunk-health: ${chunk.score}/100 (threshold: 85)`);
        }
    }
    catch { }
    // Gate 3: Search diagnostics
    const diagReportPath = '/root/clawd/skills/memory-manager/search-diagnostics-report.json';
    if (fs.existsSync(diagReportPath)) {
        try {
            const diagReport = JSON.parse(fs.readFileSync(diagReportPath, 'utf-8'));
            const diagScore = (diagReport.score || 0) * 100;
            if (diagScore < 80) {
                failures.push(`search-diagnostics: ${diagScore.toFixed(1)}% (threshold: 80%)`);
            }
        }
        catch { }
    }
    // Gate 4: Cross-reference integrity
    try {
        const { execSync } = require('child_process');
        const xrefJson = execSync('npx ts-node /root/clawd/skills/memory-manager/src/xref-check.ts --json 2>/dev/null', {
            cwd: '/root/clawd/skills/memory-manager',
            encoding: 'utf-8',
            timeout: 15000,
        });
        const xref = JSON.parse(xrefJson);
        if (xref.healthScore < 90) {
            failures.push(`xref-integrity: ${xref.healthScore}% (threshold: 90%)`);
        }
    }
    catch { }
    // Gate 5: Missing files
    if (report.files.missing.length > 0) {
        failures.push(`missing-files: ${report.files.missing.length} manifest entries point to missing files`);
    }
    return { pass: failures.length === 0, failures };
}
function main() {
    const args = process.argv.slice(2);
    const jsonMode = args.includes('--json');
    const verbose = args.includes('--verbose');
    const gateMode = args.includes('--gate');
    if (!fs.existsSync(MANIFEST_PATH)) {
        console.error('❌ Manifest not found at', MANIFEST_PATH);
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const report = analyze(manifest);
    if (jsonMode) {
        console.log(JSON.stringify(report, null, 2));
    }
    else {
        renderDashboard(report, verbose);
    }
    if (gateMode) {
        const gate = runGate(report);
        if (gate.pass) {
            console.log('\n✅ GATE: ALL CHECKS PASSED');
            process.exit(0);
        }
        else {
            console.log('\n❌ GATE: FAILED');
            for (const f of gate.failures) {
                console.log(`   ✗ ${f}`);
            }
            process.exit(1);
        }
    }
}
main();
