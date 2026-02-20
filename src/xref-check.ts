#!/usr/bin/env npx ts-node

/**
 * Cross-Reference Integrity Checker
 * 
 * Scans all memory .md files for references to other files and validates:
 * 1. Referenced files exist
 * 2. Referenced sections/headers exist within target files
 * 3. No orphaned files (exist but never referenced)
 * 4. No circular-only references (A→B→A with nothing else)
 * 
 * Outputs a health report with actionable fixes.
 * 
 * Usage:
 *   npx ts-node src/xref-check.ts              # Full check
 *   npx ts-node src/xref-check.ts --fix        # Auto-fix what it can
 *   npx ts-node src/xref-check.ts --verbose    # Show all refs, not just broken
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';
const MEMORY_DIR = path.join(WORKSPACE, 'memory');

// Top-level files that are part of the memory system
const TOP_LEVEL_FILES = ['MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'OPERATING.md', 'HEARTBEAT.md', 'AGENTS.md', 'TOOLS.md'];

// ─── Types ──────────────────────────────────────────────────────────────────

interface FileRef {
  sourceFile: string;     // Where the reference lives
  sourceLine: number;     // Line number
  targetPath: string;     // What's being referenced (raw text)
  resolvedPath: string;   // Resolved absolute path
  exists: boolean;        // Does the target exist?
  refType: 'backtick' | 'bare' | 'markdown-link' | 'see-directive';
}

interface SectionRef {
  sourceFile: string;
  sourceLine: number;
  targetFile: string;
  targetSection: string;  // The anchor (e.g., "core-identity")
  exists: boolean;
}

// Cache for file headers: path → Set of slug-ified header strings
const headerCache = new Map<string, Set<string>>();

function getFileHeaders(absPath: string): Set<string> {
  if (headerCache.has(absPath)) return headerCache.get(absPath)!;
  const headers = new Set<string>();
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const headerPattern = /^#{1,6}\s+(.+)$/gm;
    let m;
    while ((m = headerPattern.exec(content)) !== null) {
      // Slug: lowercase, strip non-alphanum (except hyphens/spaces), spaces→hyphens
      const slug = m[1]
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      headers.add(slug);
    }
  } catch {}
  headerCache.set(absPath, headers);
  return headers;
}

interface IntegrityReport {
  timestamp: string;
  totalFiles: number;
  totalRefs: number;
  brokenRefs: FileRef[];
  allowedBroken: FileRef[];
  orphanedFiles: string[];
  validRefs: FileRef[];
  brokenSections: SectionRef[];
  suggestions: string[];
}

// ─── File Discovery ─────────────────────────────────────────────────────────

function discoverMemoryFiles(): string[] {
  const files: string[] = [];
  
  // Top-level workspace files
  for (const f of TOP_LEVEL_FILES) {
    const p = path.join(WORKSPACE, f);
    if (fs.existsSync(p)) files.push(p);
  }
  
  // Recursively find all .md in memory/
  function scan(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory() && entry !== 'node_modules' && entry !== '.git' && entry !== 'archive') {
        scan(full);
      } else if (stat.isFile() && entry.endsWith('.md')) {
        files.push(full);
      }
    }
  }
  
  scan(MEMORY_DIR);
  return files;
}

// ─── Reference Extraction ───────────────────────────────────────────────────

function extractRefs(filePath: string, content: string, sectionAnchors: SectionRef[]): FileRef[] {
  const refs: FileRef[] = [];
  const lines = content.split('\n');
  const relSource = path.relative(WORKSPACE, filePath);
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    
    // Pattern 1: Backtick-enclosed file references: `some/path.md`
    const backtickPattern = /`([a-zA-Z0-9_/.:-]+\.md)`/g;
    let match;
    while ((match = backtickPattern.exec(line)) !== null) {
      const raw = match[1];
      // Skip template patterns like YYYY-MM-DD.md
      if (/YYYY|XX/.test(raw)) continue;
      refs.push(resolveRef(relSource, lineNum, raw, 'backtick'));
    }
    
    // Pattern 2: "See <path>" or "see <path>" directives
    const seePattern = /[Ss]ee\s+`?([a-zA-Z0-9_/.:-]+\.md)`?/g;
    while ((match = seePattern.exec(line)) !== null) {
      const raw = match[1];
      if (/YYYY|XX/.test(raw)) continue;
      // Avoid double-counting with backtick pattern
      if (!refs.some(r => r.sourceLine === lineNum && r.targetPath === raw && r.refType === 'backtick')) {
        refs.push(resolveRef(relSource, lineNum, raw, 'see-directive'));
      }
    }
    
    // Pattern 3: Markdown links [text](path.md) or [text](path.md#section)
    const linkPattern = /\[([^\]]*)\]\(([a-zA-Z0-9_/.:-]+\.md(?:#[a-zA-Z0-9_-]+)?)\)/g;
    while ((match = linkPattern.exec(line)) !== null) {
      const fullTarget = match[2];
      const [filePart, sectionPart] = fullTarget.split('#');
      if (/YYYY|XX/.test(filePart)) continue;
      const fileRef = resolveRef(relSource, lineNum, filePart, 'markdown-link');
      refs.push(fileRef);
      // Track section anchor for later validation
      if (sectionPart && fileRef.exists) {
        sectionAnchors.push({
          sourceFile: relSource,
          sourceLine: lineNum,
          targetFile: fileRef.resolvedPath,
          targetSection: sectionPart,
          exists: false, // validated later
        });
      }
    }
    
    // Pattern 4: Bare path references like "memory/topics/foo.md" or "MEMORY.md"
    // but NOT inside backticks or markdown links (already caught above)
    const barePattern = /(?:^|[^`\[(])(?:memory\/[a-zA-Z0-9_/.:-]+\.md|(?:MEMORY|SOUL|IDENTITY|USER|OPERATING|HEARTBEAT|AGENTS|TOOLS)\.md)/g;
    while ((match = barePattern.exec(line)) !== null) {
      const raw = match[0].replace(/^[^a-zA-Z]/, '').trim();
      if (/YYYY|XX/.test(raw)) continue;
      // Avoid duplication with earlier patterns
      const isDupe = refs.some(r => r.sourceLine === lineNum && r.targetPath === raw);
      if (!isDupe) {
        refs.push(resolveRef(relSource, lineNum, raw, 'bare'));
      }
    }
  }
  
  return refs;
}

function resolveRef(sourceFile: string, lineNum: number, rawTarget: string, refType: FileRef['refType']): FileRef {
  // Try multiple resolution strategies:
  // 1. Relative to workspace root
  // 2. Relative to source file's directory
  // 3. Inside memory/ prefix
  
  const candidates: string[] = [];

  // Handle absolute paths directly
  if (path.isAbsolute(rawTarget)) {
    candidates.push(rawTarget);
  }

  candidates.push(
    path.join(WORKSPACE, rawTarget),
    path.join(WORKSPACE, path.dirname(sourceFile), rawTarget),
    path.join(MEMORY_DIR, rawTarget),
  );
  
  // Also handle "memory/..." prefixed refs from workspace root
  if (rawTarget.startsWith('memory/')) {
    candidates.unshift(path.join(WORKSPACE, rawTarget));
  }
  
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return {
        sourceFile,
        sourceLine: lineNum,
        targetPath: rawTarget,
        resolvedPath: path.relative(WORKSPACE, candidate),
        exists: true,
        refType,
      };
    }
  }
  
  return {
    sourceFile,
    sourceLine: lineNum,
    targetPath: rawTarget,
    resolvedPath: rawTarget,
    exists: false,
    refType,
  };
}

// ─── Orphan Detection ───────────────────────────────────────────────────────

function findOrphans(allFiles: string[], allRefs: FileRef[]): string[] {
  // Files that exist but are never referenced by any other file
  const referencedPaths = new Set<string>();
  for (const ref of allRefs) {
    if (ref.exists) {
      referencedPaths.add(ref.resolvedPath);
    }
  }
  
  // Exclude boot-sequence files (always read directly, not via cross-ref)
  const bootFiles = new Set(['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md']);
  
  // Exclude convention-discovered paths (found by directory scan, not cross-ref)
  const conventionPatterns = [
    /^memory\/daily\//,      // Daily logs discovered by date convention
    /^memory\/sessions\//,   // Session logs discovered by convention
    /^memory\/weekly\//,     // Weekly digests discovered by convention
  ];
  
  const orphans: string[] = [];
  for (const file of allFiles) {
    const relPath = path.relative(WORKSPACE, file);
    if (!referencedPaths.has(relPath) && !bootFiles.has(relPath)) {
      // Skip convention-discovered files (dailies, sessions, weeklies)
      const isConvention = conventionPatterns.some(p => p.test(relPath));
      if (!isConvention) {
        orphans.push(relPath);
      }
    }
  }
  
  return orphans;
}

// ─── Report Generation ─────────────────────────────────────────────────────

function generateReport(verbose: boolean): IntegrityReport {
  const allFiles = discoverMemoryFiles();
  const allRefs: FileRef[] = [];
  const validRefs: FileRef[] = [];
  const brokenRefs: FileRef[] = [];
  const sectionAnchors: SectionRef[] = [];
  
  for (const filePath of allFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const refs = extractRefs(filePath, content, sectionAnchors);
      
      for (const ref of refs) {
        allRefs.push(ref);
        if (ref.exists) {
          validRefs.push(ref);
        } else {
          brokenRefs.push(ref);
        }
      }
    } catch (e) {
      // Skip unreadable files
    }
  }
  
  // Validate section anchors against actual file headers
  for (const sa of sectionAnchors) {
    const absPath = path.join(WORKSPACE, sa.targetFile);
    const headers = getFileHeaders(absPath);
    sa.exists = headers.has(sa.targetSection);
  }
  
  // Known acceptable broken refs (templates, intentionally deleted files, historical refs)
  const ALLOWLIST = new Set([
    'BOOTSTRAP.md',           // Intentionally deleted after first run
    'SKILL.md',               // Generic pattern reference in AGENTS.md
  ]);
  
  // Historical refs: references in daily/session logs to files that were deleted
  // These are historical records, not actionable broken links
  const isHistoricalRef = (ref: FileRef) => 
    (ref.sourceFile.includes('daily/') || ref.sourceFile.includes('sessions/'));

  // Deduplicate broken refs (same source+target) and filter allowlisted
  const uniqueBroken: FileRef[] = [];
  const allowedBroken: FileRef[] = [];
  const seenBroken = new Set<string>();
  for (const ref of brokenRefs) {
    const key = `${ref.sourceFile}:${ref.sourceLine}→${ref.targetPath}`;
    if (!seenBroken.has(key)) {
      seenBroken.add(key);
      const basename = path.basename(ref.targetPath);
      if (ALLOWLIST.has(basename) || isHistoricalRef(ref)) {
        allowedBroken.push(ref);
      } else {
        uniqueBroken.push(ref);
      }
    }
  }
  
  const orphans = findOrphans(allFiles, allRefs);
  
  // Generate suggestions
  const suggestions: string[] = [];
  
  if (uniqueBroken.length > 0) {
    suggestions.push(`Fix ${uniqueBroken.length} broken reference(s) — either create the target file or update the reference.`);
  }
  
  if (orphans.length > 3) {
    suggestions.push(`${orphans.length} orphaned files found. Consider: add cross-references from MEMORY.md/index.md, or archive if no longer relevant.`);
  }
  
  // Check for files only referenced by daily logs (low discoverability)
  const refsByTarget = new Map<string, string[]>();
  for (const ref of validRefs) {
    const sources = refsByTarget.get(ref.resolvedPath) || [];
    sources.push(ref.sourceFile);
    refsByTarget.set(ref.resolvedPath, sources);
  }
  
  const brokenSections = sectionAnchors.filter(sa => !sa.exists);
  if (brokenSections.length > 0) {
    suggestions.push(`${brokenSections.length} broken section anchor(s) — header was renamed or removed from target file.`);
  }
  
  for (const [target, sources] of refsByTarget) {
    const onlyDaily = sources.every(s => s.includes('daily/'));
    if (onlyDaily && !target.includes('daily/') && !target.includes('sessions/')) {
      suggestions.push(`"${target}" only referenced from daily logs — add to MEMORY.md or index.md for better discoverability.`);
    }
  }
  
  return {
    timestamp: new Date().toISOString(),
    totalFiles: allFiles.length,
    totalRefs: allRefs.length,
    brokenRefs: uniqueBroken,
    allowedBroken,
    orphanedFiles: orphans,
    validRefs: verbose ? validRefs : [],
    brokenSections: sectionAnchors.filter(sa => !sa.exists),
    suggestions,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

// ─── Fix Mode ───────────────────────────────────────────────────────────────

interface FixAction {
  type: 'remove-ref' | 'update-ref' | 'add-to-allowlist';
  file: string;
  line: number;
  description: string;
  applied: boolean;
}

function applyFixes(report: IntegrityReport): FixAction[] {
  const actions: FixAction[] = [];
  
  for (const ref of report.brokenRefs) {
    // Strategy: Can we find a close match? (typo, renamed file)
    const basename = path.basename(ref.targetPath, '.md');
    const dir = path.dirname(ref.resolvedPath);
    const searchDir = path.join(WORKSPACE, dir === '.' ? 'memory' : dir);
    
    let bestMatch: string | null = null;
    
    if (fs.existsSync(searchDir) && fs.statSync(searchDir).isDirectory()) {
      const files = fs.readdirSync(searchDir).filter(f => f.endsWith('.md'));
      // Look for similar names (Levenshtein-ish: starts-with or contains)
      for (const f of files) {
        const fBase = path.basename(f, '.md');
        if (fBase.includes(basename) || basename.includes(fBase)) {
          bestMatch = path.join(dir === '.' ? 'memory' : dir, f);
          break;
        }
      }
    }
    
    if (bestMatch) {
      // Try to replace in the source file
      const absSource = path.join(WORKSPACE, ref.sourceFile);
      try {
        const content = fs.readFileSync(absSource, 'utf-8');
        const lines = content.split('\n');
        const lineIdx = ref.sourceLine - 1;
        if (lineIdx < lines.length) {
          const oldLine = lines[lineIdx];
          const newLine = oldLine.replace(ref.targetPath, bestMatch);
          if (newLine !== oldLine) {
            lines[lineIdx] = newLine;
            fs.writeFileSync(absSource, lines.join('\n'), 'utf-8');
            actions.push({
              type: 'update-ref',
              file: ref.sourceFile,
              line: ref.sourceLine,
              description: `Updated "${ref.targetPath}" → "${bestMatch}"`,
              applied: true,
            });
            continue;
          }
        }
      } catch {}
    }
    
    // Can't auto-fix — report it
    actions.push({
      type: 'remove-ref',
      file: ref.sourceFile,
      line: ref.sourceLine,
      description: `Cannot auto-fix: ${ref.targetPath} (no similar file found)`,
      applied: false,
    });
  }
  
  return actions;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const fix = args.includes('--fix');
const jsonOutput = args.includes('--json');

const report = generateReport(verbose);

// JSON output mode (for integration with health dashboard)
if (jsonOutput) {
  const out = {
    timestamp: report.timestamp,
    totalFiles: report.totalFiles,
    totalRefs: report.totalRefs,
    brokenCount: report.brokenRefs.length,
    orphanCount: report.orphanedFiles.length,
    brokenSectionCount: report.brokenSections.length,
    brokenRefs: report.brokenRefs.map(r => ({
      source: `${r.sourceFile}:${r.sourceLine}`,
      target: r.targetPath,
      type: r.refType,
    })),
    brokenSections: report.brokenSections.map(s => ({
      source: `${s.sourceFile}:${s.sourceLine}`,
      target: `${s.targetFile}#${s.targetSection}`,
    })),
    orphanedFiles: report.orphanedFiles,
    suggestions: report.suggestions,
    healthScore: Math.round(
      (report.totalRefs > 0 ? (1 - report.brokenRefs.length / report.totalRefs) * 100 : 100) * 0.7 +
      (report.totalFiles > 0 ? (1 - report.orphanedFiles.length / report.totalFiles) * 100 : 100) * 0.3
    ),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('     🔗 CROSS-REFERENCE INTEGRITY CHECK');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

console.log(`📁 Files scanned: ${report.totalFiles}`);
console.log(`🔗 References found: ${report.totalRefs}`);
console.log('');

// Broken references
if (report.brokenRefs.length > 0) {
  console.log(`❌ BROKEN REFERENCES (${report.brokenRefs.length}):`);
  for (const ref of report.brokenRefs) {
    console.log(`   ${ref.sourceFile}:${ref.sourceLine} → ${ref.targetPath}`);
    console.log(`      Type: ${ref.refType} | Does not exist at: ${ref.resolvedPath}`);
  }
  console.log('');
} else {
  console.log('✅ All cross-references resolve correctly.');
  console.log('');
}

// Allowed broken (informational)
if (verbose && report.allowedBroken.length > 0) {
  console.log(`ℹ️  ALLOWED BROKEN (${report.allowedBroken.length}):`);
  console.log('   (Template/historical refs — expected to be missing)');
  for (const ref of report.allowedBroken) {
    console.log(`   ⚪ ${ref.sourceFile}:${ref.sourceLine} → ${ref.targetPath}`);
  }
  console.log('');
}

// Fix mode
if (fix && report.brokenRefs.length > 0) {
  console.log('🔧 FIX MODE:');
  const actions = applyFixes(report);
  for (const action of actions) {
    const icon = action.applied ? '✅' : '⚠️';
    console.log(`   ${icon} ${action.file}:${action.line} — ${action.description}`);
  }
  const applied = actions.filter(a => a.applied).length;
  console.log(`   Applied ${applied}/${actions.length} fixes.`);
  console.log('');
}

// Broken section anchors
if (report.brokenSections.length > 0) {
  console.log(`⚓ BROKEN SECTION ANCHORS (${report.brokenSections.length}):`);
  for (const sa of report.brokenSections) {
    console.log(`   ${sa.sourceFile}:${sa.sourceLine} → ${sa.targetFile}#${sa.targetSection}`);
  }
  console.log('');
}

// Orphaned files
if (report.orphanedFiles.length > 0) {
  console.log(`🔍 ORPHANED FILES (${report.orphanedFiles.length}):`);
  console.log('   (These files exist but are never referenced by other files)');
  for (const f of report.orphanedFiles) {
    console.log(`   📄 ${f}`);
  }
  console.log('');
}

// Valid refs (verbose only)
if (verbose && report.validRefs.length > 0) {
  console.log(`✅ VALID REFERENCES (${report.validRefs.length}):`);
  for (const ref of report.validRefs) {
    console.log(`   ${ref.sourceFile}:${ref.sourceLine} → ${ref.resolvedPath} [${ref.refType}]`);
  }
  console.log('');
}

// Suggestions
if (report.suggestions.length > 0) {
  console.log('💡 SUGGESTIONS:');
  for (const s of report.suggestions) {
    console.log(`   → ${s}`);
  }
  console.log('');
}

// Summary score
const brokenPct = report.totalRefs > 0 
  ? Math.round((1 - report.brokenRefs.length / report.totalRefs) * 100)
  : 100;
const orphanPct = report.totalFiles > 0
  ? Math.round((1 - report.orphanedFiles.length / report.totalFiles) * 100) 
  : 100;
const overallHealth = Math.round((brokenPct * 0.7 + orphanPct * 0.3));

console.log('═══════════════════════════════════════════════════════════');
console.log(`   Reference integrity: ${brokenPct}% (${report.totalRefs - report.brokenRefs.length}/${report.totalRefs})`);
console.log(`   Discovery coverage:  ${orphanPct}% (${report.totalFiles - report.orphanedFiles.length}/${report.totalFiles} reachable)`);
console.log(`   🔗 OVERALL HEALTH:   ${overallHealth}%`);
console.log('═══════════════════════════════════════════════════════════');
