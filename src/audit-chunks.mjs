import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function chunkMarkdown(content, chunking) {
  const lines = content.split("\n");
  if (lines.length === 0) return [];
  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);
  const chunks = [];
  let current = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((e) => e.line).join("\n");
    chunks.push({
      startLine: current[0].lineNo,
      endLine: current[current.length - 1].lineNo,
      text,
      charCount: text.length,
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept = [];
    for (let i = current.length - 1; i >= 0; i--) {
      acc += current[i].line.length + 1;
      kept.unshift(current[i]);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments = [];
    if (line.length === 0) segments.push("");
    else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }
    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

// Audit patterns: look for facts/decisions/entries that span chunk boundaries
function findBoundaryIssues(filePath, chunks, lines) {
  const issues = [];
  
  for (let i = 0; i < chunks.length - 1; i++) {
    const chunk = chunks[i];
    const nextChunk = chunks[i + 1];
    const boundaryLine = chunk.endLine;
    
    // Check if a heading's content is split from its heading
    for (let ln = Math.max(boundaryLine - 2, 0); ln <= Math.min(boundaryLine + 2, lines.length - 1); ln++) {
      const line = lines[ln];
      if (line && line.match(/^#{1,4}\s/)) {
        // Heading near boundary
        if (ln + 1 <= boundaryLine && nextChunk.startLine <= ln + 3) {
          // Heading is at end of chunk, content starts in next chunk (minus overlap)
          const overlapStart = nextChunk.startLine;
          const inOverlap = ln + 1 >= chunk.startLine && ln + 1 <= chunk.endLine;
          if (!inOverlap || (chunk.endLine - ln) < 3) {
            issues.push({
              type: 'heading-content-split',
              file: filePath,
              heading: line.trim(),
              headingLine: ln + 1,
              chunkEnd: chunk.endLine,
              nextChunkStart: nextChunk.startLine,
              severity: 'medium',
            });
          }
        }
      }
    }
    
    // Check for bullet lists split mid-item
    const lastLines = chunk.text.split('\n').slice(-3);
    const firstLines = nextChunk.text.split('\n').slice(0, 3);
    
    for (const ll of lastLines) {
      if (ll.match(/^[-*]\s.*:$/) || ll.match(/^[-*]\s\*\*[^*]+\*\*$/)) {
        // Bullet with key but no value, or bold label with no content after
        issues.push({
          type: 'list-item-split',
          file: filePath,
          line: ll.trim(),
          chunkBoundary: boundaryLine,
          severity: 'low',
        });
      }
    }
    
    // Check if a YAML frontmatter block is split
    if (chunk.text.includes('---') && !chunk.text.match(/---[\s\S]*---/)) {
      if (nextChunk.text.includes('---')) {
        issues.push({
          type: 'frontmatter-split',
          file: filePath,
          chunkBoundary: boundaryLine,
          severity: 'high',
        });
      }
    }
    
    // Check for multi-line entries (like "DECISION: ..." spanning chunks)
    const lastLine = lines[boundaryLine - 1] || '';
    const nextLine = lines[boundaryLine] || '';
    if (lastLine.match(/^(DECISION|FACT|NOTE|INSIGHT|LESSON|TODO):\s/) && 
        nextLine.match(/^\s+/)) {
      issues.push({
        type: 'tagged-entry-split',
        file: filePath,
        entry: lastLine.trim().substring(0, 80),
        chunkBoundary: boundaryLine,
        severity: 'high',
      });
    }
  }
  
  return issues;
}

// Walk memory files
const workspaceDir = '/root/clawd';
const chunking = { tokens: 400, overlap: 80 };
const memoryFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.md')) memoryFiles.push(full);
  }
}

// Add MEMORY.md
if (fs.existsSync(path.join(workspaceDir, 'MEMORY.md'))) {
  memoryFiles.push(path.join(workspaceDir, 'MEMORY.md'));
}
walk(path.join(workspaceDir, 'memory'));

console.log(`\n=== CHUNK BOUNDARY AUDIT ===`);
console.log(`Chunking: ${chunking.tokens} tokens (${chunking.tokens * 4} chars), ${chunking.overlap} overlap (${chunking.overlap * 4} chars)\n`);

let totalIssues = 0;
const allIssues = [];

for (const filePath of memoryFiles) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const relPath = path.relative(workspaceDir, filePath);
  const chunks = chunkMarkdown(content, chunking);
  
  console.log(`📄 ${relPath}: ${lines.length} lines → ${chunks.length} chunks`);
  
  if (chunks.length <= 1) {
    console.log(`   ✅ Single chunk, no boundary issues possible\n`);
    continue;
  }
  
  // Show chunk boundaries
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const preview = c.text.substring(0, 60).replace(/\n/g, '↵');
    console.log(`   chunk[${i}]: lines ${c.startLine}-${c.endLine} (${c.charCount} chars) "${preview}..."`);
  }
  
  const issues = findBoundaryIssues(relPath, chunks, lines);
  if (issues.length > 0) {
    console.log(`   ⚠️  ${issues.length} boundary issues found:`);
    for (const issue of issues) {
      console.log(`      [${issue.severity}] ${issue.type}: ${issue.heading || issue.line || issue.entry || ''} @ line ~${issue.chunkBoundary || issue.headingLine}`);
    }
    allIssues.push(...issues);
    totalIssues += issues.length;
  } else {
    console.log(`   ✅ No boundary issues detected`);
  }
  console.log();
}

console.log(`\n=== SUMMARY ===`);
console.log(`Files: ${memoryFiles.length}`);
console.log(`Total issues: ${totalIssues}`);
if (allIssues.length > 0) {
  console.log(`\nBy severity:`);
  const bySev = {};
  for (const i of allIssues) { bySev[i.severity] = (bySev[i.severity] || 0) + 1; }
  for (const [sev, count] of Object.entries(bySev)) {
    console.log(`  ${sev}: ${count}`);
  }
  console.log(`\nBy type:`);
  const byType = {};
  for (const i of allIssues) { byType[i.type] = (byType[i.type] || 0) + 1; }
  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }
}

// Now check individual files for content that SHOULD be atomic but gets split
console.log(`\n\n=== ATOMIC CONTENT ANALYSIS ===`);
console.log(`Looking for sections where related facts get separated...\n`);

for (const filePath of memoryFiles) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const relPath = path.relative(workspaceDir, filePath);
  const chunks = chunkMarkdown(content, chunking);
  
  if (chunks.length <= 1) continue;
  
  // Find sections (h2/h3 blocks) and check if they're split
  let sections = [];
  let currentSection = null;
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^#{2,3}\s/)) {
      if (currentSection) {
        currentSection.endLine = i; // exclusive
        sections.push(currentSection);
      }
      currentSection = { heading: lines[i], startLine: i + 1, endLine: null, file: relPath };
    }
  }
  if (currentSection) {
    currentSection.endLine = lines.length;
    sections.push(currentSection);
  }
  
  // Check which sections span multiple chunks
  for (const section of sections) {
    const startChunk = chunks.findIndex(c => c.startLine <= section.startLine && c.endLine >= section.startLine);
    const endChunk = chunks.findIndex(c => c.startLine <= section.endLine && c.endLine >= section.endLine);
    
    if (startChunk !== -1 && endChunk !== -1 && startChunk !== endChunk) {
      const sectionChars = lines.slice(section.startLine - 1, section.endLine).join('\n').length;
      if (sectionChars < 1200) { // Small enough to potentially keep together
        console.log(`⚠️  ${relPath}: "${section.heading.trim()}" (${sectionChars} chars) split across chunks ${startChunk}-${endChunk}`);
      }
    }
  }
}
