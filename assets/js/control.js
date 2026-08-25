(() => {
  'use strict';

  const params = OverlayCore.parseFragment();
  const room = params.room || '';
  const privateToken = params.sk || '';
  const status = document.querySelector('#connection-status');
  const errorBox = document.querySelector('#fatal-error');
  const app = document.querySelector('#control-app');
  const preview = document.querySelector('#preview-frame');
  const overlayUrlField = document.querySelector('#overlay-url');
  const controllerUrlField = document.querySelector('#controller-url');
  const timerCurrent = document.querySelector('#timer-current');
  const timerPeriod = document.querySelector('#match-period');
  const halfMinutes = document.querySelector('#half-minutes');
  const timerSetForm = document.querySelector('#timer-set-form');
  const timerSetValue = document.querySelector('#timer-set-value');
  const timerToggle = document.querySelector('#timer-toggle');
  const timerValidation = document.querySelector('#timer-validation');

  const state = OverlayCore.normalizeState();
  const logoBlobs = { home: null, away: null };
  const logoUrls = { home: '', away: '' };
  const queuedPatch = {};
  const queuedLogos = { home: null, away: null };
  const localLogoPreferred = { home: false, away: false };
  const pendingTimers = new Map();

  let privateKey = null;
  let peer = null;
  let connection = null;
  let authenticated = false;
  let reconnectTimer = null;
  let connecting = false;
  let hasSyncedOnce = false;
  let timerUiInterval = null;

  const TIMER_PATCH_KEYS = new Set(['period', 'half_minutes', 'timer_elapsed_ms', 'timer_running']);

  function setStatus(message, kind = 'neutral') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function fatal(message) {
    errorBox.hidden = false;
    errorBox.textContent = message;
    app.hidden = true;
  }

  function hasTimerPatch(patch) {
    return Object.keys(patch || {}).some((key) => TIMER_PATCH_KEYS.has(key));
  }

  function currentTimerPatch() {
    const snapshot = OverlayCore.portableState(state);
    return {
      period: snapshot.period,
      half_minutes: snapshot.half_minutes,
      timer_elapsed_ms: snapshot.timer_elapsed_ms,
      timer_running: snapshot.timer_running
    };
  }

  function setTimerValidation(message = '', kind = 'neutral') {
    timerValidation.textContent = message;
    timerValidation.dataset.kind = kind;
  }

  function refreshTimerUi({ syncInput = false } = {}) {
    const elapsed = OverlayCore.timerElapsedAt(state);
    const limit = OverlayCore.timerLimitMs(state.half_minutes);

    if (state.timer_running && elapsed >= limit) {
      Object.assign(state, OverlayCore.applyPatch(state, { timer_elapsed_ms: limit, timer_running: false }));
    }

    const currentElapsed = OverlayCore.timerElapsedAt(state);
    timerCurrent.textContent = OverlayCore.formatTimer(currentElapsed);
    timerToggle.textContent = state.timer_running ? 'Pauza' : 'Start';
    timerToggle.setAttribute('aria-pressed', state.timer_running ? 'true' : 'false');

    if (syncInput) {
      timerPeriod.value = state.period;
      halfMinutes.value = String(state.half_minutes);
    }

    if (syncInput || document.activeElement !== timerSetValue) {
      timerSetValue.value = OverlayCore.formatTimer(currentElapsed);
    }
  }

  function setLogoPreview(side, source) {
    if (logoUrls[side] && logoUrls[side].startsWith('blob:')) URL.revokeObjectURL(logoUrls[side]);
    logoUrls[side] = '';
    logoBlobs[side] = null;

    if (source instanceof Blob) {
      logoBlobs[side] = source;
      logoUrls[side] = URL.createObjectURL(source);
    } else if (typeof source === 'string' && source) {
      logoUrls[side] = source;
    }

    const image = document.querySelector(`#${side}-logo-preview`);
    image.src = logoUrls[side] || '';
    image.hidden = !logoUrls[side];
    postPreview();
  }

  function syncInputs() {
    document.querySelector('#home-name').value = state.home_name;
    document.querySelector('#away-name').value = state.away_name;
    document.querySelector('#home-score').value = state.home_score;
    document.querySelector('#away-score').value = state.away_score;
    refreshTimerUi({ syncInput: true });
    postPreview();
  }

  function postPreview() {
    if (!preview.contentWindow) return;
    preview.contentWindow.postMessage({
      type: 'overlay-preview',
      state: OverlayCore.portableState(state),
      logos: { home: logoUrls.home || '', away: logoUrls.away || '' }
    }, window.location.origin);
  }

  function queuePatch(patch) {
    Object.assign(queuedPatch, patch);
  }

  function sendPatch(patch) {
    const cleanPatch = OverlayCore.sanitizePatch(patch);
    if (!Object.keys(cleanPatch).length) return;
    Object.assign(state, OverlayCore.applyPatch(state, cleanPatch));
    syncInputs();
    if (authenticated && connection?.open) {
      connection.send({ type: 'patch', patch: cleanPatch });
      setStatus('Połączono • zmiana wysłana', 'ok');
    } else {
      queuePatch(cleanPatch);
      setStatus('OBS offline • zmiana czeka na połączenie', 'warning');
    }
  }

  function debouncePatch(key, value, delay = 260) {
    clearTimeout(pendingTimers.get(key));
    pendingTimers.set(key, setTimeout(() => {
      pendingTimers.delete(key);
      sendPatch({ [key]: value });
    }, delay));
  }

  async function sendLogo(side, blob, name = `${side}-logo`) {
    if (!authenticated || !connection?.open) {
      queuedLogos[side] = { blob, name, remove: false };
      setStatus(`OBS offline • logo ${side === 'home' ? 'drużyny 1' : 'drużyny 2'} czeka`, 'warning');
      return;
    }

    const label = side === 'home' ? 'drużyny 1' : 'drużyny 2';
    await OverlayCore.sendBlob(connection, side, blob, {
      purpose: 'logo',
      name,
      onProgress: (progress) => setStatus(`Wysyłam logo ${label}: ${Math.round(progress * 100)}% • ${OverlayCore.formatBytes(blob.size)}`, 'neutral')
    });
    setStatus('Połączono • logo wysłane', 'ok');
  }

  async function flushQueue() {
    if (!authenticated || !connection?.open) return;
    if (Object.keys(queuedPatch).length) {
      const patch = { ...queuedPatch };
      if (hasTimerPatch(patch)) Object.assign(patch, currentTimerPatch());
      for (const key of Object.keys(queuedPatch)) delete queuedPatch[key];
      connection.send({ type: 'patch', patch });
    }
    for (const side of ['home', 'away']) {
      const queued = queuedLogos[side];
      if (queued) {
        queuedLogos[side] = null;
        if (queued.remove) connection.send({ type: 'logo-remove', side });
        else await sendLogo(side, queued.blob, queued.name);
      }
    }
  }

  function parseTimerValue(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):([0-5]\d)$/);
    if (!match) return null;
    const minutes = Number.parseInt(match[1], 10);
    const seconds = Number.parseInt(match[2], 10);
    return (minutes * 60 + seconds) * 1000;
  }

  function bindTimer() {
    timerPeriod.addEventListener('change', () => {
      setTimerValidation();
      sendPatch({ period: timerPeriod.value });
    });

    halfMinutes.addEventListener('change', () => {
      setTimerValidation();
      sendPatch({ half_minutes: Number.parseInt(halfMinutes.value, 10) });
    });

    timerSetForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const elapsed = parseTimerValue(timerSetValue.value);
      if (elapsed === null) {
        setTimerValidation('Podaj czas w formacie MM:SS, np. 07:30.', 'error');
        timerSetValue.focus();
        return;
      }
      const limit = OverlayCore.timerLimitMs(state.half_minutes);
      if (elapsed > limit) {
        setTimerValidation(`Maksymalny czas tej połowy to ${OverlayCore.formatTimer(limit)}.`, 'error');
        timerSetValue.focus();
        return;
      }
      setTimerValidation();
      sendPatch({ timer_elapsed_ms: elapsed });
    });

    document.querySelector('#timer-minus-10').addEventListener('click', () => {
      setTimerValidation();
      sendPatch({ timer_elapsed_ms: OverlayCore.timerElapsedAt(state) - 10 * 1000 });
    });

    document.querySelector('#timer-plus-10').addEventListener('click', () => {
      setTimerValidation();
      sendPatch({ timer_elapsed_ms: OverlayCore.timerElapsedAt(state) + 10 * 1000 });
    });

    document.querySelector('#timer-reset').addEventListener('click', () => {
      setTimerValidation();
      sendPatch({ timer_elapsed_ms: 0 });
    });

    timerToggle.addEventListener('click', () => {
      const elapsed = OverlayCore.timerElapsedAt(state);
      const limit = OverlayCore.timerLimitMs(state.half_minutes);
      if (!state.timer_running && elapsed >= limit) {
        setTimerValidation('Ustaw czas poniżej końca połowy, aby uruchomić zegar.', 'error');
        return;
      }
      setTimerValidation();
      sendPatch({ timer_running: !state.timer_running });
    });

    timerUiInterval = setInterval(() => refreshTimerUi(), 200);
  }

  function bindTeam(side) {
    const name = document.querySelector(`#${side}-name`);
    const score = document.querySelector(`#${side}-score`);
    const logo = document.querySelector(`#${side}-logo`);
    const removeLogo = document.querySelector(`#${side}-logo-remove`);

    name.addEventListener('input', () => {
      const value = name.value.slice(0, 40);
      state[`${side}_name`] = value;
      postPreview();
      debouncePatch(`${side}_name`, value);
    });

    score.addEventListener('change', () => {
      sendPatch({ [`${side}_score`]: OverlayCore.clampScore(score.value) });
    });

    document.querySelectorAll(`[data-score-side="${side}"]`).forEach((button) => {
      button.addEventListener('click', () => {
        const delta = Number.parseInt(button.dataset.delta, 10);
        sendPatch({ [`${side}_score`]: OverlayCore.clampScore(state[`${side}_score`] + delta) });
      });
    });

    logo.addEventListener('change', async () => {
      const [file] = logo.files;
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        setStatus('Wybierz plik graficzny.', 'error');
        logo.value = '';
        return;
      }

      try {
        localLogoPreferred[side] = true;
        setLogoPreview(side, file);
        await sendLogo(side, file, file.name || `${side}-logo`);
      } catch (error) {
        console.error(error);
        queuedLogos[side] = { blob: file, name: file.name || `${side}-logo`, remove: false };
        setStatus(`Logo nie zostało wysłane: ${error.message || error}`, 'error');
      } finally {
        logo.value = '';
      }
    });

    removeLogo.addEventListener('click', () => {
      localLogoPreferred[side] = true;
      setLogoPreview(side, null);
      if (authenticated && connection?.open) connection.send({ type: 'logo-remove', side });
      else {
        queuedLogos[side] = { remove: true };
        setStatus('OBS offline • usunięcie logo czeka na połączenie', 'warning');
      }
    });
  }

  const assetReceiver = OverlayCore.createAssetReceiver({
    onComplete: async ({ side, blob }) => {
      if (!localLogoPreferred[side]) setLogoPreview(side, blob);
    },
    onProgress: ({ side, progress, size }) => {
      if (progress > 0 && progress < 1) {
        setStatus(`Pobieram zapisane logo ${side === 'home' ? 'drużyny 1' : 'drużyny 2'}: ${Math.round(progress * 100)}% • ${OverlayCore.formatBytes(size)}`, 'neutral');
      }
    },
    onError: (error) => setStatus(`Błąd synchronizacji logo: ${error.message || error}`, 'error')
  });

  function scheduleReconnect(delay = 1800) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connectToOverlay(), delay);
  }

  async function handleData(message, sourceConnection) {
    if (sourceConnection !== connection) return;
    if (await assetReceiver.handle(message)) return;

    if (message?.type === 'challenge') {
      if (message.protocol !== OverlayCore.PROTOCOL || message.room !== room) return;
      const signature = await OverlayCore.signChallenge(privateKey, room, message.nonce);
      sourceConnection.send({
        type: 'auth',
        nonce: message.nonce,
        signature,
        knownLogos: { home: logoBlobs.home instanceof Blob, away: logoBlobs.away instanceof Blob }
      });
      setStatus('Uwierzytelniam prywatny link…', 'neutral');
      return;
    }

    if (message?.type === 'auth-ok') {
      authenticated = true;
      connecting = false;

      const localTimerState = currentTimerPatch();
      if (!hasSyncedOnce) {
        const pendingPatch = { ...queuedPatch };
        if (hasTimerPatch(pendingPatch)) Object.assign(pendingPatch, localTimerState);
        let syncedState = OverlayCore.normalizeState(message.state);
        if (Object.keys(pendingPatch).length) syncedState = OverlayCore.applyPatch(syncedState, pendingPatch);
        Object.assign(state, syncedState);
        hasSyncedOnce = true;
      } else {
        sourceConnection.send({ type: 'patch', patch: OverlayCore.portableState(state) });
      }

      const presence = message.logoPresence || {};
      for (const side of ['home', 'away']) {
        if (logoBlobs[side] instanceof Blob && !presence[side] && !queuedLogos[side]) {
          queuedLogos[side] = { blob: logoBlobs[side], name: `${side}-logo`, remove: false };
        }
      }

      syncInputs();
      setStatus('Połączono z OBS • sterowanie aktywne', 'ok');
      await flushQueue();
      return;
    }

    if (message?.type === 'auth-failed') {
      authenticated = false;
      setStatus('Prywatny link został odrzucony przez overlay.', 'error');
      connection?.close();
      return;
    }

    if (message?.type === 'state' && authenticated) {
      Object.assign(state, OverlayCore.normalizeState(message.state));
      syncInputs();
      setStatus('Połączono z OBS • sterowanie aktywne', 'ok');
      return;
    }

    if (message?.type === 'asset-ack' && authenticated) {
      setStatus(`Połączono • logo zapisane w OBS (${OverlayCore.formatBytes(message.size)})`, 'ok');
      return;
    }

    if (message?.type === 'logo-removed' && authenticated) {
      setStatus('Połączono • logo usunięte', 'ok');
    }
  }

  async function connectToOverlay() {
    if (!peer?.open || connecting || (connection?.open && authenticated)) return;
    connecting = true;
    authenticated = false;
    setStatus('Szukam overlayu w OBS…', 'neutral');

    try {
      const conn = peer.connect(OverlayCore.peerIdForRoom(room), { reliable: true, serialization: 'binary' });
      connection = conn;

      conn.on('open', () => setStatus('Połączenie znalezione • autoryzacja…', 'neutral'));
      conn.on('data', (message) => void handleData(message, conn));
      conn.on('close', () => {
        authenticated = false;
        connecting = false;
        if (connection === conn) connection = null;
        setStatus('OBS offline • ponawiam połączenie…', 'warning');
        scheduleReconnect();
      });
      conn.on('error', (error) => {
        console.warn('Błąd DataConnection:', error);
        authenticated = false;
        connecting = false;
        setStatus('Nie udało się połączyć z OBS • ponawiam…', 'warning');
        scheduleReconnect();
      });

      setTimeout(() => {
        if (connection === conn && !authenticated) {
          connecting = false;
          try { conn.close(); } catch (_) {}
          scheduleReconnect(1200);
        }
      }, 8000);
    } catch (error) {
      console.warn(error);
      connecting = false;
      setStatus('OBS nie jest jeszcze dostępny • ponawiam…', 'warning');
      scheduleReconnect();
    }
  }

  async function init() {
    if (!room || !privateToken) {
      fatal('Brakuje prywatnego klucza sterowania w adresie. Otwórz pełny link wygenerowany na stronie startowej.');
      return;
    }
    if (!window.Peer) {
      fatal('Nie udało się załadować modułu połączenia P2P.');
      return;
    }

    try {
      privateKey = await OverlayCore.importPrivateKey(privateToken);
      const publicToken = OverlayCore.publicTokenFromPrivateToken(privateToken);
      const overlayUrl = OverlayCore.buildUrl('overlay.html', { room, pk: publicToken });
      const controllerUrl = window.location.href;

      overlayUrlField.value = overlayUrl;
      controllerUrlField.value = controllerUrl;
      preview.src = OverlayCore.buildUrl('overlay.html', { preview: '1' });
      preview.addEventListener('load', postPreview);
      window.addEventListener('message', (event) => {
        if (event.origin === window.location.origin && event.data?.type === 'overlay-preview-ready') postPreview();
      });

      bindTeam('home');
      bindTeam('away');
      bindTimer();
      document.querySelector('#reset-score').addEventListener('click', () => sendPatch({ home_score: 0, away_score: 0 }));
      document.querySelector('#copy-overlay-url').addEventListener('click', async (event) => {
        await OverlayCore.copyText(overlayUrl);
        const button = event.currentTarget;
        const old = button.textContent;
        button.textContent = 'Skopiowano';
        setTimeout(() => { button.textContent = old; }, 1300);
      });
      document.querySelector('#copy-controller-url').addEventListener('click', async (event) => {
        await OverlayCore.copyText(controllerUrl);
        const button = event.currentTarget;
        const old = button.textContent;
        button.textContent = 'Skopiowano';
        setTimeout(() => { button.textContent = old; }, 1300);
      });

      syncInputs();
      peer = new Peer();
      peer.on('open', () => {
        setStatus('Panel online • szukam OBS…', 'neutral');
        connecting = false;
        void connectToOverlay();
      });
      peer.on('disconnected', () => {
        authenticated = false;
        setStatus('Utracono sygnalizację • próbuję ponownie…', 'warning');
        try { peer.reconnect(); } catch (_) {}
      });
      peer.on('error', (error) => {
        if (error?.type === 'peer-unavailable') {
          connecting = false;
          setStatus('OBS nie jest jeszcze online • ponawiam…', 'warning');
          scheduleReconnect();
        } else {
          console.warn('PeerJS:', error);
          connecting = false;
          setStatus(`P2P: ${error?.message || error}`, 'warning');
          scheduleReconnect(2500);
        }
      });
    } catch (error) {
      console.error(error);
      fatal(`Nie udało się otworzyć panelu: ${error.message || error}`);
    }
  }

  window.addEventListener('beforeunload', () => {
    clearTimeout(reconnectTimer);
    clearInterval(timerUiInterval);
    assetReceiver.clear();
    for (const side of ['home', 'away']) {
      if (logoUrls[side]?.startsWith('blob:')) URL.revokeObjectURL(logoUrls[side]);
    }
    try { peer?.destroy(); } catch (_) {}
  }, { once: true });

  void init();
})();
