// pins.js - session pin registry (v125): sessionId -> pinnedAt(ms).
// bridge/data/pins.json survives boots (renames.json precedent). The list's
// 置顶 section renders from the `pinned`/`pinnedAt` fields mergedSessions
// stamps; archive/delete drops the pin via the delete route.
import fs from 'node:fs';

export class Pins {
  constructor(filePath) {
    this.path = filePath || ''; // empty = in-memory only (tests)
    this.map = new Map();
    try {
      if (this.path && fs.existsSync(this.path)) {
        this.map = new Map(Object.entries(JSON.parse(fs.readFileSync(this.path, 'utf8'))));
      }
    } catch { /* corrupt file -> start empty */ }
  }

  set(id, on) {
    if (on) this.map.set(id, Date.now());
    else if (!this.map.delete(id)) return false;
    this._save();
    return true;
  }

  get(id) { return this.map.get(id) || 0; }

  drop(id) { if (this.map.delete(id)) this._save(); }

  _save() {
    if (!this.path) return;
    try { fs.writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map))); } catch { /* best effort */ }
  }
}
