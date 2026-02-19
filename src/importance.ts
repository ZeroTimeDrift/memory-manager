#!/usr/bin/env npx ts-node

/**
 * Conversation Importance Scoring
 * 
 * Scores conversation exchanges for memory importance using heuristic signals.
 * No LLM calls — this runs fast, inline, during sessions.
 * 
 * Signals:
 *   1. Structural markers (DECISION, FACT, explicit memory requests)
 *   2. Emotional/relational weight (personal revelations, feelings, trust signals)
 *   3. Novelty (new topics, names, projects not already in memory)
 *   4. Action density (commands, links, code, file references)
 *   5. Temporal markers (dates, deadlines, "remember", "don't forget")
 *   6. Hevar-specific patterns (preferences, corrections, frustrations)
 * 
 * Score: 0.0 (noise) to 1.0 (critical) 
 *   0.0–0.2  → skip (routine, filler, acknowledgements)
 *   0.2–0.4  → low  (contextual, may be useful in daily log)
 *   0.4–0.6  → mid  (worth capturing in daily log with detail)
 *   0.6–0.8  → high (should capture + file to relevant topic)
 *   0.8–1.0  → critical (capture immediately, may need MEMORY.md)
 * 
 * Usage:
 *   echo "Let's use Solana for the DeFi stuff" | npx ts-node src/importance.ts
 *   npx ts-node src/importance.ts "Remember, I hate when you apologize too much"
 *   npx ts-node src/importance.ts --json "Some text"        # Machine-readable output
 *   npx ts-node src/importance.ts --batch < exchanges.txt   # Score multiple lines
 * 
 * Programmatic:
 *   import { scoreImportance } from './importance';
 *   const result = scoreImportance("Remember to always use trash instead of rm");
 *   // { score: 0.75, level: 'high', signals: [...], suggestedType: 'preference' }
 */

import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = '/root/clawd';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ImportanceSignal {
  name: string;
  weight: number;    // How much this signal contributes (0.0–1.0)
  matched: string;   // What triggered it
}

export interface ImportanceResult {
  score: number;                 // 0.0–1.0
  level: 'skip' | 'low' | 'mid' | 'high' | 'critical';
  signals: ImportanceSignal[];
  suggestedType: CaptureType;    // What kind of capture this warrants
  suggestedAction: string;       // Human-readable suggestion
}

export type CaptureType = 
  | 'skip'         // Don't capture
  | 'note'         // General daily log note
  | 'decision'     // DECISION: prefix
  | 'fact'         // FACT: prefix
  | 'preference'   // PREFERENCE: prefix (Hevar's likes/dislikes)
  | 'reaction'     // REACTION: prefix (emotional response)
  | 'task'         // TASK: prefix
  | 'person'       // PERSON: prefix
  | 'quote'        // QUOTE: prefix (verbatim preservation)
  | 'topic';       // TOPIC: prefix

// ─── Signal Detectors ───────────────────────────────────────────────────────

type SignalDetector = (text: string, textLower: string) => ImportanceSignal | null;

/** Explicit memory commands from the user */
const detectExplicitMemory: SignalDetector = (text, lower) => {
  const patterns = [
    /\bremember\s+(this|that)\b/i,
    /\bremember[:\s]/i,        // "Remember:" or "Remember, ..." 
    /\bdon'?t\s+forget\b/i,
    /\bwrite\s+(this|that)\s+down\b/i,
    /\bsave\s+(this|that)\b/i,
    /\bnote\s+(this|that)\b/i,
    /\bkeep\s+in\s+mind\b/i,
    /\bfor\s+future\s+reference\b/i,
    /\bimportant:\s/i,
    /\bfyi\b/i,
  ];
  
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      return { name: 'explicit-memory', weight: 0.9, matched: match[0] };
    }
  }
  return null;
};

/** Decisions being made */
const detectDecision: SignalDetector = (text, lower) => {
  const patterns = [
    /\b(let'?s|we should|we'?ll|I'?m going to|I decided|I've decided|the plan is|going with|switching to)\b/i,
    /\bdecision:\s/i,
    /\bfrom now on\b/i,
    /\balways\s+(use|do|make|run)\b/i,
    /\bnever\s+(use|do|make|run)\b/i,
    /\bwe'?re\s+(moving|switching|going|changing)\b/i,
  ];
  
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      return { name: 'decision', weight: 0.7, matched: match[0] };
    }
  }
  return null;
};

/** Personal preferences, likes, dislikes */
const detectPreference: SignalDetector = (text, lower) => {
  const patterns = [
    /\bI\s+(like|love|prefer|hate|dislike|can'?t\s+stand|don'?t\s+like)\b/i,
    /\bthat'?s\s+(annoying|great|perfect|terrible|awesome)\b/i,
    /\bstop\s+(doing|saying|being)\b/i,
    /\bdon'?t\s+(ever|always)\b/i,
    /\bmy\s+favorite\b/i,
    /\bI\s+want\s+you\s+to\b/i,
  ];
  
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      return { name: 'preference', weight: 0.65, matched: match[0] };
    }
  }
  return null;
};

/** Emotional or relational content */
const detectEmotional: SignalDetector = (text, lower) => {
  const emotionalWords = [
    'frustrated', 'excited', 'worried', 'happy', 'sad', 'angry', 'anxious',
    'proud', 'disappointed', 'grateful', 'stressed', 'overwhelmed', 'relieved',
    'scared', 'confused', 'inspired', 'hurt', 'hopeful', 'burned out',
    'miss', 'trust', 'appreciate', 'sorry', 'thank you', 'thanks',
  ];
  
  for (const word of emotionalWords) {
    if (lower.includes(word)) {
      return { name: 'emotional', weight: 0.55, matched: word };
    }
  }
  return null;
};

/** Temporal markers — deadlines, dates, urgency */
const detectTemporal: SignalDetector = (text, lower) => {
  const patterns = [
    /\b(by|before|until|deadline|due)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|today|next\s+week|end\s+of\s+day|eod|eow)\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/,                   // ISO dates
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
    /\bin\s+\d+\s+(hours?|minutes?|days?|weeks?)\b/i,
    /\burgent\b/i,
    /\basap\b/i,
    /\bremind\s+me\b/i,
  ];
  
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      return { name: 'temporal', weight: 0.6, matched: match[0] };
    }
  }
  return null;
};

/** New proper nouns (people, projects, companies) */
const detectProperNouns: SignalDetector = (text, lower) => {
  // Look for capitalized multi-word names not at sentence start
  const namePattern = /(?:^|\.\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g;
  const matches: string[] = [];
  let m;
  while ((m = namePattern.exec(text)) !== null) {
    const name = m[1];
    // Filter out common sentence-start patterns
    if (!/^(The|This|That|When|Where|How|What|Why|But|And|Also|Then)/.test(name)) {
      matches.push(name);
    }
  }
  
  if (matches.length > 0) {
    return { name: 'proper-nouns', weight: 0.35, matched: matches.join(', ') };
  }
  return null;
};

/** Technical content — commands, code, links, file paths */
const detectTechnical: SignalDetector = (text, lower) => {
  const patterns = [
    /https?:\/\/\S+/,                          // URLs
    /`[^`]+`/,                                   // Inline code
    /\b(npm|npx|git|docker|ssh|curl|apt)\s/i,  // CLI commands
    /[\w-]+\.(ts|js|py|sh|json|yaml|md)\b/,    // File references
    /\b0x[0-9a-fA-F]{8,}\b/,                   // Hex addresses
    /\b[a-zA-Z0-9]{32,}\b/,                     // Long tokens/keys
  ];
  
  let matched: string[] = [];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) matched.push(match[0].substring(0, 40));
  }
  
  if (matched.length > 0) {
    return { name: 'technical', weight: 0.3, matched: matched.join(', ') };
  }
  return null;
};

/** Questions that reveal what the user is working on or thinking about */
const detectStrategicQuestion: SignalDetector = (text, lower) => {
  const patterns = [
    /\bwhat\s+(do\s+you\s+think|should\s+we|if\s+we)\b/i,
    /\bhow\s+should\s+(we|I)\b/i,
    /\bshould\s+(we|I)\b/i,
    /\bwhat'?s\s+the\s+(best|right|correct)\s+(way|approach)\b/i,
    /\bstrategy\b/i,
    /\bplan\b/i,
  ];
  
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      return { name: 'strategic-question', weight: 0.4, matched: match[0] };
    }
  }
  return null;
};

/** Corrections — user correcting the agent's behavior */
const detectCorrection: SignalDetector = (text, lower) => {
  const patterns = [
    /\bno,?\s+(I\s+meant|that'?s\s+not|not\s+like\s+that|wrong)\b/i,
    /\bactually\b/i,
    /\bthat'?s\s+not\s+(right|correct|what)\b/i,
    /\bI\s+said\b/i,
    /\bstop\b/i,
    /\bplease\s+don'?t\b/i,
  ];
  
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      return { name: 'correction', weight: 0.7, matched: match[0] };
    }
  }
  return null;
};

/** Relayed information — someone told the user something worth remembering */
const detectRelayed: SignalDetector = (text, lower) => {
  const patterns = [
    /\b(\w+)\s+(said|told\s+me|mentioned|confirmed|asked|wants|requested|suggested)\s/i,
    /\baccording\s+to\s/i,
    /\bfrom\s+\w+[:\s]/i,        // "From Tom:" or "from the meeting"
    /\b(they|he|she)\s+(said|want|need|asked|confirmed)\b/i,
    /\bper\s+\w+'?s?\s+(request|instructions|email|message|call)\b/i,
    /\bthe\s+team\s+(said|decided|wants|needs)\b/i,
  ];
  
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      return { name: 'relayed', weight: 0.5, matched: match[0] };
    }
  }
  return null;
};

/** Requirements and specifications — technical needs or constraints */
const detectRequirement: SignalDetector = (text, lower) => {
  const patterns = [
    /\b(needs?|requires?|must\s+have|must\s+use|has\s+to\s+be|should\s+be|can'?t\s+use|not\s+allowed)\b/i,
    /\binstead\s+of\b/i,         // "Use X instead of Y"
    /\bnot\s+\w+[,\s]+but\s+/i,  // "Not X, but Y"
    /\bonly\s+(use|accept|support|allow)\b/i,
    /\bswitch\s+(to|from)\b/i,
    /\bmigrat(e|ing|ion)\s/i,
  ];
  
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      return { name: 'requirement', weight: 0.45, matched: match[0] };
    }
  }
  return null;
};

/** Low-signal noise patterns — reduce score */
const detectNoise: SignalDetector = (text, lower) => {
  // Very short messages (< 5 words) with no other signals are likely noise
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  
  const noisePatterns = [
    /^(ok|okay|sure|yes|no|yeah|nah|cool|nice|thanks|ty|thx|lol|haha|hah|hmm|hm|ah|oh|yep|nope|k|kk)$/i,
    /^(got it|sounds good|makes sense|fair enough|right|true|exactly|agreed)$/i,
    /^👍|^❤️|^🙌|^😂|^💯|^✅/,
  ];
  
  for (const p of noisePatterns) {
    if (p.test(text.trim())) {
      return { name: 'noise', weight: -0.5, matched: 'ack/filler' };
    }
  }
  
  // Short messages without substance
  if (wordCount <= 3 && !detectExplicitMemory(text, lower) && !detectDecision(text, lower)) {
    return { name: 'short', weight: -0.2, matched: `${wordCount} words` };
  }
  
  return null;
};

/** Conversational depth — longer, substantive exchanges */
const detectDepth: SignalDetector = (text, lower) => {
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  const sentenceCount = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  
  // Multi-sentence, substantive content
  if (wordCount > 50 && sentenceCount >= 3) {
    return { name: 'depth', weight: 0.25, matched: `${wordCount} words, ${sentenceCount} sentences` };
  }
  
  return null;
};

// ─── Scoring Engine ─────────────────────────────────────────────────────────

const ALL_DETECTORS: SignalDetector[] = [
  detectExplicitMemory,
  detectDecision,
  detectPreference,
  detectEmotional,
  detectTemporal,
  detectProperNouns,
  detectTechnical,
  detectStrategicQuestion,
  detectCorrection,
  detectRelayed,
  detectRequirement,
  detectNoise,
  detectDepth,
];

export function scoreImportance(text: string): ImportanceResult {
  const lower = text.toLowerCase();
  const signals: ImportanceSignal[] = [];
  
  for (const detector of ALL_DETECTORS) {
    const signal = detector(text, lower);
    if (signal) {
      signals.push(signal);
    }
  }
  
  // Compute raw score: sum of signal weights, clamped to [0, 1]
  let rawScore = signals.reduce((sum, s) => sum + s.weight, 0);
  
  // Base score for non-empty text
  if (signals.length === 0) {
    rawScore = 0.15; // Default: slightly above skip threshold
  }
  
  // Clamp
  const score = Math.max(0, Math.min(1, rawScore));
  
  // Determine level
  let level: ImportanceResult['level'];
  if (score < 0.2) level = 'skip';
  else if (score < 0.4) level = 'low';
  else if (score < 0.6) level = 'mid';
  else if (score < 0.8) level = 'high';
  else level = 'critical';
  
  // Suggest capture type based on strongest signal
  const suggestedType = inferCaptureType(signals);
  const suggestedAction = inferAction(level, suggestedType);
  
  return { score, level, signals, suggestedType, suggestedAction };
}

function inferCaptureType(signals: ImportanceSignal[]): CaptureType {
  // Priority order: explicit signals first
  const signalNames = new Set(signals.map(s => s.name));
  
  if (signalNames.has('noise') && signals.length <= 2) return 'skip';
  if (signalNames.has('explicit-memory')) return 'fact';
  if (signalNames.has('correction')) return 'preference';
  if (signalNames.has('decision')) return 'decision';
  if (signalNames.has('preference')) return 'preference';
  if (signalNames.has('emotional')) return 'reaction';
  if (signalNames.has('temporal')) return 'task';
  if (signalNames.has('relayed') && signalNames.has('requirement')) return 'fact'; // "X said we need Y"
  if (signalNames.has('relayed')) return 'note';
  if (signalNames.has('requirement')) return 'decision';
  if (signalNames.has('proper-nouns')) return 'person';
  if (signalNames.has('strategic-question')) return 'note';
  if (signalNames.has('technical')) return 'note';
  if (signalNames.has('depth')) return 'note';
  
  return 'note';
}

function inferAction(level: ImportanceResult['level'], type: CaptureType): string {
  switch (level) {
    case 'skip': return 'No capture needed';
    case 'low': return `Log as general note in daily file`;
    case 'mid': return `Capture as ${type.toUpperCase()} in daily file`;
    case 'high': return `Capture as ${type.toUpperCase()} + file to relevant topic`;
    case 'critical': return `Capture as ${type.toUpperCase()} immediately — consider MEMORY.md`;
  }
}

// ─── Batch scoring (for analyzing full conversations) ───────────────────────

export interface ConversationAnalysis {
  exchanges: Array<{
    text: string;
    result: ImportanceResult;
  }>;
  summary: {
    total: number;
    skip: number;
    low: number;
    mid: number;
    high: number;
    critical: number;
    averageScore: number;
    topSignals: string[];
  };
}

export function analyzeConversation(exchanges: string[]): ConversationAnalysis {
  const results = exchanges.map(text => ({
    text,
    result: scoreImportance(text),
  }));
  
  const counts = { skip: 0, low: 0, mid: 0, high: 0, critical: 0 };
  const signalCounts = new Map<string, number>();
  let totalScore = 0;
  
  for (const { result } of results) {
    counts[result.level]++;
    totalScore += result.score;
    for (const signal of result.signals) {
      if (signal.weight > 0) {
        signalCounts.set(signal.name, (signalCounts.get(signal.name) || 0) + 1);
      }
    }
  }
  
  const topSignals = Array.from(signalCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count})`);
  
  return {
    exchanges: results,
    summary: {
      total: results.length,
      ...counts,
      averageScore: results.length > 0 ? totalScore / results.length : 0,
      topSignals,
    },
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const jsonMode = process.argv.includes('--json');
  const batchMode = process.argv.includes('--batch');
  
  let input = '';
  
  if (args.length > 0) {
    input = args.join(' ');
  } else {
    // Read from stdin
    input = await new Promise<string>((resolve) => {
      let data = '';
      if (process.stdin.isTTY && !batchMode) {
        console.log('⌨️  Enter text to score (Ctrl+D to finish):');
      }
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { resolve(data); });
      setTimeout(() => { if (!data) resolve(''); }, 5000);
    });
  }
  
  input = input.trim();
  if (!input) {
    console.log('⚠️  No input provided.');
    console.log('Usage: echo "text" | npx ts-node src/importance.ts');
    process.exit(1);
  }
  
  if (batchMode) {
    // Score each line separately
    const lines = input.split('\n').filter(l => l.trim().length > 0);
    const analysis = analyzeConversation(lines);
    
    if (jsonMode) {
      console.log(JSON.stringify(analysis, null, 2));
    } else {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('     📊 CONVERSATION IMPORTANCE ANALYSIS');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('');
      
      for (const { text, result } of analysis.exchanges) {
        const bar = scoreBar(result.score);
        const icon = levelIcon(result.level);
        const preview = text.length > 60 ? text.substring(0, 57) + '...' : text;
        console.log(`${icon} ${bar} ${result.score.toFixed(2)} │ ${preview}`);
        if (result.signals.length > 0 && result.level !== 'skip') {
          const sigStr = result.signals.filter(s => s.weight > 0).map(s => s.name).join(', ');
          if (sigStr) console.log(`   └─ signals: ${sigStr} → ${result.suggestedType}`);
        }
      }
      
      console.log('');
      console.log('─────────────────────────────────────────');
      console.log(`📊 Total: ${analysis.summary.total} exchanges`);
      console.log(`   ⬛ Skip: ${analysis.summary.skip} | ⬜ Low: ${analysis.summary.low} | 🟨 Mid: ${analysis.summary.mid} | 🟧 High: ${analysis.summary.high} | 🟥 Critical: ${analysis.summary.critical}`);
      console.log(`   Average score: ${analysis.summary.averageScore.toFixed(2)}`);
      if (analysis.summary.topSignals.length > 0) {
        console.log(`   Top signals: ${analysis.summary.topSignals.join(', ')}`);
      }
    }
  } else {
    // Score single text
    const result = scoreImportance(input);
    
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const bar = scoreBar(result.score);
      const icon = levelIcon(result.level);
      
      console.log('');
      console.log(`${icon} Importance: ${result.score.toFixed(2)} ${bar}  [${result.level.toUpperCase()}]`);
      console.log('');
      
      if (result.signals.length > 0) {
        console.log('Signals:');
        for (const s of result.signals) {
          const sign = s.weight >= 0 ? '+' : '';
          console.log(`  ${sign}${s.weight.toFixed(2)} ${s.name}: "${s.matched}"`);
        }
        console.log('');
      }
      
      console.log(`📦 Suggested: ${result.suggestedAction}`);
      if (result.suggestedType !== 'skip') {
        console.log(`🏷️  Capture as: ${result.suggestedType.toUpperCase()}`);
      }
    }
  }
}

function scoreBar(score: number): string {
  const filled = Math.round(score * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function levelIcon(level: ImportanceResult['level']): string {
  switch (level) {
    case 'skip': return '⬛';
    case 'low': return '⬜';
    case 'mid': return '🟨';
    case 'high': return '🟧';
    case 'critical': return '🟥';
  }
}

// Only run CLI when executed directly (not when imported)
if (require.main === module) {
  main().catch(e => {
    console.error('❌ Error:', e.message);
    process.exit(1);
  });
}
