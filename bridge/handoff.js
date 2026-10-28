// handoff.js - takeover coordinator (Plan section 7, decision D4).
//
// Single-driver rule per session:
//  - "phone" driver = a Runner child currently running for the session.
//    Tracked in memory (the bridge is the only phone-side writer).
//  - "pc" driver = a human claim made from the terminal via `cr attach`
//    (advisory lock file; the terminal claude process cannot lock itself).
//  - unknown local writer = transcript mtime fresher than both our own last
//    run and the grace window => someone (likely an interactive terminal
//    session) is actively writing; phone sends then require `force`.
//
// Lock files live in bridge/data/locks/<sessionId>.json (gitignored with data/).
import fs from 'node:fs';
import path from 'node:path';

const WRITE_GRACE_MS = 8_000; // fresh writes newer than this block phone sends
const PC_CLAIM_TTL_MS = 12 * 60 * 60 * 1000; // stale pc claims expire silently

export class Handoff {
  constructor(opts = {}) {
    this.store = opts.store; // Store, for transcriptPath lookup
    this.locksDir = opts.locksDir;
    try { fs.mkdirSync(this.locksDir, { recursive: true }); } catch { /* later ops will fail softly */ }
    this.lastPhoneRun = new Map(); // sessionId -> ms when our last runner child exited
  }

  // Runner wiring: remember when OUR run ended so post-run transcript writes
  // (the last append flush) are not misread as a foreign active writer.
  phoneRunEnded(sessionId) {
    if (sessionId) this.lastPhoneRun.set(sessionId, Date.now());
  }
  phoneRunStarted(sessionId) {
    if (sessionId) this.lastPhoneRun.delete(sessionId);
  }

  transcriptMtime(sessionId) {
    const rec = this.store.get(sessionId);
    if (!rec || !rec.transcriptPath) return 0;
    try { return fs.statSync(rec.transcriptPath).mtimeMs; } catch { return 0; }
  }

  // Can the phone send into this session right now?
  //   ok:true  -> go ahead
  //   ok:false -> { reason:'pc-claim' } when the PC holds an advisory claim
  //               (cr attach; D4: switching drivers needs explicit intent)
  //   ok:false -> { reason:'recent-local-write' } when someone local wrote the
  //               transcript seconds ago (likely an active terminal session)
  checkPhoneSend(sessionId, force = false) {
    if (force) return { ok: true };
    const pc = this.pcClaim(sessionId);
    if (pc) return { ok: false, reason: 'pc-claim', claimedAt: pc.claimedAt || 0 };
    const mtime = this.transcriptMtime(sessionId);
    const since = Date.now() - mtime;
    if (mtime && since < WRITE_GRACE_MS) {
      // ignore writes that are just our own finished run settling
      const mine = this.lastPhoneRun.get(sessionId) || 0;
      if (mtime > mine + WRITE_GRACE_MS) {
        return { ok: false, reason: 'recent-local-write', lastWriteMs: mtime, sinceMs: since };
      }
    }
    return { ok: true };
  }

  // Advisory PC claim (cr attach). Overwrites any previous claim.
  claimPc(sessionId) {
    const file = this._lockFile(sessionId);
    const payload = { driver: 'pc', claimedAt: Date.now(), host: process.env.COMPUTERNAME || '' };
    try { fs.writeFileSync(file, JSON.stringify(payload)); } catch { return { ok: false }; }
    return { ok: true, ...payload };
  }

  release(sessionId) {
    try { fs.unlinkSync(this._lockFile(sessionId)); } catch { /* absent is fine */ }
    return { ok: true };
  }

  pcClaim(sessionId) {
    try {
      const raw = fs.readFileSync(this._lockFile(sessionId), 'utf8');
      const j = JSON.parse(raw);
      if (j.driver !== 'pc') return null;
      if (Date.now() - (j.claimedAt || 0) > PC_CLAIM_TTL_MS) return null; // stale
      return j;
    } catch { return null; }
  }

  // Current driver view for the PWA / cr list.
  status(sessionId) {
    const pc = this.pcClaim(sessionId);
    const mtime = this.transcriptMtime(sessionId);
    const activeLocal = mtime && Date.now() - mtime < WRITE_GRACE_MS;
    return {
      sessionId,
      driver: pc ? 'pc' : 'free',
      pcClaim: pc || null,
      lastWriteMs: mtime || null,
      // informational: writes inside the grace window (any writer)
      localWriteRecent: !!activeLocal,
    };
  }

  _lockFile(sessionId) {
    // sessionId is a uuid-shaped store key; still keep it out of path games
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.locksDir, safe + '.json');
  }
}
