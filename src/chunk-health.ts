#!/usr/bin/env npx ts-node
/**
 * chunk-health.ts — Chunk boundary health checker
 * 
 * Analyzes the SQLite memory index for:
 * 1. Sections that are too large for clean chunking (>1400 chars)
 * 2. Files with excessive chunk counts (potential bloat)
 * 3. Overlap quality between adjacent chunks
 * 
 * Usage: npx ts-node src/chunk-health.ts [--fix] [--json]
 *   --fix: Show actionable suggestions for each issue
 *   --json: Output as JSON for programmatic use
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const DB_PATH = '/root/.clawdbot/memory/main.sqlite';
const WORKSPACE = '/root/clawd';

interface ChunkRow {
  path: string;
  start_line: number;
  end_line: number;
  text_len: number;
}

interface SectionIssue {
  file: string;
  header: string;
  lineNo: number;
  chars: number;
  recommendation: string;
}

interface FileStats {
  path: string;
  chunks: number;
  totalLines: number;
  avgChunkSize: number;
  overlapQuality: 'good' | 'thin' | 'none';
}

function sqlite(query: string): string {
  try {
    return execSync(`sqlite3 "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function getChunksByFile(): Map<string, ChunkRow[]> {
  const raw = sqlite(`SELECT path, start_line, end_line, length(text) FROM chunks WHERE source='memory' ORDER BY path, start_line;`);
  const map = new Map<string, ChunkRow[]>();
  for (const line of raw.split('\n').filter(Boolean)) {
    const [p, s, e, l] = line.split('|');
    const row: ChunkRow = { path: p, start_line: +s, end_line: +e, text_len: +l };
    if (!map.has(p)) map.set(p, []);
    map.get(p)!.push(row);
  }
  return map;
}

function analyzeSections(filePath: string): SectionIssue[] {
  const fullPath = path.resolve(WORKSPACE, filePath);
  if (!fs.existsSync(fullPath)) return [];
  
  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const issues: SectionIssue[] = [];
  
  // Find section boundaries
  const sections: { header: string; lineNo: number; startIdx: number; endIdx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i] || '')) {
      if (sections.length > 0) {
        sections[sections.length - 1].endIdx = i;
      }
      sections.push({ header: (lines[i] || '').trim(), lineNo: i + 1, startIdx: i, endIdx: lines.length });
    }
  }
  
  for (const section of sections) {
    const sectionContent = lines.slice(section.startIdx + 1, section.endIdx).join('\n').trim();
    const chars = sectionContent.length;
    
    if (chars > 1400) {
      issues.push({
        file: filePath,
        header: section.header.slice(0, 80),
        lineNo: section.lineNo,
        chars,
        recommendation: chars > 3000 
          ? `Split into 2-3 sub-sections with ### headers (${chars} chars = ~${Math.ceil(chars/1600)} chunks)`
          : `Consider splitting or compressing (${chars} chars, slightly over 1400 limit)`
      });
    }
  }
  
  return issues;
}

function analyzeOverlap(chunks: ChunkRow[]): 'good' | 'thin' | 'none' {
  if (chunks.length < 2) return 'good';
  
  let totalOverlap = 0;
  let pairs = 0;
  
  for (let i = 0; i < chunks.length - 1; i++) {
    const overlap = chunks[i].end_line - chunks[i + 1].start_line + 1;
    if (overlap > 0) {
      totalOverlap += overlap;
      pairs++;
    }
  }
  
  if (pairs === 0) return 'none';
  const avgOverlap = totalOverlap / pairs;
  return avgOverlap >= 3 ? 'good' : 'thin';
}

// Main
const args = process.argv.slice(2);
const showFix = args.includes('--fix');
const jsonMode = args.includes('--json');

const chunksByFile = getChunksByFile();
const totalChunks = sqlite('SELECT COUNT(*) FROM chunks WHERE source=\'memory\';');
const totalFiles = chunksByFile.size;

// 1. Check section sizes in all memory files
const allIssues: SectionIssue[] = [];
const memoryFiles = sqlite(`SELECT DISTINCT path FROM chunks WHERE source='memory';`).split('\n').filter(Boolean);

for (const file of memoryFiles) {
  const issues = analyzeSections(file);
  allIssues.push(...issues);
}

// 2. File stats
const fileStats: FileStats[] = [];
for (const [filePath, chunks] of chunksByFile) {
  const avgSize = chunks.reduce((s, c) => s + c.text_len, 0) / chunks.length;
  fileStats.push({
    path: filePath,
    chunks: chunks.length,
    totalLines: chunks[chunks.length - 1].end_line,
    avgChunkSize: Math.round(avgSize),
    overlapQuality: analyzeOverlap(chunks)
  });
}

// 3. Score
const oversizedSections = allIssues.length;
const thinOverlap = fileStats.filter(f => f.overlapQuality === 'thin').length;
const noOverlap = fileStats.filter(f => f.overlapQuality === 'none').length;
const bloatedFiles = fileStats.filter(f => f.chunks > 20).length;

// Weight penalties: critical files (MEMORY.md, OPERATING.md, rules.md, index.md) penalized more
const criticalPaths = ['MEMORY.md', 'memory/OPERATING.md', 'memory/rules.md', 'memory/index.md', 'IDENTITY.md', 'SOUL.md'];
const criticalIssues = allIssues.filter(i => criticalPaths.includes(i.file));
const nonCriticalIssues = allIssues.filter(i => !criticalPaths.includes(i.file));
const maxScore = 100;
const penalty = criticalIssues.length * 10 + nonCriticalIssues.length * 2 + thinOverlap * 3 + noOverlap * 10 + bloatedFiles * 1;
const score = Math.max(0, maxScore - penalty);

if (jsonMode) {
  console.log(JSON.stringify({
    score,
    totalChunks: +totalChunks,
    totalFiles,
    oversizedSections: allIssues,
    thinOverlapFiles: fileStats.filter(f => f.overlapQuality === 'thin').map(f => f.path),
    bloatedFiles: fileStats.filter(f => f.chunks > 20).map(f => ({ path: f.path, chunks: f.chunks })),
    topFiles: fileStats.sort((a, b) => b.chunks - a.chunks).slice(0, 10)
  }, null, 2));
} else {
  console.log('═══════════════════════════════════════════════════');
  console.log(`  📊 CHUNK HEALTH: ${score}/100`);
  console.log(`  ${+totalChunks} chunks across ${totalFiles} files`);
  console.log('═══════════════════════════════════════════════════\n');
  
  if (allIssues.length > 0) {
    console.log(`⚠️  OVERSIZED SECTIONS (${allIssues.length}):`);
    for (const issue of allIssues) {
      console.log(`  ${issue.file}:${issue.lineNo} — ${issue.header}`);
      console.log(`    ${issue.chars} chars. ${showFix ? issue.recommendation : ''}`);
    }
    console.log('');
  } else {
    console.log('✅ All sections within chunk-safe bounds (<1400 chars)\n');
  }
  
  if (thinOverlap > 0 || noOverlap > 0) {
    console.log(`⚠️  OVERLAP ISSUES:`);
    for (const f of fileStats.filter(f => f.overlapQuality !== 'good')) {
      console.log(`  ${f.path}: ${f.overlapQuality} overlap (${f.chunks} chunks)`);
    }
    console.log('');
  } else {
    console.log('✅ Overlap quality good across all files\n');
  }
  
  if (bloatedFiles > 0) {
    console.log(`📦 LARGE FILES (${bloatedFiles}):`);
    for (const f of fileStats.filter(f => f.chunks > 20)) {
      console.log(`  ${f.path}: ${f.chunks} chunks, ${f.totalLines} lines`);
    }
    console.log('');
  }
  
  // Top 10 files by chunk count
  console.log('📋 TOP FILES BY CHUNK COUNT:');
  for (const f of fileStats.sort((a, b) => b.chunks - a.chunks).slice(0, 10)) {
    const overlap = f.overlapQuality === 'good' ? '✅' : f.overlapQuality === 'thin' ? '⚠️' : '❌';
    console.log(`  ${overlap} ${f.path}: ${f.chunks} chunks (${f.avgChunkSize} avg chars)`);
  }
}
