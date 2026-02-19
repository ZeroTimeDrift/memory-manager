#!/usr/bin/env npx ts-node

/**
 * Register Orphan Files
 * 
 * Scans memory/ and top-level files for anything not in manifest.json,
 * then auto-registers them with sensible defaults based on path patterns.
 * Also prunes dangling manifest entries that point to non-existent files.
 * 
 * Usage:
 *   npx ts-node src/register-orphans.ts             # Execute registration
 *   npx ts-node src/register-orphans.ts --dry-run    # Preview only
 *   npx ts-node src/register-orphans.ts --prune-only # Only remove dangling entries
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';
const MANIFEST_PATH = '/root/clawd/skills/memory-manager/manifest.json';
const MEMORY_DIR = path.join(WORKSPACE, 'memory');

const TOP_LEVEL_FILES = [
  'MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'OPERATING.md',
  'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md',
];

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

// ─── Path-based classification ──────────────────────────────────────────────

function classifyFile(relPath: string): { type: string; weight: number; decayRate: number } {
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

  // Daily files — recent ones get higher weight
  if (relPath.startsWith('memory/daily/')) {
    const dateMatch = relPath.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const fileDate = new Date(dateMatch[1]);
      const now = new Date();
      const daysAgo = Math.floor((now.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysAgo <= 2) return { type: 'recent', weight: 0.6, decayRate: 0.15 };
      if (daysAgo <= 7) return { type: 'recent', weight: 0.3, decayRate: 0.1 };
      return { type: 'recent', weight: 0.15, decayRate: 0.2 };
    }
    return { type: 'recent', weight: 0.2, decayRate: 0.15 };
  }

  // Session logs — lower priority, fast decay
  if (relPath.startsWith('memory/sessions/')) {
    return { type: 'session', weight: 0.15, decayRate: 0.15 };
  }

  // Topic files — moderate weight, slow decay
  if (relPath.startsWith('memory/topics/')) {
    return { type: 'topic', weight: 0.4, decayRate: 0.05 };
  }

  // People files — moderate weight, very slow decay
  if (relPath.startsWith('memory/people/')) {
    return { type: 'people', weight: 0.5, decayRate: 0.03 };
  }

  // Moltbook intel — moderate weight
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

  // Task graveyard, rules, etc.
  if (relPath.startsWith('memory/')) {
    return { type: 'topic', weight: 0.25, decayRate: 0.05 };
  }

  // Config files
  if (relPath.startsWith('config/')) {
    return { type: 'config', weight: 0.3, decayRate: 0.05 };
  }

  // Fallback
  return { type: 'topic', weight: 0.2, decayRate: 0.05 };
}

function generateSummary(relPath: string): string {
  // Try to extract a meaningful summary from the first few lines
  const fullPath = path.join(WORKSPACE, relPath);
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    
    // Look for a title (# heading)
    const titleLine = lines.find(l => l.startsWith('# '));
    if (titleLine) {
      return titleLine.replace(/^#+\s*/, '').slice(0, 80);
    }
    
    // Look for YAML frontmatter title
    const titleMatch = content.match(/^---[\s\S]*?title:\s*"?([^"\n]+)"?[\s\S]*?---/);
    if (titleMatch) {
      return titleMatch[1].slice(0, 80);
    }

    // First non-empty line
    if (lines[0]) {
      return lines[0].replace(/^[#\-*>\s]+/, '').slice(0, 80);
    }
  } catch {}
  
  return `File ${relPath} - auto-registered`;
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

// ─── Discovery ──────────────────────────────────────────────────────────────

function findAllMemoryFiles(): string[] {
  const files: string[] = [];

  for (const f of TOP_LEVEL_FILES) {
    if (fs.existsSync(path.join(WORKSPACE, f))) files.push(f);
  }

  // Skills SKILL.md
  const skillPath = 'skills/memory-manager/SKILL.md';
  if (fs.existsSync(path.join(WORKSPACE, skillPath))) files.push(skillPath);

  function walk(dir: string, prefix: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel);
      } else if (e.name.endsWith('.md')) {
        files.push(`memory/${rel}`);
      }
    }
  }
  walk(MEMORY_DIR, '');

  return files;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pruneOnly = args.includes('--prune-only');

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('❌ Manifest not found');
    process.exit(1);
  }

  const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const trackedSet = new Set(Object.keys(manifest.files));
  const diskFiles = findAllMemoryFiles();
  const diskSet = new Set(diskFiles);

  let registered = 0;
  let pruned = 0;

  // --- Prune dangling entries ---
  const dangling: string[] = [];
  for (const tracked of trackedSet) {
    if (!diskSet.has(tracked) && !fs.existsSync(path.join(WORKSPACE, tracked))) {
      dangling.push(tracked);
    }
  }

  if (dangling.length > 0) {
    console.log(`\n🗑️  PRUNING ${dangling.length} dangling manifest entries:`);
    for (const d of dangling) {
      console.log(`   ✕ ${d}`);
      if (!dryRun) {
        delete manifest.files[d];
      }
      pruned++;
    }
  }

  if (pruneOnly) {
    if (!dryRun && pruned > 0) {
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
      console.log(`\n✅ Pruned ${pruned} entries. Manifest saved.`);
    } else if (pruned === 0) {
      console.log('\n✅ No dangling entries found.');
    } else {
      console.log(`\n🔍 DRY RUN: Would prune ${pruned} entries.`);
    }
    return;
  }

  // --- Register orphans ---
  const orphans = diskFiles.filter(f => !trackedSet.has(f));

  if (orphans.length === 0 && dangling.length === 0) {
    console.log('\n✅ All files tracked, no orphans or dangling entries.');
    return;
  }

  if (orphans.length > 0) {
    console.log(`\n📥 REGISTERING ${orphans.length} orphan files:\n`);
    
    for (const orphan of orphans) {
      const classification = classifyFile(orphan);
      const summary = generateSummary(orphan);
      const lastAccess = getLastModified(orphan);

      const entry: ManifestFile = {
        weight: classification.weight,
        type: classification.type,
        lastAccess,
        accessCount: 1,
        decayRate: classification.decayRate,
        summary,
      };

      console.log(`   + ${orphan}`);
      console.log(`     type=${classification.type}  w=${classification.weight}  decay=${classification.decayRate}  "${summary.slice(0, 50)}"`);

      if (!dryRun) {
        manifest.files[orphan] = entry;
      }
      registered++;
    }
  }

  if (!dryRun) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`\n✅ Done. Registered: ${registered}, Pruned: ${pruned}. Manifest saved.`);
  } else {
    console.log(`\n🔍 DRY RUN complete. Would register: ${registered}, prune: ${pruned}.`);
  }
}

main();
