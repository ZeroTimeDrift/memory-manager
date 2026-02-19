#!/usr/bin/env npx ts-node
"use strict";
/**
 * Task management - manage the next task and task queue
 * Now with SMART prioritization via scoring algorithm.
 *
 * Usage:
 *   task.ts next              - Show next task with score
 *   task.ts complete          - Complete current, pick highest-scored next
 *   task.ts add "task" "ctx"  - Add task to queue (auto-categorizes)
 *   task.ts list              - List all tasks ranked by score
 *   task.ts smart             - Generate intelligent next task
 *   task.ts score             - Show detailed score breakdown for all tasks
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
const child_process = __importStar(require("child_process"));
const prioritize_1 = require("./prioritize");
const task_prioritizer_1 = require("./task-prioritizer");
const MANIFEST_PATH = '/root/clawd/skills/memory-manager/manifest.json';
const WORKSPACE = '/root/clawd';
/**
 * Generate intelligent next task based on current context
 */
function generateIntelligentTask(manifest) {
    const memoryPath = path.join(WORKSPACE, 'memory');
    // Check for missing critical structure
    const criticalPaths = [
        'memory/index.md',
        'memory/daily',
        'MEMORY.md'
    ];
    for (const criticalPath of criticalPaths) {
        if (!fs.existsSync(path.join(WORKSPACE, criticalPath))) {
            return {
                task: 'Fix missing memory structure',
                context: `Critical: ${criticalPath} missing - agent can't function properly`,
                priority: 1,
                source: 'critical-blocker-detection',
                impact: 'critical',
                category: 'survival',
                tags: ['blocker', 'memory', 'critical'],
                blocksOthers: true,
                createdAt: new Date().toISOString()
            };
        }
    }
    // Check for stale files (>3 days old)
    const dailyPath = path.join(memoryPath, 'daily');
    if (fs.existsSync(dailyPath)) {
        const dailyFiles = fs.readdirSync(dailyPath);
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        const staleFiles = dailyFiles.filter(file => {
            const filePath = path.join(dailyPath, file);
            const stats = fs.statSync(filePath);
            return stats.mtime < threeDaysAgo;
        });
        if (staleFiles.length > 2) {
            return {
                task: 'Refresh stale memory files',
                context: `${staleFiles.length} daily files need updating: ${staleFiles.slice(0, 3).join(', ')}`,
                priority: 2,
                source: 'staleness-analysis',
                impact: 'medium',
                category: 'memory',
                tags: ['stale', 'memory', 'organization'],
                createdAt: new Date().toISOString()
            };
        }
    }
    // Check recent activity (files modified in last 24h)
    let recentActivityCount = 0;
    function countRecent(dir) {
        if (!fs.existsSync(dir))
            return;
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);
            if (stats.isFile() && stats.mtime > oneDayAgo) {
                recentActivityCount++;
            }
            else if (stats.isDirectory() && file !== '.git') {
                countRecent(filePath);
            }
        });
    }
    countRecent(memoryPath);
    if (recentActivityCount > 5) {
        return {
            task: 'Consolidate recent learnings',
            context: `High activity: ${recentActivityCount} files modified recently. Time to synthesize insights.`,
            priority: 2,
            source: 'knowledge-fragmentation-detection',
            impact: 'medium',
            category: 'memory',
            tags: ['consolidation', 'memory', 'synthesis'],
            createdAt: new Date().toISOString()
        };
    }
    // Topic-driven tasks
    if (manifest.recentTopics && manifest.recentTopics.length > 0) {
        const focusTopic = manifest.recentTopics[0];
        return {
            task: `Advance ${focusTopic} understanding`,
            context: `Recent focus on ${focusTopic} - continue building expertise in this area`,
            priority: 2,
            source: 'topic-momentum-analysis',
            impact: 'medium',
            category: 'expansion',
            tags: [focusTopic, 'learning', 'growth'],
            createdAt: new Date().toISOString()
        };
    }
    // Strategic default
    return {
        task: 'Design next capability expansion',
        context: 'System is stable. Time to plan strategic improvement in core functions.',
        priority: 3,
        source: 'strategic-planning',
        impact: 'medium',
        category: 'expansion',
        tags: ['strategy', 'planning', 'growth'],
        createdAt: new Date().toISOString()
    };
}
function loadManifest() {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
}
function saveManifest(manifest) {
    // Strip computed fields before saving
    const clean = JSON.parse(JSON.stringify(manifest));
    if (clean.nextTask) {
        delete clean.nextTask._score;
        delete clean.nextTask._breakdown;
    }
    if (clean.taskQueue) {
        clean.taskQueue = clean.taskQueue.map((t) => {
            delete t._score;
            delete t._breakdown;
            return t;
        });
    }
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(clean, null, 2));
}
/**
 * Backfill category/tags on tasks that don't have them yet
 */
function backfillTask(task) {
    if (!task.category) {
        task.category = (0, prioritize_1.inferCategory)(task.task);
    }
    if (!task.tags || task.tags.length === 0) {
        task.tags = [task.category];
    }
    if (!task.createdAt) {
        task.createdAt = new Date().toISOString();
    }
    return task;
}
const command = process.argv[2];
switch (command) {
    case 'next': {
        const manifest = loadManifest();
        const task = backfillTask(manifest.nextTask);
        const scored = (0, prioritize_1.scoreTask)(task, manifest.taskQueue);
        const emoji = task.category ? prioritize_1.CATEGORY_EMOJI[task.category] : '📋';
        console.log(`${emoji} NEXT TASK:`);
        console.log(`   ${scored.task}`);
        console.log(`   Context: ${scored.context}`);
        console.log(`   Score: ${(0, prioritize_1.formatScore)(scored._score || 0)}`);
        console.log(`   Category: ${scored.category || 'unset'} | Impact: ${scored.impact || 'unset'}`);
        if (scored.tags?.length) {
            console.log(`   Tags: ${scored.tags.join(', ')}`);
        }
        if (scored.source) {
            console.log(`   Source: ${scored.source}`);
        }
        break;
    }
    case 'complete': {
        const manifest = loadManifest();
        const completed = manifest.nextTask;
        // Record session in history for streak/cooldown tracking
        // NOTE: recordSession writes directly to manifest.json, so we must
        // reload the manifest after calling it to avoid clobbering the history.
        const completedCategory = completed.category || (0, prioritize_1.inferCategory)(completed.task);
        (0, task_prioritizer_1.recordSession)(completedCategory === 'memory' && /consolidat/i.test(completed.task) ? 'consolidation' : completedCategory, completed.task, 'completed');
        // Reload manifest to pick up the recorded session history AND completed strategic tasks
        const freshManifest = loadManifest();
        manifest.sessionHistory = freshManifest.sessionHistory;
        manifest.completedStrategicTasks = freshManifest.completedStrategicTasks;
        if (manifest.taskQueue.length > 0) {
            // Backfill all tasks then use smart scoring to pick next
            manifest.taskQueue = manifest.taskQueue.map(backfillTask);
            const result = (0, prioritize_1.pickNext)(manifest.taskQueue);
            if (result) {
                manifest.nextTask = result.next;
                manifest.taskQueue = result.remaining;
            }
            else {
                // Shouldn't happen since queue.length > 0, but handle gracefully
                manifest.nextTask = manifest.taskQueue.shift();
            }
        }
        else {
            // No tasks in queue - use smart prioritizer (v2 with streak detection)
            console.log('🧠 No tasks queued. Generating intelligent next task (v2)...');
            const smartTask = (0, task_prioritizer_1.generateIntelligentTask)(manifest);
            manifest.nextTask = {
                task: smartTask.task,
                context: smartTask.context,
                priority: smartTask.priority,
                source: smartTask.source,
                impact: smartTask.impact,
                category: (smartTask.category || 'memory'),
                tags: [smartTask.category || 'general'],
                createdAt: new Date().toISOString(),
                blocksOthers: smartTask.blocksOthers,
            };
        }
        // Ensure nextTask has a createdAt
        if (!manifest.nextTask.createdAt) {
            manifest.nextTask.createdAt = new Date().toISOString();
        }
        saveManifest(manifest);
        console.log('✅ Completed:', completed.task);
        // Auto-run session summarization
        try {
            console.log('');
            console.log('📝 GENERATING SESSION SUMMARY...');
            const summaryResult = child_process.execSync('npx ts-node src/session-summary.ts --update-daily', {
                cwd: '/root/clawd/skills/memory-manager',
                encoding: 'utf-8'
            });
            console.log(summaryResult);
        }
        catch (e) {
            console.log('⚠️  Session summary generation failed:', e.message);
        }
        const nextEmoji = manifest.nextTask.category ? prioritize_1.CATEGORY_EMOJI[manifest.nextTask.category] : '📋';
        console.log(`${nextEmoji} NEW NEXT TASK:`);
        console.log(`   ${manifest.nextTask.task}`);
        break;
    }
    case 'add': {
        const taskText = process.argv[3];
        const context = process.argv[4] || '';
        const priority = parseInt(process.argv[5] || '2', 10);
        const categoryArg = process.argv[6];
        const impactArg = process.argv[7];
        if (!taskText) {
            console.log('Usage: task.ts add "task" "context" [priority] [category] [impact]');
            console.log('');
            console.log('Categories: survival, memory, infrastructure, expansion, research, maintenance, nice-to-have');
            console.log('Impact: critical, high, medium, low');
            process.exit(1);
        }
        const category = categoryArg || (0, prioritize_1.inferCategory)(taskText);
        const impact = impactArg || 'medium';
        const manifest = loadManifest();
        const newTask = {
            task: taskText,
            context,
            priority,
            category,
            impact,
            tags: [category],
            createdAt: new Date().toISOString(),
            skipCount: 0,
        };
        manifest.taskQueue.push(newTask);
        saveManifest(manifest);
        const emoji = prioritize_1.CATEGORY_EMOJI[category];
        console.log(`✅ Added: ${emoji} ${taskText}`);
        console.log(`   Category: ${category} | Impact: ${impact} | Priority: P${priority}`);
        console.log(`   Queue length: ${manifest.taskQueue.length}`);
        break;
    }
    case 'list': {
        const manifest = loadManifest();
        // Score and display the current next task
        const nextTask = backfillTask(manifest.nextTask);
        const scoredNext = (0, prioritize_1.scoreTask)(nextTask, manifest.taskQueue);
        const nextEmoji = nextTask.category ? prioritize_1.CATEGORY_EMOJI[nextTask.category] : '📋';
        console.log('═══════════════════════════════════════════════════════════');
        console.log('     🧠 TASK QUEUE — SMART PRIORITIZATION');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log(`${nextEmoji} ACTIVE TASK:`);
        console.log(`   → ${scoredNext.task}`);
        console.log(`     Score: ${(0, prioritize_1.formatScore)(scoredNext._score || 0)}`);
        console.log(`     Category: ${scoredNext.category || '?'} | Impact: ${scoredNext.impact || '?'}`);
        if (scoredNext.source) {
            console.log(`     Source: ${scoredNext.source}`);
        }
        console.log('');
        console.log('📌 QUEUED TASKS (ranked by score):');
        if (manifest.taskQueue.length === 0) {
            console.log('   (empty — will auto-generate on completion)');
        }
        else {
            // Backfill and rank
            const backfilled = manifest.taskQueue.map(backfillTask);
            const ranked = (0, prioritize_1.rankTasks)(backfilled);
            ranked.forEach((t, i) => {
                const emoji = t.category ? prioritize_1.CATEGORY_EMOJI[t.category] : '❓';
                const skipTag = (t.skipCount && t.skipCount > 0) ? ` (skipped ×${t.skipCount})` : '';
                console.log(`   ${i + 1}. ${emoji} ${t.task}`);
                console.log(`      Score: ${(0, prioritize_1.formatScore)(t._score || 0)}${skipTag}`);
                if (t.tags?.length) {
                    console.log(`      Tags: ${t.tags.join(', ')}`);
                }
            });
        }
        console.log('');
        console.log('═══════════════════════════════════════════════════════════');
        break;
    }
    case 'score': {
        // Detailed score breakdown for debugging/understanding
        const manifest = loadManifest();
        console.log('═══════════════════════════════════════════════════════════');
        console.log('     📊 DETAILED SCORE BREAKDOWN');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        const allTasks = [manifest.nextTask, ...manifest.taskQueue].map(backfillTask);
        const ranked = (0, prioritize_1.rankTasks)(allTasks);
        ranked.forEach((t, i) => {
            const emoji = t.category ? prioritize_1.CATEGORY_EMOJI[t.category] : '❓';
            const active = (t.task === manifest.nextTask.task) ? ' ← ACTIVE' : '';
            console.log(`${i + 1}. ${emoji} ${t.task}${active}`);
            console.log(`   Score: ${(0, prioritize_1.formatScore)(t._score || 0)}`);
            if (t._breakdown) {
                console.log((0, prioritize_1.formatBreakdown)(t._breakdown));
            }
            console.log('');
        });
        console.log('═══════════════════════════════════════════════════════════');
        break;
    }
    case 'smart': {
        const manifest = loadManifest();
        console.log('🧠 GENERATING INTELLIGENT NEXT TASK (v2)...\n');
        const smartTask = (0, task_prioritizer_1.generateIntelligentTask)(manifest);
        const scoredTask = {
            task: smartTask.task,
            context: smartTask.context,
            priority: smartTask.priority,
            source: smartTask.source,
            impact: smartTask.impact,
            category: (smartTask.category || 'memory'),
            tags: [smartTask.category || 'general'],
            createdAt: new Date().toISOString(),
        };
        const scored = (0, prioritize_1.scoreTask)(scoredTask);
        const emoji = smartTask.category ? prioritize_1.CATEGORY_EMOJI[smartTask.category] || '🎯' : '🎯';
        console.log(`${emoji} RECOMMENDED TASK:`);
        console.log(`   Task: ${smartTask.task}`);
        console.log(`   Context: ${smartTask.context}`);
        console.log(`   Score: ${(0, prioritize_1.formatScore)(scored._score || 0)}`);
        console.log(`   Category: ${smartTask.category} | Impact: ${smartTask.impact}`);
        console.log(`   Source: ${smartTask.source}`);
        if (smartTask.blocksOthers)
            console.log(`   🚫 Blocks other progress`);
        break;
    }
    case 'abandon': {
        // Abandon a task with a reason — removes from queue, logs to graveyard
        const targetArg = process.argv[3]; // task number (1-indexed) or "active"
        const reason = process.argv.slice(4).join(' ') || 'no longer relevant';
        if (!targetArg) {
            console.log('Usage: task.ts abandon <number|active> [reason]');
            console.log('  abandon active "overtaken by session indexing"');
            console.log('  abandon 1 "duplicate"');
            console.log('  abandon all-stale    — auto-detect and abandon stale tasks');
            process.exit(1);
        }
        const manifest = loadManifest();
        const graveyardPath = path.join(WORKSPACE, 'memory', 'task-graveyard.md');
        const timestamp = new Date().toISOString();
        const today = timestamp.split('T')[0];
        // Ensure graveyard file exists
        if (!fs.existsSync(graveyardPath)) {
            fs.writeFileSync(graveyardPath, `# Task Graveyard\n\nAbandoned tasks with reasons. Patterns here reveal planning failures.\n\n`);
        }
        let abandoned = [];
        if (targetArg === 'active') {
            abandoned.push(manifest.nextTask);
            // Promote next from queue
            if (manifest.taskQueue.length > 0) {
                const backfilled = manifest.taskQueue.map(backfillTask);
                const result = (0, prioritize_1.pickNext)(backfilled);
                if (result) {
                    manifest.nextTask = result.next;
                    manifest.taskQueue = result.remaining;
                }
                else {
                    manifest.nextTask = manifest.taskQueue.shift();
                }
            }
            else {
                manifest.nextTask = generateIntelligentTask(manifest);
            }
        }
        else if (targetArg === 'all-stale') {
            // Auto-detect stale tasks: duplicates, already-done, or old low-impact
            const seen = new Set();
            const alive = [];
            // Check active task too
            const activeKey = manifest.nextTask.task.toLowerCase().trim();
            seen.add(activeKey);
            for (const task of manifest.taskQueue) {
                const key = task.task.toLowerCase().trim();
                // Duplicate detection
                if (seen.has(key)) {
                    abandoned.push({ ...task, context: 'duplicate' });
                    continue;
                }
                seen.add(key);
                // Old + low impact + high skip count = stale
                const ageHours = task.createdAt
                    ? (Date.now() - new Date(task.createdAt).getTime()) / (1000 * 60 * 60)
                    : 999;
                const isStale = ageHours > 168 && (task.skipCount || 0) > 5 &&
                    ['maintenance', 'nice-to-have', 'research'].includes(task.category || '');
                if (isStale) {
                    abandoned.push({ ...task, context: 'stale (old + skipped + low priority)' });
                    continue;
                }
                alive.push(task);
            }
            manifest.taskQueue = alive;
        }
        else {
            // Abandon by index
            const idx = parseInt(targetArg, 10) - 1;
            if (idx >= 0 && idx < manifest.taskQueue.length) {
                abandoned.push(manifest.taskQueue[idx]);
                manifest.taskQueue.splice(idx, 1);
            }
            else {
                console.log(`❌ Invalid task number: ${targetArg} (queue has ${manifest.taskQueue.length} tasks)`);
                process.exit(1);
            }
        }
        // Log to graveyard
        if (abandoned.length > 0) {
            let entry = `\n## ${today}\n`;
            for (const task of abandoned) {
                const autoReason = task.context && ['duplicate', 'stale'].some(s => task.context?.includes(s))
                    ? task.context
                    : reason;
                entry += `- **Abandoned:** ${task.task}\n`;
                entry += `  - Reason: ${autoReason}\n`;
                entry += `  - Category: ${task.category || '?'} | Created: ${task.createdAt?.split('T')[0] || '?'} | Skips: ${task.skipCount || 0}\n`;
            }
            fs.appendFileSync(graveyardPath, entry);
            saveManifest(manifest);
            console.log(`🪦 Abandoned ${abandoned.length} task(s):`);
            for (const task of abandoned) {
                console.log(`   ☠️  ${task.task}`);
            }
            console.log(`\n📝 Logged to memory/task-graveyard.md`);
        }
        else {
            console.log('ℹ️  No tasks to abandon.');
        }
        break;
    }
    default:
        console.log('Usage: task.ts <next|complete|add|list|smart|score|abandon>');
        console.log('');
        console.log('Commands:');
        console.log('  next              Show next task with score');
        console.log('  complete          Complete current task, pick highest-scored next');
        console.log('  add "task" "ctx"  Add task to queue (auto-categorizes)');
        console.log('  list              List all tasks ranked by score');
        console.log('  score             Detailed score breakdown for all tasks');
        console.log('  smart             Generate intelligent task recommendation');
        console.log('  abandon <n|active|all-stale> [reason]  Kill stale/dead tasks');
}
