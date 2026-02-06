#!/usr/bin/env node

/**
 * Memory search - semantic search across all memory files
 * Enables "what do I know about X?" queries
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = '/root/clawd';

class MemorySearch {
  constructor() {
    this.indexedFiles = new Map();
    this.buildIndex();
  }

  buildIndex() {
    const memoryDirs = [
      path.join(WORKSPACE, 'memory'),
      WORKSPACE // for SOUL.md, USER.md, etc.
    ];
    
    const skipFiles = ['node_modules', '.git', 'skills/memory-manager/src'];
    
    memoryDirs.forEach(dir => {
      if (fs.existsSync(dir)) {
        this.indexDirectory(dir, skipFiles);
      }
    });
  }

  indexDirectory(dir, skipFiles) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      const relativePath = path.relative(WORKSPACE, fullPath);
      
      // Skip unwanted directories
      if (skipFiles.some(skip => relativePath.includes(skip))) {
        continue;
      }
      
      if (item.isDirectory()) {
        this.indexDirectory(fullPath, skipFiles);
      } else if (item.name.endsWith('.md') || item.name.endsWith('.qmd')) {
        this.indexFile(fullPath);
      }
    }
  }

  indexFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const relativePath = path.relative(WORKSPACE, filePath);
      this.indexedFiles.set(relativePath, lines);
    } catch (err) {
      // Skip files that can't be read
    }
  }

  search(query, limit = 10) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const results = [];
    
    for (const [file, lines] of this.indexedFiles.entries()) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineLower = line.toLowerCase();
        
        // Calculate relevance score
        let relevance = 0;
        let matches = 0;
        
        queryWords.forEach(word => {
          if (lineLower.includes(word)) {
            matches++;
            // Exact word match gets higher score
            if (lineLower.includes(` ${word} `) || lineLower.startsWith(word) || lineLower.endsWith(word)) {
              relevance += 2;
            } else {
              relevance += 1;
            }
          }
        });
        
        if (matches > 0) {
          // Get context (lines before and after)
          const contextStart = Math.max(0, i - 2);
          const contextEnd = Math.min(lines.length, i + 3);
          const context = lines.slice(contextStart, contextEnd).join('\n');
          
          results.push({
            file,
            snippet: line.trim(),
            context,
            line: i + 1,
            relevance: relevance + (matches / queryWords.length) // bonus for matching multiple terms
          });
        }
      }
    }
    
    // Sort by relevance and return top results
    return results
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  searchInFile(filePath, query) {
    const relativePath = path.relative(WORKSPACE, filePath);
    const lines = this.indexedFiles.get(relativePath);
    
    if (!lines) {
      return [];
    }
    
    return this.search(query).filter(r => r.file === relativePath);
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`Usage: node src/search.js "<query>" [limit]`);
    console.log(`       node src/search.js file "<filepath>" "<query>"`);
    process.exit(1);
  }
  
  const search = new MemorySearch();
  
  if (args[0] === 'file' && args.length >= 3) {
    // Search in specific file
    const filePath = args[1];
    const query = args[2];
    const results = search.searchInFile(filePath, query);
    
    console.log(`\n🔍 SEARCH: "${query}" in ${filePath}`);
    console.log(`📝 Found ${results.length} results\n`);
    
    results.forEach(result => {
      console.log(`┌─ ${result.file}:${result.line} (${result.relevance})`);
      console.log(`│  ${result.snippet}`);
      console.log(`└─ Context:\n${result.context.split('\n').map(l => `   ${l}`).join('\n')}\n`);
    });
  } else {
    // Global search
    const query = args[0];
    const limit = args[1] ? parseInt(args[1]) : 10;
    const results = search.search(query, limit);
    
    console.log(`\n🔍 SEARCH: "${query}"`);
    console.log(`📝 Found ${results.length} results\n`);
    
    results.forEach(result => {
      console.log(`┌─ ${result.file}:${result.line} (score: ${result.relevance.toFixed(1)})`);
      console.log(`│  ${result.snippet}`);
      console.log(`└─ Context:\n${result.context.split('\n').map(l => `   ${l}`).join('\n')}\n`);
    });
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { MemorySearch };