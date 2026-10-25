// tailer.js - incremental JSONL reader with byte-offset tracking.
// Robust against: partial last lines, mid-character chunk boundaries (approx),
// truncation/rotation (resets when file shrinks).
import fs from 'node:fs';

export class Tailer {
  constructor(filePath) {
    this.path = filePath;
    this.offset = 0;
    this.carry = Buffer.alloc(0); // bytes after the last complete newline
  }

  // Returns array of complete new lines since last call. [] if nothing new.
  readNew() {
    let st;
    try { st = fs.statSync(this.path); } catch { return []; }
    if (st.size < this.offset) { this.offset = 0; this.carry = Buffer.alloc(0); }
    if (st.size <= this.offset) return [];
    let chunk;
    try {
      const fd = fs.openSync(this.path, 'r');
      try {
        const len = st.size - this.offset;
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, this.offset);
        chunk = buf.subarray(0, n);
        this.offset += n;
      } finally { fs.closeSync(fd); }
    } catch { return []; }
    const data = Buffer.concat([this.carry, chunk]);
    const s = data.toString('utf8');
    const idx = s.lastIndexOf('\n');
    if (idx === -1) { this.carry = data; return []; }
    this.carry = Buffer.from(s.slice(idx + 1), 'utf8');
    return s.slice(0, idx).split('\n').filter((l) => l.trim().length > 0);
  }

  // Full re-read from the beginning.
  readAll() {
    this.offset = 0;
    this.carry = Buffer.alloc(0);
    return this.readNew();
  }
}
