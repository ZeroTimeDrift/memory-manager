#!/usr/bin/env npx ts-node

/**
 * Memory Decay Automation
 * 
 * Applies time-based weight decay to memory files.
 * Files not accessed recently lose weight. Files accessed recently gain a boost.
 * Core files have floors. Files below archival threshold get flagged.
 * 
 * Run standalone:
 *   npx ts-node src/decay.ts
 *   npx ts-node src/decay.ts --dry-run     # Preview without saving
 *   npx ts-node src/decay.ts --verbose      # Show all files, not just changed
 * 
 * Called automatically from session-wrap.ts pipeline.
 */

import * as fs from 'fs';

const MANIFEST_PATH = '/root/clawd/skills/memory-manager/manifest.json';

// ─── Configuration ──────────────────────────────────────────────────────────

const DECAY_CONFIG = {
  // After this many days with no access, decay begins
  gracePeriodDays: 1,

  // Base decay per day after grace period (multiplied by file's decayRate)
  baseDecayPerDay: 0.02,

  // Accelerated decay kicks in after this many days
  acceleratedAfterDays: 7,
  // Multiplier for accelerated decay
  acceleratedMultiplier: 2.0,

  // Recency boost: files accessed in last N days get a weight bump
  recencyBoostWindow: 2,   // days
  recencyBoostAmount: 0.03,

  // Frequency bonus: high-access files resist decay
  frequencyShieldThreshold: 10, // accessCount above which decay is halved
  frequencyShieldFactor: 0.5,

  // Weight floors by type
  floors: {
    core: 0.5,
    people: 0.15,       // People context decays slowly — always relevant
    digest: 0.10,       // Weekly digests are historical reference
    topic: 0.08,        // Topics are long-lived reference
    recent: 0.05,       // Daily files can decay freely
    default: 0.05,
  } as Record<string, number>,

  // Per-file floor overrides for structural files that should maintain
  // higher weight regardless of access patterns (boot sequence, rules, etc.)
  structuralFloors: {
    'memory/index.md': 0.35,                // Boot sequence — always relevant
    'memory/rules.md': 0.40,                // Hard rules — safety-critical
    'AGENTS.md': 0.25,                       // Workspace config
    'memory/OPERATING.md': 0.30,             // Operational procedures
    'memory/people/contacts.md': 0.20,       // Key contacts — always needed
    'memory/people/hevar-profile.md': 0.20,  // Understanding the human — core
    'memory/moltbook/clusters.md': 0.15,     // Intelligence reference
  } as Record<string, number>,

  // Active project floors: files tied to ongoing work that shouldn't decay
  // below useful thresholds even when not accessed every session.
  // Review periodically — remove projects that are truly done.
  activeProjectFloors: {
    'memory/topics/moongate.md': 0.20,           // Active employer
    'memory/topics/moltbook.md': 0.20,           // Active mission
    'memory/topics/defi-strategy-v2.md': 0.18,   // Open position
    'memory/moltbook/notable-agents.md': 0.18,   // Intel reference
    'memory/moltbook/clusters.md': 0.15,         // Intel reference (also in structural)
  } as Record<string, number>,

  // Current weekly digest always gets a floor (auto-detected)
  currentWeeklyFloor: 0.30,

  // Archival threshold: files at or below this get flagged
  archivalThreshold: 0.08,
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface FileEntry {
  weight: number;
  type: string;
  lastAccess: string;
  accessCount: number;
  decayRate: number;
  summary: string;
}

interface Manifest {
  version: number;
  nextTask: any;
  taskQueue: any[];
  files: Record<string, FileEntry>;
  recentTopics: string[];
  lastSession: any;
  config: any;
  sessionHistory?: any[];
  lastDecayRun?: string;
}

interface DecayResult {
  file: string;
  oldWeight: number;
  newWeight: number;
  reason: string;
  daysSinceAccess: number;
}

// ─── Core Logic ─────────────────────────────────────────────────────────────

function calculateDecay(entry: FileEntry, daysSinceAccess: number): { newWeight: number; reason: string } {
  const cfg = DECAY_CONFIG;
  let weight = entry.weight;
  let reason = '';

  // Core files with decayRate 0 — never decay
  if (entry.decayRate === 0) {
    return { newWeight: weight, reason: 'no-decay (rate=0)' };
  }

  // Within grace period — no decay, possible boost
  if (daysSinceAccess <= cfg.gracePeriodDays) {
    if (daysSinceAccess <= cfg.recencyBoostWindow) {
      const boost = cfg.recencyBoostAmount;
      const maxWeight = entry.type === 'core' ? 1.0 : 0.95;
      weight = Math.min(maxWeight, weight + boost);
      reason = `recency-boost +${boost.toFixed(3)}`;
    } else {
      reason = 'grace-period';
    }
    return { newWeight: weight, reason };
  }

  // Calculate effective decay days (beyond grace period)
  const effectiveDecayDays = daysSinceAccess - cfg.gracePeriodDays;

  // Base decay amount
  let decayPerDay = cfg.baseDecayPerDay * entry.decayRate;

  // Frequency shield: high-access files resist decay
  if (entry.accessCount >= cfg.frequencyShieldThreshold) {
    decayPerDay *= cfg.frequencyShieldFactor;
    reason = 'freq-shielded ';
  }

  // Accelerated decay after threshold
  let totalDecay: number;
  if (effectiveDecayDays <= cfg.acceleratedAfterDays) {
    totalDecay = effectiveDecayDays * decayPerDay;
    reason += `linear-decay (${effectiveDecayDays}d × ${decayPerDay.toFixed(4)})`;
  } else {
    // Linear for first N days, accelerated after
    const linearPortion = cfg.acceleratedAfterDays * decayPerDay;
    const accelDays = effectiveDecayDays - cfg.acceleratedAfterDays;
    const accelPortion = accelDays * decayPerDay * cfg.acceleratedMultiplier;
    totalDecay = linearPortion + accelPortion;
    reason += `accel-decay (${cfg.acceleratedAfterDays}d linear + ${accelDays}d × ${cfg.acceleratedMultiplier})`;
  }

  // Apply decay
  weight -= totalDecay;

  // Enforce floor — structural overrides take precedence over type-based floors
  const typeFloor = cfg.floors[entry.type] || cfg.floors.default;
  weight = Math.max(typeFloor, weight);

  return { newWeight: Math.round(weight * 10000) / 10000, reason };
}

/**
 * Get the effective floor for a file, considering structural overrides,
 * active project floors, and current weekly digest protection.
 * Returns the highest applicable floor, or null if none.
 */
function getEffectiveFloor(filepath: string): number | null {
  const floors: number[] = [];

  // Structural floor
  const structural = DECAY_CONFIG.structuralFloors[filepath];
  if (structural !== undefined) floors.push(structural);

  // Active project floor
  const project = DECAY_CONFIG.activeProjectFloors[filepath];
  if (project !== undefined) floors.push(project);

  // Current weekly digest auto-detection
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay() + 1); // Monday
  const year = weekStart.getFullYear();
  const weekNum = getISOWeekNumber(now);
  const currentWeeklyPath = `memory/weekly/${year}-W${String(weekNum).padStart(2, '0')}.md`;
  if (filepath === currentWeeklyPath) {
    floors.push(DECAY_CONFIG.currentWeeklyFloor);
  }

  return floors.length > 0 ? Math.max(...floors) : null;
}

/** Get ISO week number */
function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function runDecay(dryRun: boolean, verbose: boolean): void {
  const manifest: Manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  // Check if decay already ran today
  if (manifest.lastDecayRun === today && !verbose) {
    console.log(`⏭️  Decay already ran today (${today}). Use --verbose to force re-check.`);
    return;
  }

  const results: DecayResult[] = [];
  const archivalCandidates: string[] = [];
  let totalDecayed = 0;
  let totalBoosted = 0;
  let totalUnchanged = 0;

  for (const [filepath, entry] of Object.entries(manifest.files)) {
    const lastAccess = new Date(entry.lastAccess).getTime();
    const daysSinceAccess = Math.floor((now - lastAccess) / (1000 * 60 * 60 * 24));

    let { newWeight, reason } = calculateDecay(entry, daysSinceAccess);

    // Apply effective floor override (structural + active project + current weekly)
    const effectiveFloor = getEffectiveFloor(filepath);
    if (effectiveFloor !== null && newWeight < effectiveFloor) {
      newWeight = effectiveFloor;
      reason += ` [floor: ${effectiveFloor}]`;
    }

    const changed = Math.abs(newWeight - entry.weight) > 0.0001;

    if (changed || verbose) {
      results.push({
        file: filepath,
        oldWeight: entry.weight,
        newWeight,
        reason,
        daysSinceAccess,
      });
    }

    if (changed) {
      if (newWeight < entry.weight) totalDecayed++;
      else totalBoosted++;
    } else {
      totalUnchanged++;
    }

    // Check archival threshold
    if (newWeight <= DECAY_CONFIG.archivalThreshold && entry.type !== 'core') {
      archivalCandidates.push(filepath);
    }

    // Apply the change (unless dry run)
    if (!dryRun && changed) {
      entry.weight = newWeight;
    }
  }

  // ─── Output ─────────────────────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════════════');
  console.log('     ⏳ MEMORY DECAY AUTOMATION');
  console.log(`     ${new Date().toISOString()}`);
  if (dryRun) console.log('     [DRY RUN — no changes saved]');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  if (results.length === 0) {
    console.log('   No weight changes detected.');
  } else {
    // Sort: biggest changes first
    results.sort((a, b) => Math.abs(b.oldWeight - b.newWeight) - Math.abs(a.oldWeight - a.newWeight));

    for (const r of results) {
      const delta = r.newWeight - r.oldWeight;
      const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '·';
      const deltaStr = delta > 0 ? `+${delta.toFixed(4)}` : delta.toFixed(4);
      const changed = Math.abs(delta) > 0.0001;
      
      if (changed) {
        console.log(`   ${arrow} ${r.file}`);
        console.log(`     ${r.oldWeight.toFixed(4)} → ${r.newWeight.toFixed(4)} (${deltaStr}) [${r.daysSinceAccess}d] ${r.reason}`);
      } else if (verbose) {
        console.log(`   · ${r.file} (${r.oldWeight.toFixed(4)}) [${r.daysSinceAccess}d] ${r.reason}`);
      }
    }
  }

  console.log('');
  console.log(`📊 Summary: ${totalDecayed} decayed, ${totalBoosted} boosted, ${totalUnchanged} unchanged`);
  console.log(`   Total files: ${Object.keys(manifest.files).length}`);

  // Archival candidates
  if (archivalCandidates.length > 0) {
    console.log('');
    console.log('⚠️  ARCHIVAL CANDIDATES (weight ≤ threshold):');
    for (const f of archivalCandidates) {
      const entry = manifest.files[f];
      console.log(`   🗃️  ${f} (${entry.weight.toFixed(4)}) — last: ${entry.lastAccess}, count: ${entry.accessCount}`);
    }
    console.log('   Consider: merge into summary, archive, or remove from manifest.');
  }

  // Save
  if (!dryRun) {
    manifest.lastDecayRun = today;
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log('');
    console.log('💾 Manifest saved.');
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

runDecay(dryRun, verbose);
