#!/usr/bin/env npx ts-node
"use strict";
/**
 * Smart task prioritization - scores tasks based on multiple signals
 *
 * Replaces dumb FIFO/static-priority with a dynamic scoring algorithm.
 * Tasks bubble up based on urgency, impact, dependencies, and skip-decay.
 *
 * Score = (urgencyScore * urgencyWeight)
 *       + (impactScore * impactWeight)
 *       + (dependencyScore * dependencyWeight)
 *       + (skipDecayScore * skipDecayWeight)
 *       + (blockerBonus)
 *
 * All sub-scores normalized to 0-1 range, then weighted.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CATEGORY_EMOJI = void 0;
exports.scoreTask = scoreTask;
exports.rankTasks = rankTasks;
exports.pickNext = pickNext;
exports.inferCategory = inferCategory;
exports.formatScore = formatScore;
exports.formatBreakdown = formatBreakdown;
// ─── Scoring Weights ─────────────────────────────────────────────────────────
const WEIGHTS = {
    urgency: 0.12, // Reduced: age alone shouldn't dominate
    impact: 0.40, // What matters most IS what matters most
    dependency: 0.13,
    skipDecay: 0.08, // Reduced: skip decay was overweighted
    blockerBonus: 0.12, // Blocking others is a real signal
    humanRequest: 0.15, // NEW: direct human requests get priority boost
};
// ─── Category Impact Mapping ─────────────────────────────────────────────────
// Maps categories to base impact scores (0-1)
const CATEGORY_SCORES = {
    'survival': 1.0,
    'memory': 0.85,
    'infrastructure': 0.70,
    'expansion': 0.55,
    'research': 0.40,
    'maintenance': 0.30,
    'nice-to-have': 0.15,
};
// ─── Impact Level Scores ─────────────────────────────────────────────────────
const IMPACT_SCORES = {
    'critical': 1.0,
    'high': 0.75,
    'medium': 0.50,
    'low': 0.25,
};
// ─── Scoring Functions ───────────────────────────────────────────────────────
/**
 * Urgency score based on age of task, dampened by category.
 * High-impact tasks gain urgency faster. Low-impact tasks gain urgency slower.
 * Prevents old maintenance tasks from outranking fresh critical tasks.
 */
function scoreUrgency(task) {
    if (!task.createdAt)
        return 0.3; // Unknown age, middle-ish
    const ageMs = Date.now() - new Date(task.createdAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    // Category dampening: low-impact categories gain urgency slower
    const categoryDampen = {
        'survival': 1.0, // Full urgency ramp
        'memory': 0.85,
        'infrastructure': 0.7,
        'expansion': 0.5,
        'research': 0.4,
        'maintenance': 0.3, // Maintenance barely gains urgency over time
        'nice-to-have': 0.2,
    };
    const dampen = categoryDampen[task.category || 'expansion'] || 0.5;
    // Sigmoid: steep rise between 12-72 hours, plateaus at 168h (7 days)
    const sigmoid = 1 / (1 + Math.exp(-0.05 * (ageHours - 48)));
    return Math.min(1.0, sigmoid * dampen);
}
/**
 * Impact score combining explicit impact level + category.
 * Category provides base, explicit impact can override upward.
 */
function scoreImpact(task) {
    const categoryScore = task.category
        ? CATEGORY_SCORES[task.category]
        : 0.4; // Default: slightly below medium
    const impactScore = task.impact
        ? IMPACT_SCORES[task.impact]
        : 0.5; // Default: medium
    // Legacy priority mapping (1-5 → 1.0-0.2)
    const legacyScore = task.priority
        ? Math.max(0.2, 1.2 - (task.priority * 0.2))
        : 0.5;
    // Weighted combination: category 40%, explicit impact 40%, legacy 20%
    return (categoryScore * 0.4) + (impactScore * 0.4) + (legacyScore * 0.2);
}
/**
 * Dependency score: 1.0 if all deps met, 0.0 if deps unmet.
 * Tasks with no dependencies get full score.
 */
function scoreDependency(task, allTasks, completedTasks) {
    if (!task.dependencies || task.dependencies.length === 0)
        return 1.0;
    const completed = new Set(completedTasks || []);
    const pendingTasks = new Set(allTasks.map(t => t.task.toLowerCase()));
    let metCount = 0;
    for (const dep of task.dependencies) {
        const depLower = dep.toLowerCase();
        // Dependency is met if it's in completed list OR not in pending (i.e., done)
        if (completed.has(depLower) || !pendingTasks.has(depLower)) {
            metCount++;
        }
    }
    return metCount / task.dependencies.length;
}
/**
 * Skip decay score: tasks that keep getting skipped bubble up.
 * Logarithmic curve, capped by category — low-impact tasks can't
 * bubble above their station just from being neglected.
 */
function scoreSkipDecay(task) {
    const skipCount = task.skipCount || 0;
    if (skipCount === 0)
        return 0;
    // Category caps: how high can skip decay push this task?
    const categoryCap = {
        'survival': 1.0,
        'memory': 0.9,
        'infrastructure': 0.7,
        'expansion': 0.6,
        'research': 0.5,
        'maintenance': 0.35, // Maintenance can't bubble past 0.35
        'nice-to-have': 0.2, // Nice-to-have barely budges
    };
    const cap = categoryCap[task.category || 'expansion'] || 0.5;
    // Log curve: rapid initial rise, then flattening
    const raw = Math.log(skipCount + 1) / Math.log(30);
    return Math.min(cap, raw);
}
/**
 * Blocker bonus: tasks that block others get a boost proportional to chain depth.
 * A task that unblocks 1 task gets a small boost. A task that unblocks a chain of 3 gets a big boost.
 * This ensures "Get API credentials" scores higher when it blocks "Fix staging" which blocks "Deploy widget".
 */
function scoreBlocker(task, allTasks = []) {
    // Explicit flag still works
    if (task.blocksOthers)
        return 1.0;
    if (allTasks.length === 0)
        return 0;
    // Count how many tasks depend on this one (direct + transitive)
    const taskLower = task.task.toLowerCase();
    function countDependents(targetTask, visited = new Set()) {
        if (visited.has(targetTask))
            return 0;
        visited.add(targetTask);
        let count = 0;
        for (const t of allTasks) {
            if (t.dependencies?.some(d => d.toLowerCase() === targetTask)) {
                count += 1; // Direct dependent
                count += countDependents(t.task.toLowerCase(), visited); // Transitive
            }
        }
        return count;
    }
    const dependentCount = countDependents(taskLower);
    if (dependentCount === 0)
        return 0;
    // Logarithmic: 1 dependent = 0.4, 2 = 0.6, 3+ = 0.8+, capped at 1.0
    return Math.min(1.0, 0.2 + Math.log2(dependentCount + 1) * 0.3);
}
/**
 * Human request score: direct requests from Hevar always take priority.
 * Detects "Hevar asked", "human request", source=conversation-capture, etc.
 * Fresh human requests (< 1h) get maximum score.
 */
function scoreHumanRequest(task) {
    const text = (task.task + ' ' + (task.source || '')).toLowerCase();
    const tags = (task.tags || []).join(' ').toLowerCase();
    // Detect human request signals
    const isHumanRequest = /hevar|human.?request|asked.?me|told.?me|wants.?me/.test(text) ||
        /urgent|asap|right.?now|immediately/.test(text) ||
        tags.includes('hevar-request') ||
        task.source === 'conversation-capture' ||
        task.source === 'hevar-direct';
    if (!isHumanRequest)
        return 0;
    // Recency of request matters — fresh requests are highest priority
    if (task.createdAt) {
        const ageHours = (Date.now() - new Date(task.createdAt).getTime()) / (1000 * 60 * 60);
        if (ageHours < 1)
            return 1.0; // < 1h: maximum urgency
        if (ageHours < 6)
            return 0.8; // < 6h: high urgency
        if (ageHours < 24)
            return 0.5; // < 24h: medium urgency
        return 0.3; // Older: still a boost but less
    }
    return 0.7; // Unknown age, assume somewhat recent
}
// ─── Main Scoring Function ───────────────────────────────────────────────────
/**
 * Score a single task. Returns the task with _score and _breakdown attached.
 */
function scoreTask(task, allTasks = [], completedTasks = []) {
    const urgency = scoreUrgency(task);
    const impact = scoreImpact(task);
    const dependency = scoreDependency(task, allTasks, completedTasks);
    const skipDecay = scoreSkipDecay(task);
    const blockerBonus = scoreBlocker(task, allTasks);
    const humanRequest = scoreHumanRequest(task);
    const total = (urgency * WEIGHTS.urgency) +
        (impact * WEIGHTS.impact) +
        (dependency * WEIGHTS.dependency) +
        (skipDecay * WEIGHTS.skipDecay) +
        (blockerBonus * WEIGHTS.blockerBonus) +
        (humanRequest * WEIGHTS.humanRequest);
    return {
        ...task,
        _score: Math.round(total * 1000) / 1000, // 3 decimal precision
        _breakdown: {
            urgency: Math.round(urgency * 100) / 100,
            impact: Math.round(impact * 100) / 100,
            dependency: Math.round(dependency * 100) / 100,
            skipDecay: Math.round(skipDecay * 100) / 100,
            blockerBonus: Math.round(blockerBonus * 100) / 100,
            humanRequest: Math.round(humanRequest * 100) / 100,
            total: Math.round(total * 1000) / 1000,
        }
    };
}
/**
 * Score and rank all tasks. Returns sorted array, highest score first.
 * Also increments skipCount for tasks that aren't picked.
 */
function rankTasks(tasks, completedTasks = []) {
    if (tasks.length === 0)
        return [];
    const scored = tasks.map(t => scoreTask(t, tasks, completedTasks));
    scored.sort((a, b) => (b._score || 0) - (a._score || 0));
    return scored;
}
/**
 * Pick the best next task from a queue.
 * Returns the winner + the remaining queue (with skip counts updated).
 */
function pickNext(queue, completedTasks = []) {
    if (queue.length === 0)
        return null;
    const ranked = rankTasks(queue, completedTasks);
    const winner = ranked[0];
    // Increment skip count for losers
    const remaining = ranked.slice(1).map(t => ({
        ...t,
        skipCount: (t.skipCount || 0) + 1,
        // Strip computed fields before persisting
        _score: undefined,
        _breakdown: undefined,
    }));
    // Strip computed fields from winner too
    const cleanWinner = { ...winner, _score: undefined, _breakdown: undefined };
    return { next: cleanWinner, remaining };
}
/**
 * Infer category from task text if not explicitly set.
 * Simple keyword matching - better than nothing.
 */
function inferCategory(task) {
    const lower = task.toLowerCase();
    // Survival keywords
    if (/\b(boot|critical|broken|fix missing|can't function|blocker)\b/.test(lower)) {
        return 'survival';
    }
    // Memory keywords
    if (/\b(memory|consolidat|organiz|index|daily|session log|weight|manifest)\b/.test(lower)) {
        return 'memory';
    }
    // Infrastructure keywords  
    if (/\b(skill|tool|script|infra|pipeline|cron|automat|system)\b/.test(lower)) {
        return 'infrastructure';
    }
    // Expansion keywords
    if (/\b(build|expand|new capabilit|implement|create|design)\b/.test(lower)) {
        return 'expansion';
    }
    // Research keywords
    if (/\b(research|investigat|analyz|monitor|scan|review|explore)\b/.test(lower)) {
        return 'research';
    }
    // Maintenance keywords
    if (/\b(clean|refactor|update|minor|tidy|rename|reorganiz)\b/.test(lower)) {
        return 'maintenance';
    }
    return 'nice-to-have';
}
/**
 * Format a score for display (e.g., "0.723 [■■■■■■■···]")
 */
function formatScore(score) {
    const bars = Math.round(score * 10);
    const bar = '■'.repeat(bars) + '·'.repeat(10 - bars);
    return `${score.toFixed(3)} [${bar}]`;
}
/**
 * Format a full score breakdown for display
 */
function formatBreakdown(breakdown) {
    return [
        `  urgency:  ${breakdown.urgency.toFixed(2)} × ${WEIGHTS.urgency}`,
        `  impact:   ${breakdown.impact.toFixed(2)} × ${WEIGHTS.impact}`,
        `  dep:      ${breakdown.dependency.toFixed(2)} × ${WEIGHTS.dependency}`,
        `  skip:     ${breakdown.skipDecay.toFixed(2)} × ${WEIGHTS.skipDecay}`,
        `  blocker:  ${breakdown.blockerBonus.toFixed(2)} × ${WEIGHTS.blockerBonus}`,
        `  ─────────────────────`,
        `  TOTAL:    ${breakdown.total.toFixed(3)}`,
    ].join('\n');
}
// ─── Category emoji helpers ──────────────────────────────────────────────────
exports.CATEGORY_EMOJI = {
    'survival': '🔴',
    'memory': '🧠',
    'infrastructure': '🔧',
    'expansion': '🚀',
    'research': '🔍',
    'maintenance': '🧹',
    'nice-to-have': '✨',
};
// ─── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
    // Demo mode: show how scoring works
    const demoTasks = [
        {
            task: 'Fix missing memory structure',
            context: 'Critical blocker',
            priority: 1,
            category: 'survival',
            impact: 'critical',
            blocksOthers: true,
            createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
            task: 'Consolidate recent learnings',
            context: 'Knowledge fragmentation',
            priority: 2,
            category: 'memory',
            impact: 'medium',
            createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
            skipCount: 3,
        },
        {
            task: 'Build Twitter monitoring',
            context: 'Research infrastructure',
            priority: 3,
            category: 'research',
            impact: 'low',
            createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        },
        {
            task: 'Refactor boot script',
            context: 'Nice to have',
            priority: 4,
            category: 'nice-to-have',
            impact: 'low',
            createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
            skipCount: 8,
        },
    ];
    console.log('═══════════════════════════════════════════════════════════');
    console.log('     🧠 SMART TASK PRIORITIZATION - DEMO');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    const ranked = rankTasks(demoTasks);
    ranked.forEach((t, i) => {
        const emoji = t.category ? exports.CATEGORY_EMOJI[t.category] : '❓';
        console.log(`${i + 1}. ${emoji} ${t.task}`);
        console.log(`   Score: ${formatScore(t._score || 0)}`);
        if (t._breakdown) {
            console.log(formatBreakdown(t._breakdown));
        }
        console.log('');
    });
}
