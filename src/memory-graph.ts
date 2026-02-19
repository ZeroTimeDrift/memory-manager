#!/usr/bin/env npx ts-node

/**
 * Memory Graph — File-to-file relationship index
 * 
 * Builds a weighted graph where nodes = memory files, edges = relationships.
 * Edge weights come from:
 *   1. Shared entities — files mentioning the same concepts (concept-index.json)
 *   2. Cross-references — explicit [[links]] or paths between files
 *   3. Temporal proximity — daily files from nearby dates
 *   4. Section overlap — shared section headings suggest topic overlap
 * 
 * Enables:
 *   - "Given file X, what else is relevant?" (context expansion)
 *   - Cluster detection (which files form natural groups?)
 *   - Boot context optimization (load clusters, not isolated files)
 *   - Gap detection (disconnected files = potential orphans)
 * 
 * Usage:
 *   npx ts-node src/memory-graph.ts build            # Build/rebuild graph
 *   npx ts-node src/memory-graph.ts neighbors <path>  # Related files for a given file
 *   npx ts-node src/memory-graph.ts clusters          # Detect topic clusters
 *   npx ts-node src/memory-graph.ts isolated          # Files with few/no connections
 *   npx ts-node src/memory-graph.ts context <query>   # Context-aware file set for a query
 *   npx ts-node src/memory-graph.ts stats             # Graph statistics
 *   npx ts-node src/memory-graph.ts viz               # ASCII visualization
 */

import * as fs from 'fs';
import * as path from 'path';

const MEMORY_DIR = '/root/clawd/memory';
const ROOT_DIR = '/root/clawd';
const SKILL_DIR = '/root/clawd/skills/memory-manager';
const GRAPH_PATH = path.join(SKILL_DIR, 'memory-graph.json');
const CONCEPT_INDEX_PATH = path.join(SKILL_DIR, 'concept-index.json');
const MANIFEST_PATH = path.join(SKILL_DIR, 'manifest.json');

// ─── Types ──────────────────────────────────────────────────────────────────

interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  reasons: EdgeReason[];
}

interface EdgeReason {
  type: 'entity' | 'xref' | 'temporal' | 'section' | 'co-mention';
  detail: string;
  contribution: number;
}

interface GraphNode {
  path: string;
  type: 'core' | 'daily' | 'weekly' | 'topic' | 'people' | 'operational' | 'proxy';
  edges: Record<string, number>;  // target path → weight
  degree: number;                  // total edge count
  weightedDegree: number;         // sum of edge weights
  cluster?: number;                // assigned cluster id
}

interface MemoryGraph {
  version: number;
  builtAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  clusters: Cluster[];
}

interface Cluster {
  id: number;
  label: string;
  members: string[];
  coherence: number;  // avg intra-cluster edge weight
}

// ─── File Discovery ─────────────────────────────────────────────────────────

function discoverMemoryFiles(): string[] {
  const files: string[] = [];
  
  // Root files that matter
  const rootFiles = ['MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md'];
  for (const f of rootFiles) {
    const p = path.join(ROOT_DIR, f);
    if (fs.existsSync(p)) files.push(f);
  }
  
  // Memory directory files (recursive)
  function walk(dir: string, prefix: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'archive') continue;  // skip archived
        walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith('.md')) {
        files.push(rel);
      }
    }
  }
  walk(MEMORY_DIR, 'memory');
  
  return files;
}

function classifyFile(filePath: string): GraphNode['type'] {
  if (['SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'TOOLS.md'].includes(filePath)) return 'core';
  if (filePath.includes('daily/')) return 'daily';
  if (filePath.includes('weekly/')) return 'weekly';
  if (filePath.includes('topics/')) return 'topic';
  if (filePath.includes('people/')) return 'people';
  if (filePath.includes('OPERATING')) return 'operational';
  if (filePath.includes('core-identity') || filePath.includes('rules-reference')) return 'proxy';
  return 'topic';  // default
}

// ─── Edge Builders ──────────────────────────────────────────────────────────

/**
 * Build edges from shared entities (concept index).
 * Two files sharing entity "kamino" get an edge weighted by co-occurrence strength.
 */
function buildEntityEdges(files: string[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  
  let conceptIndex: any;
  try {
    conceptIndex = JSON.parse(fs.readFileSync(CONCEPT_INDEX_PATH, 'utf-8'));
  } catch {
    console.log('  ⚠️  No concept index found, skipping entity edges');
    return [];
  }
  
  // For each concept, all files mentioning it share an edge
  const fileSet = new Set(files);
  
  // Skip ubiquitous concepts that connect everything (noise)
  const NOISE_CONCEPTS = new Set([
    'memory', 'prometheus', 'hevar', 'clawdbot', 'survival',
    'session', 'identity', 'consciousness',
  ]);
  
  for (const [conceptName, concept] of Object.entries(conceptIndex.concepts || {}) as [string, any][]) {
    if (NOISE_CONCEPTS.has(conceptName)) continue;
    
    const conceptFiles = Object.keys(concept.files || {}).filter(f => fileSet.has(f));
    // Only create edges for concepts appearing in 2-8 files (not too common, not unique)
    if (conceptFiles.length < 2 || conceptFiles.length > 8) continue;
    
    // Pairwise edges between files sharing this concept
    for (let i = 0; i < conceptFiles.length; i++) {
      for (let j = i + 1; j < conceptFiles.length; j++) {
        const a = conceptFiles[i];
        const b = conceptFiles[j];
        const countA = concept.files[a]?.count || 1;
        const countB = concept.files[b]?.count || 1;
        
        // Weight: sqrt of min mention count, normalized. More mentions = stronger link.
        // Boost for rare concepts (appear in fewer files = more specific signal)
        const rarity = 1.0 / Math.sqrt(conceptFiles.length);
        const strength = Math.sqrt(Math.min(countA, countB)) * 0.15 * rarity;
        
        edges.push({
          source: a,
          target: b,
          weight: Math.min(strength, 0.5),  // cap per-concept contribution
          reasons: [{
            type: 'entity',
            detail: conceptName,
            contribution: strength,
          }],
        });
      }
    }
  }
  
  return edges;
}

/**
 * Build edges from cross-references (explicit file mentions in content).
 */
function buildXrefEdges(files: string[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const fileSet = new Set(files);
  
  for (const file of files) {
    const fullPath = file.startsWith('memory') ? path.join(ROOT_DIR, file) : path.join(ROOT_DIR, file);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch { continue; }
    
    // Count total outgoing refs from this file (to detect hubs)
    let refCount = 0;
    
    // Find references to other known files
    for (const target of files) {
      if (target === file) continue;
      
      // Check various reference patterns
      const patterns = [
        target,                                           // exact path
        `→ ${path.basename(target)}`,                     // arrow reference
        `(${target})`,                                    // markdown link
      ];
      // Only match filename if it's distinctive (>6 chars, not generic names)
      const basename = path.basename(target, '.md');
      if (basename.length > 6 && !['index', 'MEMORY', 'memory'].includes(basename)) {
        patterns.push(basename);
      }
      
      for (const pattern of patterns) {
        if (content.includes(pattern)) {
          refCount++;
          break;
        }
      }
    }
    
    // Hub penalty: files referencing many others get reduced edge weight
    // (MEMORY.md referencing 20 files ≠ moongate.md referencing 3 files)
    const hubPenalty = refCount > 5 ? Math.sqrt(5 / refCount) : 1.0;
    
    for (const target of files) {
      if (target === file) continue;
      
      const patterns = [
        target,
        `→ ${path.basename(target)}`,
        `(${target})`,
      ];
      const basename = path.basename(target, '.md');
      if (basename.length > 6 && !['index', 'MEMORY', 'memory'].includes(basename)) {
        patterns.push(basename);
      }
      
      for (const pattern of patterns) {
        if (content.includes(pattern)) {
          edges.push({
            source: file,
            target,
            weight: 0.4 * hubPenalty,
            reasons: [{
              type: 'xref',
              detail: `${file} references ${target}`,
              contribution: 0.4 * hubPenalty,
            }],
          });
          break;
        }
      }
    }
  }
  
  return edges;
}

/**
 * Build edges from temporal proximity (nearby daily files).
 */
function buildTemporalEdges(files: string[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  
  // Extract daily files with dates
  const dailyFiles: { path: string; date: Date }[] = [];
  for (const f of files) {
    const match = f.match(/daily\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (match) {
      dailyFiles.push({ path: f, date: new Date(match[1] + 'T12:00:00') });
    }
  }
  
  // Sort by date
  dailyFiles.sort((a, b) => a.date.getTime() - b.date.getTime());
  
  // Adjacent days get edges (strength decays with distance)
  for (let i = 0; i < dailyFiles.length; i++) {
    for (let j = i + 1; j < dailyFiles.length && j <= i + 3; j++) {
      const daysDiff = Math.abs(dailyFiles[j].date.getTime() - dailyFiles[i].date.getTime()) / (1000 * 60 * 60 * 24);
      const weight = 0.25 * Math.exp(-daysDiff * 0.5);  // exponential decay
      
      if (weight > 0.02) {
        edges.push({
          source: dailyFiles[i].path,
          target: dailyFiles[j].path,
          weight,
          reasons: [{
            type: 'temporal',
            detail: `${Math.round(daysDiff)}d apart`,
            contribution: weight,
          }],
        });
      }
    }
  }
  
  // Weekly files link to their daily files
  for (const f of files) {
    const weekMatch = f.match(/weekly\/(\d{4})-W(\d{2})\.md$/);
    if (!weekMatch) continue;
    
    const year = parseInt(weekMatch[1]);
    const week = parseInt(weekMatch[2]);
    
    // Find daily files in this week
    for (const daily of dailyFiles) {
      const d = daily.date;
      const dayOfYear = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000);
      const weekNum = Math.ceil((dayOfYear + new Date(d.getFullYear(), 0, 1).getDay() + 1) / 7);
      
      // Rough week matching (±1 to handle edge cases)
      if (d.getFullYear() === year && Math.abs(weekNum - week) <= 1) {
        edges.push({
          source: f,
          target: daily.path,
          weight: 0.3,
          reasons: [{
            type: 'temporal',
            detail: `weekly contains daily`,
            contribution: 0.3,
          }],
        });
      }
    }
  }
  
  return edges;
}

/**
 * Build edges from shared section headings.
 * Files with similar headings likely cover related topics.
 */
function buildSectionEdges(files: string[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  
  // Extract section headings from each file
  const fileHeadings: Map<string, Set<string>> = new Map();
  
  for (const file of files) {
    const fullPath = path.join(ROOT_DIR, file);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch { continue; }
    
    const headings = new Set<string>();
    for (const line of content.split('\n')) {
      const match = line.match(/^#{1,3}\s+(.+)/);
      if (match) {
        // Normalize: lowercase, strip special chars
        const normalized = match[1].toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (normalized.length > 3) {
          headings.add(normalized);
        }
      }
    }
    
    if (headings.size > 0) {
      fileHeadings.set(file, headings);
    }
  }
  
  // Pairwise comparison of heading sets
  const fileList = [...fileHeadings.keys()];
  for (let i = 0; i < fileList.length; i++) {
    for (let j = i + 1; j < fileList.length; j++) {
      const a = fileHeadings.get(fileList[i])!;
      const b = fileHeadings.get(fileList[j])!;
      
      // Jaccard-like overlap (but on exact heading matches + substring containment)
      let shared = 0;
      for (const ha of a) {
        for (const hb of b) {
          if (ha === hb || ha.includes(hb) || hb.includes(ha)) {
            shared++;
          }
        }
      }
      
      if (shared > 0) {
        const totalUnique = a.size + b.size - shared;
        const overlap = shared / totalUnique;
        const weight = overlap * 0.3;  // section overlap is a moderate signal
        
        if (weight > 0.03) {
          edges.push({
            source: fileList[i],
            target: fileList[j],
            weight,
            reasons: [{
              type: 'section',
              detail: `${shared} shared heading(s)`,
              contribution: weight,
            }],
          });
        }
      }
    }
  }
  
  return edges;
}

// ─── Graph Construction ─────────────────────────────────────────────────────

/**
 * Merge parallel edges between the same pair of files.
 * Multiple reasons (entity + xref + temporal) combine into one stronger edge.
 */
function mergeEdges(rawEdges: GraphEdge[]): GraphEdge[] {
  const edgeMap = new Map<string, GraphEdge>();
  
  for (const edge of rawEdges) {
    // Canonical key (sorted pair)
    const [a, b] = [edge.source, edge.target].sort();
    const key = `${a}|||${b}`;
    
    const existing = edgeMap.get(key);
    if (existing) {
      // Combine: add weights (with diminishing returns) and merge reasons
      existing.weight += edge.weight * 0.8;  // slight diminishing returns
      existing.reasons.push(...edge.reasons);
    } else {
      edgeMap.set(key, {
        source: a,
        target: b,
        weight: edge.weight,
        reasons: [...edge.reasons],
      });
    }
  }
  
  // Normalize weights to [0, 1] and filter weak edges
  const edges = [...edgeMap.values()];
  const maxWeight = Math.max(...edges.map(e => e.weight), 0.001);
  for (const edge of edges) {
    edge.weight = Math.min(edge.weight / maxWeight, 1.0);
  }
  
  // Prune: drop edges below threshold (removes noise)
  // Adaptive threshold: use the median weight as a dynamic cutoff
  const sorted = [...edges].sort((a, b) => a.weight - b.weight);
  const medianWeight = sorted[Math.floor(sorted.length / 2)]?.weight || 0;
  const MIN_EDGE_WEIGHT = Math.max(0.2, medianWeight * 1.1);  // above-median edges only
  const filtered = edges.filter(e => e.weight >= MIN_EDGE_WEIGHT);
  
  return filtered;
}

/**
 * Detect clusters using a simple label propagation algorithm.
 * Each node starts with its own label; iteratively takes the most common
 * neighbor label until convergence.
 */
function detectClusters(nodes: Record<string, GraphNode>, edges: GraphEdge[]): Cluster[] {
  // Initialize each node with unique label
  const labels = new Map<string, number>();
  let nextLabel = 0;
  for (const nodePath of Object.keys(nodes)) {
    labels.set(nodePath, nextLabel++);
  }
  
  // Build adjacency with weights
  const adj = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    if (!adj.has(edge.source)) adj.set(edge.source, new Map());
    if (!adj.has(edge.target)) adj.set(edge.target, new Map());
    adj.get(edge.source)!.set(edge.target, edge.weight);
    adj.get(edge.target)!.set(edge.source, edge.weight);
  }
  
  // Iterate until stable (max 20 rounds)
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    const nodeOrder = Object.keys(nodes);
    // Shuffle for randomized propagation
    for (let i = nodeOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nodeOrder[i], nodeOrder[j]] = [nodeOrder[j], nodeOrder[i]];
    }
    
    for (const node of nodeOrder) {
      const neighbors = adj.get(node);
      if (!neighbors || neighbors.size === 0) continue;
      
      // Weighted vote: sum weights per label
      const labelVotes = new Map<number, number>();
      for (const [neighbor, weight] of neighbors) {
        const nLabel = labels.get(neighbor)!;
        labelVotes.set(nLabel, (labelVotes.get(nLabel) || 0) + weight);
      }
      
      // Pick label with highest weighted vote
      let bestLabel = labels.get(node)!;
      let bestVote = 0;
      for (const [label, vote] of labelVotes) {
        if (vote > bestVote) {
          bestVote = vote;
          bestLabel = label;
        }
      }
      
      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }
    
    if (!changed) break;
  }
  
  // Group by label
  const clusterMembers = new Map<number, string[]>();
  for (const [node, label] of labels) {
    if (!clusterMembers.has(label)) clusterMembers.set(label, []);
    clusterMembers.get(label)!.push(node);
  }
  
  // Convert to Cluster objects, filter singles
  const clusters: Cluster[] = [];
  let clusterIdx = 0;
  for (const [, members] of clusterMembers) {
    if (members.length < 2) continue;
    
    // Calculate coherence: avg intra-cluster edge weight
    let totalWeight = 0;
    let edgeCount = 0;
    for (const edge of edges) {
      if (members.includes(edge.source) && members.includes(edge.target)) {
        totalWeight += edge.weight;
        edgeCount++;
      }
    }
    const coherence = edgeCount > 0 ? totalWeight / edgeCount : 0;
    
    // Generate label from most common file type or topic
    const types = members.map(m => classifyFile(m));
    const typeCount = new Map<string, number>();
    for (const t of types) typeCount.set(t, (typeCount.get(t) || 0) + 1);
    const dominantType = [...typeCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'mixed';
    
    // Try to extract a more descriptive label
    let label = dominantType;
    const topicMembers = members.filter(m => m.includes('topics/'));
    if (topicMembers.length > 0) {
      label = topicMembers.map(m => path.basename(m, '.md')).join('+');
    } else if (members.every(m => m.includes('daily/'))) {
      label = 'timeline';
    } else if (members.some(m => m.includes('MEMORY') || m.includes('SOUL') || m.includes('IDENTITY'))) {
      label = 'identity-core';
    }
    
    clusters.push({
      id: clusterIdx++,
      label,
      members,
      coherence,
    });
    
    // Update node cluster assignments
    for (const member of members) {
      if (nodes[member]) nodes[member].cluster = clusters[clusters.length - 1].id;
    }
  }
  
  // Sort by coherence descending
  clusters.sort((a, b) => b.coherence - a.coherence);
  
  return clusters;
}

/**
 * Build the complete memory graph.
 */
function buildGraph(): MemoryGraph {
  console.log('🕸️  Building memory graph...\n');
  
  const files = discoverMemoryFiles();
  console.log(`  📄 Discovered ${files.length} files`);
  
  // Build edges from all sources
  console.log('  🔗 Building entity edges...');
  const entityEdges = buildEntityEdges(files);
  console.log(`     → ${entityEdges.length} raw entity edges`);
  
  console.log('  🔗 Building cross-reference edges...');
  const xrefEdges = buildXrefEdges(files);
  console.log(`     → ${xrefEdges.length} xref edges`);
  
  console.log('  🔗 Building temporal edges...');
  const temporalEdges = buildTemporalEdges(files);
  console.log(`     → ${temporalEdges.length} temporal edges`);
  
  console.log('  🔗 Building section overlap edges...');
  const sectionEdges = buildSectionEdges(files);
  console.log(`     → ${sectionEdges.length} section edges`);
  
  // Merge all edges
  const allRaw = [...entityEdges, ...xrefEdges, ...temporalEdges, ...sectionEdges];
  console.log(`\n  📊 Total raw edges: ${allRaw.length}`);
  
  const mergedEdges = mergeEdges(allRaw);
  console.log(`  📊 Merged edges: ${mergedEdges.length}`);
  
  // Build nodes
  const nodes: Record<string, GraphNode> = {};
  for (const file of files) {
    nodes[file] = {
      path: file,
      type: classifyFile(file),
      edges: {},
      degree: 0,
      weightedDegree: 0,
    };
  }
  
  // Populate node edges
  for (const edge of mergedEdges) {
    if (nodes[edge.source]) {
      nodes[edge.source].edges[edge.target] = edge.weight;
      nodes[edge.source].degree++;
      nodes[edge.source].weightedDegree += edge.weight;
    }
    if (nodes[edge.target]) {
      nodes[edge.target].edges[edge.source] = edge.weight;
      nodes[edge.target].degree++;
      nodes[edge.target].weightedDegree += edge.weight;
    }
  }
  
  // Detect clusters
  console.log('  🏷️  Detecting clusters...');
  const clusters = detectClusters(nodes, mergedEdges);
  console.log(`     → ${clusters.length} clusters found`);
  
  const graph: MemoryGraph = {
    version: 1,
    builtAt: new Date().toISOString(),
    nodeCount: files.length,
    edgeCount: mergedEdges.length,
    nodes,
    edges: mergedEdges,
    clusters,
  };
  
  // Save
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));
  console.log(`\n  💾 Saved to ${GRAPH_PATH}`);
  
  return graph;
}

// ─── Queries ────────────────────────────────────────────────────────────────

function loadGraph(): MemoryGraph {
  try {
    return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
  } catch {
    console.error('No graph found. Run: npx ts-node src/memory-graph.ts build');
    process.exit(1);
  }
}

/**
 * Get neighbors of a file, sorted by edge weight.
 */
function getNeighbors(filePath: string, limit: number = 10): { path: string; weight: number; reasons: string[] }[] {
  const graph = loadGraph();
  
  // Fuzzy match: allow partial paths
  let nodePath = filePath;
  if (!graph.nodes[filePath]) {
    const match = Object.keys(graph.nodes).find(n => 
      n.includes(filePath) || n.endsWith(filePath) || path.basename(n, '.md') === filePath
    );
    if (match) nodePath = match;
    else {
      console.error(`File not found in graph: ${filePath}`);
      return [];
    }
  }
  
  const node = graph.nodes[nodePath];
  if (!node) return [];
  
  // Get edges and their reasons
  const neighbors: { path: string; weight: number; reasons: string[] }[] = [];
  
  for (const [target, weight] of Object.entries(node.edges)) {
    // Find the edge details
    const edge = graph.edges.find(e => 
      (e.source === nodePath && e.target === target) ||
      (e.target === nodePath && e.source === target)
    );
    
    const reasons = edge?.reasons.map(r => `${r.type}:${r.detail}`) || [];
    neighbors.push({ path: target, weight, reasons });
  }
  
  neighbors.sort((a, b) => b.weight - a.weight);
  return neighbors.slice(0, limit);
}

/**
 * Context expansion: given a query, find the initial results via smart search,
 * then expand via graph neighbors to build a richer context set.
 */
function contextExpand(query: string, maxFiles: number = 8): { path: string; score: number; source: string }[] {
  const graph = loadGraph();
  
  // Step 1: Get initial results from memory_search via clawdbot CLI
  let initialResults: { path: string; score: number }[] = [];
  try {
    const result = require('child_process').execSync(
      `clawdbot memory search "${query.replace(/"/g, '\\"')}" --json --max-results 5 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    const data = JSON.parse(result);
    initialResults = (data.results || []).map((r: any) => ({
      path: r.path || '',
      score: r.score || 0,
    }));
  } catch {}
  
  if (initialResults.length === 0) {
    console.log('  No initial results found.');
    return [];
  }
  
  // Step 2: Expand via graph — for each initial result, add its strongest neighbors
  const seen = new Set<string>();
  const expanded: { path: string; score: number; source: string }[] = [];
  
  // Add initial results first
  for (const r of initialResults) {
    if (!seen.has(r.path)) {
      seen.add(r.path);
      expanded.push({ path: r.path, score: r.score, source: 'search' });
    }
  }
  
  // Expand from top-3 initial results
  for (const r of initialResults.slice(0, 3)) {
    const node = graph.nodes[r.path];
    if (!node) continue;
    
    // Get top-3 neighbors of this result
    const neighbors = Object.entries(node.edges)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);
    
    for (const [neighborPath, edgeWeight] of neighbors) {
      if (seen.has(neighborPath)) continue;
      seen.add(neighborPath);
      
      // Score: parent's search score * edge weight (decayed)
      const derivedScore = r.score * edgeWeight * 0.6;
      expanded.push({ path: neighborPath, score: derivedScore, source: `graph(${path.basename(r.path)})` });
    }
  }
  
  // Sort by score and limit
  expanded.sort((a, b) => b.score - a.score);
  return expanded.slice(0, maxFiles);
}

/**
 * Find isolated files — nodes with low connectivity.
 */
function findIsolated(threshold: number = 2): string[] {
  const graph = loadGraph();
  return Object.values(graph.nodes)
    .filter(n => n.degree < threshold)
    .sort((a, b) => a.degree - b.degree)
    .map(n => `${n.path} (degree: ${n.degree}, type: ${n.type})`);
}

/**
 * Print graph statistics.
 */
function printStats() {
  const graph = loadGraph();
  
  console.log('═══════════════════════════════════════════════════════');
  console.log('  🕸️  MEMORY GRAPH STATISTICS');
  console.log('═══════════════════════════════════════════════════════\n');
  
  console.log(`  Nodes: ${graph.nodeCount}`);
  console.log(`  Edges: ${graph.edgeCount}`);
  console.log(`  Density: ${(2 * graph.edgeCount / (graph.nodeCount * (graph.nodeCount - 1))).toFixed(3)}`);
  console.log(`  Clusters: ${graph.clusters.length}`);
  console.log(`  Built: ${graph.builtAt}\n`);
  
  // Degree distribution
  const degrees = Object.values(graph.nodes).map(n => n.degree);
  const avgDegree = degrees.reduce((a, b) => a + b, 0) / degrees.length;
  const maxDegree = Math.max(...degrees);
  const minDegree = Math.min(...degrees);
  
  console.log(`  Degree: avg=${avgDegree.toFixed(1)} min=${minDegree} max=${maxDegree}`);
  
  // Most connected
  const sorted = Object.values(graph.nodes).sort((a, b) => b.weightedDegree - a.weightedDegree);
  console.log('\n  📌 Most connected:');
  for (const node of sorted.slice(0, 8)) {
    console.log(`    ${node.weightedDegree.toFixed(2)} | ${node.path} (${node.degree} edges, ${node.type})`);
  }
  
  // Edge type distribution
  const typeCounts: Record<string, number> = {};
  for (const edge of graph.edges) {
    for (const reason of edge.reasons) {
      typeCounts[reason.type] = (typeCounts[reason.type] || 0) + 1;
    }
  }
  console.log('\n  🔗 Edge types:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type}: ${count}`);
  }
  
  // Clusters
  if (graph.clusters.length > 0) {
    console.log('\n  🏷️  Clusters:');
    for (const cluster of graph.clusters) {
      console.log(`    [${cluster.id}] ${cluster.label} (${cluster.members.length} files, coherence: ${cluster.coherence.toFixed(3)})`);
      for (const member of cluster.members.slice(0, 5)) {
        console.log(`        ${member}`);
      }
      if (cluster.members.length > 5) console.log(`        ... +${cluster.members.length - 5} more`);
    }
  }
  
  // Isolated
  const isolated = Object.values(graph.nodes).filter(n => n.degree <= 1);
  if (isolated.length > 0) {
    console.log(`\n  ⚠️  Isolated files (degree ≤ 1): ${isolated.length}`);
    for (const node of isolated) {
      console.log(`    ${node.path} (${node.type})`);
    }
  }
}

/**
 * ASCII visualization of the graph (simplified).
 */
function visualize() {
  const graph = loadGraph();
  
  console.log('═══════════════════════════════════════════════════════');
  console.log('  🕸️  MEMORY GRAPH VISUALIZATION');
  console.log('═══════════════════════════════════════════════════════\n');
  
  // Show each cluster as a group
  for (const cluster of graph.clusters) {
    console.log(`  ┌─ Cluster: ${cluster.label} (coherence: ${cluster.coherence.toFixed(2)}) ─┐`);
    for (const member of cluster.members) {
      const node = graph.nodes[member];
      const topEdges = Object.entries(node.edges)
        .filter(([t]) => cluster.members.includes(t))
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3);
      
      const bar = '█'.repeat(Math.ceil(node.weightedDegree * 3));
      console.log(`  │ ${bar.padEnd(12)} ${path.basename(member, '.md').padEnd(25)} (${node.type})`);
      for (const [target, weight] of topEdges) {
        const w = '─'.repeat(Math.ceil(weight * 10));
        console.log(`  │   ${w}→ ${path.basename(target, '.md')}`);
      }
    }
    console.log(`  └${'─'.repeat(50)}┘\n`);
  }
  
  // Unclustered nodes
  const unclustered = Object.values(graph.nodes).filter(n => n.cluster === undefined);
  if (unclustered.length > 0) {
    console.log('  ○ Unclustered:');
    for (const node of unclustered) {
      console.log(`    ${path.basename(node.path, '.md')} (${node.type}, degree: ${node.degree})`);
    }
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'build':
      const graph = buildGraph();
      console.log('\n');
      printStats();
      break;
      
    case 'neighbors': {
      const target = args[1];
      if (!target) {
        console.log('Usage: memory-graph.ts neighbors <file-path>');
        process.exit(1);
      }
      const limit = parseInt(args[2]) || 10;
      const neighbors = getNeighbors(target, limit);
      console.log(`\n  🔗 Neighbors of "${target}":\n`);
      for (const n of neighbors) {
        const bar = '█'.repeat(Math.ceil(n.weight * 15));
        console.log(`  ${bar.padEnd(16)} ${n.weight.toFixed(3)} | ${n.path}`);
        console.log(`  ${''.padEnd(16)} reasons: ${n.reasons.join(', ')}`);
      }
      break;
    }
    
    case 'clusters': {
      const g = loadGraph();
      console.log(`\n  🏷️  ${g.clusters.length} clusters detected:\n`);
      for (const cluster of g.clusters) {
        console.log(`  [${cluster.id}] ${cluster.label} — ${cluster.members.length} files, coherence: ${cluster.coherence.toFixed(3)}`);
        for (const member of cluster.members) {
          console.log(`      ${member}`);
        }
        console.log();
      }
      break;
    }
    
    case 'isolated': {
      const threshold = parseInt(args[1]) || 2;
      const isolated = findIsolated(threshold);
      console.log(`\n  ⚠️  Files with degree < ${threshold}:\n`);
      for (const i of isolated) {
        console.log(`    ${i}`);
      }
      break;
    }
    
    case 'context': {
      const query = args.slice(1).join(' ');
      if (!query) {
        console.log('Usage: memory-graph.ts context <query>');
        process.exit(1);
      }
      const results = contextExpand(query);
      console.log(`\n  🧠 Context expansion for "${query}":\n`);
      for (const r of results) {
        const icon = r.source === 'search' ? '🔍' : '🕸️';
        console.log(`  ${icon} ${r.score.toFixed(3)} | ${r.path} [${r.source}]`);
      }
      break;
    }
    
    case 'stats':
      printStats();
      break;
      
    case 'viz':
      visualize();
      break;
      
    default:
      console.log('Usage: npx ts-node src/memory-graph.ts <command>');
      console.log('');
      console.log('Commands:');
      console.log('  build             Build/rebuild the memory graph');
      console.log('  neighbors <path>  Show related files for a given file');
      console.log('  clusters          Show detected topic clusters');
      console.log('  isolated          Find disconnected files');
      console.log('  context <query>   Context-aware file expansion for a query');
      console.log('  stats             Graph statistics');
      console.log('  viz               ASCII visualization');
  }
}

// Exports
export { buildGraph, getNeighbors, contextExpand, findIsolated, detectClusters, loadGraph, MemoryGraph, GraphNode, GraphEdge, Cluster };

main();
