// js/state.js - the single mutable source of truth (ES module singleton:
// every importer shares this instance). Views own the mutations; persistence
// keys (token/perm/model/effort/closed groups) are read here, written inline.

const CLOSED_KEY = 'cr_closed_groups';

// touch devices: Enter inserts a newline (send only via the button);
// desktop keeps the Enter-to-send convention
export const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

export const state = {
  token: localStorage.getItem('cr_token') || '',
  ws: null, wsTimer: null, wsRetry: 1000,
  sessions: [],
  currentId: null,
  atBottom: true,
  runs: {},            // sessionId -> {runId, state}
  driver: null,
  pendingNew: null,
  turns: [],           // transcript turn objects for the open session
  liveTurnOpen: false,
  closedGroups: new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')),
  perm: localStorage.getItem('cr_perm') || 'auto', // 'auto' | 'ask'
  approvals: [],   // pending permission requests (queue)
  userCollapsedLive: false, // user folded the live turn manually - respect it
  modelCatalog: null, // /api/models cache: [{id,label,ctx}]
  ctxProbe: null,    // last /context probe result {key,window,fixed,buffer}
  queue: {},         // sessionId -> [{id,text}] pending queue (WS 'queue' frames)
  attach: [],        // pending attachments for the open session (uploaded)
  waits: {},         // sessionId -> {kind,tool,msg,at} PC stuck on a prompt (v21)
};

export { CLOSED_KEY };
