#!/usr/bin/env npx ts-node

/**
 * Auto-Discovery — Detect and register untracked memory files
 * 
 * Scans workspace for .md files that should be in manifest but aren't.
 * Extracts meaningful summaries, classifies by path, and registers them.
 * Also prunes dangling entries pointing to deleted files.
 * 
 * Designed to be imported by boot.ts and session-wrap.ts, or run standalone.
 * 
 * Usage:
 *   npx ts-node src/auto-discover.ts              # Run discovery + registration
 *   npx ts-node src/auto-discover.ts --dry-run     # Preview only
 *   npx ts-node src/auto-discover.ts --report       # Report-only (for boot context)
 *   npx ts-node src/auto-discover.ts --fix-summaries # Re-extract summaries for "auto-discovered" entries
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';
const MANIFEST_PATH = path.join(WORKSPACE, 'skills/memory-manager/manifest.json');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');

// ─── Types ──────────────────────────────────────────────────────────────────

interface ManifestFile {
  weight: number;
  type: string;
  lastAccess: string;
  accessCount: number;
  decayRate: number;
  summary: string;
}

interface Manifest {
  version: number;
  files: Record<string, ManifestFile>;
  [key: string]: any;
}

interface DiscoveryResult {
  orphans: Array<{ path: string; entry: ManifestFile }>;
  dangling: string[];
  staleSummaries: Array<{ path: string; oldSummary: string; newSummary: string }>;
}

// ─── Top-level files to track ───────────────────────────────────────────────

const TOP_LEVEL_FILES = [
  'MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'OPERATING.md',
  'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md',
];

const SKILL_FILES = [
  'skills/memory-manager/SKILL.md',
];

// ─── Path-based classification ──────────────────────────────────────────────

export function classifyFile(relPath: string): { type: string; weight: number; decayRate: number } {
  // Core top-level files
  if (['SOUL.md', 'IDENTITY.md', 'USER.md'].includes(relPath)) {
    return { type: 'core', weight: 0.9, decayRate: 0 };
  }
  if (['MEMORY.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md', 'OPERATING.md'].includes(relPath)) {
    return { type: 'core', weight: 0.7, decayRate: 0 };
  }
  if (relPath.startsWith('skills/') && relPath.endsWith('SKILL.md')) {
    return { type: 'core', weight: 0.8, decayRate: 0 };
  }

  // Daily files — weight by recency
  if (relPath.startsWith('memory/daily/')) {
    const dateMatch = relPath.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const fileDate = new Date(dateMatch[1]);
      const now = new Date();
      const daysAgo = Math.floor((now.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysAgo <= 1) return { type: 'recent', weight: 0.6, decayRate: 0.15 };
      if (daysAgo <= 3) return { type: 'recent', weight: 0.4, decayRate: 0.15 };
      if (daysAgo <= 7) return { type: 'recent', weight: 0.3, decayRate: 0.1 };
      return { type: 'recent', weight: 0.15, decayRate: 0.2 };
    }
    return { type: 'recent', weight: 0.2, decayRate: 0.15 };
  }

  // Topic files
  if (relPath.startsWith('memory/topics/')) {
    return { type: 'topic', weight: 0.4, decayRate: 0.05 };
  }

  // People files
  if (relPath.startsWith('memory/people/')) {
    return { type: 'people', weight: 0.5, decayRate: 0.03 };
  }

  // Moltbook intel
  if (relPath.startsWith('memory/moltbook/')) {
    return { type: 'topic', weight: 0.35, decayRate: 0.05 };
  }

  // Weekly digests
  if (relPath.startsWith('memory/weekly/')) {
    return { type: 'digest', weight: 0.25, decayRate: 0.08 };
  }

  // Drafts
  if (relPath.startsWith('memory/drafts/')) {
    return { type: 'draft', weight: 0.2, decayRate: 0.1 };
  }

  // Memory root files (rules, task-graveyard, OPERATING, index, etc.)
  if (relPath.startsWith('memory/')) {
    return { type: 'topic', weight: 0.25, decayRate: 0.05 };
  }

  // Config files
  if (relPath.startsWith('config/')) {
    return { type: 'config', weight: 0.3, decayRate: 0.05 };
  }

  return { type: 'topic', weight: 0.2, decayRate: 0.05 };
}

// ─── Smart summary extraction ───────────────────────────────────────────────

export function extractSummary(relPath: string): string {
  const fullPath = path.join(WORKSPACE, relPath);
  
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');
    const nonEmpty = lines.filter(l => l.trim());
    
    if (nonEmpty.length === 0) return `Empty file: ${path.basename(relPath)}`;

    // 1. YAML frontmatter — look for title, summary, or description
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const titleMatch = fm.match(/title:\s*"?([^"\n]+)"?/);
      if (titleMatch) return titleMatch[1].trim().slice(0, 100);
      const summaryMatch = fm.match(/summary:\s*"?([^"\n]+)"?/);
      if (summaryMatch) return summaryMatch[1].trim().slice(0, 100);
      const descMatch = fm.match(/description:\s*"?([^"\n]+)"?/);
      if (descMatch) return descMatch[1].trim().slice(0, 100);
    }

    // 2. H1 heading with context from next substantive line
    const h1Idx = lines.findIndex(l => /^# /.test(l));
    if (h1Idx >= 0) {
      const h1Text = lines[h1Idx].replace(/^#\s*/, '').trim();
      // Look for a subtitle or first content line after the heading
      for (let i = h1Idx + 1; i < Math.min(h1Idx + 5, lines.length); i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#') || line.startsWith('---') || line.startsWith('*This file')) continue;
        if (line.length > 10) {
          return `${h1Text} — ${line.replace(/^[>*\-]\s*/, '')}`.slice(0, 100);
        }
      }
      return h1Text.slice(0, 100);
    }

    // 3. For daily files, extract key events
    if (relPath.startsWith('memory/daily/')) {
      const dateMatch = relPath.match(/(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : 'unknown';
      
      // Find H2 headings which represent session entries
      const h2s = lines.filter(l => /^## /.test(l)).map(l => l.replace(/^##\s*/, '').trim());
      if (h2s.length > 0) {
        const sessionCount = h2s.length;
        // Try to extract session types
        const types = h2s.slice(0, 3).join(', ');
        return `${date}: ${sessionCount} session(s) — ${types}`.slice(0, 100);
      }
      return `Daily log: ${date}`;
    }

    // 4. For weekly digests, extract period info
    if (relPath.startsWith('memory/weekly/')) {
      const weekMatch = relPath.match(/(20\d{2}-W\d{2})/);
      const h2s = lines.filter(l => /^## /.test(l)).map(l => l.replace(/^##\s*/, '').trim());
      if (weekMatch && h2s.length > 0) {
        return `Week ${weekMatch[1]}: ${h2s.slice(0, 2).join(', ')}`.slice(0, 100);
      }
    }

    // 5. First meaningful content line (skip metadata, decorators, comments)
    for (const line of nonEmpty) {
      const trimmed = line.trim();
      if (trimmed.startsWith('---')) continue;   // YAML boundary
      if (trimmed.startsWith('<!')) continue;     // HTML comment
      if (trimmed.startsWith('```')) continue;    // Code fence
      if (/^(tags|date|day|mood|title):/.test(trimmed)) continue; // Frontmatter fields
      
      const cleaned = trimmed.replace(/^[#>*\-\s]+/, '').trim();
      if (cleaned.length > 5) {
        return cleaned.slice(0, 100);
      }
    }
    
    return `File: ${path.basename(relPath, '.md')}`;
  } catch (e) {
    return `File: ${path.basename(relPath, '.md')} (unreadable)`;
  }
}

function getLastModified(relPath: string): string {
  const fullPath = path.join(WORKSPACE, relPath);
  try {
    const stat = fs.statSync(fullPath);
    return stat.mtime.toISOString().split('T')[0];
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

// ─── File discovery ─────────────────────────────────────────────────────────

function findAllTrackableFiles(): string[] {
  const files: string[] = [];

  // Top-level workspace files
  for (const f of TOP_LEVEL_FILES) {
    if (fs.existsSync(path.join(WORKSPACE, f))) files.push(f);
  }

  // Skill files
  for (const f of SKILL_FILES) {
    if (fs.existsSync(path.join(WORKSPACE, f))) files.push(f);
  }

  // Walk memory/ directory recursively
  function walk(dir: string, prefix: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Skip archive directories
        if (e.name === 'archive' || e.name === 'sessions-legacy') continue;
        walk(path.join(dir, e.name), rel);
      } else if (e.name.endsWith('.md')) {
        files.push(`memory/${rel}`);
      }
    }
  }
  walk(MEMORY_DIR, '');

  return files;
}

// ─── Core discovery function (importable) ───────────────────────────────────

export function discover(): DiscoveryResult {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}`);
  }

  const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const trackedSet = new Set(Object.keys(manifest.files));
  const diskFiles = findAllTrackableFiles();
  const diskSet = new Set(diskFiles);

  // Find orphans (on disk but not in manifest)
  const orphans: DiscoveryResult['orphans'] = [];
  for (const filePath of diskFiles) {
    if (!trackedSet.has(filePath)) {
      const classification = classifyFile(filePath);
      const summary = extractSummary(filePath);
      const lastAccess = getLastModified(filePath);

      orphans.push({
        path: filePath,
        entry: {
          weight: classification.weight,
          type: classification.type,
          lastAccess,
          accessCount: 1,
          decayRate: classification.decayRate,
          summary,
        },
      });
    }
  }

  // Find dangling entries (in manifest but not on disk)
  const dangling: string[] = [];
  for (const tracked of trackedSet) {
    if (!diskSet.has(tracked) && !fs.existsSync(path.join(WORKSPACE, tracked))) {
      dangling.push(tracked);
    }
  }

  // Find stale summaries (entries with "auto-discovered" or empty summaries)
  const staleSummaries: DiscoveryResult['staleSummaries'] = [];
  for (const [filePath, entry] of Object.entries(manifest.files)) {
    if (!fs.existsSync(path.join(WORKSPACE, filePath))) continue;
    
    const isStale = 
      entry.summary.includes('auto-discovered') ||
      entry.summary.includes('.qmd') ||
      entry.summary === '' ||
      entry.summary === `File ${filePath}` ||
      entry.summary === path.basename(filePath, '.md');
    
    if (isStale) {
      const newSummary = extractSummary(filePath);
      if (newSummary !== entry.summary) {
        staleSummaries.push({
          path: filePath,
          oldSummary: entry.summary,
          newSummary,
        });
      }
    }
  }

  return { orphans, dangling, staleSummaries };
}

// ─── Apply discovery results to manifest ────────────────────────────────────

export function applyDiscovery(result: DiscoveryResult): { registered: number; pruned: number; fixed: number } {
  const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  let registered = 0;
  let pruned = 0;
  let fixed = 0;

  // Register orphans
  for (const orphan of result.orphans) {
    manifest.files[orphan.path] = orphan.entry;
    registered++;
  }

  // Prune dangling
  for (const d of result.dangling) {
    delete manifest.files[d];
    pruned++;
  }

  // Fix stale summaries
  for (const stale of result.staleSummaries) {
    if (manifest.files[stale.path]) {
      manifest.files[stale.path].summary = stale.newSummary;
      fixed++;
    }
  }

  if (registered > 0 || pruned > 0 || fixed > 0) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  }

  return { registered, pruned, fixed };
}

// ─── Reporting (for boot context) ───────────────────────────────────────────

export function reportDiscovery(result: DiscoveryResult): string {
  const parts: string[] = [];

  if (result.orphans.length > 0) {
    parts.push(`📥 ${result.orphans.length} untracked file(s): ${result.orphans.map(o => o.path).join(', ')}`);
  }
  if (result.dangling.length > 0) {
    parts.push(`🗑️ ${result.dangling.length} dangling entry(ies): ${result.dangling.join(', ')}`);
  }
  if (result.staleSummaries.length > 0) {
    parts.push(`📝 ${result.staleSummaries.length} stale summary(ies) to fix`);
  }
  if (parts.length === 0) {
    parts.push('✅ All files tracked, no issues.');
  }

  return parts.join('\n');
}

// ─── CLI Main ───────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const reportOnly = args.includes('--report');
  const fixSummaries = args.includes('--fix-summaries');

  console.log('🔍 Auto-Discovery: Scanning workspace...\n');

  const result = discover();

  // Report
  if (result.orphans.length > 0) {
    console.log(`📥 UNTRACKED FILES (${result.orphans.length}):`);
    for (const o of result.orphans) {
      console.log(`   + ${o.path}`);
      console.log(`     type=${o.entry.type}  w=${o.entry.weight}  "${o.entry.summary.slice(0, 60)}"`);
    }
    console.log('');
  }

  if (result.dangling.length > 0) {
    console.log(`🗑️  DANGLING ENTRIES (${result.dangling.length}):`);
    for (const d of result.dangling) {
      console.log(`   ✕ ${d}`);
    }
    console.log('');
  }

  if (result.staleSummaries.length > 0) {
    console.log(`📝 STALE SUMMARIES (${result.staleSummaries.length}):`);
    for (const s of result.staleSummaries) {
      console.log(`   ~ ${s.path}`);
      console.log(`     old: "${s.oldSummary.slice(0, 50)}"`);
      console.log(`     new: "${s.newSummary.slice(0, 50)}"`);
    }
    console.log('');
  }

  if (result.orphans.length === 0 && result.dangling.length === 0 && result.staleSummaries.length === 0) {
    console.log('✅ All files tracked, summaries current, no issues.\n');
    return;
  }

  if (reportOnly) {
    console.log('📋 Report-only mode. No changes made.');
    return;
  }

  if (dryRun) {
    console.log(`🔍 DRY RUN: Would register ${result.orphans.length}, prune ${result.dangling.length}, fix ${result.staleSummaries.length} summaries.`);
    return;
  }

  // Apply unless --fix-summaries was passed without other issues
  const toApply: DiscoveryResult = fixSummaries
    ? result
    : { ...result, staleSummaries: fixSummaries ? result.staleSummaries : result.staleSummaries };

  const stats = applyDiscovery(toApply);
  console.log(`✅ Done. Registered: ${stats.registered}, Pruned: ${stats.pruned}, Summaries fixed: ${stats.fixed}`);
}

// Only run main when executed directly
if (require.main === module) {
  main();
}
