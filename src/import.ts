#!/usr/bin/env npx ts-node

/**
 * Memory Import — Restore from a portable bundle
 * 
 * Reads a JSON export bundle and restores files to the workspace.
 * Supports dry-run mode to preview changes before applying.
 * 
 * Usage:
 *   import.ts <bundle.json>              — Preview what would be restored (dry run)
 *   import.ts <bundle.json> --apply      — Actually restore files
 *   import.ts <bundle.json> --apply --overwrite  — Overwrite existing files
 *   import.ts <bundle.json> --diff       — Show diff for existing files
 * 
 * Notes:
 *   - Only JSON format bundles can be imported (markdown is one-way)
 *   - Without --overwrite, existing files are skipped
 *   - Creates directories as needed
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';

interface ImportOptions {
  bundlePath: string;
  apply: boolean;
  overwrite: boolean;
  diff: boolean;
}

interface BundleFile {
  path: string;
  category: string;
  content: string;
  size: number;
  modified: string;
}

interface Bundle {
  exportedAt: string;
  version: string;
  stats: {
    totalFiles: number;
    totalBytes: number;
    categories: Record<string, number>;
  };
  files: BundleFile[];
}

function parseArgs(): ImportOptions {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0].startsWith('--')) {
    console.error('Usage: import.ts <bundle.json> [--apply] [--overwrite] [--diff]');
    process.exit(1);
  }
  
  return {
    bundlePath: args[0],
    apply: args.includes('--apply'),
    overwrite: args.includes('--overwrite'),
    diff: args.includes('--diff'),
  };
}

function loadBundle(bundlePath: string): Bundle {
  if (!fs.existsSync(bundlePath)) {
    console.error(`Bundle not found: ${bundlePath}`);
    process.exit(1);
  }
  
  const raw = fs.readFileSync(bundlePath, 'utf-8');
  
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse bundle. Only JSON format exports can be imported.');
    console.error('Tip: Re-export with --format=json');
    process.exit(1);
  }
}

function simpleDiff(existing: string, incoming: string): string[] {
  const existLines = existing.split('\n');
  const incomLines = incoming.split('\n');
  const lines: string[] = [];
  
  const maxLen = Math.max(existLines.length, incomLines.length);
  let changes = 0;
  
  for (let i = 0; i < maxLen; i++) {
    const e = existLines[i] ?? '';
    const n = incomLines[i] ?? '';
    if (e !== n) {
      if (e) lines.push(`  - ${e.slice(0, 80)}`);
      if (n) lines.push(`  + ${n.slice(0, 80)}`);
      changes++;
      if (changes > 10) {
        lines.push(`  ... and ${maxLen - i - 1} more lines differ`);
        break;
      }
    }
  }
  
  return lines;
}

function main() {
  const opts = parseArgs();
  const bundle = loadBundle(opts.bundlePath);
  
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  🜂 MEMORY IMPORT');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Bundle:   ${opts.bundlePath}`);
  console.log(`  Exported: ${bundle.exportedAt}`);
  console.log(`  Version:  ${bundle.version}`);
  console.log(`  Files:    ${bundle.stats.totalFiles}`);
  console.log(`  Mode:     ${opts.apply ? (opts.overwrite ? 'APPLY (overwrite)' : 'APPLY (skip existing)') : 'DRY RUN'}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  
  let restored = 0;
  let skipped = 0;
  let created = 0;
  let overwritten = 0;
  
  for (const file of bundle.files) {
    const fullPath = path.join(WORKSPACE, file.path);
    const exists = fs.existsSync(fullPath);
    const sizeKb = (file.size / 1024).toFixed(1);
    
    if (exists && !opts.overwrite) {
      console.log(`  SKIP  ${file.path} (exists, ${sizeKb} KB)`);
      
      if (opts.diff) {
        const existing = fs.readFileSync(fullPath, 'utf-8');
        if (existing !== file.content) {
          const diffLines = simpleDiff(existing, file.content);
          if (diffLines.length > 0) {
            console.log('  Differences:');
            for (const dl of diffLines) console.log(dl);
          }
        } else {
          console.log('  (identical)');
        }
      }
      
      skipped++;
      continue;
    }
    
    const action = exists ? 'OVERWRITE' : 'CREATE';
    const symbol = exists ? '⚠️' : '✅';
    
    if (opts.apply) {
      // Ensure directory exists
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(fullPath, file.content, 'utf-8');
      console.log(`  ${symbol} ${action}  ${file.path} (${sizeKb} KB)`);
      
      if (exists) overwritten++;
      else created++;
      restored++;
    } else {
      console.log(`  [would ${action.toLowerCase()}]  ${file.path} (${sizeKb} KB)`);
      restored++;
    }
  }
  
  console.log('');
  console.log('───────────────────────────────────────────────────');
  if (opts.apply) {
    console.log(`  Created:     ${created}`);
    console.log(`  Overwritten: ${overwritten}`);
    console.log(`  Skipped:     ${skipped}`);
    console.log(`  Total:       ${restored + skipped}`);
  } else {
    console.log(`  Would restore: ${restored}`);
    console.log(`  Would skip:    ${skipped}`);
    console.log('');
    console.log('  Run with --apply to restore files.');
    console.log('  Add --overwrite to replace existing files.');
  }
  console.log('───────────────────────────────────────────────────');
}

main();
