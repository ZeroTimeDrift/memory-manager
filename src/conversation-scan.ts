#!/usr/bin/env npx ts-node

/**
 * Conversation Scanner — Real-time importance scoring for session transcripts
 * 
 * Bridges live conversations to the capture pipeline. Analyzes conversation
 * exchanges, scores them for importance, auto-classifies high-value items,
 * and routes them through capture.ts (with dedup protection).
 * 
 * This is the missing piece: instead of manually piping "DECISION: X" after
 * every conversation, this tool scans transcripts and extracts what matters.
 * 
 * Modes:
 *   --stdin          Read conversation from stdin (one exchange per line, or
 *                    alternating "USER: " / "ASSISTANT: " prefixed lines)
 *   --session <key>  Read from Clawdbot session history (requires clawdbot CLI)
 *   --daily          Scan today's session logs in memory/sessions/
 *   --dry-run        Show what would be captured without actually filing
 *   --threshold N    Minimum importance score to capture (default: 0.45)
 *   --user-only      Only score user messages (skip assistant messages)
 *   --json           Machine-readable output
 * 
 * Usage:
 *   npx ts-node src/conversation-scan.ts --stdin < transcript.txt
 *   npx ts-node src/conversation-scan.ts --session main --threshold 0.5
 *   npx ts-node src/conversation-scan.ts --daily --dry-run
 *   echo "Remember, I hate when you apologize\nLet's use Rust for this" | npx ts-node src/conversation-scan.ts --stdin
 * 
 * Programmatic:
 *   import { scanConversation, ScanResult } from './conversation-scan';
 *   const result = await scanConversation(exchanges, { threshold: 0.5 });
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { scoreImportance, analyzeConversation, type ImportanceResult, type CaptureType } from './importance';
import { checkDuplicate } from './dedup';

const WORKSPACE = '/root/clawd';
const SESSIONS_DIR = path.join(WORKSPACE, 'memory', 'sessions');
const DAILY_DIR = path.join(WORKSPACE, 'memory', 'daily');
const SKILL_DIR = path.join(WORKSPACE, 'skills', 'memory-manager');
const SCAN_STATE_PATH = path.join(SKILL_DIR, 'scan-state.json');

// ─── Types ──────────────────────────────────────────────────────────────────

interface Exchange {
  role: 'user' | 'assistant' | 'unknown';
  text: string;
  timestamp?: string;
}

interface ScanOptions {
  threshold: number;        // Minimum score to capture (default 0.45)
  dryRun: boolean;          // Preview mode — don't file anything
  userOnly: boolean;        // Only score user messages
  jsonOutput: boolean;      // Machine-readable output
  contextWindow: number;    // Number of surrounding exchanges for context (default 1)
}

interface ClassifiedItem {
  exchange: Exchange;
  score: number;
  level: string;
  captureType: CaptureType;
  captureText: string;      // The formatted capture string (e.g., "DECISION: ...")
  signals: string[];
  contextBefore?: string;   // Previous exchange for context
  contextAfter?: string;    // Next exchange for context
  dedupStatus: 'new' | 'warning' | 'duplicate';
}

export interface ScanResult {
  totalExchanges: number;
  scanned: number;
  captured: ClassifiedItem[];
  skippedLowScore: number;
  skippedDuplicate: number;
  skippedWarning: number;
  captureLines: string[];   // Ready-to-pipe lines for capture.ts
}

// ─── Exchange Parsing ───────────────────────────────────────────────────────

/**
 * Parse raw text into exchanges. Supports multiple formats:
 * - "USER: text" / "ASSISTANT: text" prefixed lines
 * - "Human: text" / "Claude: text" (Claude transcript format)
 * - Plain lines (treated as alternating user/assistant)
 * - JSON array of {role, content} objects
 */
function parseExchanges(raw: string): Exchange[] {
  const trimmed = raw.trim();
  
  // Try JSON format first
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed.map((item: any) => ({
        role: normalizeRole(item.role),
        text: (item.content || item.text || '').trim(),
        timestamp: item.timestamp,
      })).filter((e: Exchange) => e.text.length > 0);
    } catch {
      // Not JSON, fall through
    }
  }
  
  const lines = trimmed.split('\n');
  const exchanges: Exchange[] = [];
  let currentRole: Exchange['role'] = 'unknown';
  let currentText: string[] = [];
  
  for (const line of lines) {
    const userMatch = line.match(/^(USER|Human|Hevar|>)\s*:\s*(.*)/i);
    const assistantMatch = line.match(/^(ASSISTANT|Claude|Prometheus|AI|Bot)\s*:\s*(.*)/i);
    
    if (userMatch) {
      // Flush previous
      if (currentText.length > 0) {
        exchanges.push({ role: currentRole, text: currentText.join('\n').trim() });
      }
      currentRole = 'user';
      currentText = [userMatch[2]];
    } else if (assistantMatch) {
      if (currentText.length > 0) {
        exchanges.push({ role: currentRole, text: currentText.join('\n').trim() });
      }
      currentRole = 'assistant';
      currentText = [assistantMatch[2]];
    } else if (line.trim().length > 0) {
      if (currentRole === 'unknown' && exchanges.length === 0) {
        // First line without prefix — assume user
        currentRole = 'user';
      }
      currentText.push(line);
    } else if (currentText.length > 0) {
      // Blank line separates exchanges in plain mode
      exchanges.push({ role: currentRole, text: currentText.join('\n').trim() });
      currentText = [];
      // Toggle role for plain-text mode
      if (currentRole === 'user') currentRole = 'assistant';
      else if (currentRole === 'assistant') currentRole = 'user';
      else currentRole = 'user';
    }
  }
  
  // Flush last
  if (currentText.length > 0) {
    exchanges.push({ role: currentRole, text: currentText.join('\n').trim() });
  }
  
  return exchanges.filter(e => e.text.length > 0);
}

function normalizeRole(role: string): Exchange['role'] {
  const lower = (role || '').toLowerCase();
  if (['user', 'human', 'hevar'].includes(lower)) return 'user';
  if (['assistant', 'ai', 'claude', 'prometheus', 'bot'].includes(lower)) return 'assistant';
  return 'unknown';
}

// ─── Contextual Enhancement ─────────────────────────────────────────────────

/**
 * Some exchanges score higher when we consider context.
 * E.g., "Yes, let's go with that" is noise alone, but if the previous 
 * exchange was "Should we use Rust or Go for the backend?", then it's
 * a decision confirmation.
 */
function enhanceWithContext(
  exchange: Exchange,
  importanceResult: ImportanceResult,
  prev?: Exchange,
  next?: Exchange
): { score: number; captureType: CaptureType; captureText: string } {
  let score = importanceResult.score;
  let captureType = importanceResult.suggestedType;
  let captureText = exchange.text;
  
  // Context boost: user confirmation after a question
  if (exchange.role === 'user' && prev?.role === 'assistant') {
    const prevLower = prev.text.toLowerCase();
    const isConfirmation = /^(yes|yeah|yep|sure|go\s+for\s+it|do\s+it|sounds\s+good|let'?s\s+do\s+it|go\s+ahead|approved?)\b/i.test(exchange.text.trim());
    const prevIsQuestion = prevLower.includes('?') || /\b(should|shall|would you|do you want)\b/.test(prevLower);
    
    if (isConfirmation && prevIsQuestion) {
      score = Math.max(score, 0.5); // Confirmation of a decision
      captureType = 'decision';
      // Include both the question and the confirmation
      const questionSnippet = prev.text.length > 100 ? prev.text.substring(0, 97) + '...' : prev.text;
      captureText = `Confirmed: ${questionSnippet} → ${exchange.text}`;
    }
  }
  
  // Context boost: assistant acted on a high-value user instruction
  if (exchange.role === 'assistant' && prev?.role === 'user') {
    const prevResult = scoreImportance(prev.text);
    if (prevResult.score >= 0.6) {
      // The assistant response to a high-value exchange might contain
      // implementation details or conclusions worth noting
      const hasActionWords = /\b(done|created|updated|deployed|configured|set up|installed|fixed|built|wrote|implemented|changed)\b/i.test(exchange.text);
      if (hasActionWords) {
        score = Math.max(score, 0.35); // Log the outcome
        captureType = 'note';
      }
    }
  }

  // Context boost: correction patterns (user says "no" then provides correct info)
  if (exchange.role === 'user' && /^(no|nah|wrong|nope|not?\s+quite)/i.test(exchange.text.trim())) {
    if (prev?.role === 'assistant') {
      score = Math.max(score, 0.6);
      captureType = 'preference';
      captureText = `Correction: ${exchange.text}`;
    }
  }
  
  return { score, captureType, captureText };
}

// ─── Capture Text Formatting ────────────────────────────────────────────────

/**
 * Format an exchange into a capture-ready string with the right prefix.
 */
function formatForCapture(text: string, captureType: CaptureType): string {
  // Don't double-prefix if already prefixed
  if (/^(DECISION|FACT|TASK|TOPIC|PERSON|QUOTE|PREFERENCE|REACTION):/i.test(text)) {
    return text;
  }
  
  const typeMap: Record<string, string> = {
    'decision': 'DECISION',
    'fact': 'FACT',
    'preference': 'PREFERENCE',
    'reaction': 'REACTION',
    'task': 'TASK',
    'quote': 'QUOTE',
    'person': 'PERSON',
    'note': '',       // Notes don't get a prefix
    'topic': '',
    'skip': '',
  };
  
  const prefix = typeMap[captureType];
  
  // Clean up the text: collapse to single line, trim
  const cleaned = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  
  // Truncate very long texts for capture (keep first 200 chars)
  const maxLen = 250;
  const truncated = cleaned.length > maxLen ? cleaned.substring(0, maxLen - 3) + '...' : cleaned;
  
  if (prefix) {
    return `${prefix}: ${truncated}`;
  }
  return truncated;
}

// ─── Scan State (incremental scanning) ──────────────────────────────────────

interface ScanState {
  lastScanTimestamp: string;
  lastSessionKey?: string;
  scannedExchangeHashes: string[];  // Simple hashes to avoid re-scanning
}

function loadScanState(): ScanState {
  try {
    if (fs.existsSync(SCAN_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(SCAN_STATE_PATH, 'utf-8'));
    }
  } catch {}
  return {
    lastScanTimestamp: new Date(0).toISOString(),
    scannedExchangeHashes: [],
  };
}

function saveScanState(state: ScanState): void {
  fs.writeFileSync(SCAN_STATE_PATH, JSON.stringify(state, null, 2));
}

function simpleHash(text: string): string {
  // Fast hash for dedup — not cryptographic
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

// ─── Core Scanner ───────────────────────────────────────────────────────────

export async function scanConversation(
  exchanges: Exchange[],
  options: Partial<ScanOptions> = {}
): Promise<ScanResult> {
  const opts: ScanOptions = {
    threshold: options.threshold ?? 0.45,
    dryRun: options.dryRun ?? false,
    userOnly: options.userOnly ?? false,
    jsonOutput: options.jsonOutput ?? false,
    contextWindow: options.contextWindow ?? 1,
  };
  
  const state = loadScanState();
  const captured: ClassifiedItem[] = [];
  let skippedLow = 0;
  let skippedDupe = 0;
  let skippedWarn = 0;
  
  // Filter by role if requested
  const toScan = opts.userOnly
    ? exchanges.filter(e => e.role === 'user')
    : exchanges;
  
  for (let i = 0; i < exchanges.length; i++) {
    const exchange = exchanges[i];
    
    // Skip if userOnly and not user
    if (opts.userOnly && exchange.role !== 'user') continue;
    
    // Skip already-scanned exchanges
    const hash = simpleHash(exchange.text);
    if (state.scannedExchangeHashes.includes(hash)) continue;
    
    // Score importance
    const importanceResult = scoreImportance(exchange.text);
    
    // Enhance with context
    const prev = i > 0 ? exchanges[i - 1] : undefined;
    const next = i < exchanges.length - 1 ? exchanges[i + 1] : undefined;
    const enhanced = enhanceWithContext(exchange, importanceResult, prev, next);
    
    // Apply threshold
    if (enhanced.score < opts.threshold) {
      skippedLow++;
      state.scannedExchangeHashes.push(hash);
      continue;
    }
    
    // Skip 'skip' type
    if (enhanced.captureType === 'skip') {
      skippedLow++;
      state.scannedExchangeHashes.push(hash);
      continue;
    }
    
    // Format capture text
    const captureText = formatForCapture(enhanced.captureText, enhanced.captureType);
    
    // Dedup check
    const dedupResult = checkDuplicate(captureText);
    let dedupStatus: ClassifiedItem['dedupStatus'] = 'new';
    
    if (dedupResult.isDuplicate) {
      skippedDupe++;
      dedupStatus = 'duplicate';
      state.scannedExchangeHashes.push(hash);
      continue; // Don't capture duplicates
    }
    
    if (dedupResult.isWarning) {
      skippedWarn++;
      dedupStatus = 'warning';
      // Still capture, but flag it
    }
    
    captured.push({
      exchange,
      score: enhanced.score,
      level: importanceResult.level,
      captureType: enhanced.captureType,
      captureText,
      signals: importanceResult.signals.filter(s => s.weight > 0).map(s => s.name),
      contextBefore: prev?.text?.substring(0, 100),
      contextAfter: next?.text?.substring(0, 100),
      dedupStatus,
    });
    
    state.scannedExchangeHashes.push(hash);
  }
  
  // Trim state to prevent unbounded growth (keep last 500 hashes)
  if (state.scannedExchangeHashes.length > 500) {
    state.scannedExchangeHashes = state.scannedExchangeHashes.slice(-500);
  }
  
  // Build capture lines
  const captureLines = captured.map(item => item.captureText);
  
  // Execute capture if not dry-run and we have items
  if (!opts.dryRun && captureLines.length > 0) {
    const captureInput = captureLines.join('\n');
    try {
      child_process.execSync(
        `echo ${JSON.stringify(captureInput)} | npx ts-node ${path.join(SKILL_DIR, 'src', 'capture.ts')}`,
        { cwd: SKILL_DIR, stdio: 'pipe', timeout: 30000 }
      );
    } catch (e) {
      console.error(`⚠️  Capture pipeline error: ${(e as Error).message}`);
    }
  }
  
  // Save state
  state.lastScanTimestamp = new Date().toISOString();
  if (!opts.dryRun) {
    saveScanState(state);
  }
  
  return {
    totalExchanges: exchanges.length,
    scanned: exchanges.length - (opts.userOnly ? exchanges.filter(e => e.role !== 'user').length : 0),
    captured,
    skippedLowScore: skippedLow,
    skippedDuplicate: skippedDupe,
    skippedWarning: skippedWarn,
    captureLines,
  };
}

// ─── Session History Reader ─────────────────────────────────────────────────

/**
 * Read session history from Clawdbot's session logs.
 * Falls back to memory/sessions/ directory if CLI not available.
 */
function readSessionLogs(): Exchange[] {
  // Try to read from session files in memory/sessions/
  const today = new Date().toISOString().split('T')[0];
  
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  
  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.startsWith(today) && f.endsWith('.md'))
    .sort();
  
  const exchanges: Exchange[] = [];
  
  for (const file of files) {
    const content = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
    exchanges.push(...parseExchanges(content));
  }
  
  return exchanges;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function printReport(result: ScanResult, opts: ScanOptions): void {
  if (opts.jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🔍 CONVERSATION SCAN RESULTS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log(`📊 Scanned: ${result.scanned}/${result.totalExchanges} exchanges`);
  console.log(`   Threshold: ${opts.threshold}`);
  console.log(`   Mode: ${opts.dryRun ? 'DRY RUN' : 'LIVE CAPTURE'}`);
  console.log('');
  
  if (result.captured.length === 0) {
    console.log('   ⬛ Nothing above threshold — conversation was routine.');
    console.log('');
  } else {
    console.log(`✅ CAPTURED (${result.captured.length} items):`);
    console.log('─────────────────────────────────────────');
    
    for (const item of result.captured) {
      const icon = levelIcon(item.level);
      const scoreBar = '█'.repeat(Math.round(item.score * 10)) + '░'.repeat(10 - Math.round(item.score * 10));
      const role = item.exchange.role === 'user' ? '👤' : '🤖';
      const dedupMark = item.dedupStatus === 'warning' ? ' ⚠️' : '';
      
      console.log(`${icon} ${scoreBar} ${item.score.toFixed(2)} ${role} [${item.captureType.toUpperCase()}]${dedupMark}`);
      
      // Show capture text (truncated)
      const preview = item.captureText.length > 80 
        ? item.captureText.substring(0, 77) + '...' 
        : item.captureText;
      console.log(`   → ${preview}`);
      
      if (item.signals.length > 0) {
        console.log(`   signals: ${item.signals.join(', ')}`);
      }
      console.log('');
    }
  }
  
  console.log('─────────────────────────────────────────');
  console.log(`📦 Summary:`);
  console.log(`   ✅ Captured:     ${result.captured.length}`);
  console.log(`   ⬛ Low score:    ${result.skippedLowScore}`);
  console.log(`   🔄 Duplicates:   ${result.skippedDuplicate}`);
  console.log(`   ⚠️  Warnings:    ${result.skippedWarning}`);
  
  if (!opts.dryRun && result.captureLines.length > 0) {
    console.log('');
    console.log('📝 Items filed via capture.ts pipeline.');
  }
  
  if (opts.dryRun && result.captureLines.length > 0) {
    console.log('');
    console.log('🔸 DRY RUN — nothing was filed. Remove --dry-run to capture.');
    console.log('');
    console.log('Would pipe to capture.ts:');
    for (const line of result.captureLines) {
      console.log(`   ${line}`);
    }
  }
}

function levelIcon(level: string): string {
  switch (level) {
    case 'skip': return '⬛';
    case 'low': return '⬜';
    case 'mid': return '🟨';
    case 'high': return '🟧';
    case 'critical': return '🟥';
    default: return '❓';
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isStdin = args.includes('--stdin');
  const isDailyMode = args.includes('--daily');
  const isDryRun = args.includes('--dry-run');
  const isJson = args.includes('--json');
  const isUserOnly = args.includes('--user-only');
  
  // Parse threshold
  let threshold = 0.45;
  const threshIdx = args.indexOf('--threshold');
  if (threshIdx !== -1 && args[threshIdx + 1]) {
    threshold = parseFloat(args[threshIdx + 1]);
  }
  
  const opts: ScanOptions = {
    threshold,
    dryRun: isDryRun,
    userOnly: isUserOnly,
    jsonOutput: isJson,
    contextWindow: 1,
  };
  
  let exchanges: Exchange[] = [];
  
  if (isStdin) {
    // Read from stdin
    const input = await new Promise<string>((resolve) => {
      let data = '';
      if (process.stdin.isTTY) {
        console.log('⌨️  Paste conversation (Ctrl+D to finish):');
      }
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { resolve(data); });
      setTimeout(() => { if (!data) resolve(''); }, 10000);
    });
    
    if (!input.trim()) {
      console.log('⚠️  No input provided.');
      process.exit(1);
    }
    
    exchanges = parseExchanges(input);
  } else if (isDailyMode) {
    exchanges = readSessionLogs();
  } else {
    // Default: try session logs, fall back to stdin hint
    exchanges = readSessionLogs();
    if (exchanges.length === 0) {
      // Try reading non-flag args as text
      const textArgs = args.filter(a => !a.startsWith('--'));
      if (textArgs.length > 0) {
        exchanges = parseExchanges(textArgs.join('\n'));
      }
    }
  }
  
  if (exchanges.length === 0) {
    console.log('⚠️  No exchanges to scan.');
    console.log('');
    console.log('Usage:');
    console.log('  echo "USER: Remember I like dark themes" | npx ts-node src/conversation-scan.ts --stdin');
    console.log('  npx ts-node src/conversation-scan.ts --daily --dry-run');
    console.log('  npx ts-node src/conversation-scan.ts --stdin --threshold 0.5 --user-only');
    process.exit(1);
  }
  
  if (!isJson) {
    console.log(`🔍 Scanning ${exchanges.length} exchanges...`);
  }
  
  const result = await scanConversation(exchanges, opts);
  printReport(result, opts);
}

// Only run CLI when executed directly
if (require.main === module) {
  main().catch(e => {
    console.error('❌ Error:', e.message);
    process.exit(1);
  });
}
