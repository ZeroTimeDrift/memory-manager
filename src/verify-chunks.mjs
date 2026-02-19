import crypto from "node:crypto";
import fs from "node:fs";

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
    const text = current.map(e => e.line).join("\n");
    chunks.push({ startLine: current[0].lineNo, endLine: current[current.length - 1].lineNo, text, charCount: text.length });
  };
  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) { current = []; currentChars = 0; return; }
    let acc = 0; const kept = [];
    for (let i = current.length - 1; i >= 0; i--) {
      acc += current[i].line.length + 1; kept.unshift(current[i]);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments = line.length === 0 ? [""] : [];
    if (line.length > 0) { for (let s = 0; s < line.length; s += maxChars) segments.push(line.slice(s, s + maxChars)); }
    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) { flush(); carryOverlap(); }
      current.push({ line: segment, lineNo }); currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

const file = process.argv[2] || '/root/clawd/MEMORY.md';
const content = fs.readFileSync(file, 'utf-8');
const lines = content.split('\n');
const chunks = chunkMarkdown(content, { tokens: 400, overlap: 80 });

console.log(`\n📄 ${file}: ${lines.length} lines → ${chunks.length} chunks\n`);

for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i];
  // Find headings in this chunk
  const chunkLines = c.text.split('\n');
  const headings = chunkLines.filter(l => l.match(/^#{1,4}\s/)).map(l => l.trim());
  
  console.log(`chunk[${i}]: lines ${c.startLine}-${c.endLine} (${c.charCount} chars)`);
  if (headings.length > 0) console.log(`  Headings: ${headings.join(' | ')}`);
  
  // Check if any heading is in last 2 lines of chunk (about to be split)
  const lastTwoLines = chunkLines.slice(-2);
  for (const ll of lastTwoLines) {
    if (ll.match(/^#{1,4}\s/)) {
      console.log(`  ⚠️  HEADING AT CHUNK END: "${ll.trim()}" — content will be in next chunk!`);
    }
  }
}

// Check sections split across chunks
let sections = [];
let cur = null;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].match(/^#{2,3}\s/)) {
    if (cur) { cur.endLine = i; sections.push(cur); }
    cur = { heading: lines[i], startLine: i + 1, endLine: null };
  }
}
if (cur) { cur.endLine = lines.length; sections.push(cur); }

console.log(`\n--- Section Analysis ---`);
let splitCount = 0;
for (const s of sections) {
  const sChars = lines.slice(s.startLine - 1, s.endLine).join('\n').length;
  const startChunk = chunks.findIndex(c => c.startLine <= s.startLine && c.endLine >= s.startLine);
  const endChunk = chunks.findIndex(c => c.startLine <= s.endLine && c.endLine >= s.endLine);
  const split = startChunk !== -1 && endChunk !== -1 && startChunk !== endChunk;
  const marker = split ? '⚠️  SPLIT' : '✅';
  if (split) splitCount++;
  console.log(`${marker} "${s.heading.trim()}" (${sChars} chars) → chunk${split ? 's ' + startChunk + '-' + endChunk : ' ' + startChunk}`);
}
console.log(`\nTotal sections: ${sections.length}, Split: ${splitCount}, Clean: ${sections.length - splitCount}`);
