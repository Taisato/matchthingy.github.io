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
  const timerReadout = document.querySelector('#timer-readout');
  const timerPeriod = document.querySelector('#timer-period');
  const timerBadge = document.querySelector('#clock-badge');
  const clockToggleButton = document.querySelector('#clock-toggle');
  const overlayWidthLabel = document.querySelector('#overlay-width-label');

  const state = OverlayCore.normalizeState();
  const logoBlobs = { home: null, away: null, league: null };
  const logoUrls = { home: '', away: '', league: '' };
  const queuedPatch = {};
  const queuedLogos = { home: null, away: null, league: null };
  const localLogoPreferred = { home: false, away: false, league: false };
  const pendingTimers = new Map();

  let privateKey = null;
  let peer = null;
  let connection = null;
  let authenticated = false;
  let reconnectTimer = null;
  let connecting = false;
  let uiInterval = null;

  function setStatus(message, kind = 'neutral') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function fatal(message) {
    errorBox.hidden = false;
    errorBox.textContent = message;
    app.hidden = true;
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
    if (image) {
      image.src = logoUrls[side] || '';
      image.hidden = !logoUrls[side];
    }
    postPreview();
  }

  function currentRemainingSeconds() {
    return OverlayCore.getClockRemaining(state);
  }

  function applyStateToInputs() {
    document.querySelector('#home-name').value = state.home_name;
    document.querySelector('#away-name').value = state.away_name;
    document.querySelector('#home-score').value = state.home_score;
    document.querySelector('#away-score').value = state.away_score;
    document.querySelector('#league-name').value = state.league_name;
    document.querySelector('#show-league-logo').checked = state.show_league_logo;
    document.querySelector('#show-league-name').checked = state.show_league_name;
    document.querySelector('#overlay-width-range').value = state.overlay_width;
    document.querySelector('#overlay-width-number').value = state.overlay_width;
    overlayWidthLabel.textContent = `${state.overlay_width} px`;

    document.querySelectorAll('[data-period]').forEach((button) => {
      button.dataset.active = String(button.dataset.period === state.clock_period);
    });
    document.querySelectorAll('[data-minutes]').forEach((button) => {
      button.dataset.active = String(Number.parseInt(button.dataset.minutes, 10) === state.clock_minutes);
    });

    renderClockUi();
    postPreview();
  }

  function renderClockUi() {
    const remaining = currentRemainingSeconds();
    timerReadout.textContent = OverlayCore.formatClock(remaining);
    timerPeriod.textContent = state.clock_period;
    timerBadge.textContent = state.clock_running ? 'LIVE' : 'PAUZA';
    timerBadge.dataset.running = String(state.clock_running);
    clockToggleButton.textContent = state.clock_running ? 'Pauza' : 'Start';

    if (state.clock_running && remaining <= 0) {
      state.clock_running = false;
      state.clock_remaining_seconds = 0;
      state.clock_anchor_epoch = 0;
      queuePatch({ clock_running: false, clock_remaining_seconds: 0, clock_anchor_epoch: 0 });
      void flushQueue();
      timerBadge.textContent = 'KONIEC';
      timerBadge.dataset.running = 'false';
      clockToggleButton.textContent = 'Start';
    }
  }

  function postPreview() {
    if (!preview.contentWindow) return;
    preview.contentWindow.postMessage({
      type: 'overlay-preview',
      state: { ...state },
      logos: { home: logoUrls.home || '', away: logoUrls.away || '', league: logoUrls.league || '' }
    }, window.location.origin);
  }

  function queuePatch(patch) {
    Object.assign(queuedPatch, OverlayCore.sanitizePatch(patch));
  }

  function sendPatch(patch, { silent = false } = {}) {
    const sanitized = OverlayCore.sanitizePatch(patch);
    Object.assign(state, sanitized);
    applyStateToInputs();

    if (authenticated && connection?.open) {
      connection.send({ type: 'patch', patch: sanitized });
      if (!silent) setStatus('Połączono • zmiana wysłana', 'ok');
    } else {
      queuePatch(sanitized);
      if (!silent) setStatus('OBS offline • zmiana czeka na połączenie', 'warning');
    }
  }

  function debouncePatch(key, value, delay = 260) {
    clearTimeout(pendingTimers.get(key));
    pendingTimers.set(key, setTimeout(() => {
      pendingTimers.delete(key);
      sendPatch({ [key]: value }, { silent: true });
    }, delay));
  }

  async function sendLogo(side, blob, name = `${side}-logo`) {
    if (!authenticated || !connection?.open) {
      queuedLogos[side] = { blob, name, remove: false };
      setStatus(`OBS offline • ${side === 'league' ? 'logo ligi' : `logo ${side === 'home' ? 'drużyny 1' : 'drużyny 2'}`} czeka`, 'warning');
      return;
    }

    const label = side === 'league' ? 'logo ligi' : `logo ${side === 'home' ? 'drużyny 1' : 'drużyny 2'}`;
    await OverlayCore.sendBlob(connection, side, blob, {
      purpose: 'logo',
      name,
      onProgress: (progress) => setStatus(`Wysyłam ${label}: ${Math.round(progress * 100)}% • ${OverlayCore.formatBytes(blob.size)}`, 'neutral')
    });
    setStatus('Połączono • logo wysłane', 'ok');
  }

  async function flushQueue() {
    if (!authenticated || !connection?.open) return;
    if (Object.keys(queuedPatch).length) {
      const patch = { ...queuedPatch };
      for (const key of Object.keys(queuedPatch)) delete queuedPatch[key];
      connection.send({ type: 'patch', patch });
    }
    for (const side of ['home', 'away', 'league']) {
      const queued = queuedLogos[side];
      if (queued) {
        queuedLogos[side] = null;
        if (queued.remove) connection.send({ type: 'logo-remove', side });
        else await sendLogo(side, queued.blob, queued.name);
      }
    }
  }

  function updateClockState(next) {
    sendPatch(next, { silent: true });
  }

  function setClockRunning(running) {
    const remaining = currentRemainingSeconds();
    updateClockState({
      clock_running: running,
      clock_remaining_seconds: remaining,
      clock_anchor_epoch: running ? Date.now() : 0
    });
    setStatus(running ? 'Zegar uruchomiony' : 'Zegar zatrzymany', 'ok');
  }

  function adjustClock(deltaSeconds) {
    const maxSeconds = 59 * 60 + 59;
    const next = Math.max(0, Math.min(maxSeconds, currentRemainingSeconds() + deltaSeconds));
    updateClockState({
      clock_remaining_seconds: next,
      clock_anchor_epoch: state.clock_running ? Date.now() : 0
    });
    setStatus('Zmieniono czas zegara', 'ok');
  }

  function resetClock() {
    updateClockState({
      clock_running: false,
      clock_remaining_seconds: state.clock_minutes * 60,
      clock_anchor_epoch: 0
    });
    setStatus('Zegar zresetowany do pełnego czasu', 'ok');
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

  function bindLeagueControls() {
    const leagueName = document.querySelector('#league-name');
    const showLogo = document.querySelector('#show-league-logo');
    const showName = document.querySelector('#show-league-name');
    const leagueLogo = document.querySelector('#league-logo');
    const removeLogo = document.querySelector('#league-logo-remove');
    const widthRange = document.querySelector('#overlay-width-range');
    const widthNumber = document.querySelector('#overlay-width-number');

    leagueName.addEventListener('input', () => {
      const value = leagueName.value.slice(0, 40);
      state.league_name = value;
      postPreview();
      debouncePatch('league_name', value);
    });

    showLogo.addEventListener('change', () => sendPatch({ show_league_logo: showLogo.checked }, { silent: true }));
    showName.addEventListener('change', () => sendPatch({ show_league_name: showName.checked }, { silent: true }));

    leagueLogo.addEventListener('change', async () => {
      const [file] = leagueLogo.files;
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        setStatus('Wybierz plik graficzny.', 'error');
        leagueLogo.value = '';
        return;
      }
      try {
        localLogoPreferred.league = true;
        setLogoPreview('league', file);
        await sendLogo('league', file, file.name || 'league-logo');
      } catch (error) {
        console.error(error);
        queuedLogos.league = { blob: file, name: file.name || 'league-logo', remove: false };
        setStatus(`Logo ligi nie zostało wysłane: ${error.message || error}`, 'error');
      } finally {
        leagueLogo.value = '';
      }
    });

    removeLogo.addEventListener('click', () => {
      localLogoPreferred.league = true;
      setLogoPreview('league', null);
      if (authenticated && connection?.open) connection.send({ type: 'logo-remove', side: 'league' });
      else {
        queuedLogos.league = { remove: true };
        setStatus('OBS offline • usunięcie logo ligi czeka na połączenie', 'warning');
      }
    });

    function applyWidth(nextValue) {
      const value = OverlayCore.clampInt(nextValue, 760, 1500, state.overlay_width);
      state.overlay_width = value;
      widthRange.value = value;
      widthNumber.value = value;
      overlayWidthLabel.textContent = `${value} px`;
      postPreview();
      debouncePatch('overlay_width', value, 80);
    }

    widthRange.addEventListener('input', () => applyWidth(widthRange.value));
    widthNumber.addEventListener('input', () => applyWidth(widthNumber.value));
  }

  function bindClockControls() {
    document.querySelectorAll('[data-period]').forEach((button) => {
      button.addEventListener('click', () => sendPatch({ clock_period: button.dataset.period }));
    });

    document.querySelectorAll('[data-minutes]').forEach((button) => {
      button.addEventListener('click', () => {
        const minutes = Number.parseInt(button.dataset.minutes, 10) === 20 ? 20 : 15;
        const patch = { clock_minutes: minutes };
        if (!state.clock_running && state.clock_remaining_seconds > minutes * 60) {
          patch.clock_remaining_seconds = minutes * 60;
        }
        sendPatch(patch);
      });
    });

    clockToggleButton.addEventListener('click', () => setClockRunning(!state.clock_running));
    document.querySelector('#clock-reset').addEventListener('click', resetClock);
    document.querySelectorAll('[data-seconds]').forEach((button) => {
      button.addEventListener('click', () => adjustClock(Number.parseInt(button.dataset.seconds, 10) || 0));
    });
  }

  const assetReceiver = OverlayCore.createAssetReceiver({
    onComplete: async ({ side, blob }) => {
      if (!localLogoPreferred[side]) setLogoPreview(side, blob);
    },
    onProgress: ({ side, progress, size }) => {
      if (progress > 0) {
        const label = side === 'league' ? 'logo ligi' : `logo ${side === 'home' ? 'drużyny 1' : 'drużyny 2'}`;
        setStatus(`Odbieram ${label}: ${Math.round(progress * 100)}% • ${OverlayCore.formatBytes(size)}`, 'neutral');
      }
    },
    onError: (error) => {
      console.error(error);
      setStatus(`Błąd transferu logo: ${error.message || error}`, 'error');
    }
  });

  async function handleConnectionData(message) {
    if (await assetReceiver.handle(message)) return;

    if (message?.type === 'challenge') {
      const signature = await OverlayCore.signChallenge(privateKey, room, message.nonce || '');
      connection.send({
        type: 'auth',
        nonce: message.nonce,
        signature,
        knownLogos: {
          home: !!logoUrls.home,
          away: !!logoUrls.away,
          league: !!logoUrls.league
        }
      });
      return;
    }

    if (message?.type === 'auth-ok') {
      authenticated = true;
      if (message.state) Object.assign(state, OverlayCore.normalizeState(message.state));
      applyStateToInputs();
      setStatus('Połączono z OBS • autoryzacja OK', 'ok');
      await flushQueue();
      for (const side of ['home', 'away', 'league']) {
        if (localLogoPreferred[side] && logoBlobs[side] instanceof Blob && !message.logoPresence?.[side]) {
          await sendLogo(side, logoBlobs[side], `${side}-logo`);
        }
      }
      return;
    }

    if (message?.type === 'auth-failed') {
      authenticated = false;
      setStatus('Autoryzacja nie powiodła się. Sprawdź prywatny link sterowania.', 'error');
      return;
    }

    if (message?.type === 'state' && message.state) {
      Object.assign(state, OverlayCore.normalizeState(message.state));
      applyStateToInputs();
      return;
    }

    if (message?.type === 'logo-removed' && ['home', 'away', 'league'].includes(message.side)) {
      setStatus('Logo usunięte', 'ok');
      return;
    }

    if (message?.type === 'asset-ack') {
      setStatus('Logo zapisane w overlayu', 'ok');
    }
  }

  function scheduleReconnect(delay = 1500) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectToOverlay();
    }, delay);
  }

  function bindConnection(conn) {
    connection = conn;
    authenticated = false;
    connecting = false;

    conn.on('open', () => setStatus('Połączono z OBS • czekam na autoryzację…', 'neutral'));
    conn.on('data', (message) => void handleConnectionData(message));
    conn.on('close', () => {
      assetReceiver.clear();
      if (connection === conn) connection = null;
      authenticated = false;
      setStatus('Połączenie z OBS zamknięte • ponawiam…', 'warning');
      scheduleReconnect();
    });
    conn.on('error', (error) => {
      console.warn('Błąd połączenia:', error);
      authenticated = false;
      setStatus(`Połączenie: ${error?.message || error}`, 'warning');
      scheduleReconnect(2200);
    });
  }

  async function connectToOverlay() {
    if (connecting || !peer?.open) return;
    connecting = true;
    setStatus('Szukam aktywnego OBS…', 'neutral');

    try {
      const conn = peer.connect(OverlayCore.peerIdForRoom(room), { reliable: true });
      bindConnection(conn);
    } catch (error) {
      console.error(error);
      connecting = false;
      setStatus(`Nie udało się połączyć: ${error.message || error}`, 'warning');
      scheduleReconnect(2200);
    }
  }

  async function init() {
    if (!room || !privateToken) {
      fatal('Nieprawidłowy link sterowania: brakuje pokoju lub klucza prywatnego.');
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
      const controllerUrl = OverlayCore.buildUrl('control.html', { room, sk: privateToken });

      preview.src = OverlayCore.buildUrl('overlay.html', { preview: '1' });
      overlayUrlField.value = overlayUrl;
      controllerUrlField.value = controllerUrl;

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

      bindTeam('home');
      bindTeam('away');
      bindLeagueControls();
      bindClockControls();
      document.querySelector('#reset-score').addEventListener('click', () => sendPatch({ home_score: 0, away_score: 0 }));

      applyStateToInputs();
      uiInterval = setInterval(renderClockUi, 250);

      peer = new Peer();
      peer.on('open', () => {
        connecting = false;
        setStatus('Panel online • szukam OBS…', 'neutral');
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
    clearInterval(uiInterval);
    assetReceiver.clear();
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    for (const side of ['home', 'away', 'league']) {
      if (logoUrls[side]?.startsWith('blob:')) URL.revokeObjectURL(logoUrls[side]);
    }
    try { peer?.destroy(); } catch (_) {}
  }, { once: true });

  void init();
})();
