// No dependencies: all Pi content is inserted as text nodes, never as HTML.
const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['identity','connection','context','session-name','cwd','notice','conversation','messages','activity','bottom','work-state','stop','compose','prompt','send','pair-overlay','pair-form','pair-code','pair-error','pair-submit','choice-overlay'].map(id => [id, $(id)]));
const state = { sessionId: null, seq: 0, entries: [], busy: false, attention: false, connected: false, pending: false, source: null, generation: 0, timer: null, retryDelay: 1000, draftKey: null, draftText: null, live: null, frame: 0 };
const make = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = String(text); return el; };
function banner(text) { ui.notice.textContent = text || ''; ui.notice.hidden = !text; }
function connection(text, style = '') { ui.connection.textContent = text; ui.connection.className = `status ${style}`; state.connected = style === 'online'; updateControls(); }
function updateControls() {
  ui['work-state'].textContent = state.attention ? 'Needs attention in Pi terminal' : state.busy ? 'Pi is working' : 'Ready';
  ui.stop.hidden = !state.busy; ui.stop.disabled = !state.connected || state.pending;
  ui.send.disabled = !state.connected || state.pending || !ui.prompt.value.trim();
  ui.send.textContent = state.pending ? 'Sending…' : state.busy ? 'Choose…' : 'Send';
  ui.activity.textContent = state.connected ? (state.attention ? 'Waiting for action in Pi terminal.' : state.busy ? 'Working…' : '') : 'Connection paused — reconnecting…';
}
function showPair() { ui['pair-overlay'].hidden = false; ui.bottom.hidden = true; ui['choice-overlay'].hidden = true; connection('Pair to connect', 'offline'); ui['pair-code'].focus(); }
function isNearBottom() { const e = ui.conversation; return e.scrollHeight - e.scrollTop - e.clientHeight < 110; }
function scrollBottom() { ui.conversation.scrollTop = ui.conversation.scrollHeight; }
function textAndCode(parent, input) {
  const source = typeof input === 'string' ? input : String(input ?? '');
  // split has capture groups; simpler explicit scan to avoid treating partial fences as code.
  const fence = /(?:^|\n)```([^\n]*)\n([\s\S]*?)\n?```(?=\n|$)/g;
  let at = 0, match;
  while ((match = fence.exec(source))) {
    if (match.index > at) parent.append(make('p', 'text', source.slice(at, match.index)));
    const wrap = make('div', 'code-wrap'), bar = make('div', 'code-bar');
    bar.append(make('span', '', match[1].trim().slice(0, 40) || 'Code'));
    const copy = make('button', 'copy', 'Copy'); copy.type = 'button';
    const code = match[2];
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy', 1800); } catch { copy.textContent = 'Copy failed'; } });
    bar.append(copy); wrap.append(bar);
    const pre = make('pre'); pre.append(make('code', '', code)); wrap.append(pre); parent.append(wrap);
    at = fence.lastIndex;
  }
  if (at < source.length) parent.append(make('p', 'text', source.slice(at)));
}
function detail(parent, title, content) { const d = make('details', 'detail'); d.append(make('summary', '', title)); const body = make('div', 'detail-content'); textAndCode(body, content); d.append(body); parent.append(d); }
function safeJson(value) { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
function renderContent(parent, message) {
  const content = message?.content;
  if (typeof content === 'string') { textAndCode(parent, content); return; }
  if (Array.isArray(content)) for (const block of content) {
    if (typeof block === 'string') textAndCode(parent, block);
    else if (block?.type === 'text') textAndCode(parent, block.text);
    else if (block?.type === 'thinking') detail(parent, 'Thinking', block.thinking ?? block.text ?? '');
    else if (block?.type === 'toolCall' || block?.type === 'tool_use') detail(parent, `Tool · ${block.name ?? 'call'}`, safeJson(block.arguments ?? block.input ?? block));
    else if (block?.type === 'image') parent.append(make('p', 'text', '[Image omitted from text view]'));
    else if (block != null) detail(parent, `Content · ${block.type ?? 'unknown'}`, safeJson(block));
  }
  if (message?.role === 'toolResult') {
    if (message.toolName) parent.prepend(make('p', 'text', `Tool: ${message.toolName}${message.isError ? ' · Error' : ''}`));
    if (message.details != null) detail(parent, 'Details', safeJson(message.details));
  }
  if (!parent.childNodes.length) parent.append(make('p', 'text', '[No text content]'));
}
function render() {
  const follow = isNearBottom(); const oldTop = ui.conversation.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const entry of state.entries) {
    if (entry?.type !== 'message' || !entry.message) continue;
    const message = entry.message, role = message.role ?? 'other';
    const card = make('article', `message ${['user','assistant','toolResult'].includes(role) ? role : 'other'}`);
    card.append(make('div', 'message-head', role === 'toolResult' ? 'Tool result' : role === 'assistant' ? 'Pi' : role === 'user' ? 'You' : role));
    const body = make('div', 'message-body'); renderContent(body, message); card.append(body); fragment.append(card);
  }
  if (state.live && !state.entries.some(e => e.id != null && e.id === state.live.id)) {
    const liveRole = state.live.message?.role ?? 'assistant';
    const card = make('article', `message ${liveRole}`); card.append(make('div', 'message-head', liveRole === 'assistant' ? 'Pi · streaming' : liveRole === 'user' ? 'You' : liveRole));
    const body = make('div', 'message-body'); renderContent(body, state.live.message); card.append(body); fragment.append(card);
  }
  if (!fragment.childNodes.length) fragment.append(make('p', 'empty', 'This branch has no messages yet. Send a prompt to begin.'));
  ui.messages.replaceChildren(fragment);
  if (follow) scrollBottom(); else ui.conversation.scrollTop = oldTop; // Keep reader position.
  updateControls();
}
function scheduleRender() {
  if (state.frame) return;
  state.frame = requestAnimationFrame(() => { state.frame = 0; render(); });
}
function applyDelta(delta) {
  if (!delta || typeof delta !== 'object') return;
  const type = delta.type;
  const index = delta.contentIndex;
  if (!Number.isInteger(index) || index < 0 || index > 200) return;
  if (!state.live) state.live = { id: null, message: { role: 'assistant', content: [] } };
  const content = state.live.message.content;
  if (type === 'text_start' || type === 'thinking_start') content[index] = type === 'text_start' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' };
  if (type === 'text_delta') {
    if (!content[index] || content[index].type !== 'text') content[index] = { type: 'text', text: '' };
    content[index].text += String(delta.delta ?? '');
  }
  if (type === 'thinking_delta') {
    if (!content[index] || content[index].type !== 'thinking') content[index] = { type: 'thinking', thinking: '' };
    content[index].thinking += String(delta.delta ?? '');
  }
  if (type === 'text_end' && typeof delta.content === 'string') content[index] = { type: 'text', text: delta.content };
  if (type === 'thinking_end' && typeof delta.content === 'string') content[index] = { type: 'thinking', thinking: delta.content };
  if (type === 'toolcall_end' && delta.toolCall) content[index] = delta.toolCall;
}
function identity(snapshot) {
  ui.identity.textContent = snapshot.name || snapshot.sessionId || 'Active session';
  ui['session-name'].textContent = snapshot.name || snapshot.sessionId || 'Active session';
  ui.cwd.textContent = snapshot.cwd || '';
  ui.context.hidden = !snapshot.cwd && !snapshot.sessionId;
}
function installSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.entries) || !Number.isSafeInteger(snapshot.seq)) throw Error('Invalid session snapshot');
  const changed = state.sessionId != null && state.sessionId !== snapshot.sessionId;
  state.sessionId = snapshot.sessionId; state.seq = snapshot.seq; state.entries = snapshot.entries; state.live = null;
  state.busy = Boolean(snapshot.busy); state.attention = Boolean(snapshot.attention);
  identity(snapshot);
  if (changed) banner('Active session changed. Showing the current branch.');
  ui.bottom.hidden = false; ui['pair-overlay'].hidden = true;
  render();
  if (changed) ui.conversation.scrollTop = 0;
}
function upsert(message, id) {
  if (!message || typeof message !== 'object') return;
  const key = id ?? message.id;
  const position = key == null ? -1 : state.entries.findIndex(e => e?.type === 'message' && e.id === key);
  if (position !== -1) state.entries[position] = { ...state.entries[position], message };
  else if (key != null) state.entries.push({ type: 'message', id: key, message });
  else state.live = { id: null, message };
}
function applyEvent(event) {
  if (!event || !Number.isSafeInteger(event.seq)) { reconnect('Stream out of sync. Reloading…'); return; }
  if (event.seq <= state.seq) return;
  if (event.seq !== state.seq + 1 || (event.sessionId != null && event.sessionId !== state.sessionId)) { reconnect('Session updated. Reloading…'); return; }
  state.seq = event.seq;
  const data = event.data ?? {};
  if (event.kind === 'session_change' || event.kind === 'resync') { reconnect('Active session changed. Loading branch…'); return; }
  if (event.kind === 'agent_start') { state.busy = true; state.attention = false; }
  if (event.kind === 'agent_end') { state.busy = false; state.attention = false; state.live = null; reconnectSoon(); }
  if (event.kind === 'attention') state.attention = true;
  if (['message_start','message_update','message_end'].includes(event.kind)) {
    const message = data.message ?? (data.role ? data : null);
    if (message) {
      if (!data.id && !data.entryId) state.live = { id: null, message };
      else upsert(message, data.id ?? data.entryId);
    } else if (event.kind === 'message_update') applyDelta(data.assistantMessageEvent);
    // Native Pi message events have no persisted entry ID; reconcile the completed branch.
    if (event.kind === 'message_end') reconnectSoon();
  }
  scheduleRender();
}
function reconnectSoon() { clearTimeout(state.timer); state.timer = setTimeout(() => reconnect(), 350); }
function reconnect(message) {
  if (message) banner(message);
  clearTimeout(state.timer); state.generation++; state.source?.close(); state.source = null;
  connection('Reconnecting…', 'offline');
  const generation = state.generation;
  state.timer = setTimeout(() => connect(generation), state.retryDelay);
  state.retryDelay = Math.min(state.retryDelay * 2, 12000);
}
async function jsonRequest(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  let payload = null; try { payload = await response.json(); } catch { /* non-JSON error */ }
  if (!response.ok) { const error = new Error(payload?.error?.message || payload?.error || payload?.message || `Request failed (${response.status})`); error.status = response.status; throw error; }
  return payload;
}
async function connect(generation = ++state.generation) {
  if (generation !== state.generation) return;
  connection('Connecting…');
  // Open the stream first; only fetch the snapshot once the subscription is open.
  // Buffer any events arriving during the fetch, then apply those newer than snapshot.seq.
  const source = new EventSource('/api/v1/events', { withCredentials: true }); state.source = source;
  let loading = false, ready = false, buffered = [];
  source.onopen = async () => {
    if (generation !== state.generation || loading) return;
    loading = true;
    try {
      const snapshot = await jsonRequest('/api/v1/session');
      if (generation !== state.generation) return;
      installSnapshot(snapshot);
      buffered.sort((a,b) => a.seq - b.seq).forEach(applyEvent); buffered = [];
      if (generation !== state.generation) return;
      ready = true;
      connection('Connected', 'online'); state.retryDelay = 1000;
      if (ui.notice.textContent === 'Connection lost. Reconnecting…') banner('');
    } catch (error) {
      if (generation !== state.generation) return;
      if (error.status === 401 || error.status === 403) { source.close(); showPair(); return; }
      reconnect(`Unable to load session: ${error.message}`);
    }
  };
  const receive = e => {
    if (generation !== state.generation) return;
    let event; try { event = JSON.parse(e.data); } catch { reconnect('Invalid stream event. Reloading…'); return; }
    if (event.kind === 'snapshot') return; // GET /session is our authoritative fresh snapshot.
    if (event.kind === 'resync') { reconnect('Stream requires a fresh snapshot. Reloading…'); return; }
    if (!ready) buffered.push(event); else applyEvent(event);
  };
  for (const kind of ['message_start','message_update','message_end','agent_start','agent_end','session_change','attention','turn_start','turn_end','tool_execution_start','tool_execution_end','resync','snapshot']) source.addEventListener(kind, receive);
  source.onmessage = receive;
  source.onerror = async () => {
    if (generation !== state.generation) return;
    // EventSource hides HTTP status (including 401). Check session before retrying.
    if (!ready) {
      try { await jsonRequest('/api/v1/session'); }
      catch (error) { if (generation !== state.generation) return; if (error.status === 401 || error.status === 403) { source.close(); showPair(); return; } }
    }
    if (generation === state.generation) reconnect('Connection lost. Reconnecting…');
  };
}
ui['pair-form'].addEventListener('submit', async e => {
  e.preventDefault(); const code = ui['pair-code'].value.trim(); if (!/^[0-9]{6}$/.test(code)) { ui['pair-error'].textContent = 'Enter exactly six digits.'; ui['pair-error'].hidden = false; return; }
  ui['pair-submit'].disabled = true; ui['pair-error'].hidden = true;
  try { await jsonRequest('/api/v1/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, mode: 'browser' }) }); ui['pair-code'].value = ''; ui['pair-overlay'].hidden = true; state.retryDelay = 1000; reconnect(); }
  catch (error) { ui['pair-error'].textContent = error.message; ui['pair-error'].hidden = false; }
  finally { ui['pair-submit'].disabled = false; }
});
ui.prompt.addEventListener('input', () => { if (ui.prompt.value !== state.draftText) state.draftKey = null; updateControls(); ui.prompt.style.height = 'auto'; ui.prompt.style.height = `${Math.min(ui.prompt.scrollHeight, 180)}px`; });
ui.prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ui.compose.requestSubmit(); } });
async function submit(mode) {
  const text = ui.prompt.value.trim(); if (!text || state.pending || !state.connected) return;
  if (!state.draftKey || state.draftText !== text) { state.draftKey = crypto.randomUUID(); state.draftText = text; }
  const key = state.draftKey;
  state.pending = true; updateControls();
  try {
    await jsonRequest('/api/v1/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ text, mode }) });
    if (ui.prompt.value.trim() === text) { ui.prompt.value = ''; ui.prompt.style.height = 'auto'; }
    state.draftKey = null; state.draftText = null; banner('Prompt accepted. Waiting for Pi.');
  } catch (error) {
    if (error.status === 401 || error.status === 403) showPair();
    banner(`${error.message}. ${error.status ? 'Prompt was not confirmed; check Pi before retrying.' : 'Delivery unknown. Retry keeps the same idempotency key.'}`);
  } finally { state.pending = false; updateControls(); }
}
ui.compose.addEventListener('submit', e => { e.preventDefault(); if (state.busy) { ui['choice-overlay'].hidden = false; ui['choice-overlay'].querySelector('button').focus(); } else submit('normal'); });
ui['choice-overlay'].addEventListener('click', e => { const button = e.target.closest('button[data-mode]'); if (!button) return; ui['choice-overlay'].hidden = true; if (button.dataset.mode !== 'cancel') submit(button.dataset.mode); else ui.prompt.focus(); });
ui.stop.addEventListener('click', async () => { if (!confirm('Stop the current run? External side effects may already have happened.')) return; ui.stop.disabled = true; try { await jsonRequest('/api/v1/abort', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: '{}' }); banner('Stop requested. Waiting for Pi to confirm.'); } catch (error) { banner(`Could not stop: ${error.message}`); } finally { updateControls(); } });
window.addEventListener('online', () => reconnect());
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnect(); });
connect();
