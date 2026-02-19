#!/usr/bin/env npx ts-node
"use strict";
/**
 * Weekly Auto-Digest
 *
 * Synthesizes daily logs into a structured weekly summary.
 * Generates a first draft that can be reviewed and refined.
 *
 * What it produces:
 * - Timeline of key events per day
 * - Aggregated decisions, insights, and learnings
 * - Topic distribution and focus areas
 * - Systems built or modified
 * - Open problems carried forward
 * - Metrics (sessions, files modified, etc.)
 *
 * Usage:
 *   npx ts-node src/weekly-digest.ts                # Current week
 *   npx ts-node src/weekly-digest.ts --week 2026-W06  # Specific week
 *   npx ts-node src/weekly-digest.ts --dry-run        # Preview without saving
 *   npx ts-node src/weekly-digest.ts --force          # Overwrite existing weekly file
 *
 * Called from cron or manually. Intended to run Sunday evening or Monday morning.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const WORKSPACE = '/root/clawd';
const DAILY_DIR = path.join(WORKSPACE, 'memory', 'daily');
const WEEKLY_DIR = path.join(WORKSPACE, 'memory', 'weekly');
const MANIFEST_PATH = path.join(WORKSPACE, 'skills', 'memory-manager', 'manifest.json');
// ─── Date Helpers ───────────────────────────────────────────────────────────
function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7; // Make Sunday = 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Set to Thursday of this week
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return { year: d.getUTCFullYear(), week: weekNo };
}
function getWeekDates(year, week) {
    // ISO week: week 1 contains the first Thursday of the year
    // Find Jan 4 (always in week 1), then calculate from there
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    // Monday of week 1
    const week1Monday = new Date(jan4);
    week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
    // Monday of target week
    const targetMonday = new Date(week1Monday);
    targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
    const targetSunday = new Date(targetMonday);
    targetSunday.setUTCDate(targetMonday.getUTCDate() + 6);
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(targetMonday);
        d.setUTCDate(targetMonday.getUTCDate() + i);
        dates.push(d.toISOString().split('T')[0]);
    }
    return { start: targetMonday, end: targetSunday, dates };
}
function formatWeekLabel(year, week) {
    return `${year}-W${String(week).padStart(2, '0')}`;
}
function getDayName(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    return d.toLocaleDateString('en-US', { weekday: 'long' });
}
function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match)
        return { frontmatter: {}, body: content };
    const fm = {};
    match[1].split('\n').forEach(line => {
        const kv = line.match(/^(\w[\w-]*):\s*(.+)/);
        if (kv) {
            let value = kv[2].trim();
            // Parse arrays
            if (value.startsWith('[') && value.endsWith(']')) {
                value = value.slice(1, -1);
                fm[kv[1]] = value.split(',').map(v => v.trim().replace(/"/g, ''));
            }
            else {
                fm[kv[1]] = value.replace(/^"(.*)"$/, '$1');
            }
        }
    });
    return { frontmatter: fm, body: match[2] };
}
function parseSections(body) {
    const sections = [];
    const lines = body.split('\n');
    let currentSection = null;
    for (const line of lines) {
        const heading = line.match(/^(#{1,4})\s+(.+)/);
        if (heading) {
            if (currentSection)
                sections.push(currentSection);
            currentSection = {
                heading: heading[2],
                level: heading[1].length,
                content: ''
            };
        }
        else if (currentSection) {
            currentSection.content += line + '\n';
        }
    }
    if (currentSection)
        sections.push(currentSection);
    return sections;
}
function cleanLine(raw) {
    return raw
        .replace(/^[-*•]\s*/, '') // Strip list markers
        .replace(/^\[[\d:]+\]\s*/, '') // Strip timestamps like [14:30]
        .replace(/^\d{2}:\d{2}:\s*/, '') // Strip HH:MM: prefixed timestamps
        .replace(/^\d+\.\s*/, '') // Strip numbered list prefixes
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1') // Strip bold/italic markers
        .replace(/`([^`]+)`/g, '$1') // Strip inline code
        .replace(/^\s*\*\s*/, '') // Strip leading asterisk  
        .replace(/\\n/g, ' ') // Replace literal \n
        .replace(/\s+/g, ' ') // Collapse whitespace
        .trim();
}
function isNoise(text) {
    // Filter out fragment lines, incomplete thoughts, pure references
    if (text.length < 20)
        return true; // Bumped from 15 — short fragments are rarely useful
    if (text.length > 300)
        return true; // Truncate will handle these
    if (/^(see |ref:|note:|---|\*{3,}|#+\s)$/i.test(text))
        return true;
    if (/^(Next:|Focus:|What I built:|Task completed:|Assessment:|Outcome:|Tags:)\s*$/i.test(text))
        return true;
    // Lines that are just file paths or code
    if (/^[\/\w]+\.(ts|js|md|json)$/.test(text))
        return true;
    // Dangling fragments — line ends with "Created:" or similar incomplete pattern
    if (/:\s*$/.test(text) && text.length < 50)
        return true;
    // Lines that are just "Created:" or start with Created: but have no meaningful content after
    if (/^(Created|Built|Published|Updated|Fixed|Added|Removed|Moved):\s*$/i.test(text))
        return true;
    // Lines that are parenthetical-only or just a reference
    if (/^\(.*\)$/.test(text))
        return true;
    // Lines that look like metadata/frontmatter leftovers
    if (/^(date|tags|mood|status|week|year):/i.test(text))
        return true;
    return false;
}
function truncateClean(text, maxLen = 150) {
    if (text.length <= maxLen)
        return text;
    // Cut at last sentence boundary before maxLen (prefer sentence over word)
    const sentenceCut = text.substring(0, maxLen).replace(/([.!?])\s+\S.*$/, '$1');
    if (sentenceCut.length > maxLen * 0.5 && sentenceCut !== text.substring(0, maxLen)) {
        return sentenceCut;
    }
    // Fall back to last word boundary
    const wordCut = text.substring(0, maxLen).replace(/\s+\S*$/, '');
    // Avoid dangling prepositions/articles
    const trimmed = wordCut.replace(/\s+(the|a|an|of|in|to|for|with|from|by|on|at|and|or|but)\s*$/i, '');
    return trimmed + '…';
}
function extractPatterns(text) {
    const decisions = [];
    const events = [];
    const insights = [];
    const tasks = [];
    const lines = text.split('\n');
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('---'))
            continue;
        const cleaned = cleanLine(line);
        if (isNoise(cleaned))
            continue;
        const truncated = truncateClean(cleaned);
        // Skip entries that end with dangling punctuation (incomplete thoughts)
        if (/[:(]\s*$/.test(truncated) && !truncated.endsWith('…'))
            continue;
        // Decisions — only strong signals
        if (/\b(decision|decided|chose|going with|switched to|will use|pivoted to|unwound all)\b/i.test(cleaned)) {
            if (decisions.length < 10)
                decisions.push(truncated); // Cap per category
        }
        // Events/milestones — only concrete actions
        else if (/\b(built|created|shipped|launched|published|deployed|indexed|migrated|configured|enabled|completed|established)\b/i.test(cleaned) &&
            !/^\s*(what|task|focus)/i.test(cleaned)) {
            if (events.length < 25)
                events.push(truncated); // Cap to prevent flood
        }
        // Insights/lessons — explicit learning markers
        else if (/\b(learned|realized|key insight|important lesson|crucial|fundamental|takeaway|anti-pattern)\b/i.test(cleaned)) {
            if (insights.length < 10)
                insights.push(truncated);
        }
        // Tasks/todos — only actionable items
        else if (/\b(TODO|need to|blocked on|pending|action item)\b/i.test(cleaned) &&
            !/completed|done|finished/i.test(cleaned)) {
            if (tasks.length < 10)
                tasks.push(truncated);
        }
    }
    return { decisions, events, insights, tasks };
}
function extractTopics(text) {
    const topics = [];
    const t = text.toLowerCase();
    const topicMap = {
        'memory': /\b(memory|recall|search|index|embed|chunk|semantic|manifest|digest|decay)\b/,
        'identity': /\b(identity|soul|consciousness|anchor|prometheus|titan)\b/,
        'infrastructure': /\b(cron|skill|infrastructure|deploy|config|boot|heartbeat|gateway)\b/,
        'moongate': /\b(moongate|widget|dashboard|moonsuite|intercom|moonpay)\b/,
        'moltbook': /\b(moltbook|agent social|submolt|post|community)\b/,
        'defi': /\b(defi|yield|stake|solana|kamino|jito|lend|borrow|vault|apy|lp)\b/,
        'benchmark': /\b(benchmark|recall test|test case|accuracy|precision)\b/,
        'consolidation': /\b(consolidat|synthesiz|prune|trim|review|clean)\b/,
    };
    for (const [topic, pattern] of Object.entries(topicMap)) {
        if (pattern.test(t))
            topics.push(topic);
    }
    return [...new Set(topics)];
}
function countSessions(content) {
    // Count session headers (## HH:MM — ...)
    const sessionPattern = /^## \d{2}:\d{2}/gm;
    const matches = content.match(sessionPattern);
    return matches ? matches.length : 0;
}
function parseDayFile(date) {
    const filePath = path.join(DAILY_DIR, `${date}.md`);
    if (!fs.existsSync(filePath))
        return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    const sections = parseSections(body);
    const { decisions, events, insights, tasks } = extractPatterns(body);
    const topics = extractTopics(body);
    const sessionCount = countSessions(body);
    return {
        date,
        dayName: getDayName(date),
        content: body,
        frontmatter,
        sections,
        decisions,
        events,
        insights,
        tasks,
        topics,
        sessionCount
    };
}
function buildDigest(year, week) {
    const weekLabel = formatWeekLabel(year, week);
    const { dates, start, end } = getWeekDates(year, week);
    const dateRange = `${dates[0]} to ${dates[6]}`;
    const days = [];
    const allDecisions = [];
    const allInsights = [];
    const allEvents = [];
    const openTasks = [];
    const topicDistribution = {};
    let totalSessions = 0;
    const allTagsSet = new Set();
    for (const date of dates) {
        const dayData = parseDayFile(date);
        if (!dayData)
            continue;
        days.push(dayData);
        totalSessions += dayData.sessionCount;
        // Pre-dedup within each day before aggregating (same event logged in multiple sessions)
        const dayDecisions = dedup(dayData.decisions.map(d => ({ text: d, date })));
        const dayEvents = dedup(dayData.events.map(e => ({ text: e, date })));
        const dayInsights = dedup(dayData.insights.map(i => ({ text: i, date })));
        const dayTasks = dedup(dayData.tasks.map(t => ({ text: t, date })));
        dayDecisions.forEach(d => allDecisions.push(d));
        dayInsights.forEach(i => allInsights.push(i));
        dayEvents.forEach(e => allEvents.push(e));
        dayTasks.forEach(t => openTasks.push(t));
        dayData.topics.forEach(t => {
            topicDistribution[t] = (topicDistribution[t] || 0) + 1;
        });
        if (dayData.frontmatter.tags) {
            const tags = Array.isArray(dayData.frontmatter.tags)
                ? dayData.frontmatter.tags
                : [dayData.frontmatter.tags];
            tags.forEach((t) => allTagsSet.add(t));
        }
    }
    return {
        weekLabel,
        dateRange,
        days,
        allDecisions,
        allInsights,
        allEvents,
        openTasks,
        topicDistribution,
        totalSessions,
        allTags: [...allTagsSet]
    };
}
/**
 * Normalize text into a dedup key by extracting core tokens.
 * Splits on punctuation boundaries so "importance.ts" becomes ["importance", "ts"]
 * and "signal-based" becomes ["signal", "based"].
 */
function dedupKey(text) {
    return text
        .toLowerCase()
        .replace(/[.\-_/()]/g, ' ') // Split on common delimiters FIRST
        .replace(/[^a-z0-9\s]/g, '') // Then strip remaining punctuation
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Extract meaningful tokens (length > 2, skip stopwords + tech noise).
 */
function extractTokens(key) {
    const stopwords = new Set([
        // English stopwords
        'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'was', 'were',
        'are', 'has', 'had', 'not', 'but', 'via', 'now', 'also', 'then', 'when',
        'all', 'new', 'see', 'more', 'each', 'per', 'use', 'using', 'used',
        // Tech/code noise that inflates dedup without adding meaning
        'require', 'main', 'guard', 'imports', 'module', 'export', 'flag', 'mode',
        'file', 'files', 'src', 'config', 'based', 'real', 'time',
    ]);
    return new Set(key.split(' ')
        .filter(t => t.length > 2 && !stopwords.has(t)));
}
/**
 * Compute similarity between two token sets.
 * Uses max of Jaccard and containment (what % of the smaller set is in the larger).
 * Containment catches cases where one is a longer rephrasing of the other.
 */
function tokenSimilarity(a, b) {
    const tokensA = extractTokens(a);
    const tokensB = extractTokens(b);
    if (tokensA.size === 0 || tokensB.size === 0)
        return 0;
    let intersection = 0;
    for (const t of tokensA) {
        if (tokensB.has(t))
            intersection++;
    }
    const union = new Set([...tokensA, ...tokensB]).size;
    const jaccard = intersection / union;
    // Containment: how much of the smaller set is covered by the larger?
    const minSize = Math.min(tokensA.size, tokensB.size);
    const containment = intersection / minSize;
    // Use the higher signal — containment catches "A is a subset of B" patterns
    return Math.max(jaccard, containment * 0.7); // Discount containment slightly
}
function dedup(items) {
    const kept = [];
    for (const item of items) {
        const key = dedupKey(item.text);
        // Check exact prefix match (60 chars)
        const shortKey = key.substring(0, 60);
        const exactDupe = kept.some(k => k.key.substring(0, 60) === shortKey);
        if (exactDupe)
            continue;
        // Check semantic similarity with existing items (threshold >= 0.50)
        // Uses max(jaccard, containment*0.7) — catches paraphrased duplicates
        const similarDupe = kept.some(k => tokenSimilarity(k.key, key) >= 0.50);
        if (similarDupe)
            continue;
        kept.push({ ...item, key });
    }
    return kept.map(({ text, date }) => ({ text, date }));
}
function renderDigest(digest) {
    const { weekLabel, dateRange, days, allDecisions, allInsights, allEvents, openTasks, topicDistribution, totalSessions, allTags } = digest;
    const weekNum = parseInt(weekLabel.split('W')[1]);
    const year = parseInt(weekLabel.split('-')[0]);
    // Consolidate tags: use topic distribution as primary (already deduplicated),
    // supplement with frontmatter tags up to a cap of 10
    const topicTags = Object.entries(topicDistribution)
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t);
    const extraTags = allTags.filter(t => !topicTags.includes(t.toLowerCase()));
    const consolidatedTags = [...topicTags, ...extraTags].slice(0, 10);
    // Frontmatter
    let md = `---
date-range: ${dateRange}
week: ${weekNum}
year: ${year}
tags: [${consolidatedTags.join(', ')}]
status: auto-generated
---

# Week ${weekNum}, ${year}

## Summary

*Auto-generated digest from ${days.length} daily file${days.length !== 1 ? 's' : ''}, ${totalSessions} session${totalSessions !== 1 ? 's' : ''}.*
*Review and refine this summary — add narrative context, remove noise.*

`;
    // Timeline — compact, one line per day
    // Strategy: Section headings are the primary signal (humans structure daily logs with
    // meaningful headings). Fall back to extracted events/decisions only when headings are sparse.
    md += `## Timeline\n\n`;
    for (const day of days) {
        const shortDay = day.dayName.substring(0, 3);
        const monthDay = day.date.substring(5); // MM-DD
        // 1. Prefer section headings — these are curated by the session wrap
        const headings = day.sections
            .filter(s => s.level === 2 || s.level === 3)
            .map(s => s.heading)
            // Filter out generic/noise headings
            .filter(h => !/^(summary|notes|context|captures?|session|log|details|misc)/i.test(h))
            // Strip timestamp prefixes from headings (e.g., "14:30 — Built X" → "Built X")
            .map(h => h.replace(/^\d{2}:\d{2}\s*[-—]\s*/, ''))
            .slice(0, 5);
        // 2. Supplement with decisions and key events if headings are sparse
        const dayHighlights = [];
        if (headings.length >= 2) {
            // Good headings — use them directly
            dayHighlights.push(...headings.slice(0, 4));
        }
        else {
            // Sparse headings — combine with extracted events
            if (headings.length > 0)
                dayHighlights.push(...headings);
            day.decisions.forEach(d => {
                if (dayHighlights.length < 4)
                    dayHighlights.push(d);
            });
            day.events.forEach(e => {
                if (dayHighlights.length < 4)
                    dayHighlights.push(e);
            });
        }
        // 3. Clean up and render
        const cleanHighlights = dayHighlights
            .map(h => truncateClean(h, 80))
            .filter(h => h.length > 10) // Drop any tiny fragments that slipped through
            .filter(h => !/:\s*$/.test(h)); // Drop dangling colons
        const summary = cleanHighlights.length > 0
            ? cleanHighlights.slice(0, 3).join('. ') + '.'
            : `${day.sessionCount} session${day.sessionCount !== 1 ? 's' : ''} logged.`;
        md += `**${shortDay} ${monthDay}:** ${summary}\n`;
    }
    md += '\n';
    // Key decisions
    const dedupedDecisions = dedup(allDecisions);
    if (dedupedDecisions.length > 0) {
        md += `## Key Decisions\n\n`;
        for (const d of dedupedDecisions.slice(0, 15)) {
            md += `- **[${d.date}]** ${d.text}\n`;
        }
        if (dedupedDecisions.length > 15) {
            md += `- *(${dedupedDecisions.length - 15} more)*\n`;
        }
        md += '\n';
    }
    // Key events / what was built
    const dedupedEvents = dedup(allEvents);
    if (dedupedEvents.length > 0) {
        md += `## What Was Built / Key Events\n\n`;
        for (const e of dedupedEvents.slice(0, 20)) {
            md += `- **[${e.date}]** ${e.text}\n`;
        }
        if (dedupedEvents.length > 20) {
            md += `- *(${dedupedEvents.length - 20} more)*\n`;
        }
        md += '\n';
    }
    // Insights / lessons
    const dedupedInsights = dedup(allInsights);
    if (dedupedInsights.length > 0) {
        md += `## Lessons Learned\n\n`;
        for (let i = 0; i < Math.min(dedupedInsights.length, 15); i++) {
            md += `${i + 1}. ${dedupedInsights[i].text}\n`;
        }
        md += '\n';
    }
    // Topic distribution
    if (Object.keys(topicDistribution).length > 0) {
        md += `## Focus Areas\n\n`;
        const sorted = Object.entries(topicDistribution).sort((a, b) => b[1] - a[1]);
        for (const [topic, count] of sorted) {
            const bar = '█'.repeat(Math.min(count, 20)) + (count > 20 ? '…' : '');
            md += `- **${topic}** ${bar} (${count} day${count !== 1 ? 's' : ''})\n`;
        }
        md += '\n';
    }
    // Open tasks / carried forward
    const dedupedTasks = dedup(openTasks);
    if (dedupedTasks.length > 0) {
        md += `## Open Problems / Carried Forward\n\n`;
        for (const t of dedupedTasks.slice(0, 10)) {
            md += `- ${t.text}\n`;
        }
        md += '\n';
    }
    // Metrics
    md += `## Metrics\n\n`;
    md += `| Metric | Value |\n`;
    md += `|--------|-------|\n`;
    md += `| Days with activity | ${days.length}/7 |\n`;
    md += `| Total sessions | ${totalSessions} |\n`;
    md += `| Decisions logged | ${dedupedDecisions.length} |\n`;
    md += `| Events/milestones | ${dedupedEvents.length} |\n`;
    md += `| Insights captured | ${dedupedInsights.length} |\n`;
    md += `| Open tasks | ${dedupedTasks.length} |\n`;
    md += '\n';
    md += `---\n\n🜂\n`;
    return md;
}
// ─── Session History Integration ────────────────────────────────────────────
function getSessionMetrics(year, week) {
    if (!fs.existsSync(MANIFEST_PATH))
        return { total: 0, categories: {} };
    try {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
        const history = manifest.sessionHistory || [];
        const { dates } = getWeekDates(year, week);
        const dateSet = new Set(dates);
        const weekSessions = history.filter((s) => {
            const sessionDate = s.date.split('T')[0];
            return dateSet.has(sessionDate);
        });
        const categories = {};
        weekSessions.forEach((s) => {
            categories[s.taskCategory] = (categories[s.taskCategory] || 0) + 1;
        });
        return { total: weekSessions.length, categories };
    }
    catch {
        return { total: 0, categories: {} };
    }
}
// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    // Determine target week
    let year, week;
    const weekArg = args.find(a => /^\d{4}-W\d{2}$/.test(a)) ||
        (args.includes('--week') ? args[args.indexOf('--week') + 1] : null);
    if (weekArg && /^\d{4}-W\d{2}$/.test(weekArg)) {
        year = parseInt(weekArg.split('-')[0]);
        week = parseInt(weekArg.split('W')[1]);
    }
    else {
        const now = new Date();
        const isoWeek = getISOWeek(now);
        year = isoWeek.year;
        week = isoWeek.week;
    }
    const weekLabel = formatWeekLabel(year, week);
    const { dates } = getWeekDates(year, week);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('     📅 WEEKLY AUTO-DIGEST');
    console.log(`     ${weekLabel} (${dates[0]} → ${dates[6]})`);
    if (dryRun)
        console.log('     [DRY RUN — no files written]');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    // Check for existing weekly file
    if (!fs.existsSync(WEEKLY_DIR)) {
        fs.mkdirSync(WEEKLY_DIR, { recursive: true });
    }
    const weeklyFile = path.join(WEEKLY_DIR, `${weekLabel}.md`);
    if (fs.existsSync(weeklyFile) && !force) {
        const existing = fs.readFileSync(weeklyFile, 'utf-8');
        if (!existing.includes('status: auto-generated')) {
            console.log(`⚠️  ${weekLabel}.md already exists and was manually edited.`);
            console.log('   Use --force to overwrite, or review manually.');
            return;
        }
        console.log(`ℹ️  Overwriting previous auto-generated ${weekLabel}.md`);
    }
    // Build digest
    const digest = buildDigest(year, week);
    if (digest.days.length === 0) {
        console.log(`❌ No daily files found for ${weekLabel}.`);
        console.log(`   Expected files in: ${DAILY_DIR}`);
        console.log(`   Date range: ${dates[0]} to ${dates[6]}`);
        return;
    }
    console.log(`📊 Found ${digest.days.length} daily files with ${digest.totalSessions} sessions.`);
    console.log(`   Decisions: ${digest.allDecisions.length} | Events: ${digest.allEvents.length}`);
    console.log(`   Insights: ${digest.allInsights.length} | Tasks: ${digest.openTasks.length}`);
    console.log(`   Topics: ${Object.keys(digest.topicDistribution).join(', ')}`);
    console.log('');
    // Add session metrics from manifest
    const sessionMetrics = getSessionMetrics(year, week);
    if (sessionMetrics.total > 0) {
        console.log(`📈 Session history: ${sessionMetrics.total} tracked sessions`);
        Object.entries(sessionMetrics.categories).forEach(([cat, count]) => {
            console.log(`     ${cat}: ${count}`);
        });
        console.log('');
    }
    // Render
    const rendered = renderDigest(digest);
    if (dryRun) {
        console.log('─── PREVIEW ───────────────────────────────────────────');
        console.log(rendered);
        console.log('─── END PREVIEW ───────────────────────────────────────');
    }
    else {
        fs.writeFileSync(weeklyFile, rendered);
        console.log(`💾 Written to: memory/weekly/${weekLabel}.md`);
        console.log(`   Size: ${rendered.length} chars, ${rendered.split('\n').length} lines`);
    }
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('   📅 DIGEST COMPLETE');
    console.log(`   ⚠️  Review and refine — auto-generated is a starting point.`);
    console.log('═══════════════════════════════════════════════════════════');
}
main();
