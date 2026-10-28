// api: core route surface (sessions/messages/queue/hooks-waiting)
import { withEnv, writeSession, assert, api, waitSession } from '../harness.mjs';
import { timelineLines } from '../fixtures.mjs';

await withEnv(async (h) => {
  writeSession(h, 'T--e2e', 'api1', timelineLines());
  assert(await waitSession('api1'), 'session visible');

  const ping = await api('/api/ping');
  assert(ping.ok, 'ping');

  const msgs = await (await api('/api/sessions/api1/messages')).json();
  assert(msgs.events.some((e) => e.k === 'user'), 'messages user events');
  assert(msgs.events.some((e) => e.k === 'toolres'), 'messages toolres events');
  assert(msgs.events.some((e) => e.k === 'stop'), 'messages stop marker');

  // v44: pagination surface + markdown export
  assert(Number.isInteger(msgs.total) && msgs.total >= msgs.events.length, 'messages total present');
  const older = await (await api('/api/sessions/api1/messages?before=1')).json();
  assert(older.total === msgs.total && older.events.length === msgs.total - 1, 'messages ?before slices');
  const ex = await api('/api/sessions/api1/export?scope=full');
  const md = await ex.text();
  assert(ex.status === 200 && (ex.headers.get('content-type') || '').includes('text/markdown'), 'export full 200 markdown');
  assert(md.startsWith('# ') && md.includes('## 用户'), 'export markdown shape');
  assert((await api('/api/sessions/api1/export?scope=summary')).status === 200, 'export summary 200');

  const q = await (await api('/api/sessions/api1/queue')).json();
  assert(q.ok && Array.isArray(q.queue) && q.queue.length === 0, 'queue snapshot empty');
  assert((await api('/api/sessions/api1/queue/nope', { method: 'DELETE' })).status === 404, 'queue delete unknown 404');
  assert((await api('/api/sessions/api1/queue/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"order":[]}' })).status === 400, 'reorder empty 400');

  // waiting state via fake hook payload (permission only - v21 rule)
  const H = '/hooks/notification?token=' + 'e2etok';
  const hook = (body) => fetch('http://127.0.0.1:3799' + H, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await hook({ session_id: 'api1', message: 'Claude is waiting for your input' });
  let s = ((await (await api('/api/sessions')).json()).sessions || []).find((x) => x.id === 'api1');
  assert(!s.waiting, 'idle nudge must NOT set waiting (v21 rule)');
  await hook({ session_id: 'api1', message: 'Claude needs your permission to use Bash' });
  s = ((await (await api('/api/sessions')).json()).sessions || []).find((x) => x.id === 'api1');
  assert(s.waiting && s.waiting.kind === 'permission' && s.waiting.tool === 'Bash', 'permission sets waiting');
  await fetch('http://127.0.0.1:3799/hooks/stop?token=e2etok', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'api1' }) });
  s = ((await (await api('/api/sessions')).json()).sessions || []).find((x) => x.id === 'api1');
  assert(!s.waiting, 'stop hook clears waiting');
});
