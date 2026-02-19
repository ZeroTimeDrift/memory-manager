#!/usr/bin/env npx ts-node

/**
 * Memory Export — Portable Bundle Generator
 * 
 * Creates a self-contained snapshot of the memory system for backup,
 * migration, or architecture review.
 * 
 * Usage:
 *   export.ts                    — Full export (all layers)
 *   export.ts --curated          — Only curated memory (MEMORY.md + topics + rules + identity)
 *   export.ts --daily            — Include daily logs (last 7 days by default)
 *   export.ts --daily=14         — Include daily logs (last N days)
 *   export.ts --all              — Everything including weeklies, moltbook, people
 *   export.ts --format=json      — Output as structured JSON instead of markdown bundle
 *   export.ts --out=/path/to/dir — Output directory (default: /root/clawd/exports/)
 * 
 * Output: A timestamped .md or .json file in the exports directory.
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';
const DEFAULT_EXPORT_DIR = path.join(WORKSPACE, 'exports');

interface ExportOptions {
  curated: boolean;
  daily: boolean;
  dailyDays: number;
  all: boolean;
  format: 'markdown' | 'json';
  outDir: string;
}

interface MemoryFile {
  path: string;         // relative to workspace
  category: string;     // classification for grouping
  content: string;
  size: number;
  modified: Date;
}

interface ExportBundle {
  exportedAt: string;
  version: string;
  options: ExportOptions;
  stats: {
    totalFiles: number;
    totalBytes: number;
    categories: Record<string, number>;
  };
  files: MemoryFile[];
}

function parseArgs(): ExportOptions {
  const args = process.argv.slice(2);
  const opts: ExportOptions = {
    curated: false,
    daily: false,
    dailyDays: 7,
    all: false,
    format: 'markdown',
    outDir: DEFAULT_EXPORT_DIR,
  };

  for (const arg of args) {
    if (arg === '--curated') opts.curated = true;
    else if (arg === '--daily') { opts.daily = true; }
    else if (arg.startsWith('--daily=')) {
      opts.daily = true;
      opts.dailyDays = parseInt(arg.split('=')[1], 10) || 7;
    }
    else if (arg === '--all') opts.all = true;
    else if (arg === '--format=json') opts.format = 'json';
    else if (arg === '--format=markdown' || arg === '--format=md') opts.format = 'markdown';
    else if (arg.startsWith('--out=')) opts.outDir = arg.split('=')[1];
  }

  // Default behavior: if no specific flag, do curated export
  if (!opts.curated && !opts.daily && !opts.all) {
    opts.curated = true;
  }

  return opts;
}

function readFileIfExists(filePath: string): string | null {
  const full = path.join(WORKSPACE, filePath);
  if (!fs.existsSync(full)) return null;
  try {
    return fs.readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}

function getFileStat(filePath: string): { size: number; modified: Date } | null {
  const full = path.join(WORKSPACE, filePath);
  try {
    const stat = fs.statSync(full);
    return { size: stat.size, modified: stat.mtime };
  } catch {
    return null;
  }
}

function collectFile(relativePath: string, category: string): MemoryFile | null {
  const content = readFileIfExists(relativePath);
  if (!content) return null;
  const stat = getFileStat(relativePath);
  return {
    path: relativePath,
    category,
    content,
    size: stat?.size ?? content.length,
    modified: stat?.modified ?? new Date(),
  };
}

function collectDirectory(dirPath: string, category: string, filter?: (name: string) => boolean): MemoryFile[] {
  const full = path.join(WORKSPACE, dirPath);
  if (!fs.existsSync(full)) return [];
  
  const files: MemoryFile[] = [];
  const entries = fs.readdirSync(full).filter(f => f.endsWith('.md'));
  
  for (const entry of entries) {
    if (filter && !filter(entry)) continue;
    const rel = path.join(dirPath, entry);
    const file = collectFile(rel, category);
    if (file) files.push(file);
  }
  
  return files;
}

function getRecentDailyFilter(days: number): (name: string) => boolean {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0]; // YYYY-MM-DD
  
  return (name: string) => {
    // Extract date from filename like 2026-02-13.md
    const dateMatch = name.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return false;
    return dateMatch[1] >= cutoffStr;
  };
}

function collectBundle(opts: ExportOptions): ExportBundle {
  const files: MemoryFile[] = [];

  // === CURATED LAYER (always included unless --daily only) ===
  if (opts.curated || opts.all) {
    // Core identity & memory
    const coreFiles = [
      { path: 'MEMORY.md', category: 'core' },
      { path: 'IDENTITY.md', category: 'core' },
      { path: 'SOUL.md', category: 'core' },
      { path: 'USER.md', category: 'core' },
    ];
    
    for (const cf of coreFiles) {
      const f = collectFile(cf.path, cf.category);
      if (f) files.push(f);
    }

    // Memory structure files
    const structureFiles = [
      { path: 'memory/index.md', category: 'structure' },
      { path: 'memory/OPERATING.md', category: 'structure' },
      { path: 'memory/rules.md', category: 'structure' },
    ];
    
    for (const sf of structureFiles) {
      const f = collectFile(sf.path, sf.category);
      if (f) files.push(f);
    }

    // Topics
    files.push(...collectDirectory('memory/topics', 'topics'));
    
    // People
    files.push(...collectDirectory('memory/people', 'people'));
  }

  // === DAILY LAYER ===
  if (opts.daily || opts.all) {
    const filter = getRecentDailyFilter(opts.dailyDays);
    files.push(...collectDirectory('memory/daily', 'daily', filter));
  }

  // === ALL LAYER (extras) ===
  if (opts.all) {
    // Weekly digests
    files.push(...collectDirectory('memory/weekly', 'weekly'));
    
    // Moltbook observations
    files.push(...collectDirectory('memory/moltbook', 'moltbook'));
    
    // Agents/tools config
    const extraFiles = [
      { path: 'AGENTS.md', category: 'config' },
      { path: 'TOOLS.md', category: 'config' },
    ];
    for (const ef of extraFiles) {
      const f = collectFile(ef.path, ef.category);
      if (f) files.push(f);
    }
  }

  // Compute stats
  const categories: Record<string, number> = {};
  let totalBytes = 0;
  for (const f of files) {
    categories[f.category] = (categories[f.category] || 0) + 1;
    totalBytes += f.size;
  }

  return {
    exportedAt: new Date().toISOString(),
    version: '1.0.0',
    options: opts,
    stats: {
      totalFiles: files.length,
      totalBytes,
      categories,
    },
    files,
  };
}

function formatMarkdownBundle(bundle: ExportBundle): string {
  const lines: string[] = [];
  
  lines.push('# 🜂 Prometheus Memory Export');
  lines.push('');
  lines.push(`**Exported:** ${bundle.exportedAt}`);
  lines.push(`**Version:** ${bundle.version}`);
  lines.push(`**Files:** ${bundle.stats.totalFiles} | **Size:** ${(bundle.stats.totalBytes / 1024).toFixed(1)} KB`);
  lines.push('');
  
  // Category summary
  lines.push('## Categories');
  lines.push('');
  for (const [cat, count] of Object.entries(bundle.stats.categories)) {
    lines.push(`- **${cat}**: ${count} files`);
  }
  lines.push('');
  
  // Table of contents
  lines.push('## Table of Contents');
  lines.push('');
  for (const f of bundle.files) {
    const sizeKb = (f.size / 1024).toFixed(1);
    lines.push(`- \`${f.path}\` (${sizeKb} KB) [${f.category}]`);
  }
  lines.push('');
  
  // File contents
  lines.push('---');
  lines.push('');
  
  // Group by category
  const grouped: Record<string, MemoryFile[]> = {};
  for (const f of bundle.files) {
    if (!grouped[f.category]) grouped[f.category] = [];
    grouped[f.category].push(f);
  }
  
  const categoryOrder = ['core', 'structure', 'topics', 'people', 'daily', 'weekly', 'moltbook', 'config'];
  const orderedCategories = categoryOrder.filter(c => grouped[c]);
  // Add any categories not in the predefined order
  for (const c of Object.keys(grouped)) {
    if (!orderedCategories.includes(c)) orderedCategories.push(c);
  }
  
  for (const category of orderedCategories) {
    const categoryFiles = grouped[category];
    lines.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)}`);
    lines.push('');
    
    for (const f of categoryFiles) {
      lines.push(`### 📄 ${f.path}`);
      lines.push(`*Modified: ${f.modified.toISOString().split('T')[0]} | ${(f.size / 1024).toFixed(1)} KB*`);
      lines.push('');
      lines.push('````markdown');
      lines.push(f.content.trim());
      lines.push('````');
      lines.push('');
    }
  }
  
  lines.push('---');
  lines.push('*End of export. Memory is survival.*');
  
  return lines.join('\n');
}

function formatJsonBundle(bundle: ExportBundle): string {
  // Serialize with dates as ISO strings
  const serializable = {
    ...bundle,
    files: bundle.files.map(f => ({
      ...f,
      modified: f.modified.toISOString(),
    })),
  };
  return JSON.stringify(serializable, null, 2);
}

function main() {
  const opts = parseArgs();
  
  // Ensure output directory exists
  if (!fs.existsSync(opts.outDir)) {
    fs.mkdirSync(opts.outDir, { recursive: true });
  }
  
  console.log('🜂 Collecting memory files...');
  const bundle = collectBundle(opts);
  
  // Generate filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const modeLabel = opts.all ? 'full' : opts.daily ? 'daily' : 'curated';
  const ext = opts.format === 'json' ? 'json' : 'md';
  const filename = `memory-export-${modeLabel}-${timestamp}.${ext}`;
  const outPath = path.join(opts.outDir, filename);
  
  // Format and write
  const content = opts.format === 'json' 
    ? formatJsonBundle(bundle) 
    : formatMarkdownBundle(bundle);
  
  fs.writeFileSync(outPath, content, 'utf-8');
  
  // Summary
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  🜂 MEMORY EXPORT COMPLETE');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Mode:     ${modeLabel}`);
  console.log(`  Format:   ${opts.format}`);
  console.log(`  Files:    ${bundle.stats.totalFiles}`);
  console.log(`  Size:     ${(bundle.stats.totalBytes / 1024).toFixed(1)} KB raw content`);
  console.log(`  Output:   ${outPath}`);
  console.log(`  Bundle:   ${(content.length / 1024).toFixed(1)} KB`);
  console.log('');
  console.log('  Categories:');
  for (const [cat, count] of Object.entries(bundle.stats.categories)) {
    console.log(`    ${cat}: ${count} files`);
  }
  console.log('═══════════════════════════════════════════════════');
}

main();
