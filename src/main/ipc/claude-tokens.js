// Per-tab token & cost summary from JSONL on disk.
//
// Why on disk and not from claude CLI's /cost: /cost lives only in RAM of the
// current process, lost on rebar/--resume. JSONL is authoritative — Anthropic
// writes the exact billed usage to each assistant turn.
//
// Two numbers we surface:
//   • TOTAL (everything in the file chain) — what you actually paid Anthropic,
//     including turns that were later deleted via edit-range or forked away
//   • ACTIVE BRANCH (parseTimelineEntries backtrace) — what the conversation
//     would cost if you re-played the current state from zero
// Delta = "wasted on experiments you rolled back".
//
// Each assistant message.usage has:
//   input_tokens, output_tokens,
//   cache_creation_input_tokens (cache_write), cache_read_input_tokens
// Plus message.model lets us split by model.
//
// Pricing per million tokens (May 2026, public Anthropic rates):
//   Model         input  output  cache_write  cache_read
//   opus           15.00  75.00   18.75         1.50
//   opus[1m]>200k  30.00 150.00   37.50         3.00
//   sonnet          3.00  15.00    3.75         0.30
//   haiku           0.80   4.00    1.00         0.08

const { ipcMain } = require('electron');
const path = require('path');

const PRICING = {
  opus:        { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'opus-1m':   { input: 30.00, output: 150.00, cache_write: 37.50, cache_read: 3.00 },
  sonnet:      { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
  haiku:       { input:  0.80, output:  4.00, cache_write:  1.00, cache_read: 0.08 },
  unknown:     { input:  3.00, output: 15.00, cache_write:  3.75, cache_read: 0.30 },
};

function classifyModel(modelStr, inputTokens) {
  if (!modelStr || typeof modelStr !== 'string') return 'unknown';
  const m = modelStr.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) {
    // claude-opus-4-7[1m] family bills 2× above 200k input
    if ((m.includes('[1m]') || m.includes('-1m')) && inputTokens > 200_000) return 'opus-1m';
    return 'opus';
  }
  return 'unknown';
}

function emptyBucket() {
  return { input: 0, output: 0, cache_write: 0, cache_read: 0, count: 0 };
}

function addUsage(bucket, usage) {
  bucket.input += usage.input_tokens || 0;
  bucket.output += usage.output_tokens || 0;
  bucket.cache_write += usage.cache_creation_input_tokens || 0;
  bucket.cache_read += usage.cache_read_input_tokens || 0;
  bucket.count += 1;
}

function bucketCost(bucket, modelKey) {
  const p = PRICING[modelKey] || PRICING.unknown;
  return (
    (bucket.input * p.input +
     bucket.output * p.output +
     bucket.cache_write * p.cache_write +
     bucket.cache_read * p.cache_read) / 1_000_000
  );
}

function bucketTotalTokens(bucket) {
  return bucket.input + bucket.output + bucket.cache_write + bucket.cache_read;
}

// Aggregate usage records into per-model buckets.
// `records` is an iterable of assistant message records that have
// `message.usage` and `message.model`.
function aggregate(records) {
  const byModel = new Map();
  let totalCost = 0;
  let totalTokens = 0;
  let totalTurns = 0;

  for (const rec of records) {
    if (rec?.type !== 'assistant') continue;
    const usage = rec.message?.usage;
    if (!usage) continue;
    const modelKey = classifyModel(rec.message?.model, usage.input_tokens || 0);
    if (!byModel.has(modelKey)) byModel.set(modelKey, emptyBucket());
    const bucket = byModel.get(modelKey);
    addUsage(bucket, usage);
  }

  for (const [modelKey, bucket] of byModel) {
    const cost = bucketCost(bucket, modelKey);
    totalCost += cost;
    totalTokens += bucketTotalTokens(bucket);
    totalTurns += bucket.count;
    bucket.cost = cost;
    bucket.totalTokens = bucketTotalTokens(bucket);
  }

  // Convert Map → plain object for IPC
  const modelsObj = {};
  for (const [k, v] of byModel) modelsObj[k] = v;

  return {
    models: modelsObj,
    totalCost,
    totalTokens,
    totalTurns,
  };
}

function register({ claudeData }) {
  // claudeData = require('./claude-data') — exports findSessionFile,
  // loadJsonlRecords, resolveSessionChain, parseTimelineEntries directly.
  const { resolveSessionChain } = claudeData;

  ipcMain.handle('claude-tokens:summary', async (_e, { sessionId, cwd }) => {
    if (!sessionId) return { ok: false, error: 'No sessionId' };

    try {
      // Walk the full resume chain (compact bridges + --resume copies). This is
      // the same logic used everywhere else in the project — see CLAUDE.md
      // anti-pattern "не переизобретай".
      const chain = await resolveSessionChain(sessionId, cwd);
      if (!chain || !chain.mergedMap || chain.mergedMap.size === 0) {
        return { ok: false, error: 'Session has no records yet' };
      }

      // ── TOTAL: every assistant turn ever written to any file in the chain ──
      const allRecords = Array.from(chain.mergedMap.values());
      const total = aggregate(allRecords);

      // ── ACTIVE BRANCH: only turns reachable from current tip via parentUuid ──
      // We don't have a parseTimelineEntries-equivalent that returns the raw
      // assistant entries; parseTimelineEntries strips usage. So replicate the
      // backtrace inline against the merged recordMap.
      const lastRec = chain.lastRecord;
      const activeUuids = new Set();
      if (lastRec) {
        let cur = lastRec.uuid;
        const seen = new Set();
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          activeUuids.add(cur);
          const rec = chain.mergedMap.get(cur);
          if (!rec) break;
          cur = rec.logicalParentUuid || rec.parentUuid;
        }
      }
      const activeRecords = allRecords.filter(r => activeUuids.has(r.uuid));
      const active = aggregate(activeRecords);

      return {
        ok: true,
        sessionId,
        chainLength: (chain.sessionBoundaries?.length || 0) + 1,
        total,
        active,
        wasted: {
          cost: Math.max(0, total.totalCost - active.totalCost),
          tokens: Math.max(0, total.totalTokens - active.totalTokens),
          turns: Math.max(0, total.totalTurns - active.totalTurns),
        },
      };
    } catch (e) {
      console.error('[ClaudeTokens] aggregate failed:', e.message);
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { register };
