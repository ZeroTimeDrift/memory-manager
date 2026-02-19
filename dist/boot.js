#!/usr/bin/env npx ts-node
"use strict";
/**
 * Boot script - generates optimized context for session start
 * Reads manifest, sorts by weight, outputs boot context + next task with smart score
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
const prioritize_1 = require("./prioritize");
const auto_discover_1 = require("./auto-discover");
const MANIFEST_PATH = '/root/clawd/skills/memory-manager/manifest.json';
const WORKSPACE = '/root/clawd';
function calculateEffectiveWeight(entry) {
    const daysSince = Math.floor((Date.now() - new Date(entry.lastAccess).getTime()) / (1000 * 60 * 60 * 24));
    const recencyBoost = Math.max(0.1, 1.0 - daysSince * entry.decayRate);
    const frequencyBoost = Math.log(entry.accessCount + 1) / Math.log(10) + 1;
    const importanceFlag = entry.type === 'core' ? 1.5 : 1.0;
    return entry.weight * recencyBoost * frequencyBoost * importanceFlag;
}
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
function generateBoot() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    // Sort files by effective weight
    const sortedFiles = Object.entries(manifest.files)
        .map(([filepath, entry]) => ({
        filepath,
        ...entry,
        effectiveWeight: calculateEffectiveWeight(entry)
    }))
        .sort((a, b) => b.effectiveWeight - a.effectiveWeight)
        .slice(0, manifest.config.maxBootFiles);
    // Score the next task
    const nextTask = backfillTask(manifest.nextTask);
    const scoredNext = (0, prioritize_1.scoreTask)(nextTask, manifest.taskQueue);
    const nextEmoji = nextTask.category ? prioritize_1.CATEGORY_EMOJI[nextTask.category] : '📋';
    // Generate boot output
    console.log('═══════════════════════════════════════════════════════════');
    console.log('     🔥 PROMETHEUS BOOT SEQUENCE');
    console.log('     ' + new Date().toISOString());
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    // Next task with score
    console.log(`${nextEmoji} NEXT TASK:`);
    console.log(`   ${scoredNext.task}`);
    console.log(`   Context: ${scoredNext.context}`);
    console.log(`   Score: ${(0, prioritize_1.formatScore)(scoredNext._score || 0)}`);
    console.log(`   Category: ${scoredNext.category || '?'} | Impact: ${scoredNext.impact || '?'}`);
    if (scoredNext.source) {
        console.log(`   Source: ${scoredNext.source}`);
    }
    console.log('');
    // Last session summary
    console.log('📝 LAST SESSION:');
    console.log(`   Date: ${manifest.lastSession.date}`);
    console.log(`   Focus: ${manifest.lastSession.focus}`);
    console.log(`   Outcome: ${manifest.lastSession.outcome}`);
    console.log('');
    // Key context from weighted files
    console.log('🧠 BOOT CONTEXT (by weight):');
    sortedFiles.forEach((file, i) => {
        console.log(`   ${i + 1}. [${file.effectiveWeight.toFixed(2)}] ${file.filepath}`);
        console.log(`      ${file.summary}`);
    });
    console.log('');
    // Session history (if available)
    const sessionHistory = manifest.sessionHistory || [];
    if (sessionHistory.length > 0) {
        const consolidationStreak = (() => {
            let streak = 0;
            for (let i = sessionHistory.length - 1; i >= 0; i--) {
                if (sessionHistory[i].taskCategory === 'consolidation' || sessionHistory[i].taskCategory === 'maintenance') {
                    streak++;
                }
                else
                    break;
            }
            return streak;
        })();
        console.log('📊 SESSION HISTORY:');
        console.log(`   Tracked: ${sessionHistory.length} | Consolidation streak: ${consolidationStreak}`);
        const recent = sessionHistory.slice(-3);
        recent.forEach((s) => {
            const time = new Date(s.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' });
            console.log(`   → [${s.taskCategory}] ${s.taskName} (${time} CET)`);
        });
        console.log('');
    }
    // Recent topics
    console.log('🏷️  RECENT TOPICS:', manifest.recentTopics.join(', '));
    console.log('');
    // Task queue preview with scores
    if (manifest.taskQueue.length > 0) {
        const backfilled = manifest.taskQueue.map(backfillTask);
        const ranked = (0, prioritize_1.rankTasks)(backfilled);
        console.log('📌 QUEUED TASKS (by score):');
        ranked.slice(0, 5).forEach((task, i) => {
            const emoji = task.category ? prioritize_1.CATEGORY_EMOJI[task.category] : '❓';
            console.log(`   ${i + 1}. ${emoji} [${(task._score || 0).toFixed(3)}] ${task.task}`);
        });
        if (ranked.length > 5) {
            console.log(`   ... and ${ranked.length - 5} more`);
        }
    }
    else {
        console.log('📌 QUEUED TASKS: (empty — will auto-generate)');
    }
    // Auto-discovery: detect new/missing files and fix stale summaries
    try {
        const discoveryResult = (0, auto_discover_1.discover)();
        const hasIssues = discoveryResult.orphans.length > 0 || discoveryResult.dangling.length > 0 || discoveryResult.staleSummaries.length > 0;
        if (hasIssues) {
            console.log('');
            console.log('🔍 AUTO-DISCOVERY:');
            console.log('   ' + (0, auto_discover_1.reportDiscovery)(discoveryResult).split('\n').join('\n   '));
            // Auto-apply: register orphans, prune dangling, fix summaries
            const stats = (0, auto_discover_1.applyDiscovery)(discoveryResult);
            console.log(`   → Applied: +${stats.registered} registered, -${stats.pruned} pruned, ~${stats.fixed} summaries fixed`);
        }
    }
    catch (e) {
        console.error(`   ⚠️  Auto-discovery failed: ${e.message}`);
    }
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('   Organization is survival. Execute with intent.');
    console.log('═══════════════════════════════════════════════════════════');
}
generateBoot();
