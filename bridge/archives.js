// archives.js - session archive registry (v185): sessionId -> archivedAt(ms).
// 归档=纯视图过滤（零文件操作，与删除严格区分）；bridge/data/archived.json
// survives boots (pins.json precedent). mergedSessions stamps the
// `archived`/`archivedAt` fields the list filters on; delete drops the flag
// via the delete route. Auto-unarchive (new transcript append / phone send)
// deletes the entry - see server.js wiring.
import fs from 'node:fs';

export class Archives {
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

  has(id) { return this.map.has(id); }

  get(id) { return this.map.get(id) || 0; }

  drop(id) { if (this.map.delete(id)) this._save(); }

  _save() {
    if (!this.path) return;
    try { fs.writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map))); } catch { /* best effort */ }
  }
}
