// store.js - unified session registry + event hub.
// SessionRecord (normalized across adapters):
//   { id, kind: 'cc'|'cowork', title, project, cwd, status: 'active'|'idle',
//     transcriptPath, lastActive(ms), lines, model, cost: {usd, inTok, outTok} }
import { EventEmitter } from 'node:events';

export class Store extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  get(id) { return this.sessions.get(id); }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.lastActive - a.lastActive);
  }

  // Patch an existing record or insert a new one; emits 'session' on change.
  upsert(patch) {
    if (!patch || !patch.id) return null;
    const prev = this.sessions.get(patch.id) || {};
    const rec = {
      kind: 'cc', title: '', project: '', cwd: '', status: 'idle', lastOutcome: '',
      transcriptPath: '', lastActive: 0, lines: 0, model: '', cost: null,
      ...prev, ...patch,
    };
    const changed =
      !prev || JSON.stringify(prev) !== JSON.stringify(rec);
    this.sessions.set(rec.id, rec);
    if (changed) this.emit('session', rec);
    return rec;
  }

  // Remove a record (its transcript file is gone); emits 'session' on change.
  drop(id) {
    if (!this.sessions.delete(id)) return false;
    this.emit('session', null);
    return true;
  }
}
