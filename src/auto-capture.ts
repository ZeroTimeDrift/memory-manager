#!/usr/bin/env npx ts-node

/**
 * Auto-Capture — Real-time conversation importance scoring & capture
 * 
 * The missing bridge between live sessions and the capture pipeline.
 * Reads recent session history via Clawdbot sessions API (or piped input),
 * scores exchanges with multi-turn context awareness, and auto-captures
 * high-value items through capture.ts.
 * 
 * Key differences from conversation-scan.ts:
 *   - Designed for incremental, real-time use (tracks watermark per session)
 *   - Multi-turn context scoring with richer patterns (agreement chains,
 *     topic shifts, question-answer pairs, instruction sequences)
 *   - Conversation-level signals (not just per-exchange)
 *   - Callable from heartbeat/cron for zero-effort memory capture
 * 
 * Usage:
 *   npx ts-node src/auto-capture.ts                          # Scan current main session
 *   npx ts-node src/auto-capture.ts --session <key>          # Scan specific session
 *   npx ts-node src/auto-capture.ts --all-active             # Scan all active sessions
 *   npx ts-node src/auto-capture.ts --stdin                  # Pipe conversation in
 *   npx ts-node src/auto-capture.ts --dry-run                # Preview without capturing
 *   npx ts-node src/auto-capture.ts --threshold 0.5          # Override min score
 *   npx ts-node src/auto-capture.ts --max-exchanges 50       # Limit how far back to look
 *   npx ts-node src/auto-capture.ts --json                   # Machine-readable output
 * 
 * Designed to be run from heartbeat or cron:
 *   Cron: "cd /root/clawd/skills/memory-manager && npx ts-node src/auto-capture.ts --all-active"
 * 
 * Programmatic:
 *   import { autoCapture, AutoCaptureResult } from './auto-capture';
 *   const result = await autoCapture({ sessionKey: 'main', threshold: 0.45 });
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { scoreImportance, type ImportanceResult, type CaptureType } from './importance';
import { checkDuplicate } from './dedup';

const WORKSPACE = '/root/clawd';
const SKILL_DIR = path.join(WORKSPACE, 'skills', 'memory-manager');
const STATE_PATH = path.join(SKILL_DIR, 'auto-capture-state.json');

// ─── Types ──────────────────────────────────────────────────────────────────

interface Exchange {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  index: number;      // Position in conversation
  timestamp?: string;
}

interface ContextWindow {
  before: Exchange[];  // Previous N exchanges
  after: Exchange[];   // Next N exchanges (if available)
  topic?: string;      // Inferred conversation topic
}

interface ScoredExchange {
  exchange: Exchange;
  baseScore: number;         // Raw importance.ts score
  contextBoost: number;      // Additional score from multi-turn context
  finalScore: number;        // baseScore + contextBoost, clamped [0,1]
  captureType: CaptureType;
  captureText: string;       // Formatted for capture.ts pipeline
  signals: string[];         // What triggered the score
  contextSignals: string[];  // Multi-turn signals that contributed
  dedupStatus: 'new' | 'warning' | 'duplicate';
}

export interface AutoCaptureResult {
  sessionKey: string;
  exchangesScanned: number;
  exchangesNew: number;       // Not seen in previous scans
  captured: ScoredExchange[];
  skipped: {
    lowScore: number;
    duplicate: number;
    alreadyScanned: number;
  };
  captureLines: string[];
  conversationSignals: ConversationSignal[];  // Session-level patterns
}

interface ConversationSignal {
  name: string;
  description: string;
  affectedExchanges: number[];
  boost: number;
}

// ─── State Management ───────────────────────────────────────────────────────

interface AutoCaptureState {
  sessions: Record<string, SessionWatermark>;
  lastRun: string;
  totalCaptured: number;
}

interface SessionWatermark {
  lastIndex: number;           // Index of last scanned exchange
  lastTimestamp: string;       // Timestamp of last scan
  recentHashes: string[];     // Hashes of recently scored exchanges (ring buffer, max 200)
}

function loadState(): AutoCaptureState {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    }
  } catch {}
  return { sessions: {}, lastRun: new Date(0).toISOString(), totalCaptured: 0 };
}

function saveState(state: AutoCaptureState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function quickHash(text: string): string {
  let h = 0;
  for (let i = 0; i < Math.min(text.length, 200); i++) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

// ─── Session History Reader ─────────────────────────────────────────────────

/**
 * Read session history from Clawdbot's session_history CLI.
 * Returns exchanges in chronological order.
 */
function readSessionHistory(sessionKey: string, limit: number = 80): Exchange[] {
  try {
    // Use clawdbot CLI to get session history as JSON
    const result = child_process.execSync(
      `clawdbot session history ${sessionKey} --limit ${limit} --json 2>/dev/null`,
      { timeout: 15000, encoding: 'utf-8' }
    );
    
    const messages = JSON.parse(result);
    return messages
      .filter((m: any) => m.role && m.content)
      .map((m: any, i: number) => ({
        role: normalizeRole(m.role),
        text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        index: i,
        timestamp: m.timestamp,
      }))
      .filter((e: Exchange) => e.text.length > 0 && e.text.length < 5000); // Skip huge tool outputs
  } catch {
    // Fallback: try reading daily files for session content
    return [];
  }
}

/**
 * List active sessions from Clawdbot.
 */
function listActiveSessions(): string[] {
  try {
    const result = child_process.execSync(
      'clawdbot session list --active --json 2>/dev/null',
      { timeout: 10000, encoding: 'utf-8' }
    );
    const sessions = JSON.parse(result);
    return sessions.map((s: any) => s.key || s.sessionKey).filter(Boolean);
  } catch {
    return ['main']; // Default to main session
  }
}

function normalizeRole(role: string): Exchange['role'] {
  const lower = (role || '').toLowerCase();
  if (['user', 'human'].includes(lower)) return 'user';
  if (['assistant', 'ai'].includes(lower)) return 'assistant';
  if (lower === 'system') return 'system';
  if (lower === 'tool') return 'tool';
  return 'assistant';
}

// ─── Multi-Turn Context Scoring ─────────────────────────────────────────────

/**
 * Score an exchange considering its multi-turn context.
 * This is the core improvement over single-exchange scoring.
 * 
 * Patterns detected:
 * 1. Decision confirmation chains: Q → A → "yes/go ahead" 
 * 2. Correction sequences: assistant says X → user says "no, actually Y"
 * 3. Topic introductions: new subject not in previous N exchanges
 * 4. Instruction sequences: user gives multi-step directions
 * 5. Emotional escalation: increasing sentiment intensity
 * 6. Information density: user provides many facts in sequence
 * 7. Preference revelation: user reacts to assistant suggestions
 * 8. Knowledge transfer: user shares domain knowledge
 */
function scoreWithContext(
  exchange: Exchange,
  context: ContextWindow,
  baseResult: ImportanceResult
): { boost: number; contextSignals: string[]; captureType: CaptureType; captureText: string } {
  
  let boost = 0;
  const contextSignals: string[] = [];
  let captureType = baseResult.suggestedType;
  let captureText = exchange.text;
  
  const prevExchanges = context.before;
  const prevUser = prevExchanges.filter(e => e.role === 'user');
  const prevAssistant = prevExchanges.filter(e => e.role === 'assistant');
  const immediatePrev = prevExchanges.length > 0 ? prevExchanges[prevExchanges.length - 1] : null;
  
  const textLower = exchange.text.toLowerCase().trim();
  
  // ─── Pattern 1: Decision Confirmation Chain ───
  // User confirms something the assistant proposed or asked about
  if (exchange.role === 'user' && immediatePrev?.role === 'assistant') {
    const isConfirmation = /^(yes|yeah|yep|sure|do it|go for it|go ahead|approved?|let'?s do (it|that)|sounds good|perfect|that works|exactly|correct)\b/i.test(textLower);
    const prevHasQuestion = immediatePrev.text.includes('?') || 
      /\b(should|shall|would you like|want me to|do you want|option|recommend|suggest)\b/i.test(immediatePrev.text.toLowerCase());
    const prevHasProposal = /\b(I (could|can|would|will|suggest|recommend|'ll)|option\s*\d|approach|we could|how about|the plan|target|going to)\b/i.test(immediatePrev.text.toLowerCase());
    
    if (isConfirmation && (prevHasQuestion || prevHasProposal)) {
      boost += 0.35;
      captureType = 'decision';
      contextSignals.push('decision-confirmation');
      
      // Extract what was decided — look at the assistant's proposal,
      // but also check the user's preceding instruction (the thing being confirmed)
      const proposalSnippet = extractProposal(immediatePrev.text);
      
      // Also look further back: if user gave instructions before assistant echoed/asked
      const userBefore = prevExchanges.filter(e => e.role === 'user').slice(-1)[0];
      const userInstruction = userBefore && userBefore !== exchange
        ? extractProposal(userBefore.text) || userBefore.text.substring(0, 150)
        : null;
      
      if (userInstruction && userInstruction.length > (proposalSnippet?.length || 0)) {
        // The user's own instruction is richer context than the assistant's echo
        captureText = `Decided: ${userInstruction} (confirmed)`;
      } else if (proposalSnippet) {
        captureText = `Decided: ${proposalSnippet} (confirmed by user)`;
      } else {
        captureText = `Confirmed: ${immediatePrev.text.substring(0, 150)}`;
      }
    }
  }
  
  // ─── Pattern 2: Correction Sequence ───
  // User corrects or redirects the assistant
  if (exchange.role === 'user' && immediatePrev?.role === 'assistant') {
    const isCorrecting = /^(no[,.\s]|nah|wrong|not?\s+(quite|exactly|what|like)|actually[,\s]|that'?s\s+(not|wrong)|I\s+(said|meant|want)|stop|don'?t)\b/i.test(textLower);
    
    if (isCorrecting && exchange.text.length > 15) {
      boost += 0.3;
      captureType = 'preference';
      contextSignals.push('correction-sequence');
      captureText = `Correction: ${exchange.text}`;
    }
  }
  
  // ─── Pattern 3: Topic Introduction ───
  // User introduces something completely new
  if (exchange.role === 'user' && exchange.text.length > 30) {
    const recentTopicWords = new Set(
      prevExchanges
        .slice(-6)
        .flatMap(e => extractContentWords(e.text))
    );
    
    const currentWords = extractContentWords(exchange.text);
    const newWords = currentWords.filter(w => !recentTopicWords.has(w));
    const noveltyRatio = currentWords.length > 0 ? newWords.length / currentWords.length : 0;
    
    if (noveltyRatio > 0.6 && currentWords.length >= 5) {
      boost += 0.15;
      contextSignals.push('topic-introduction');
    }
  }
  
  // ─── Pattern 4: Multi-Step Instructions ───
  // User gives a sequence of instructions
  if (exchange.role === 'user') {
    const hasNumberedSteps = /\b(\d+[\.\)]\s|\bfirst\b.*\bthen\b|\bstep\s+\d)/i.test(exchange.text);
    const hasMultipleImperatives = (exchange.text.match(/\b(do|make|create|build|add|remove|change|update|set|configure|use|run|deploy|write|check|fix)\b/gi) || []).length >= 3;
    
    if (hasNumberedSteps || hasMultipleImperatives) {
      boost += 0.2;
      captureType = 'note';
      contextSignals.push('multi-step-instruction');
    }
  }
  
  // ─── Pattern 5: Emotional Escalation ───
  // Sentiment intensity increases over recent exchanges
  if (exchange.role === 'user') {
    const emotionIntensity = countEmotionSignals(exchange.text);
    const prevEmotionAvg = prevUser.length > 0 
      ? prevUser.reduce((sum, e) => sum + countEmotionSignals(e.text), 0) / prevUser.length
      : 0;
    
    if (emotionIntensity > prevEmotionAvg + 1 && emotionIntensity >= 2) {
      boost += 0.2;
      captureType = emotionIntensity >= 3 ? 'reaction' : captureType;
      contextSignals.push('emotional-escalation');
    }
  }
  
  // ─── Pattern 6: Information Density ───
  // User provides multiple facts in rapid succession
  if (exchange.role === 'user') {
    const recentUserExchanges = prevUser.slice(-3);
    const recentHighInfoCount = recentUserExchanges.filter(e => {
      const r = scoreImportance(e.text);
      return r.score >= 0.4;
    }).length;
    
    if (recentHighInfoCount >= 2 && baseResult.score >= 0.3) {
      boost += 0.1;
      contextSignals.push('info-density-burst');
    }
  }
  
  // ─── Pattern 7: Preference Revelation via Reaction ───
  // User reacts to what assistant showed/did
  if (exchange.role === 'user' && immediatePrev?.role === 'assistant') {
    const prevDidSomething = /\b(here'?s|done|created|I'?ve|updated|built|set up|configured|looks like)\b/i.test(immediatePrev.text.toLowerCase());
    const userReacts = /\b(love|hate|like|prefer|perfect|ugly|clean|messy|nice|terrible|great|awful|beautiful|horrible|good|bad|better|worse)\b/i.test(textLower);
    
    if (prevDidSomething && userReacts) {
      boost += 0.2;
      captureType = 'preference';
      contextSignals.push('preference-via-reaction');
    }
  }
  
  // ─── Pattern 8: Knowledge Transfer ───
  // User shares domain knowledge or explains something
  if (exchange.role === 'user' && exchange.text.length > 80) {
    const isExplaining = /\b(the way it works|basically|the thing is|here'?s (the|how)|so what happens|the reason|because|it turns out|fun fact|did you know)\b/i.test(exchange.text);
    const hasSpecificKnowledge = /\b(API|SDK|protocol|algorithm|framework|architecture|database|network|blockchain|contract|wallet|token|key|endpoint|webhook|schema)\b/i.test(exchange.text);
    
    if (isExplaining && hasSpecificKnowledge) {
      boost += 0.2;
      captureType = 'fact';
      contextSignals.push('knowledge-transfer');
    }
  }
  
  // ─── Pattern 9: Name/Contact Introduction ───
  // User mentions a new person with context (but don't override higher-priority types)
  if (exchange.role === 'user' && !contextSignals.includes('decision-confirmation') && !contextSignals.includes('correction-sequence')) {
    const nameIntro = exchange.text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b.*?\b(is|works|from|at|runs|manages|handles|leads|joined)\b/i);
    if (nameIntro && !isCommonPhrase(nameIntro[1])) {
      boost += 0.25;
      captureType = 'person';
      contextSignals.push('contact-introduction');
    }
  }
  
  // ─── Pattern 10: Summary/Wrap-up Statements ───
  // User or assistant summarizes conclusions
  if (/\b(so (basically|in summary|to summarize|to wrap up)|the (takeaway|conclusion|bottom line|key point)|in short|tl;?dr|long story short)\b/i.test(exchange.text)) {
    boost += 0.2;
    captureType = exchange.text.length > 100 ? 'note' : captureType;
    contextSignals.push('summary-statement');
  }
  
  return { boost, contextSignals, captureType, captureText };
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Extract the core proposal/suggestion from an assistant message.
 */
function extractProposal(text: string): string | null {
  // Try to find the key proposal sentence
  const sentences = text.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length > 10);
  
  for (const sentence of sentences) {
    if (/\b(I (suggest|recommend|think)|we (should|could)|how about|option|approach|let'?s)\b/i.test(sentence)) {
      return sentence.length > 150 ? sentence.substring(0, 147) + '...' : sentence;
    }
  }
  
  // If no clear proposal sentence, take the first substantial sentence
  const substantial = sentences.find(s => s.length > 20 && s.length < 200);
  return substantial || null;
}

/**
 * Extract meaningful content words (nouns, verbs, adjectives) for topic analysis.
 */
function extractContentWords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between', 'under',
    'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
    'so', 'than', 'too', 'very', 'just', 'don', 'now', 'and', 'but', 'or',
    'if', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
    'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they',
    'them', 'their', 'what', 'which', 'who', 'whom', 'ok', 'okay', 'yeah',
    'yes', 'sure', 'like', 'think', 'know', 'want', 'need', 'get', 'got',
    'let', 'make', 'go', 'going', 'also', 'well', 'back', 'even', 'still',
  ]);
  
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

/**
 * Count emotional signal words in text.
 */
function countEmotionSignals(text: string): number {
  const lower = text.toLowerCase();
  const emotionWords = [
    'frustrated', 'annoyed', 'angry', 'pissed', 'irritated',
    'excited', 'happy', 'thrilled', 'amazing', 'awesome',
    'worried', 'concerned', 'anxious', 'nervous', 'scared',
    'love', 'hate', 'dislike', 'terrible', 'horrible',
    'perfect', 'beautiful', 'awful', 'disgusting', 'brilliant',
    '!', '!!', '!!!', '???',
  ];
  
  let count = 0;
  for (const word of emotionWords) {
    if (lower.includes(word)) count++;
  }
  
  // Exclamation mark density
  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations >= 2) count += 1;
  if (exclamations >= 4) count += 1;
  
  // ALL CAPS words (3+ chars)
  const capsWords = (text.match(/\b[A-Z]{3,}\b/g) || []).length;
  if (capsWords >= 2) count += 1;
  
  return count;
}

/**
 * Check if a capitalized phrase is a common English phrase (not a name).
 */
function isCommonPhrase(phrase: string): boolean {
  const common = new Set([
    'The Way', 'The Thing', 'The Plan', 'New York', 'The Point',
    'First Step', 'Next Steps', 'Good Morning', 'Let Me', 'Thank You',
    'Quick Reference', 'For Example', 'In Summary', 'By The Way',
  ]);
  return common.has(phrase);
}

// ─── Capture Pipeline ───────────────────────────────────────────────────────

/**
 * Format scored exchanges into capture.ts-compatible lines.
 */
function formatCaptureLine(scored: ScoredExchange): string {
  const text = scored.captureText
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Max 300 chars for a capture line
  const truncated = text.length > 300 ? text.substring(0, 297) + '...' : text;
  
  // Add type prefix if not already present
  if (/^(DECISION|FACT|TASK|TOPIC|PERSON|QUOTE|PREFERENCE|REACTION):/i.test(truncated)) {
    return truncated;
  }
  
  const prefixMap: Record<string, string> = {
    'decision': 'DECISION',
    'fact': 'FACT',
    'preference': 'PREFERENCE',
    'reaction': 'REACTION',
    'task': 'TASK',
    'quote': 'QUOTE',
    'person': 'PERSON',
  };
  
  const prefix = prefixMap[scored.captureType];
  if (prefix) {
    return `${prefix}: ${truncated}`;
  }
  return truncated;
}

/**
 * Pipe capture lines through capture.ts for filing.
 */
function executeCapture(lines: string[]): boolean {
  if (lines.length === 0) return true;
  
  const input = lines.join('\n');
  try {
    child_process.execSync(
      `echo ${JSON.stringify(input)} | npx ts-node ${path.join(SKILL_DIR, 'src', 'capture.ts')}`,
      { cwd: SKILL_DIR, stdio: 'pipe', timeout: 30000 }
    );
    return true;
  } catch (e) {
    console.error(`⚠️  Capture pipeline error: ${(e as Error).message}`);
    return false;
  }
}

// ─── Conversation-Level Signals ─────────────────────────────────────────────

/**
 * Detect conversation-level patterns that affect scoring globally.
 * These patterns span multiple exchanges and can boost or suppress scores.
 */
function detectConversationSignals(exchanges: Exchange[]): ConversationSignal[] {
  const signals: ConversationSignal[] = [];
  
  // Signal: Planning session (multiple decisions/instructions)
  const decisionExchanges: number[] = [];
  for (let i = 0; i < exchanges.length; i++) {
    if (exchanges[i].role === 'user') {
      const r = scoreImportance(exchanges[i].text);
      if (r.suggestedType === 'decision' || r.signals.some(s => s.name === 'decision')) {
        decisionExchanges.push(i);
      }
    }
  }
  if (decisionExchanges.length >= 3) {
    signals.push({
      name: 'planning-session',
      description: `Multiple decisions detected (${decisionExchanges.length}) — planning session`,
      affectedExchanges: decisionExchanges,
      boost: 0.1,
    });
  }
  
  // Signal: Onboarding/knowledge dump (user sharing lots of context)
  const longUserExchanges = exchanges
    .filter(e => e.role === 'user' && e.text.length > 100)
    .map(e => e.index);
  if (longUserExchanges.length >= 4) {
    signals.push({
      name: 'knowledge-dump',
      description: 'User sharing extensive context — possible onboarding/briefing',
      affectedExchanges: longUserExchanges,
      boost: 0.1,
    });
  }
  
  // Signal: Debugging session (error messages, stack traces, "fix" language)
  const debugExchanges: number[] = [];
  for (let i = 0; i < exchanges.length; i++) {
    const lower = exchanges[i].text.toLowerCase();
    if (/\b(error|bug|fix|broken|crash|fail|stack\s*trace|exception|undefined|null\b.*\bnot)/i.test(lower)) {
      debugExchanges.push(i);
    }
  }
  if (debugExchanges.length >= 3) {
    signals.push({
      name: 'debugging-session',
      description: 'Debugging conversation — outcomes may be worth capturing',
      affectedExchanges: debugExchanges,
      boost: 0.05,  // Small boost — only capture if resolution found
    });
  }
  
  return signals;
}

// ─── Core Auto-Capture ─────────────────────────────────────────────────────

interface AutoCaptureOptions {
  sessionKey?: string;
  threshold?: number;
  dryRun?: boolean;
  maxExchanges?: number;
  jsonOutput?: boolean;
}

export async function autoCapture(options: AutoCaptureOptions = {}): Promise<AutoCaptureResult> {
  const sessionKey = options.sessionKey || 'main';
  const threshold = options.threshold ?? 0.45;
  const dryRun = options.dryRun ?? false;
  const maxExchanges = options.maxExchanges ?? 80;
  
  // Load state
  const state = loadState();
  const watermark = state.sessions[sessionKey] || {
    lastIndex: 0,
    lastTimestamp: new Date(0).toISOString(),
    recentHashes: [],
  };
  
  // Read session history
  const allExchanges = readSessionHistory(sessionKey, maxExchanges);
  
  if (allExchanges.length === 0) {
    return {
      sessionKey,
      exchangesScanned: 0,
      exchangesNew: 0,
      captured: [],
      skipped: { lowScore: 0, duplicate: 0, alreadyScanned: 0 },
      captureLines: [],
      conversationSignals: [],
    };
  }
  
  // Determine new exchanges (not yet scanned)
  const hashSet = new Set(watermark.recentHashes);
  const newExchanges: Exchange[] = [];
  let alreadyScanned = 0;
  
  for (const exchange of allExchanges) {
    const hash = quickHash(exchange.text);
    if (hashSet.has(hash)) {
      alreadyScanned++;
      continue;
    }
    newExchanges.push(exchange);
  }
  
  // Detect conversation-level signals
  const convSignals = detectConversationSignals(allExchanges);
  const convBoostMap = new Map<number, number>();
  for (const sig of convSignals) {
    for (const idx of sig.affectedExchanges) {
      convBoostMap.set(idx, (convBoostMap.get(idx) || 0) + sig.boost);
    }
  }
  
  // Score new exchanges
  const captured: ScoredExchange[] = [];
  let skippedLow = 0;
  let skippedDupe = 0;
  
  for (const exchange of newExchanges) {
    // Skip system messages and very short tool outputs
    if (exchange.role === 'system' || exchange.role === 'tool') continue;
    if (exchange.text.length < 10) continue;
    
    // Base score
    const baseResult = scoreImportance(exchange.text);
    
    // Build context window
    const contextBefore = allExchanges
      .filter(e => e.index < exchange.index)
      .slice(-3);
    const contextAfter = allExchanges
      .filter(e => e.index > exchange.index)
      .slice(0, 1);
    
    const context: ContextWindow = {
      before: contextBefore,
      after: contextAfter,
    };
    
    // Multi-turn context scoring
    const contextResult = scoreWithContext(exchange, context, baseResult);
    
    // Add conversation-level boost
    const convBoost = convBoostMap.get(exchange.index) || 0;
    
    // Compute final score
    const finalScore = Math.min(1, baseResult.score + contextResult.boost + convBoost);
    
    // Apply threshold
    if (finalScore < threshold) {
      skippedLow++;
      // Still track hash to avoid re-scoring
      watermark.recentHashes.push(quickHash(exchange.text));
      continue;
    }
    
    // Skip 'skip' type unless contextually upgraded
    if (contextResult.captureType === 'skip' && contextResult.boost === 0) {
      skippedLow++;
      watermark.recentHashes.push(quickHash(exchange.text));
      continue;
    }
    
    // Dedup check
    const dedupResult = checkDuplicate(contextResult.captureText);
    let dedupStatus: ScoredExchange['dedupStatus'] = 'new';
    
    if (dedupResult.isDuplicate) {
      skippedDupe++;
      watermark.recentHashes.push(quickHash(exchange.text));
      continue;
    }
    if (dedupResult.isWarning) {
      dedupStatus = 'warning';
    }
    
    const scored: ScoredExchange = {
      exchange,
      baseScore: baseResult.score,
      contextBoost: contextResult.boost + convBoost,
      finalScore,
      captureType: contextResult.captureType,
      captureText: contextResult.captureText,
      signals: baseResult.signals.filter(s => s.weight > 0).map(s => s.name),
      contextSignals: contextResult.contextSignals,
      dedupStatus,
    };
    
    captured.push(scored);
    watermark.recentHashes.push(quickHash(exchange.text));
  }
  
  // Trim hash ring buffer
  if (watermark.recentHashes.length > 200) {
    watermark.recentHashes = watermark.recentHashes.slice(-200);
  }
  
  // Build capture lines
  const captureLines = captured.map(formatCaptureLine);
  
  // Execute capture pipeline
  if (!dryRun && captureLines.length > 0) {
    executeCapture(captureLines);
  }
  
  // Update state
  if (!dryRun) {
    watermark.lastIndex = allExchanges.length - 1;
    watermark.lastTimestamp = new Date().toISOString();
    state.sessions[sessionKey] = watermark;
    state.lastRun = new Date().toISOString();
    state.totalCaptured += captured.length;
    saveState(state);
  }
  
  return {
    sessionKey,
    exchangesScanned: allExchanges.length,
    exchangesNew: newExchanges.length,
    captured,
    skipped: {
      lowScore: skippedLow,
      duplicate: skippedDupe,
      alreadyScanned,
    },
    captureLines,
    conversationSignals: convSignals,
  };
}

// ─── Stdin Mode ─────────────────────────────────────────────────────────────

function parseStdinExchanges(raw: string): Exchange[] {
  const lines = raw.trim().split('\n');
  const exchanges: Exchange[] = [];
  let currentRole: Exchange['role'] = 'user';
  let currentText: string[] = [];
  let index = 0;
  
  for (const line of lines) {
    const userMatch = line.match(/^(USER|Human|Hevar|>)\s*:\s*(.*)/i);
    const assistantMatch = line.match(/^(ASSISTANT|Claude|Prometheus|AI|Bot)\s*:\s*(.*)/i);
    
    if (userMatch) {
      if (currentText.length > 0) {
        exchanges.push({ role: currentRole, text: currentText.join('\n').trim(), index: index++ });
      }
      currentRole = 'user';
      currentText = [userMatch[2]];
    } else if (assistantMatch) {
      if (currentText.length > 0) {
        exchanges.push({ role: currentRole, text: currentText.join('\n').trim(), index: index++ });
      }
      currentRole = 'assistant';
      currentText = [assistantMatch[2]];
    } else if (line.trim()) {
      currentText.push(line);
    }
  }
  
  if (currentText.length > 0) {
    exchanges.push({ role: currentRole, text: currentText.join('\n').trim(), index: index++ });
  }
  
  return exchanges.filter(e => e.text.length > 0);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function printReport(result: AutoCaptureResult, dryRun: boolean): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('     🔍 AUTO-CAPTURE RESULTS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log(`📡 Session: ${result.sessionKey}`);
  console.log(`📊 Exchanges: ${result.exchangesScanned} total, ${result.exchangesNew} new`);
  console.log(`   Mode: ${dryRun ? '🔸 DRY RUN' : '🟢 LIVE'}`);
  
  if (result.conversationSignals.length > 0) {
    console.log('');
    console.log('🔮 Conversation signals:');
    for (const sig of result.conversationSignals) {
      console.log(`   • ${sig.name}: ${sig.description}`);
    }
  }
  
  console.log('');
  
  if (result.captured.length === 0) {
    console.log('   ⬛ No items above threshold. Conversation was routine.');
  } else {
    console.log(`✅ CAPTURED (${result.captured.length} items):`);
    console.log('─────────────────────────────────────────');
    
    for (const item of result.captured) {
      const bar = '█'.repeat(Math.round(item.finalScore * 10)) + '░'.repeat(10 - Math.round(item.finalScore * 10));
      const role = item.exchange.role === 'user' ? '👤' : '🤖';
      const typeLabel = item.captureType.toUpperCase();
      const dedupMark = item.dedupStatus === 'warning' ? ' ⚠️' : '';
      const ctxMark = item.contextBoost > 0 ? ` (+${item.contextBoost.toFixed(2)} ctx)` : '';
      
      console.log(`${bar} ${item.finalScore.toFixed(2)} ${role} [${typeLabel}]${ctxMark}${dedupMark}`);
      
      const preview = item.captureText.length > 80
        ? item.captureText.substring(0, 77) + '...'
        : item.captureText;
      console.log(`   → ${preview}`);
      
      const allSignals = [...item.signals, ...item.contextSignals].filter(Boolean);
      if (allSignals.length > 0) {
        console.log(`   signals: ${allSignals.join(', ')}`);
      }
      console.log('');
    }
  }
  
  console.log('─────────────────────────────────────────');
  console.log(`📦 Summary:`);
  console.log(`   ✅ Captured:        ${result.captured.length}`);
  console.log(`   ⬛ Below threshold: ${result.skipped.lowScore}`);
  console.log(`   🔄 Duplicates:      ${result.skipped.duplicate}`);
  console.log(`   ⏭️  Already scanned: ${result.skipped.alreadyScanned}`);
  
  if (dryRun && result.captureLines.length > 0) {
    console.log('');
    console.log('🔸 DRY RUN — nothing filed. Remove --dry-run to capture.');
    console.log('');
    console.log('Would capture:');
    for (const line of result.captureLines) {
      console.log(`   ${line}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  const isStdin = args.includes('--stdin');
  const isDryRun = args.includes('--dry-run');
  const isJson = args.includes('--json');
  const isAllActive = args.includes('--all-active');
  
  // Parse threshold
  let threshold = 0.45;
  const threshIdx = args.indexOf('--threshold');
  if (threshIdx !== -1 && args[threshIdx + 1]) {
    threshold = parseFloat(args[threshIdx + 1]);
  }
  
  // Parse max exchanges
  let maxExchanges = 80;
  const maxIdx = args.indexOf('--max-exchanges');
  if (maxIdx !== -1 && args[maxIdx + 1]) {
    maxExchanges = parseInt(args[maxIdx + 1], 10);
  }
  
  // Parse session key
  let sessionKey = 'main';
  const sessIdx = args.indexOf('--session');
  if (sessIdx !== -1 && args[sessIdx + 1]) {
    sessionKey = args[sessIdx + 1];
  }
  
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
    
    const exchanges = parseStdinExchanges(input);
    
    // Use scanConversation-like flow but with our enhanced scoring
    const state = loadState();
    const captured: ScoredExchange[] = [];
    const convSignals = detectConversationSignals(exchanges);
    const convBoostMap = new Map<number, number>();
    for (const sig of convSignals) {
      for (const idx of sig.affectedExchanges) {
        convBoostMap.set(idx, (convBoostMap.get(idx) || 0) + sig.boost);
      }
    }
    
    let skippedLow = 0;
    let skippedDupe = 0;
    
    for (const exchange of exchanges) {
      if (exchange.role === 'system' || exchange.role === 'tool') continue;
      if (exchange.text.length < 10) continue;
      
      const baseResult = scoreImportance(exchange.text);
      const contextBefore = exchanges.filter(e => e.index < exchange.index).slice(-3);
      const contextAfter = exchanges.filter(e => e.index > exchange.index).slice(0, 1);
      const contextResult = scoreWithContext(exchange, { before: contextBefore, after: contextAfter }, baseResult);
      const convBoost = convBoostMap.get(exchange.index) || 0;
      const finalScore = Math.min(1, baseResult.score + contextResult.boost + convBoost);
      
      if (finalScore < threshold) { skippedLow++; continue; }
      if (contextResult.captureType === 'skip') { skippedLow++; continue; }
      
      const dedupResult = checkDuplicate(contextResult.captureText);
      if (dedupResult.isDuplicate) { skippedDupe++; continue; }
      
      captured.push({
        exchange,
        baseScore: baseResult.score,
        contextBoost: contextResult.boost + convBoost,
        finalScore,
        captureType: contextResult.captureType,
        captureText: contextResult.captureText,
        signals: baseResult.signals.filter(s => s.weight > 0).map(s => s.name),
        contextSignals: contextResult.contextSignals,
        dedupStatus: dedupResult.isWarning ? 'warning' : 'new',
      });
    }
    
    const captureLines = captured.map(formatCaptureLine);
    if (!isDryRun && captureLines.length > 0) executeCapture(captureLines);
    
    const result: AutoCaptureResult = {
      sessionKey: 'stdin',
      exchangesScanned: exchanges.length,
      exchangesNew: exchanges.length,
      captured,
      skipped: { lowScore: skippedLow, duplicate: skippedDupe, alreadyScanned: 0 },
      captureLines,
      conversationSignals: convSignals,
    };
    
    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result, isDryRun);
    }
    return;
  }
  
  if (isAllActive) {
    // Scan all active sessions
    const sessions = listActiveSessions();
    if (!isJson) {
      console.log(`🔍 Scanning ${sessions.length} active session(s)...`);
    }
    
    const allResults: AutoCaptureResult[] = [];
    for (const key of sessions) {
      const result = await autoCapture({
        sessionKey: key,
        threshold,
        dryRun: isDryRun,
        maxExchanges,
      });
      allResults.push(result);
      if (!isJson) printReport(result, isDryRun);
    }
    
    if (isJson) {
      console.log(JSON.stringify(allResults, null, 2));
    }
    return;
  }
  
  // Single session scan
  const result = await autoCapture({
    sessionKey,
    threshold,
    dryRun: isDryRun,
    maxExchanges,
  });
  
  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result, isDryRun);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('❌ Error:', e.message);
    process.exit(1);
  });
}
