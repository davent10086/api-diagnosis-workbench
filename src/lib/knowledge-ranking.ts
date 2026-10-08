export function searchTerms(keyword: string) {
  return [...new Set(keyword.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/\b\d{8}\b/g, "").match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((term) => term.length >= 2).slice(0, 8);
}

function queryWeight(query: string) {
  if (/^[45]\d{2}$/.test(query)) return 0.25;
  if (/(?:Exception|Error|exceeded|timeout)/i.test(query)) return 1.5;
  if (/_|\d/.test(query)) return 2;
  if (/^[a-z]+(?:-[a-z]+)+$/.test(query)) return 0.25;
  return 1;
}

export function matchedExcerpt(body: string, queries: string[], limit = 1200) {
  const lower = body.toLowerCase();
  const exact = queries.map((q) => ({ index: lower.indexOf(q.toLowerCase()), weight: queryWeight(q) })).filter((match) => match.index >= 0);
  const positions = exact.length ? exact : queries.flatMap(searchTerms).map((term) => ({ index: lower.indexOf(term.toLowerCase()), weight: 1 })).filter((match) => match.index >= 0);
  if (!positions.length || body.length <= limit) return body.slice(0, limit);
  const starts = positions.map((position) => Math.min(Math.max(0, position.index - 200), Math.max(0, body.length - limit)));
  const coverage = (start: number) => positions.reduce((score, p) => score + (p.index >= start && p.index < start + limit ? p.weight : 0), 0);
  const start = starts.sort((a, b) => coverage(b) - coverage(a) || a - b)[0];
  return body.slice(start, start + limit);
}

type RankedHit = { id: string; sourceUrl: string; title: string; body: string; score: number };
/** Reciprocal rank fusion combines relevance without comparing backend scores. */
export function fuseKnowledgeResults<T extends RankedHit>(results: T[][], queries: string[], limit = 5): (T & { excerpt: string })[] {
  const ranked = new Map<string, { hit: T; fusion: number; bestRank: number; queryIndex: number; queries: string[] }>();
  for (const [queryIndex, items] of results.entries()) {
    const seen = new Set<string>();
    for (const [rank, hit] of items.entries()) {
      const key = `${hit.sourceUrl}\u0000${hit.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = ranked.get(key) ?? { hit, fusion: 0, bestRank: rank, queryIndex, queries: [] };
      const query = queries[queryIndex];
      const exact = `${hit.title}\n${hit.body}`.toLowerCase().includes(query.toLowerCase());
      const specific = /_|\d|Exception$|Error$/i.test(query) && !/^[45]\d{2}$/.test(query);
      // Expanded matches must not outrank a document naming the actual identifier.
      entry.fusion += queryWeight(query) * (specific && !exact ? 0.25 : 1) / (60 + rank + 1);
      entry.bestRank = Math.min(entry.bestRank, rank);
      entry.queries.push(queries[queryIndex]);
      ranked.set(key, entry);
    }
  }
  return [...ranked.values()].sort((a, b) => b.fusion - a.fusion || a.bestRank - b.bestRank || a.queryIndex - b.queryIndex || a.hit.id.localeCompare(b.hit.id))
    .slice(0, limit).map(({ hit, queries: matches }) => ({ ...hit, excerpt: matchedExcerpt(hit.body, matches) }));
}
