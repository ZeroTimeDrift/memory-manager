#!/usr/bin/env npx ts-node

/**
 * Retrieval Learning Loop — Synthesize search reports → actionable improvements
 * 
 * Closes the feedback loop between measurement and improvement:
 * 1. Reads all search quality reports (search-quality, recall-probe, search-diagnostics)
 * 2. Identifies recurring failure patterns (not just individual misses)
 * 3. Generates concrete improvement actions:
 *    - Vocabulary patches (add search-friendly terms to file headers)
 *    - Chunk split suggestions (oversized sections that cause ranking dilution)
 *    - Cross-reference additions (files that should link but don't)
 *    - Weight adjustments (files consistently retrieved but low-weighted)
 * 4. Can auto-apply safe improvements (vocabulary enrichment)
 * 
 * Usage:
 *   npx ts-node src/retrieval-learn.ts                # Analyze + suggest
 *   npx ts-node src/retrieval-learn.ts --apply        # Auto-apply safe patches
 *   npx ts-node src/retrieval-learn.ts --history      # Show learning history
 *   npx ts-node src/retrieval-learn.ts --dry-run      # Show what --apply would do
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

const WORKSPACE = '/root/clawd';
const SKILL_DIR = path.join(WORKSPACE, 'skills/memory-manager');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const LEARNING_LOG = path.join(SKILL_DIR, 'retrieval-learning-log.json');

// ─── Types ──────────────────────────────────────────────────────────────────

interface FailurePattern {
  type: 'vocabulary-gap' | 'ranking-dilution' | 'missing-content' | 'chunk-too-large' | 'wrong-file-ranked';
  severity: 'high' | 'medium' | 'low';
  file: string;
  description: string;
  evidence: string[];  // Which reports/queries surfaced this
  suggestedFix: string;
}

interface VocabularyPatch {
  file: string;
  terms: string[];          // Terms to add to search context section
  reason: string;
  queries: string[];        // Queries that triggered this suggestion
}

interface ChunkSuggestion {
  file: string;
  section: string;
  currentSize: number;
  suggestedAction: 'split' | 'compress' | 'extract';
  reason: string;
}

interface WeightAdjustment {
  file: string;
  currentWeight: number;
  suggestedWeight: number;
  reason: string;
}

interface LearningReport {
  timestamp: string;
  inputReports: string[];
  patterns: FailurePattern[];
  vocabularyPatches: VocabularyPatch[];
  chunkSuggestions: ChunkSuggestion[];
  weightAdjustments: WeightAdjustment[];
  appliedPatches: string[];
  summary: string;
}

// ─── Report Loading ─────────────────────────────────────────────────────────

function loadJson(filepath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadSearchQuality(): any | null {
  const data = loadJson(path.join(SKILL_DIR, 'search-quality-history.json'));
  if (Array.isArray(data) && data.length > 0) return data[data.length - 1];
  return data;
}

function loadRecallProbe(): any | null {
  return loadJson(path.join(SKILL_DIR, 'recall-probe-report.json'));
}

function loadDiagnostics(): any | null {
  return loadJson(path.join(SKILL_DIR, 'search-diagnostics-report.json'));
}

function loadManifest(): any {
  return loadJson(path.join(SKILL_DIR, 'manifest.json')) || { files: {} };
}

// ─── Pattern Detection ──────────────────────────────────────────────────────

function detectVocabularyGaps(
  searchQuality: any,
  recallProbe: any,
  diagnostics: any
): FailurePattern[] {
  const patterns: FailurePattern[] = [];
  const fileIssues: Map<string, { queries: string[]; type: string }[]> = new Map();

  // From search-quality: weak spots where correct file is outranked
  if (searchQuality?.weakSpots) {
    for (const ws of searchQuality.weakSpots) {
      // Determine expected file from details
      const detail = searchQuality.details?.find((d: any) => d.query === ws.query);
      const file = detail?.correctPath || 'unknown';
      if (!fileIssues.has(file)) fileIssues.set(file, []);
      fileIssues.get(file)!.push({ queries: [ws.query], type: 'outranked' });
    }
  }

  // From recall-probe: blind spots where content exists but isn't found
  if (recallProbe?.blindSpots) {
    for (const bs of recallProbe.blindSpots) {
      const file = bs.file || 'unknown';
      if (!fileIssues.has(file)) fileIssues.set(file, []);
      fileIssues.get(file)!.push({ queries: [bs.query], type: 'not-found' });
    }
  }

  // From diagnostics: partial hits (found but not at rank 1)
  if (diagnostics?.results) {
    for (const r of diagnostics.results) {
      if (r.type === 'partial') {
        const file = r.expected || 'unknown';
        if (!fileIssues.has(file)) fileIssues.set(file, []);
        fileIssues.get(file)!.push({ queries: [r.query], type: 'partial' });
      }
    }
  }

  // Aggregate: files with multiple issues are high priority
  for (const [file, issues] of fileIssues) {
    const allQueries = issues.flatMap(i => i.queries);
    const uniqueQueries = [...new Set(allQueries)];
    const severity = issues.length >= 3 ? 'high' : issues.length >= 2 ? 'medium' : 'low';
    const types = [...new Set(issues.map(i => i.type))];

    patterns.push({
      type: 'vocabulary-gap',
      severity,
      file,
      description: `${file} has ${issues.length} retrieval issue(s): ${types.join(', ')}`,
      evidence: uniqueQueries,
      suggestedFix: `Add search context section with terms from failing queries`
    });
  }

  return patterns;
}

function detectRankingDilution(searchQuality: any): FailurePattern[] {
  const patterns: FailurePattern[] = [];

  if (!searchQuality?.details) return patterns;

  // Find files where correct score is close to top score (competitive ranking)
  const fileScores: Map<string, { gaps: number[]; queries: string[] }> = new Map();

  for (const d of searchQuality.details) {
    if (d.scoreGap !== null && d.scoreGap > 0 && d.scoreGap < 0.3) {
      const file = d.correctPath;
      if (!fileScores.has(file)) fileScores.set(file, { gaps: [], queries: [] });
      fileScores.get(file)!.gaps.push(d.scoreGap);
      fileScores.get(file)!.queries.push(d.query);
    }
  }

  for (const [file, data] of fileScores) {
    if (data.gaps.length >= 2) {
      const avgGap = data.gaps.reduce((a, b) => a + b, 0) / data.gaps.length;
      patterns.push({
        type: 'ranking-dilution',
        severity: avgGap > 0.15 ? 'high' : 'medium',
        file,
        description: `${file} consistently outranked (avg gap: ${avgGap.toFixed(3)}) — content may be too diluted`,
        evidence: data.queries,
        suggestedFix: `Consider splitting large sections or adding more specific search keywords`
      });
    }
  }

  return patterns;
}

function detectChunkIssues(): FailurePattern[] {
  const patterns: FailurePattern[] = [];

  // Read chunk health if available
  const memoryFiles = getMemoryFiles();
  
  for (const file of memoryFiles) {
    try {
      const content = fs.readFileSync(path.join(WORKSPACE, file), 'utf-8');
      const sections = content.split(/^## /m);
      
      for (let i = 1; i < sections.length; i++) {
        const section = sections[i];
        const title = section.split('\n')[0].trim();
        const charCount = section.length;
        
        if (charCount > 2000) {
          patterns.push({
            type: 'chunk-too-large',
            severity: charCount > 4000 ? 'high' : 'medium',
            file,
            description: `Section "${title}" is ${charCount} chars (target <500 for optimal embedding)`,
            evidence: [`${file}#${title}: ${charCount} chars`],
            suggestedFix: `Split into smaller subsections or compress content`
          });
        }
      }
    } catch {
      // skip files we can't read
    }
  }

  return patterns;
}

function detectWrongFileRanked(searchQuality: any): FailurePattern[] {
  const patterns: FailurePattern[] = [];

  if (!searchQuality?.details) return patterns;

  // Find cases where a different file consistently steals queries
  const stealers: Map<string, { victimFile: string; queries: string[] }[]> = new Map();

  for (const d of searchQuality.details) {
    if (d.outrankedBy && d.outrankedBy.length > 0) {
      for (const stealer of d.outrankedBy) {
        if (!stealers.has(stealer)) stealers.set(stealer, []);
        stealers.get(stealer)!.push({
          victimFile: d.correctPath,
          queries: [d.query]
        });
      }
    }
  }

  for (const [stealer, victims] of stealers) {
    if (victims.length >= 2) {
      patterns.push({
        type: 'wrong-file-ranked',
        severity: 'medium',
        file: stealer,
        description: `${stealer} steals ranking from ${victims.length} other files — may be too broadly matching`,
        evidence: victims.flatMap(v => v.queries),
        suggestedFix: `Check if ${stealer} has overly generic content that matches many queries`
      });
    }
  }

  return patterns;
}

// ─── Vocabulary Patch Generation ────────────────────────────────────────────

function generateVocabularyPatches(patterns: FailurePattern[]): VocabularyPatch[] {
  const patches: VocabularyPatch[] = [];
  const vocabPatterns = patterns.filter(p => p.type === 'vocabulary-gap');

  for (const pattern of vocabPatterns) {
    // Extract key terms from failing queries
    const allQueries = pattern.evidence;
    const terms = extractKeyTerms(allQueries);
    
    if (terms.length > 0) {
      patches.push({
        file: pattern.file,
        terms,
        reason: pattern.description,
        queries: allQueries
      });
    }
  }

  return patches;
}

function extractKeyTerms(queries: string[]): string[] {
  // Stop words to filter out
  const stopWords = new Set([
    'what', 'who', 'how', 'where', 'when', 'why', 'is', 'the', 'a', 'an', 'and',
    'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
    'does', 'do', 'did', 'should', 'could', 'would', 'my', 'your', 'this', 'that',
    'i', 'me', 'we', 'he', 'she', 'it', 'they', 'them', 'our', 'their',
    'not', 'no', 'can', 'will', 'are', 'was', 'were', 'been', 'have', 'has',
    'had', 'be', 'if', 'about', 'up', 'out', 'any', 'all', 'just', 'some'
  ]);

  const termCounts: Map<string, number> = new Map();

  for (const query of queries) {
    const words = query.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));

    for (const word of words) {
      termCounts.set(word, (termCounts.get(word) || 0) + 1);
    }

    // Also extract bigrams
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      termCounts.set(bigram, (termCounts.get(bigram) || 0) + 1);
    }
  }

  // Return terms that appear in multiple queries, or unique significant terms
  return [...termCounts.entries()]
    .filter(([term, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([term]) => term);
}

// ─── Chunk Suggestions ──────────────────────────────────────────────────────

function generateChunkSuggestions(patterns: FailurePattern[]): ChunkSuggestion[] {
  const chunkPatterns = patterns.filter(p => p.type === 'chunk-too-large');
  
  return chunkPatterns.map(p => {
    const match = p.evidence[0]?.match(/^(.+?)#(.+?): (\d+) chars$/);
    return {
      file: p.file,
      section: match?.[2] || 'unknown',
      currentSize: parseInt(match?.[3] || '0'),
      suggestedAction: (parseInt(match?.[3] || '0') > 3000 ? 'split' : 'compress') as 'split' | 'compress',
      reason: p.description
    };
  });
}

// ─── Weight Adjustments ─────────────────────────────────────────────────────

function generateWeightAdjustments(
  patterns: FailurePattern[],
  manifest: any
): WeightAdjustment[] {
  const adjustments: WeightAdjustment[] = [];
  const files = manifest.files || {};

  // Files with retrieval issues but high weight → weight is fine, fix content
  // Files with good retrieval but low weight → boost weight
  // Files that "steal" ranking → maybe lower weight

  for (const pattern of patterns) {
    const fileData = files[pattern.file];
    if (!fileData) continue;

    if (pattern.type === 'wrong-file-ranked' && fileData.weight > 0.5) {
      // File is too dominant — consider if its weight is inflated
      adjustments.push({
        file: pattern.file,
        currentWeight: fileData.weight,
        suggestedWeight: fileData.weight, // Don't auto-adjust — flag for review
        reason: `Steals ranking from other files — review if content is too broad`
      });
    }
  }

  return adjustments;
}

// ─── Auto-Apply ─────────────────────────────────────────────────────────────

function applyVocabularyPatch(patch: VocabularyPatch, dryRun: boolean): boolean {
  const fullPath = path.join(WORKSPACE, patch.file);
  
  if (!fs.existsSync(fullPath)) {
    console.log(`  ⚠️  File not found: ${patch.file}`);
    return false;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  
  // Check if file already has a Search Context section
  const searchContextRegex = /^## Search Context.*$/m;
  const hasSearchContext = searchContextRegex.test(content);

  // Build the terms line
  const termsLine = patch.terms.join(', ');

  if (dryRun) {
    if (hasSearchContext) {
      console.log(`  📝 Would update Search Context in ${patch.file}: +[${termsLine}]`);
    } else {
      console.log(`  📝 Would add Search Context to ${patch.file}: [${termsLine}]`);
    }
    return true;
  }

  if (hasSearchContext) {
    // Append terms to existing search context
    const updatedContent = content.replace(
      /^(## Search Context[^\n]*\n)([\s\S]*?)(?=\n## |\n---|\Z)/m,
      (match, header, body) => {
        // Check which terms are already present
        const existingLower = body.toLowerCase();
        const newTerms = patch.terms.filter(t => !existingLower.includes(t.toLowerCase()));
        if (newTerms.length === 0) return match;
        
        const addition = `\nRetrieval enrichment (${new Date().toISOString().split('T')[0]}): ${newTerms.join(', ')}`;
        return header + body.trimEnd() + addition + '\n';
      }
    );
    
    if (updatedContent !== content) {
      fs.writeFileSync(fullPath, updatedContent);
      console.log(`  ✅ Updated Search Context in ${patch.file}: +${patch.terms.length} terms`);
      return true;
    } else {
      console.log(`  ⏭️  All terms already present in ${patch.file}`);
      return false;
    }
  } else {
    // Add new Search Context section at end of file
    const section = `\n---\n\n## Search Context — Retrieval Enrichment\n\nRetrieval enrichment (${new Date().toISOString().split('T')[0]}): ${termsLine}\n`;
    fs.writeFileSync(fullPath, content.trimEnd() + '\n' + section);
    console.log(`  ✅ Added Search Context to ${patch.file}: ${patch.terms.length} terms`);
    return true;
  }
}

function reindexMemory(): void {
  console.log('\n  🔄 Re-indexing memory...');
  try {
    child_process.execSync('clawdbot memory index 2>&1', { 
      cwd: WORKSPACE,
      timeout: 30000 
    });
    console.log('  ✅ Re-indexed');
  } catch (e: any) {
    console.log(`  ⚠️  Re-index failed: ${e.message?.substring(0, 100)}`);
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function getMemoryFiles(): string[] {
  const files: string[] = [];
  
  function walk(dir: string, prefix: string) {
    try {
      const entries = fs.readdirSync(path.join(WORKSPACE, dir), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relPath = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === 'archive') continue;
          walk(path.join(dir, entry.name), `${relPath}/`);
        } else if (entry.name.endsWith('.md')) {
          files.push(relPath);
        }
      }
    } catch {}
  }

  // Include root files tracked in manifest
  for (const f of ['MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md']) {
    if (fs.existsSync(path.join(WORKSPACE, f))) files.push(f);
  }

  walk('memory', 'memory/');
  return files;
}

// ─── Learning Log ───────────────────────────────────────────────────────────

function loadLearningLog(): LearningReport[] {
  try {
    return JSON.parse(fs.readFileSync(LEARNING_LOG, 'utf-8'));
  } catch {
    return [];
  }
}

function saveLearningLog(log: LearningReport[]): void {
  fs.writeFileSync(LEARNING_LOG, JSON.stringify(log, null, 2));
}

function showHistory(): void {
  const log = loadLearningLog();
  if (log.length === 0) {
    console.log('No learning history yet.');
    return;
  }

  console.log(`\n📚 RETRIEVAL LEARNING HISTORY (${log.length} sessions)\n`);

  for (const entry of log.slice(-10)) {
    const date = new Date(entry.timestamp).toLocaleString();
    const patternCount = entry.patterns.length;
    const patchCount = entry.vocabularyPatches.length;
    const applied = entry.appliedPatches.length;

    console.log(`  ${date}`);
    console.log(`    Patterns: ${patternCount} | Patches: ${patchCount} | Applied: ${applied}`);
    console.log(`    ${entry.summary}`);
    console.log();
  }

  // Trend analysis
  if (log.length >= 3) {
    const recent = log.slice(-3);
    const avgPatterns = recent.reduce((s, r) => s + r.patterns.length, 0) / recent.length;
    const trend = log.length >= 6 
      ? (log.slice(-6, -3).reduce((s, r) => s + r.patterns.length, 0) / 3)
      : null;

    console.log('📈 Trend:');
    console.log(`  Recent avg patterns: ${avgPatterns.toFixed(1)}`);
    if (trend !== null) {
      const dir = avgPatterns < trend ? '📉 improving' : avgPatterns > trend ? '📈 degrading' : '➡️ stable';
      console.log(`  Previous avg: ${trend.toFixed(1)} → ${dir}`);
    }
  }
}

// ─── "Good Enough" Threshold ────────────────────────────────────────────────
// When quality metrics are at ceiling, stop generating micro-tasks.
// This prevents the diminishing-returns loop documented on Feb 15, 2026.

interface QualityMetrics {
  recallPercent: number | null;   // From recall-probe (target: >=90%)
  diagnosticsPercent: number | null; // From search-diagnostics (target: >=90%)
  highSeverityCount: number;      // Patterns with severity 'high'
}

const GOOD_ENOUGH_THRESHOLDS = {
  recallPercent: 90,        // Above this, only fix high-severity issues
  diagnosticsPercent: 90,   // Above this, only fix high-severity issues
  maxLowSeverityPatterns: 0, // When above thresholds, ignore low-severity entirely
  recentCleanRuns: 3,       // If last N runs were all low-severity, skip entirely
};

function extractQualityMetrics(
  recallProbe: any,
  diagnostics: any,
  patterns: FailurePattern[]
): QualityMetrics {
  let recallPercent: number | null = null;
  let diagnosticsPercent: number | null = null;

  if (recallProbe) {
    const total = recallProbe.totalFacts || recallProbe.total || recallProbe.probed || 0;
    const found = recallProbe.found || (total - (recallProbe.missed || 0));
    if (total > 0) recallPercent = (found / total) * 100;
  }

  if (diagnostics?.results) {
    const total = diagnostics.results.length;
    const hits = diagnostics.results.filter((r: any) => r.type === 'hit').length;
    if (total > 0) diagnosticsPercent = (hits / total) * 100;
  }

  // Exclude moltbook patterns from high-severity count — moltbook files are auto-generated
  // by the observation cron and regenerate oversized chunks every cycle. Including them
  // in the quality gate creates an unbreakable loop.
  const actionableHighPatterns = patterns.filter(p => 
    p.severity === 'high' && !(p.file && /moltbook\//.test(p.file))
  );

  return {
    recallPercent,
    diagnosticsPercent,
    highSeverityCount: actionableHighPatterns.length,
  };
}

function isGoodEnough(metrics: QualityMetrics, learningLog: LearningReport[]): { 
  goodEnough: boolean; 
  reason: string;
  filterToHighOnly: boolean;
} {
  const { recallPercent, diagnosticsPercent, highSeverityCount } = metrics;

  // If there are high-severity issues, always proceed
  if (highSeverityCount > 0) {
    return { goodEnough: false, reason: `${highSeverityCount} high-severity pattern(s)`, filterToHighOnly: false };
  }

  // Check if recent runs have all been low-severity (diminishing returns)
  const recentRuns = learningLog.slice(-GOOD_ENOUGH_THRESHOLDS.recentCleanRuns);
  if (recentRuns.length >= GOOD_ENOUGH_THRESHOLDS.recentCleanRuns) {
    const allLowOrClean = recentRuns.every(r => 
      r.patterns.every(p => p.severity === 'low') || r.patterns.length === 0
    );
    if (allLowOrClean) {
      return { 
        goodEnough: true, 
        reason: `Last ${GOOD_ENOUGH_THRESHOLDS.recentCleanRuns} runs all low/clean — system stable`,
        filterToHighOnly: true 
      };
    }
  }

  // Check metric thresholds
  const recallAbove = recallPercent !== null && recallPercent >= GOOD_ENOUGH_THRESHOLDS.recallPercent;
  const diagAbove = diagnosticsPercent !== null && diagnosticsPercent >= GOOD_ENOUGH_THRESHOLDS.diagnosticsPercent;

  if (recallAbove && diagAbove) {
    return { 
      goodEnough: true, 
      reason: `Recall ${recallPercent!.toFixed(1)}% ≥ ${GOOD_ENOUGH_THRESHOLDS.recallPercent}%, Diagnostics ${diagnosticsPercent!.toFixed(1)}% ≥ ${GOOD_ENOUGH_THRESHOLDS.diagnosticsPercent}% — above thresholds`,
      filterToHighOnly: true 
    };
  }

  if (recallAbove || diagAbove) {
    return { 
      goodEnough: false, 
      reason: `Partial — recall: ${recallPercent?.toFixed(1) || '?'}%, diagnostics: ${diagnosticsPercent?.toFixed(1) || '?'}%`,
      filterToHighOnly: true  // Still filter to high+medium only
    };
  }

  return { goodEnough: false, reason: 'Metrics below thresholds', filterToHighOnly: false };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const doApply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const showHistoryFlag = args.includes('--history');
  const forceFlag = args.includes('--force'); // Bypass good-enough check

  if (showHistoryFlag) {
    showHistory();
    return;
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  🔄 RETRIEVAL LEARNING LOOP');
  console.log('═══════════════════════════════════════════════════════\n');

  // Load reports
  const searchQuality = loadSearchQuality();
  const recallProbe = loadRecallProbe();
  const diagnostics = loadDiagnostics();
  const manifest = loadManifest();

  const inputReports: string[] = [];
  if (searchQuality) inputReports.push(`search-quality (${searchQuality.timestamp || 'unknown'})`);
  if (recallProbe) inputReports.push(`recall-probe (${recallProbe.timestamp || 'unknown'})`);
  if (diagnostics) inputReports.push(`diagnostics (${diagnostics.timestamp || 'unknown'})`);

  console.log(`📊 Input reports: ${inputReports.length}`);
  for (const r of inputReports) console.log(`   · ${r}`);
  console.log();

  if (inputReports.length === 0) {
    console.log('❌ No reports found. Run search-quality, recall-probe, or search-diagnostics first.');
    return;
  }

  // Detect patterns
  console.log('🔍 Detecting patterns...\n');

  let allPatterns: FailurePattern[] = [
    ...detectVocabularyGaps(searchQuality, recallProbe, diagnostics),
    ...detectRankingDilution(searchQuality),
    ...detectChunkIssues(),
    ...detectWrongFileRanked(searchQuality),
  ];

  // Sort by severity
  const severityOrder = { high: 0, medium: 1, low: 2 };
  allPatterns.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // ─── Good Enough Check ──────────────────────────────────────────────
  const existingLog = loadLearningLog();
  const metrics = extractQualityMetrics(recallProbe, diagnostics, allPatterns);
  const goodEnoughResult = isGoodEnough(metrics, existingLog);

  console.log(`📏 Quality gate: recall=${metrics.recallPercent?.toFixed(1) || '?'}%, high_sev=${metrics.highSeverityCount}`);
  
  if (goodEnoughResult.goodEnough && !forceFlag) {
    console.log(`\n✅ GOOD ENOUGH — ${goodEnoughResult.reason}`);
    console.log('   System is healthy. Skipping micro-optimizations.');
    console.log('   Use --force to override.\n');
    
    // Still log the clean run
    const report: LearningReport = {
      timestamp: new Date().toISOString(),
      inputReports,
      patterns: allPatterns,
      vocabularyPatches: [],
      chunkSuggestions: [],
      weightAdjustments: [],
      appliedPatches: [],
      summary: `GOOD_ENOUGH: ${goodEnoughResult.reason}. ${allPatterns.length} low-severity patterns skipped.`
    };
    existingLog.push(report);
    if (existingLog.length > 50) existingLog.splice(0, existingLog.length - 50);
    saveLearningLog(existingLog);
    
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  📋 SUMMARY: System healthy — no action needed`);
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`📝 Saved to learning log (${existingLog.length} entries total)`);
    return;
  }

  // Filter patterns based on threshold gate
  if (goodEnoughResult.filterToHighOnly && !forceFlag) {
    const before = allPatterns.length;
    allPatterns = allPatterns.filter(p => p.severity === 'high' || p.severity === 'medium');
    const filtered = before - allPatterns.length;
    if (filtered > 0) {
      console.log(`   Filtered ${filtered} low-severity pattern(s) — ${goodEnoughResult.reason}\n`);
    }
  }

  if (allPatterns.length === 0) {
    console.log('✅ No actionable patterns after filtering. Search system is performing well.\n');
  } else {
    console.log(`⚠️  Found ${allPatterns.length} pattern(s):\n`);

    for (const p of allPatterns) {
      const icon = { high: '🔴', medium: '🟡', low: '🟢' }[p.severity];
      console.log(`  ${icon} [${p.type}] ${p.description}`);
      console.log(`     Evidence: ${p.evidence.slice(0, 3).join('; ')}${p.evidence.length > 3 ? ` (+${p.evidence.length - 3} more)` : ''}`);
      console.log(`     Fix: ${p.suggestedFix}`);
      console.log();
    }
  }

  // Generate improvements
  const vocabularyPatches = generateVocabularyPatches(allPatterns);
  const chunkSuggestions = generateChunkSuggestions(allPatterns);
  const weightAdjustments = generateWeightAdjustments(allPatterns, manifest);

  // Report improvements
  if (vocabularyPatches.length > 0) {
    console.log(`\n📝 VOCABULARY PATCHES (${vocabularyPatches.length}):\n`);
    for (const patch of vocabularyPatches) {
      console.log(`  📄 ${patch.file}`);
      console.log(`     Terms: ${patch.terms.join(', ')}`);
      console.log(`     Triggered by: ${patch.queries.slice(0, 2).join('; ')}`);
      console.log();
    }
  }

  if (chunkSuggestions.length > 0) {
    console.log(`\n✂️  CHUNK SUGGESTIONS (${chunkSuggestions.length}):\n`);
    for (const cs of chunkSuggestions) {
      console.log(`  📄 ${cs.file} → ${cs.section}`);
      console.log(`     ${cs.currentSize} chars → ${cs.suggestedAction}`);
      console.log(`     ${cs.reason}`);
      console.log();
    }
  }

  if (weightAdjustments.length > 0) {
    console.log(`\n⚖️  WEIGHT REVIEWS (${weightAdjustments.length}):\n`);
    for (const wa of weightAdjustments) {
      console.log(`  📄 ${wa.file} (${wa.currentWeight.toFixed(3)})`);
      console.log(`     ${wa.reason}`);
      console.log();
    }
  }

  // Apply if requested
  const appliedPatches: string[] = [];

  if (doApply || dryRun) {
    console.log(`\n${dryRun ? '🔍 DRY RUN' : '🚀 APPLYING'} vocabulary patches...\n`);

    for (const patch of vocabularyPatches) {
      const applied = applyVocabularyPatch(patch, dryRun);
      if (applied && !dryRun) {
        appliedPatches.push(`vocab:${patch.file}:${patch.terms.length}terms`);
      }
    }

    if (!dryRun && appliedPatches.length > 0) {
      reindexMemory();
    }
  }

  // Summary
  const totalIssues = allPatterns.length;
  const highSev = allPatterns.filter(p => p.severity === 'high').length;
  const actionable = vocabularyPatches.length + chunkSuggestions.length + weightAdjustments.length;
  
  const summary = totalIssues === 0
    ? 'Clean run — no patterns detected'
    : `${totalIssues} patterns (${highSev} high), ${actionable} actionable suggestions, ${appliedPatches.length} applied`;

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  📋 SUMMARY: ${summary}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // Save to learning log
  const report: LearningReport = {
    timestamp: new Date().toISOString(),
    inputReports,
    patterns: allPatterns,
    vocabularyPatches,
    chunkSuggestions,
    weightAdjustments,
    appliedPatches,
    summary
  };

  const log = loadLearningLog();
  log.push(report);
  // Keep last 50 entries
  if (log.length > 50) log.splice(0, log.length - 50);
  saveLearningLog(log);

  console.log(`📝 Saved to learning log (${log.length} entries total)`);
}

main();
