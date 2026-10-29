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
  detailSeq: 0,       // monotonic id for detail history entries - every
                      // pushState({cr:'detail'}) MUST be unique (state AND
                      // url): adjacent identical entries are silently
                      // traversed by Chromium and eat a back press
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
  expectQueuedUser: false,  // a queued message just dispatched: its user event
                            // must render even if same-text elders would read
                            // as a replayed duplicate (v37)
  modelCatalog: null, // /api/models cache: [{id,label,ctx}]
  ctxProbe: null,    // last /context probe result {key,window,fixed,buffer}
  queue: {},         // sessionId -> [{id,text}] pending queue (WS 'queue' frames)
  attach: [],        // pending attachments for the open session (uploaded)
  waits: {},         // sessionId -> {kind,tool,msg,at} PC stuck on a prompt (v21)
  armedBranch: null,      // v40: session id whose NEXT message forks a new thread
  listQuery: '',          // v43: list-page search box content
  batchMode: false,       // v43: list-page multi-select mode
  batchSel: new Set(),    // v43: session ids ticked in batch mode
  pendingBranch: false,   // a fork send is in flight; adopt its real session id
  pendingBranchRun: null, // that fork's runId (known once the 202 lands)
  histBefore: 0,      // v44 history pagination: trailing events already loaded
  histTotal: 0,       // v44: total parsed events in the transcript
  histLoading: false, // v44: an older-page fetch is in flight
  orphanToolRes: new Map(), // v46: toolres whose tool_use is on an older page
                            // (pagination split) - parked here until it loads
  agents: {},          // v112: toolUseId -> {agentId, desc, agentType, bg,
                       // finished, state, steps, act, startedAt} (agent frames
                       // + the messages fetch's agents summary)
  agentView: null,     // v112: the open agent bubble {toolUseId, agentId}
};

export { CLOSED_KEY };

// picked send overrides (persisted): '' = follow CLI/session default.
// Views write localStorage inline; reads funnel through here.
export function currentModel() { return localStorage.getItem('cr_model') || ''; }
export function currentEffort() { return localStorage.getItem('cr_effort') || ''; }
