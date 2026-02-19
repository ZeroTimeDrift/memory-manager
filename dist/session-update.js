#!/usr/bin/env npx ts-node
"use strict";
/**
 * Session update script - automatically update memory weights after sessions
 * Updates access counts, last access dates, and weights based on session activity
 *
 * Usage:
 *   session-update.ts [files_accessed...]
 *
 * If no files provided, analyzes recent memory files for session activity
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
const MANIFEST_PATH = '/root/clawd/skills/memory-manager/manifest.json';
const WORKSPACE = '/root/clawd';
function loadManifest() {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
}
function saveManifest(manifest) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}
function updateFileWeight(entry) {
    // Base weight adjustment logic
    const accessBoost = entry.accessCount > 5 ? 0.05 : 0.02;
    const recencyBoost = 0.02; // Small boost for recent access
    // Different rules for different file types
    switch (entry.type) {
        case 'core':
            // Core files maintain weight but get slight access boost
            entry.weight = Math.min(1.0, entry.weight + accessBoost);
            break;
        case 'recent':
            // Recent files get bigger boost but have decay
            entry.weight = Math.min(0.95, entry.weight + recencyBoost + accessBoost);
            break;
        case 'topic':
            // Topic files get moderate boost and can grow in importance
            entry.weight = Math.min(0.9, entry.weight + accessBoost);
            break;
        default:
            // Standard files get small boost
            entry.weight = Math.min(0.8, entry.weight + accessBoost);
    }
}
function scanForAccessedFiles() {
    const today = new Date().toISOString().split('T')[0];
    const dailyFile = path.join(WORKSPACE, 'memory', 'daily', `${today}.md`);
    const sessionDir = path.join(WORKSPACE, 'memory', 'sessions');
    const accessedFiles = new Set();
    // Check daily file for references
    try {
        const dailyContent = fs.readFileSync(dailyFile, 'utf-8');
        // Look for file references in the daily content
        const fileMatches = dailyContent.match(/[\w\/\.-]+\.(?:md|qmd)/g);
        if (fileMatches) {
            fileMatches.forEach(file => {
                // Filter out template patterns and validate file exists
                if (!file.includes('YYYY') && !file.includes('XX')) {
                    const fullPath = path.isAbsolute(file) ? file : path.join(WORKSPACE, file);
                    if (fs.existsSync(fullPath)) {
                        accessedFiles.add(file);
                    }
                }
            });
        }
    }
    catch (e) {
        // Daily file might not exist
    }
    // Check recent session files (last 2 hours)
    try {
        const sessions = fs.readdirSync(sessionDir);
        const recentSessions = sessions
            .filter(file => file.endsWith('.md'))
            .filter(file => {
            const filePath = path.join(sessionDir, file);
            const stats = fs.statSync(filePath);
            const hoursSinceModified = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
            return hoursSinceModified < 2;
        });
        recentSessions.forEach(sessionFile => {
            const sessionPath = path.join(sessionDir, sessionFile);
            const content = fs.readFileSync(sessionPath, 'utf-8');
            const fileMatches = content.match(/[\w\/\.-]+\.(?:md|qmd)/g);
            if (fileMatches) {
                fileMatches.forEach(file => {
                    // Filter out template patterns and validate file exists
                    if (!file.includes('YYYY') && !file.includes('XX')) {
                        const fullPath = path.isAbsolute(file) ? file : path.join(WORKSPACE, file);
                        if (fs.existsSync(fullPath)) {
                            accessedFiles.add(file);
                        }
                    }
                });
            }
        });
    }
    catch (e) {
        // Session directory might not exist
    }
    return Array.from(accessedFiles);
}
function updateWeights(accessedFiles) {
    const manifest = loadManifest();
    const today = new Date().toISOString().split('T')[0];
    const sessionTime = new Date().toISOString();
    console.log('📊 UPDATING MEMORY WEIGHTS');
    console.log(`   Session time: ${sessionTime}`);
    console.log(`   Files accessed: ${accessedFiles.length}`);
    console.log('');
    // Update accessed files
    accessedFiles.forEach(file => {
        // Normalize file path
        let normalizedPath = file;
        if (normalizedPath.startsWith(WORKSPACE)) {
            normalizedPath = path.relative(WORKSPACE, normalizedPath);
        }
        // Get or create file entry
        if (!manifest.files[normalizedPath]) {
            // New file discovered
            manifest.files[normalizedPath] = {
                weight: 0.3,
                type: 'topic',
                lastAccess: today,
                accessCount: 1,
                decayRate: 0.05,
                summary: `File ${normalizedPath} - auto-discovered`
            };
            console.log(`   + NEW: ${normalizedPath} (weight: 0.3)`);
        }
        else {
            // Update existing file
            const entry = manifest.files[normalizedPath];
            const oldWeight = entry.weight;
            entry.lastAccess = today;
            entry.accessCount += 1;
            updateFileWeight(entry);
            console.log(`   ↑ ${normalizedPath}: ${oldWeight.toFixed(2)} → ${entry.weight.toFixed(2)} (count: ${entry.accessCount})`);
        }
    });
    // Apply decay to files NOT accessed
    Object.entries(manifest.files).forEach(([filepath, entry]) => {
        if (!accessedFiles.includes(filepath)) {
            const daysSinceAccess = Math.floor((Date.now() - new Date(entry.lastAccess).getTime()) / (1000 * 60 * 60 * 24));
            if (daysSinceAccess > 0 && entry.type !== 'core') {
                const decayAmount = daysSinceAccess * (manifest.config.weightDecayPerDay || 0.1) * entry.decayRate;
                const minWeight = entry.type === 'core' ? (manifest.config.minCoreWeight || 0.5) : 0.1;
                const oldWeight = entry.weight;
                entry.weight = Math.max(minWeight, entry.weight - decayAmount);
                if (oldWeight !== entry.weight) {
                    console.log(`   ↓ ${filepath}: ${oldWeight.toFixed(2)} → ${entry.weight.toFixed(2)} (decay: ${decayAmount.toFixed(3)})`);
                }
            }
        }
    });
    // Update session info
    manifest.lastSession = {
        date: sessionTime,
        focus: 'session-update',
        outcome: 'weights-updated',
        filesAccessed: accessedFiles,
        notes: `Updated weights for ${accessedFiles.length} accessed files`
    };
    console.log('');
    console.log('💾 SAVING MANIFEST');
    saveManifest(manifest);
    console.log('✅ Weight updates complete');
}
// Main execution
const providedFiles = process.argv.slice(2);
if (providedFiles.length > 0) {
    // Use provided file list
    console.log('Using provided file list...');
    updateWeights(providedFiles);
}
else {
    // Scan for accessed files
    console.log('Scanning for accessed files...');
    const accessedFiles = scanForAccessedFiles();
    if (accessedFiles.length === 0) {
        console.log('No accessed files found. No weight updates needed.');
    }
    else {
        updateWeights(accessedFiles);
    }
}
