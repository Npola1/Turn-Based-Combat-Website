/* UI and transport only. The adapter inside the game owns game state. */
(() => {
  'use strict';
  document.documentElement.classList.add('save-choice-pending');
  const copy = value => JSON.parse(JSON.stringify(value));
  let adapter, controls, statusNode, saveButton, dialog, chosen = false, pickerOpened = false;
  let session = null, ready = false, readyGeneration = 0, enemyDepth = 0, busy = false;
  let opening = null, openingSent = false, openingRequested = false, sequence = 0, turn = 1, pending = [];
  let logs = [], intent = null, enemyIntent = null, baseline = null, outcome = null;
  let queue = Promise.resolve(), pickerPromise, flushScheduled = false, readyTimer;
  const showStatus = text => { if (statusNode) statusNode.textContent = text; };
  // Keep API calls inside the same deployed game directory (root locally).
  const apiBase = new URL('.', document.currentScript?.src || location.href).pathname.replace(/\/$/, '');
  const utf8 = new TextEncoder();
  const uploadIds = new WeakMap();
  const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
  const base64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(text); };
  async function request(path, options = {}) {
    if (location.protocol === 'file:') throw Error('Run npm start or use the deployed HTTPS website to access SQL saves.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = new Headers(options.headers || {});
      // CloudFront OAC signs Lambda requests. POST/PUT bodies need their exact hash.
      if (options.body !== undefined) headers.set('x-amz-content-sha256', hex(await crypto.subtle.digest('SHA-256', utf8.encode(options.body))));
      const response = await fetch(apiBase + path, { ...options, headers, credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw Error(error.error || `Request failed (${response.status})`); }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  async function api(path, options) {
    const result = await request(path, options);
    if (!result?.__rpgChunked) return result;
    const { id, parts } = result.__rpgChunked;
    if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isInteger(parts) || parts < 1 || parts > 2048) throw Error('Invalid chunked server response');
    const chunks = []; let length = 0;
    for (let part = 0; part < parts; part++) { const response = await request(`/api/responses/${id}/${part}`); const bytes = Uint8Array.from(atob(response.data), c => c.charCodeAt(0)); chunks.push(bytes); length += bytes.length; }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  async function write(path, body, method = 'POST') {
    const text = JSON.stringify(body), bytes = utf8.encode(text);
    if (bytes.length > 8 * 1024 * 1024) throw Error('Save exceeds the 8 MiB request limit');
    const send = (route, payload, verb = 'POST') => api(route, { method: verb, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    // The shared site's managed WAF rule limits each request body to 8 KiB.
    // Leave room for JSON/base64 metadata while preserving the full save limit.
    if (bytes.length <= 7 * 1024) return send(path, body, method);
    // Reuse an operation's receipt on retry. A new manual save gets a fresh ID,
    // even if its state matches an earlier save that has since been overwritten.
    let id = uploadIds.get(body);
    if (!id) { id = crypto.randomUUID(); uploadIds.set(body, id); }
    const size = 5 * 1024, total = Math.ceil(bytes.length / size);
    for (let index = 0; index < total; index++) await send('/api/uploads', { id, index, total, path, method, data: base64(bytes.subarray(index * size, (index + 1) * size)) });
    return send(`/api/uploads/${id}/commit`, {});
  }
  function serialize(task) {
    const job = queue.catch(() => {}).then(task);
    queue = job;
    return job;
  }
  function canSave() { return !!session && ready && !enemyDepth && !outcome && adapter.isReady(); }
  function update() {
    if (!controls) return;
    controls.hidden = !chosen || !adapter.hasBattle();
    saveButton.disabled = busy || !canSave();
    saveButton.title = canSave() ? 'Save this turn into slot 1–5' : 'Save at the start of a player turn, after effects finish';
  }
  function modal(title, subtitle, cancel) {
    if (dialog) dialog.remove();
    dialog = document.createElement('dialog');
    dialog.className = 'rpg-save-dialog';
    const heading = document.createElement('h2'); heading.textContent = title;
    heading.id = 'rpg-save-dialog-title'; dialog.setAttribute('aria-labelledby', heading.id);
    const text = document.createElement('p'); text.textContent = subtitle;
    dialog.append(heading, text);
    dialog.addEventListener('cancel', event => { if (!cancel || busy) event.preventDefault(); else closeModal(); });
    document.documentElement.appendChild(dialog);
    dialog.showModal();
    return dialog;
  }
  function closeModal() { dialog?.close(); dialog?.remove(); dialog = null; update(); }
  function button(text, action, primary = false) {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = text;
    if (primary) element.className = 'rpg-save-primary';
    element.onclick = action;
    return element;
  }
  function feedback(host) {
    const element = document.createElement('span'); element.setAttribute('role', 'status'); element.setAttribute('aria-live', 'polite'); host.append(element); return element;
  }
  function slotButton(slot, info, action, manual) {
    const element = button('', action); element.className = 'rpg-save-slot'; element.dataset.slot = slot;
    const title = document.createElement('strong'); title.textContent = slot === 6 ? 'Slot 6 · Autosave' : `Slot ${slot}`;
    const details = document.createElement('small');
    details.textContent = info ? `${new Date(info.updatedAt.replace(' ', 'T') + 'Z').toLocaleString()} · Turn ${info.turn} · ${info.actor}\n${info.party.join(', ')}` : 'Empty';
    element.append(title, details);
    if (!manual && !info) element.disabled = true;
    if (manual && slot === 6) { element.disabled = true; element.title = 'Reserved for the opening autosave'; }
    return element;
  }
  function metadata() { return { ...session, decisions: copy(pending), outcome }; }
  function checkpoint() {
    return { ...metadata(), state: { ...copy(adapter.snapshot()), schemaVersion: 2, battleId: session.battleId, sequence, turn }, inventory: copy(adapter.inventory()) };
  }
  async function sendOpening() {
    if (!opening || openingSent) return;
    await write('/api/autosave', opening);
    openingSent = true;
    showStatus('Opening autosave saved in slot 6');
  }
  async function flush() {
    if (!session) return;
    await sendOpening();
    const batch = metadata();
    // History writes do not replace a save slot or advance its checkpoint.
    await write('/api/battles/events', batch);
    const ids = new Set(batch.decisions.map(d => d.id));
    pending = pending.filter(d => !ids.has(d.id));
  }
  function flushSoon() {
    if (flushScheduled) return;
    flushScheduled = true;
    serialize(flush).catch(() => showStatus('History or autosave pending — check the server connection')).finally(() => { flushScheduled = false; });
  }
  function record(actorId, actionType, abilityOrItemId, targets = []) {
    if (!session || !baseline) return;
    const after = copy(adapter.combat());
    const beforeUnits = [...baseline.party, ...baseline.enemies];
    const changed = [...after.party, ...after.enemies].filter(unit => JSON.stringify(unit) !== JSON.stringify(beforeUnits.find(x => x.name === unit.name))).map(unit => unit.name);
    pending.push({ id: crypto.randomUUID(), sequenceNumber: ++sequence, turnNumber: turn, actorId: actorId || 'engine', actionType: actionType || 'action', abilityOrItemId: abilityOrItemId || null, targets: targets.length ? targets : changed, result: { before: baseline, after, log: logs.splice(0) } });
    baseline = after;
    flushSoon();
  }
  async function manualPicker() {
    if (!canSave() || busy || dialog) return;
    const host = modal('Save your battle', 'Choose a manual slot. Slot 6 is reserved for the opening autosave.', true);
    const message = feedback(host), grid = document.createElement('div'); grid.className = 'rpg-save-grid'; host.append(grid);
    const cancel = button('Cancel', closeModal); host.append(cancel);
    try {
      const entries = await api('/api/saves');
      if (host !== dialog) return;
      for (let slot = 1; slot <= 6; slot++) {
        const info = entries.find(x => x.slot === slot);
        grid.append(slotButton(slot, info, () => {
          if (!canSave()) { message.textContent = 'Wait for a ready player turn.'; return; }
          if (info) {
            grid.hidden = true;
            message.textContent = `Overwrite the existing save in slot ${slot}?`;
            const actions = document.createElement('div'); actions.className = 'rpg-save-actions';
            actions.append(button('Back', () => { actions.remove(); grid.hidden = false; message.textContent = ''; }), button('Overwrite', () => save(slot), true)); host.append(actions);
          } else save(slot);
        }, true));
      }
    } catch (error) { message.textContent = error.message; }
    async function save(slot) {
      if (busy || !canSave() || slot === 6) return;
      const snapshot = checkpoint();
      busy = true; update(); message.textContent = 'Saving…';
      host.querySelectorAll('button').forEach(b => b.disabled = true);
      try {
        await serialize(async () => {
          await sendOpening();
          await write(`/api/saves/${slot}`, snapshot, 'PUT');
          const ids = new Set(snapshot.decisions.map(d => d.id)); pending = pending.filter(d => !ids.has(d.id));
        });
        showStatus(`Saved in slot ${slot}`); closeModal();
      } catch (error) {
        message.textContent = `Save failed: ${error.message} Cancel and reopen Save to retry.`;
        cancel.disabled = false;
      } finally { busy = false; update(); }
    }
  }
  async function history() {
    if (dialog || busy) return;
    const host = modal('Battle history', 'Combat records are kept separately from your save slots.', true);
    const message = feedback(host); host.append(button('Close', closeModal));
    try {
      const battles = await api('/api/history');
      if (host !== dialog) return;
      if (!battles.length) message.textContent = 'No battles recorded yet.';
      for (const battle of battles) {
        const details = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('pre');
        summary.textContent = `${battle.started_at} · ${battle.outcome || 'In progress'} · ${battle.decisions.length} decisions${battle.source_battle_id ? ' · Resumed save' : ''}`;
        content.textContent = battle.decisions.map(d => `${d.sequence_number}. Turn ${d.turn_number}: ${d.actor_id} · ${d.action_type} ${d.ability_or_item_id || ''}\n${(JSON.parse(d.result_json).log || []).join('\n')}`).join('\n\n');
        details.append(summary, content); host.append(details);
      }
    } catch (error) { message.textContent = error.message; }
  }
  // A modal blocks game shortcuts as well as mouse interaction behind the dialog.
  for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => {
    if (!dialog?.open) return;
    event.stopImmediatePropagation();
    if (!dialog.contains(event.target)) event.preventDefault();
  }, true);

  window.RpgSaves = {
    install(gameAdapter) {
      adapter = gameAdapter;
      controls = document.createElement('div'); controls.id = 'rpg-save-controls'; controls.hidden = true;
      saveButton = button('Save', manualPicker); saveButton.dataset.save = '';
      const historyButton = button('History', history); historyButton.dataset.history = '';
      statusNode = document.createElement('span'); statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite');
      controls.append(saveButton, historyButton, statusNode); document.documentElement.append(controls);
      setInterval(() => { update(); if (session && (pending.length || (opening && !openingSent)) && !busy) flushSoon(); }, 3000);
    },
    openPicker() {
      if (pickerOpened) return pickerPromise;
      pickerOpened = true;
      pickerPromise = new Promise(resolve => {
        const host = modal('Choose a save', 'Load a saved battle, or start a new battle and choose your party.', false);
        const message = feedback(host), grid = document.createElement('div'); grid.className = 'rpg-save-grid'; host.append(grid);
        const actions = document.createElement('div'); actions.className = 'rpg-save-actions';
        const retry = button('Refresh saves', fill), fresh = button('New Battle', () => finish('new'), true);
        actions.append(retry, fresh); host.append(actions);
        async function fill() {
          message.textContent = 'Loading saves…'; grid.replaceChildren();
          try {
            const entries = await api('/api/saves');
            if (host !== dialog) return;
            for (let slot = 1; slot <= 6; slot++) grid.append(slotButton(slot, entries.find(x => x.slot === slot), () => load(slot), false));
            message.textContent = entries.length ? 'Loading is only available on this opening screen.' : 'No saves yet. Choose New Battle to begin.';
          } catch (error) { message.textContent = error.message; }
        }
        async function load(slot) {
          if (chosen || busy) return;
          busy = true; host.querySelectorAll('button').forEach(b => b.disabled = true);
          message.textContent = 'Restoring battle…';
          try {
            const saved = await api(`/api/saves/${slot}`);
            if (!saved) throw Error('This slot is empty.');
            adapter.restore(copy(saved));
            session = { battleId: crypto.randomUUID(), sourceBattleId: saved.state.battleId, sourceSequence: saved.state.sequence };
            sequence = 0; turn = saved.state.turn; pending = []; logs = []; intent = null; outcome = null;
            opening = null; openingSent = true; openingRequested = false; baseline = copy(adapter.combat());
            ready = true; showStatus(`Loaded slot ${slot}`); finish('loaded'); flushSoon();
          } catch (error) { message.textContent = `Load failed: ${error.message}`; fresh.disabled = false; retry.disabled = false; }
          finally { busy = false; update(); }
        }
        function finish(choice) {
          if (chosen) return;
          chosen = true; document.documentElement.classList.remove('save-choice-pending'); closeModal(); resolve(choice); update();
        }
        fill();
      });
      return pickerPromise;
    },
    begin() {
      // Drain the preceding battle before replacing its in-memory history queue.
      if (busy || pending.length || (opening && !openingSent)) { showStatus('Wait for pending saves/history to finish before starting another battle'); return false; }
      session = { battleId: crypto.randomUUID(), sourceBattleId: null, sourceSequence: null };
      sequence = 0; turn = 1; pending = []; logs = []; intent = null; baseline = null; outcome = null;
      opening = null; openingSent = false; openingRequested = false; ready = false; ++readyGeneration;
      update(); return true;
    },
    openingFinished() { openingRequested = true; this.ready(); },
    ready() {
      const generation = ++readyGeneration;
      clearTimeout(readyTimer);
      const checkReady = async () => {
        await adapter.animationsDone();
        if (generation !== readyGeneration || !session || outcome || enemyDepth) return;
        // Dialogue completion can notify us before its controls finish unlocking.
        // Recheck this same boundary; actions and phase changes invalidate it.
        if (!adapter.isReady()) { readyTimer = setTimeout(checkReady, 50); return; }
        ready = true;
        if (baseline === null) baseline = copy(adapter.combat());
        if (openingRequested && !opening && !openingSent) {
          opening = checkpoint(); opening.decisions = [];
          serialize(sendOpening).catch(() => showStatus('Opening autosave pending — check the server connection'));
        }
        update();
      };
      readyTimer = setTimeout(checkReady, 0);
    },
    invalidate() { clearTimeout(readyTimer); ready = false; ++readyGeneration; update(); },
    intent(action, ability, targets = []) { intent = { action, ability, targets }; this.invalidate(); },
    message(message) { if (session) logs.push(String(typeof message === 'object' ? message.text : message)); },
    player(actor, action, ability) {
      if (outcome) return;
      this.invalidate();
      record(actor, intent?.action || action, intent?.ability || ability, intent?.targets || []); intent = null;
    },
    followup(actor, partner, type, target) { if (!outcome && actor && partner) record(actor, 'follow-up', type + ':' + partner, [target || partner]); },
    enemyPhaseStart() { enemyDepth++; turn++; this.invalidate(); },
    enemyPhaseEnd() { enemyDepth = Math.max(0, enemyDepth - 1); this.ready(); },
    enemyIntent(ability) { enemyIntent = ability; },
    enemy(foe) { if (outcome) return; record(foe.name, 'enemy-action', enemyIntent); enemyIntent = null; },
    finish(result) {
      if (outcome) return;
      if (adapter.currentEnemy()) record(adapter.currentEnemy(), 'enemy-action', enemyIntent);
      else if (intent) record(adapter.currentActor(), intent.action, intent.ability, intent.targets);
      intent = null;
      outcome = result; this.invalidate(); record('engine', 'battle-end', result); flushSoon();
    },
    leaveBattle() { this.invalidate(); flushSoon(); setTimeout(update, 0); }
  };
})();
