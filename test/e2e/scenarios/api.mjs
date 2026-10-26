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
