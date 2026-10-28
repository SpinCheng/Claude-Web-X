// lib/models.js - model catalog from ~/.claude/settings.json env aliases
// (shared by /api/models and the context-probe endpoint). Verbatim move
// from server.js (refactor step 3).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function readModelCatalog() {
  const models = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const env = s.env || {};
    const ctxOf = (id) => (/\[1m\]/i.test(String(id)) || /(^|[-.])1m$/i.test(String(id)) ? 1_000_000 : 200_000);
    const seen = new Set();
    if (env.ANTHROPIC_MODEL) {
      seen.add(env.ANTHROPIC_MODEL);
      models.push({ id: env.ANTHROPIC_MODEL, label: env.ANTHROPIC_MODEL, ctx: ctxOf(env.ANTHROPIC_MODEL) });
    }
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      const id = env['ANTHROPIC_DEFAULT_' + tier.toUpperCase() + '_MODEL'];
      const label = env['ANTHROPIC_DEFAULT_' + tier.toUpperCase() + '_MODEL_NAME'];
      if (!id || !label || seen.has(label)) continue;
      seen.add(label);
      models.push({ id, label, ctx: ctxOf(id) });
    }
  } catch { /* fall through with empty list */ }
  return models;
}
