#!/usr/bin/env npx ts-node

/**
 * Memory Conflict Detector — Tool #36
 * 
 * Finds contradictions, stale facts, and inconsistencies across memory files.
 * 
 * Strategy:
 * 1. Extract "factual claims" — statements with numbers, dates, statuses, names
 * 2. Group claims by entity/topic (using concept index + BM25 overlap)
 * 3. Compare claims within groups for contradictions
 * 4. Score by severity: hard contradiction > stale data > soft inconsistency
 * 
 * Contradiction types:
 * - Numeric: "2.0 SOL" vs "2.35 SOL" (different values for same metric)
 * - Status: "submitted" vs "pending" (conflicting state)
 * - Temporal: "Feb 10" claim contradicted by "Feb 12" update
 * - Entity: same person/project described differently
 * 
 * Usage:
 *   npx ts-node src/conflict-detect.ts                    # Full scan
 *   npx ts-node src/conflict-detect.ts --topic "DeFi"     # Scan specific topic
 *   npx ts-node src/conflict-detect.ts --file MEMORY.md   # Scan specific file
 *   npx ts-node src/conflict-detect.ts --json              # JSON output
 *   npx ts-node src/conflict-detect.ts --fix               # Suggest fixes
 */

import * as fs from 'fs';
import * as path from 'path';

const { DatabaseSync } = require('node:sqlite');
const DB_PATH = path.join(process.env.HOME || '/root', '.clawdbot/memory/main.sqlite');
const MEMORY_DIR = '/root/clawd/memory';
const CONCEPT_PATH = '/root/clawd/skills/memory-manager/concept-index.json';

// ─── Types ──────────────────────────────────────────────────────────────────

interface FactClaim {
  text: string;           // The original chunk text
  path: string;           // File path
  startLine: number;
  entity: string;         // Primary entity this is about
  claims: ClaimDetail[];  // Extracted factual claims
  fileDate?: string;      // Date from filename if daily log
}

interface ClaimDetail {
  type: 'numeric' | 'status' | 'count' | 'date' | 'name' | 'version';
  subject: string;        // What the claim is about
  value: string;          // The claimed value
  raw: string;            // Original text fragment
  confidence: number;     // How confident we are this is a factual claim
}

interface Conflict {
  severity: 'high' | 'medium' | 'low';
  type: 'contradiction' | 'stale' | 'inconsistency' | 'duplicate';
  description: string;
  claims: { path: string; text: string; date?: string }[];
  suggestion?: string;
}

// ─── Claim Extraction ───────────────────────────────────────────────────────

/**
 * Extract factual claims from a chunk of text.
 * Looks for patterns that encode facts: numbers, statuses, dates, versions.
 */
function extractClaims(text: string, chunkPath: string, startLine: number): FactClaim {
  const claims: ClaimDetail[] = [];
  const lines = text.split('\n');
  
  // Detect file date from path (supports YYYY-MM-DD and YYYY-WNN formats)
  const dateMatch = chunkPath.match(/(\d{4}-\d{2}-\d{2})/);
  const weekMatch = chunkPath.match(/(\d{4}-W\d{2})/);
  const fileDate = dateMatch ? dateMatch[1] : weekMatch ? weekMatch[1] : undefined;
  
  // Detect primary entity from context
  const entity = detectPrimaryEntity(text, chunkPath);
  
  // Pattern 1: Numeric values with context — "~2.0 SOL", "$1.3M", "35 tools", "127 chunks"
  const numericPatterns = [
    // Currency/amounts: "~2.0 SOL", "$1.3M", "0.97 SOL"
    /(?:~|≈|about\s+)?(\$?[\d,.]+[KkMmBb]?)\s+(SOL|USDC|USD|ETH|BTC|shares?|tokens?)/gi,
    // Counts: "35 tools", "127 chunks", "33 files"
    /\b(\d+)\s+(tools?|chunks?|files?|xrefs?|sessions?|entries|PRs?|tests?|members?|commits?|stars?)\b/gi,
    // Percentages: "100%", "7.37% APY", "90%"
    /\b([\d.]+%)\s*(?:APY|recall|accuracy|coverage|score)?\b/gi,
    // Scores: "P@1=90%", "68/68", "98/100"
    /\b(\d+\/\d+)\b/g,
    // Versions: "v2", "#36"
    /\b(?:v|#|version\s*)(\d+(?:\.\d+)*)\b/gi,
  ];
  
  for (const pattern of numericPatterns) {
    let match;
    // Reset regex state
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[0].trim();
      // Get surrounding context for subject detection
      const contextStart = Math.max(0, match.index - 60);
      const contextEnd = Math.min(text.length, match.index + match[0].length + 60);
      const context = text.substring(contextStart, contextEnd);
      const subject = extractSubject(context, value);
      
      claims.push({
        type: 'numeric',
        subject,
        value: normalizeNumeric(value),
        raw: context.trim(),
        confidence: 0.8,
      });
    }
  }
  
  // Pattern 2: Status indicators — "submitted", "pending", "complete", "operational"
  const statusPatterns = [
    /\b(submitted|pending|complete[d]?|operational|stable|healthy|broken|failed|active|inactive|archived|deprecated|draft|live|dead|paused|snoozed|open|closed)\b/gi,
  ];
  
  for (const pattern of statusPatterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const contextStart = Math.max(0, match.index - 80);
      const contextEnd = Math.min(text.length, match.index + match[0].length + 40);
      const context = text.substring(contextStart, contextEnd);
      const subject = extractSubject(context, match[0]);
      
      claims.push({
        type: 'status',
        subject,
        value: match[1].toLowerCase(),
        raw: context.trim(),
        confidence: 0.7,
      });
    }
  }
  
  // Pattern 3: Date-bound facts — "signed Jan 2025", "ended Feb 13", "started Feb 3"
  const dateFactPatterns = [
    /\b(signed|started|ended|launched|submitted|created|deployed|published|built|fixed|merged)\s+(?:on\s+)?(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2})/gi,
  ];
  
  for (const pattern of dateFactPatterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const contextStart = Math.max(0, match.index - 40);
      const contextEnd = Math.min(text.length, match.index + match[0].length + 40);
      const context = text.substring(contextStart, contextEnd);
      
      claims.push({
        type: 'date',
        subject: extractSubject(context, match[0]),
        value: match[0].trim(),
        raw: context.trim(),
        confidence: 0.85,
      });
    }
  }

  return { text, path: chunkPath, startLine, entity, claims, fileDate };
}

/**
 * Detect the primary entity a chunk is about
 */
function detectPrimaryEntity(text: string, filePath: string): string {
  // Check file path for topic
  if (filePath.includes('topics/')) {
    const topicMatch = filePath.match(/topics\/([^/]+?)\.md/);
    if (topicMatch) return topicMatch[1].replace(/-/g, ' ');
  }
  if (filePath.includes('moltbook/')) return 'moltbook';
  if (filePath.includes('people/')) return 'people';
  
  // Check for section headers
  const headerMatch = text.match(/^#+\s+(.+)$/m);
  if (headerMatch) return headerMatch[1].trim().toLowerCase().substring(0, 60);
  
  // Check for bold labels
  const boldMatch = text.match(/\*\*([^*]+?)\*\*/);
  if (boldMatch) return boldMatch[1].trim().toLowerCase().substring(0, 60);
  
  // Use file basename
  return path.basename(filePath, '.md').replace(/-/g, ' ');
}

/**
 * Extract the subject of a claim from surrounding context
 */
function extractSubject(context: string, value: string): string {
  // Look for bold labels nearby
  const boldMatch = context.match(/\*\*([^*]+?)\*\*/);
  if (boldMatch) return boldMatch[1].trim().toLowerCase().substring(0, 80);
  
  // Look for "Subject:" patterns
  const colonMatch = context.match(/([A-Z][a-zA-Z\s]+?):\s/);
  if (colonMatch) return colonMatch[1].trim().toLowerCase().substring(0, 80);
  
  // Use text before the value
  const idx = context.indexOf(value);
  if (idx > 5) {
    const before = context.substring(Math.max(0, idx - 50), idx).trim();
    const words = before.split(/\s+/).slice(-4).join(' ');
    return words.toLowerCase().substring(0, 80);
  }
  
  return 'unknown';
}

/**
 * Normalize numeric values for comparison
 */
function normalizeNumeric(value: string): string {
  return value.replace(/[~≈,]/g, '').trim().toLowerCase();
}

// ─── Conflict Detection ─────────────────────────────────────────────────────

/**
 * Group claims by subject similarity and check for conflicts
 */
function detectConflicts(allClaims: FactClaim[]): Conflict[] {
  const conflicts: Conflict[] = [];
  
  // Flatten all individual claims with their source context
  const flatClaims: Array<ClaimDetail & { sourcePath: string; sourceText: string; sourceDate?: string }> = [];
  
  for (const fc of allClaims) {
    for (const claim of fc.claims) {
      flatClaims.push({
        ...claim,
        sourcePath: fc.path,
        sourceText: fc.text,
        sourceDate: fc.fileDate,
      });
    }
  }
  
  // Group by subject similarity
  const groups = groupBySubject(flatClaims);
  
  for (const [groupKey, members] of Object.entries(groups)) {
    if (members.length < 2) continue;
    
    // Check for numeric contradictions within group
    const numericClaims = members.filter(m => m.type === 'numeric');
    if (numericClaims.length >= 2) {
      checkNumericConflicts(numericClaims, conflicts, groupKey);
    }
    
    // Check for status contradictions within group
    const statusClaims = members.filter(m => m.type === 'status');
    if (statusClaims.length >= 2) {
      checkStatusConflicts(statusClaims, conflicts, groupKey);
    }
    
    // Check for near-duplicate information (redundancy)
    checkDuplicates(members, conflicts, groupKey);
  }
  
  // Deduplicate conflicts — same pair of files often generates multiple hits
  const deduped: Conflict[] = [];
  const seenPairs = new Set<string>();
  
  for (const c of conflicts) {
    const paths = c.claims.map(cl => cl.path).sort().join('|');
    const typeKey = `${c.type}:${paths}`;
    
    if (!seenPairs.has(typeKey)) {
      seenPairs.add(typeKey);
      deduped.push(c);
    }
  }
  
  // Sort by severity
  const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  deduped.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  
  return deduped;
}

/**
 * Group claims by subject similarity using token overlap
 */
function groupBySubject(claims: Array<ClaimDetail & { sourcePath: string; sourceText: string; sourceDate?: string }>): Record<string, typeof claims> {
  const groups: Record<string, typeof claims> = {};
  const assigned = new Set<number>();
  
  for (let i = 0; i < claims.length; i++) {
    if (assigned.has(i)) continue;
    
    const group: typeof claims = [claims[i]];
    assigned.add(i);
    
    const tokensA = getTokens(claims[i].subject + ' ' + claims[i].raw);
    
    for (let j = i + 1; j < claims.length; j++) {
      if (assigned.has(j)) continue;
      
      const tokensB = getTokens(claims[j].subject + ' ' + claims[j].raw);
      const overlap = tokenOverlap(tokensA, tokensB);
      
      // Also check if they're about the same type of measurement
      const sameType = claims[i].type === claims[j].type;
      const threshold = sameType ? 0.35 : 0.5;
      
      // Skip grouping if both are from daily logs with different dates
      // (different days naturally have different session counts, etc.)
      const dateA = claims[i].sourceDate;
      const dateB = claims[j].sourceDate;
      if (dateA && dateB && dateA !== dateB) {
        // Require much higher overlap for cross-date comparisons
        // to avoid "8 sessions on Feb 12" vs "14 sessions on Feb 13" false positives
        if (overlap < 0.6) continue;
      }
      
      if (overlap >= threshold) {
        group.push(claims[j]);
        assigned.add(j);
      }
    }
    
    if (group.length >= 2) {
      const key = claims[i].subject.substring(0, 50) || `group-${i}`;
      groups[key] = group;
    }
  }
  
  return groups;
}

function getTokens(text: string): Set<string> {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'and', 'or', 'not', 'has', 'had', 'have', 'been', 'this', 'that']);
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !stopWords.has(t))
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

/**
 * Check if two paths are both temporal files (dailies, weeklies, archives)
 * where different values are expected temporal evolution, not contradictions.
 */
function areBothTemporalFiles(pathA: string, pathB: string): boolean {
  const temporalPatterns = [
    /memory\/daily\//,
    /memory\/archive\/daily\//,
    /memory\/weekly\//,
    /memory\/archive\/weekly\//,
  ];
  const isTemporalA = temporalPatterns.some(p => p.test(pathA));
  const isTemporalB = temporalPatterns.some(p => p.test(pathB));
  return isTemporalA && isTemporalB;
}

/**
 * Check if one path is a summary of the other (weekly summarizes daily, etc.)
 */
function isSummaryRelationship(pathA: string, pathB: string): boolean {
  const isWeeklyA = /weekly\//.test(pathA);
  const isWeeklyB = /weekly\//.test(pathB);
  const isDailyA = /daily\//.test(pathA);
  const isDailyB = /daily\//.test(pathB);
  
  // Weekly + daily = summary relationship
  if ((isWeeklyA && isDailyB) || (isDailyA && isWeeklyB)) return true;
  
  // MEMORY.md summarizes everything
  const isMemoryA = pathA.endsWith('MEMORY.md');
  const isMemoryB = pathB.endsWith('MEMORY.md');
  if (isMemoryA || isMemoryB) {
    const other = isMemoryA ? pathB : pathA;
    if (/daily\/|weekly\/|topics\/|archive\//.test(other)) return true;
  }
  
  // memory-system.md is a topic summary
  const isTopicA = /topics\//.test(pathA);
  const isTopicB = /topics\//.test(pathB);
  if ((isTopicA && isDailyB) || (isDailyA && isTopicB)) return true;
  
  return false;
}

/**
 * Detect if two numeric values are equivalent expressions of the same fact.
 * E.g., "25/25" (=1.0) and "100%" (=1.0), or "25 tests" and "25/25".
 */
function areEquivalentExpressions(rawA: string, rawB: string, numA: number, numB: number): boolean {
  // "25/25" (ratio = 1.0) and "100%" are equivalent
  const fracA = rawA.match(/(\d+)\/(\d+)/);
  const fracB = rawB.match(/(\d+)\/(\d+)/);
  const pctA = rawA.match(/([\d.]+)%/);
  const pctB = rawB.match(/([\d.]+)%/);
  
  // fraction vs percentage: 25/25 → 100%
  if (fracA && pctB) {
    const ratioA = parseInt(fracA[1]) / parseInt(fracA[2]) * 100;
    const pct = parseFloat(pctB[1]);
    if (Math.abs(ratioA - pct) < 1) return true;
  }
  if (fracB && pctA) {
    const ratioB = parseInt(fracB[1]) / parseInt(fracB[2]) * 100;
    const pct = parseFloat(pctA[1]);
    if (Math.abs(ratioB - pct) < 1) return true;
  }
  
  // "N tests" vs "N/N" — same count
  const countA = rawA.match(/(\d+)\s+tests?/i);
  const countB = rawB.match(/(\d+)\s+tests?/i);
  if (countA && fracB && parseInt(countA[1]) === parseInt(fracB[1])) return true;
  if (countB && fracA && parseInt(countB[1]) === parseInt(fracA[1])) return true;
  
  return false;
}

/**
 * Check numeric claims for contradictions.
 * 
 * Key insight: different values across temporal files (daily logs, weeklies, archives)
 * are typically progression/evolution, not contradictions. A health score going from
 * 79→84→100 over days is expected. Only flag as contradiction when:
 * - Both claims are in persistent/curated files (topics, MEMORY.md) with no date separation
 * - Values conflict within the same time period
 */
function checkNumericConflicts(
  claims: Array<ClaimDetail & { sourcePath: string; sourceText: string; sourceDate?: string }>,
  conflicts: Conflict[],
  groupKey: string
): void {
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      
      // Skip if from same file or same file in daily vs archive
      if (a.sourcePath === b.sourcePath) continue;
      if (areSameFileInDailyAndArchive(a.sourcePath, b.sourcePath)) continue;
      
      // Compare extracted numbers
      const numA = extractNumber(a.value);
      const numB = extractNumber(b.value);
      
      if (numA !== null && numB !== null && numA !== numB) {
        // Check if they're equivalent expressions (e.g., "25/25" vs "25 tests" vs "100%")
        if (areEquivalentExpressions(a.raw, b.raw, numA, numB)) continue;
        
        // Check if they're measuring the same thing
        const subjectOverlap = tokenOverlap(getTokens(a.subject), getTokens(b.subject));
        const unitA = extractUnit(a.value);
        const unitB = extractUnit(b.value);
        const sameUnit = unitA && unitB && unitA === unitB;
        
        // If values have different units, require much higher subject overlap
        // "100% xref integrity" vs "79/100 health score" are different metrics
        if (unitA && unitB && unitA !== unitB) continue;
        
        // If one is a percentage and the other is a raw number with different unit context,
        // check if they're truly the same metric by looking for matching metric labels
        const metricA = extractMetricLabel(a.raw);
        const metricB = extractMetricLabel(b.raw);
        if (metricA && metricB && metricA !== metricB) continue;
        
        if (subjectOverlap >= 0.3 || sameUnit) {
          const dateA = a.sourceDate || '';
          const dateB = b.sourceDate || '';
          const newer = dateA > dateB ? a : dateB > dateA ? b : null;
          
          // --- Temporal evolution filtering ---
          
          // If both are temporal files with different dates, this is evolution, not conflict
          if (areBothTemporalFiles(a.sourcePath, b.sourcePath) && dateA !== dateB) continue;
          
          // If one summarizes the other (weekly→daily, MEMORY.md→daily), skip
          if (isSummaryRelationship(a.sourcePath, b.sourcePath)) continue;
          
          // If different dates and values are monotonically changing (metrics improving),
          // this is temporal progression — downgrade to low/stale at most
          if (dateA && dateB && dateA !== dateB) {
            // Different dates = likely temporal evolution
            // Only flag if both are in curated/persistent files (not temporal logs)
            const isTemporalA = /daily\/|weekly\/|archive\//.test(a.sourcePath);
            const isTemporalB = /daily\/|weekly\/|archive\//.test(b.sourcePath);
            
            if (isTemporalA || isTemporalB) {
              // At least one is a temporal file — this is expected evolution, skip
              continue;
            }
          }
          
          // --- End temporal filtering ---
          
          const divergence = Math.abs(numA - numB) / Math.max(numA, numB);
          const severity = divergence > 0.2 ? 'high' : 'medium';
          
          conflicts.push({
            severity,
            type: 'contradiction',
            description: `Numeric conflict in "${groupKey}": ${a.value} vs ${b.value}`,
            claims: [
              { path: a.sourcePath, text: a.raw, date: a.sourceDate },
              { path: b.sourcePath, text: b.raw, date: b.sourceDate },
            ],
            suggestion: newer
              ? `Newer value (${newer.value} from ${newer.sourcePath}) likely correct. Update the other.`
              : `Values differ — verify which is current.`,
          });
        }
      }
    }
  }
}

function extractNumber(value: string): number | null {
  const cleaned = value.replace(/[~≈$,]/g, '').trim();
  // Handle K/M/B suffixes
  const suffixMatch = cleaned.match(/([\d.]+)\s*([KkMmBb])/);
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1]);
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[suffixMatch[2].toLowerCase()] || 1;
    return num * mult;
  }
  // Handle fractions: "68/68"
  const fracMatch = cleaned.match(/^(\d+)\/(\d+)$/);
  if (fracMatch) return parseInt(fracMatch[1]) / parseInt(fracMatch[2]);
  
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function extractUnit(value: string): string | null {
  const unitMatch = value.match(/\b(SOL|USDC|USD|ETH|BTC|shares?|tokens?|tools?|chunks?|files?|xrefs?|%)\b/i);
  return unitMatch ? unitMatch[1].toLowerCase().replace(/s$/, '') : null;
}

/**
 * Extract a metric label from the context around a claim.
 * E.g., "100% xref integrity" → "xref integrity", "79/100 health score" → "health"
 * Returns null if no clear metric label found.
 */
function extractMetricLabel(raw: string): string | null {
  const metricPatterns = [
    /(?:[\d.%/]+)\s+(xref\s+integrity|recall|health|accuracy|coverage|chunk\s+health|search\s+diagnostics|balance|gas|APY|score)/i,
    /(xref\s+integrity|recall|health|accuracy|coverage|chunk\s+health|search\s+diagnostics|balance|gas|APY|score)\s*[:=]?\s*[\d.%/]+/i,
    /(health)\s*(?:score)?/i,
    /deploy\s+(100%)/i,  // "deploy 100%" → deploy context, not a metric
  ];
  
  for (const pattern of metricPatterns) {
    const match = raw.match(pattern);
    if (match) {
      return match[1].toLowerCase().trim();
    }
  }
  return null;
}

/**
 * Check status claims for contradictions
 */
function checkStatusConflicts(
  claims: Array<ClaimDetail & { sourcePath: string; sourceText: string; sourceDate?: string }>,
  conflicts: Conflict[],
  groupKey: string
): void {
  const contradictoryPairs: Record<string, string[]> = {
    'submitted': ['pending', 'draft'],
    'complete': ['pending', 'active', 'draft'],
    'operational': ['broken', 'failed', 'inactive', 'dead'],
    'stable': ['broken', 'failed'],
    'healthy': ['broken', 'failed'],
    'active': ['inactive', 'dead', 'archived', 'deprecated'],
    'live': ['dead', 'archived', 'deprecated'],
    'open': ['closed'],
    'closed': ['open'],
  };
  
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      
      if (a.sourcePath === b.sourcePath) continue;
      if (areSameFileInDailyAndArchive(a.sourcePath, b.sourcePath)) continue;
      
      const valA = a.value.toLowerCase();
      const valB = b.value.toLowerCase();
      
      if (valA === valB) continue;
      
      // Check if they're contradictory
      const isContradiction = 
        (contradictoryPairs[valA]?.includes(valB)) ||
        (contradictoryPairs[valB]?.includes(valA));
      
      if (isContradiction) {
        const dateA = a.sourceDate || '';
        const dateB = b.sourceDate || '';
        const newer = dateA > dateB ? a : dateB > dateA ? b : null;
        
        // Temporal evolution filtering — status changes over time are expected
        if (areBothTemporalFiles(a.sourcePath, b.sourcePath) && dateA !== dateB) continue;
        if (isSummaryRelationship(a.sourcePath, b.sourcePath)) continue;
        if (dateA && dateB && dateA !== dateB) {
          const isTemporalA = /daily\/|weekly\/|archive\//.test(a.sourcePath);
          const isTemporalB = /daily\/|weekly\/|archive\//.test(b.sourcePath);
          if (isTemporalA || isTemporalB) continue;
        }
        
        conflicts.push({
          severity: 'medium',
          type: 'contradiction',
          description: `Status conflict in "${groupKey}": "${valA}" vs "${valB}"`,
          claims: [
            { path: a.sourcePath, text: a.raw, date: a.sourceDate },
            { path: b.sourcePath, text: b.raw, date: b.sourceDate },
          ],
          suggestion: newer
            ? `"${newer.value}" is more recent (${newer.sourcePath}). Update the older reference.`
            : `Conflicting statuses — check which is current.`,
        });
      }
    }
  }
}

/**
 * Check for near-duplicate information across files
 */
function checkDuplicates(
  claims: Array<ClaimDetail & { sourcePath: string; sourceText: string; sourceDate?: string }>,
  conflicts: Conflict[],
  groupKey: string
): void {
  // Check if the same fact appears verbatim or near-verbatim in multiple files
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      
      if (a.sourcePath === b.sourcePath) continue;
      if (areSameFileInDailyAndArchive(a.sourcePath, b.sourcePath)) continue;
      
      // Check raw text similarity
      const overlap = tokenOverlap(getTokens(a.raw), getTokens(b.raw));
      
      if (overlap >= 0.8 && a.value === b.value) {
        // Summary relationships naturally contain duplicated facts (weekly→daily, MEMORY→topic)
        if (isSummaryRelationship(a.sourcePath, b.sourcePath)) continue;
        // Both temporal files having same facts is expected (daily snapshot vs weekly digest)
        if (areBothTemporalFiles(a.sourcePath, b.sourcePath)) continue;
        
        conflicts.push({
          severity: 'low',
          type: 'duplicate',
          description: `Duplicate info in "${groupKey}": same fact in two places`,
          claims: [
            { path: a.sourcePath, text: a.raw.substring(0, 120), date: a.sourceDate },
            { path: b.sourcePath, text: b.raw.substring(0, 120), date: b.sourceDate },
          ],
          suggestion: `Consider consolidating into one authoritative location.`,
        });
      }
    }
  }
}

// ─── Main Scan ──────────────────────────────────────────────────────────────

function loadChunks(filterPath?: string, filterTopic?: string): Array<{ path: string; text: string; start_line: number }> {
  const db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
  
  let query = `SELECT path, text, start_line FROM chunks WHERE source='memory'`;
  const params: any[] = [];
  
  if (filterPath) {
    const relPath = filterPath.replace('/root/clawd/', '');
    query += ` AND path = ?`;
    params.push(relPath);
  }
  
  if (filterTopic) {
    // Use BM25 to find topic-relevant chunks
    const ftsQuery = filterTopic.split(/\s+/).map(t => `"${t}"`).join(' AND ');
    try {
      const rows = db.prepare(
        `SELECT path, text, bm25(chunks_fts) AS rank
         FROM chunks_fts
         WHERE chunks_fts MATCH ? AND source='memory'
         ORDER BY rank ASC
         LIMIT 100`
      ).all(ftsQuery);
      db.close();
      return rows.map((r: any) => ({ path: r.path, text: r.text, start_line: 0 }));
    } catch {
      db.close();
      return [];
    }
  }
  
  const stmt = db.prepare(query);
  const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
  db.close();
  return rows;
}

function runScan(opts: { filterPath?: string; filterTopic?: string; json?: boolean; fix?: boolean }): void {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🔍 MEMORY CONFLICT DETECTOR');
  console.log('═══════════════════════════════════════════════════════════');
  
  if (opts.filterPath) console.log(`   Scope: ${opts.filterPath}`);
  if (opts.filterTopic) console.log(`   Topic: ${opts.filterTopic}`);
  
  // Load chunks
  const chunks = loadChunks(opts.filterPath, opts.filterTopic);
  console.log(`   Chunks loaded: ${chunks.length}`);
  
  // Extract claims
  const allClaims: FactClaim[] = [];
  let totalClaimCount = 0;
  
  for (const chunk of chunks) {
    const factClaim = extractClaims(chunk.text, chunk.path, chunk.start_line);
    if (factClaim.claims.length > 0) {
      allClaims.push(factClaim);
      totalClaimCount += factClaim.claims.length;
    }
  }
  
  console.log(`   Factual claims extracted: ${totalClaimCount} from ${allClaims.length} chunks`);
  console.log('');
  
  // Detect archive mirror duplicates (files in both daily/ and archive/daily/)
  const archiveMirrors = detectArchiveMirrors();
  
  // Detect conflicts
  const conflicts = detectConflicts(allClaims);
  
  // Prepend archive mirror warnings
  if (archiveMirrors.length > 0) {
    for (const mirror of archiveMirrors) {
      conflicts.unshift({
        severity: 'medium',
        type: 'duplicate',
        description: `Archive mirror: ${mirror.file} exists in both daily/ and archive/daily/`,
        claims: [
          { path: `memory/daily/${mirror.file}`, text: 'Active copy' },
          { path: `memory/archive/daily/${mirror.file}`, text: 'Archive copy' },
        ],
        suggestion: `Remove one copy. If archived, delete from daily/. If active, delete from archive/daily/.`,
      });
    }
  }
  
  if (opts.json) {
    console.log(JSON.stringify({ totalClaims: totalClaimCount, conflicts }, null, 2));
    return;
  }
  
  if (conflicts.length === 0) {
    console.log('   ✅ No conflicts detected!');
    console.log('');
    console.log('   Memory is internally consistent.');
    console.log('═══════════════════════════════════════════════════════════');
    return;
  }
  
  // Report conflicts
  const high = conflicts.filter(c => c.severity === 'high').length;
  const medium = conflicts.filter(c => c.severity === 'medium').length;
  const low = conflicts.filter(c => c.severity === 'low').length;
  
  console.log(`   ⚠️  Found ${conflicts.length} conflicts: ${high} high, ${medium} medium, ${low} low`);
  console.log('');
  
  const severityIcon: Record<string, string> = { high: '🔴', medium: '🟡', low: '⚪' };
  const typeIcon: Record<string, string> = { contradiction: '⚡', stale: '📅', inconsistency: '🔀', duplicate: '📋' };
  
  for (const [i, conflict] of conflicts.entries()) {
    const sev = severityIcon[conflict.severity] || '❓';
    const typ = typeIcon[conflict.type] || '❓';
    
    console.log(`── ${sev} ${typ} Conflict #${i + 1} [${conflict.severity}/${conflict.type}] ──`);
    console.log(`   ${conflict.description}`);
    console.log('');
    
    for (const claim of conflict.claims) {
      const dateStr = claim.date ? ` (${claim.date})` : '';
      console.log(`   📄 ${claim.path}${dateStr}`);
      console.log(`      "${claim.text.substring(0, 150)}${claim.text.length > 150 ? '...' : ''}"`);
    }
    
    if (conflict.suggestion && opts.fix) {
      console.log(`   💡 ${conflict.suggestion}`);
    }
    console.log('');
  }
  
  console.log('───────────────────────────────────────');
  console.log(`   📊 Summary: ${conflicts.length} conflicts across ${allClaims.length} factual chunks`);
  
  if (!opts.fix) {
    console.log(`   💡 Run with --fix to see resolution suggestions`);
  }
  
  console.log('═══════════════════════════════════════════════════════════');
  
  // Save results
  const resultsPath = path.join('/root/clawd/skills/memory-manager', 'conflict-history.json');
  let history: any[] = [];
  try { history = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')); } catch {}
  history.push({
    timestamp: new Date().toISOString(),
    scope: opts.filterPath || opts.filterTopic || 'full',
    totalClaims: totalClaimCount,
    conflicts: conflicts.length,
    high,
    medium,
    low,
  });
  if (history.length > 30) history = history.slice(-30);
  fs.writeFileSync(resultsPath, JSON.stringify(history, null, 2));
}

/**
 * Check if two paths point to the same file in daily/ vs archive/daily/
 */
function areSameFileInDailyAndArchive(pathA: string, pathB: string): boolean {
  const basenameA = path.basename(pathA);
  const basenameB = path.basename(pathB);
  if (basenameA !== basenameB) return false;
  
  const isDailyA = pathA.includes('memory/daily/') && !pathA.includes('archive');
  const isArchiveA = pathA.includes('archive/daily/');
  const isDailyB = pathB.includes('memory/daily/') && !pathB.includes('archive');
  const isArchiveB = pathB.includes('archive/daily/');
  
  return (isDailyA && isArchiveB) || (isArchiveA && isDailyB);
}

// ─── Archive Mirror Detection ───────────────────────────────────────────────

function detectArchiveMirrors(): Array<{ file: string }> {
  const dailyDir = path.join(MEMORY_DIR, 'daily');
  const archiveDir = path.join(MEMORY_DIR, 'archive/daily');
  
  try {
    const dailyFiles = new Set(fs.readdirSync(dailyDir).filter(f => f.endsWith('.md')));
    const archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.md'));
    
    const mirrors: Array<{ file: string }> = [];
    for (const af of archiveFiles) {
      if (dailyFiles.has(af)) {
        mirrors.push({ file: af });
      }
    }
    return mirrors;
  } catch {
    return [];
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  
  const opts: { filterPath?: string; filterTopic?: string; json?: boolean; fix?: boolean } = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      opts.filterPath = args[++i];
    } else if (args[i] === '--topic' && args[i + 1]) {
      opts.filterTopic = args[++i];
    } else if (args[i] === '--json') {
      opts.json = true;
    } else if (args[i] === '--fix') {
      opts.fix = true;
    }
  }
  
  runScan(opts);
}

// Exports
export { extractClaims, detectConflicts, Conflict, FactClaim, ClaimDetail };

main();
