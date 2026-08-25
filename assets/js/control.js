import { joinRoom, getRelaySockets } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.3/+esm';

(() => {
  'use strict';

  const APP_ID = 'grupa-format-match-overlay-v3';
  const params = OverlayCore.parseFragment();
  const roomId = params.room || '';
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
  let publicToken = '';
  let room = null;
  let overlayPeerId = '';
  let authenticated = false;
  let uiInterval = null;
  let discoveryInterval = null;
  let relayInterval = null;
  let actions = null;

  function setStatus(message, kind = 'neutral') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function fatal(message) {
    errorBox.hidden = false;
    errorBox.textContent = message;
    app.hidden = true;
  }

  function relayCount() {
    try {
      return Object.values(getRelaySockets?.() || {}).filter((socket) => socket?.readyState === WebSocket.OPEN).length;
    } catch (_) {
      return 0;
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

  function canSend() {
    return authenticated && overlayPeerId && actions;
  }

  function sendPatch(patch, { silent = false } = {}) {
    const sanitized = OverlayCore.sanitizePatch(patch);
    Object.assign(state, sanitized);
    applyStateToInputs();

    if (canSend()) {
      void actions.patch.send(sanitized, { target: overlayPeerId }).catch((error) => {
        console.warn('Patch send failed:', error);
        authenticated = false;
        queuePatch(sanitized);
        setStatus('Połączenie z OBS przerwane • ponawiam automatycznie', 'warning');
      });
      if (!silent) setStatus('Połączono z OBS • zmiana wysłana', 'ok');
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
    if (!canSend()) {
      queuedLogos[side] = { blob, name, remove: false };
      setStatus(`OBS offline • ${side === 'league' ? 'logo ligi' : `logo ${side === 'home' ? 'drużyny 1' : 'drużyny 2'}`} czeka`, 'warning');
      return;
    }

    const label = side === 'league' ? 'logo ligi' : `logo ${side === 'home' ? 'drużyny 1' : 'drużyny 2'}`;
    await actions.logo.send(blob, {
      target: overlayPeerId,
      metadata: { side, name, mime: blob.type || 'application/octet-stream', size: blob.size },
      onProgress: (progress) => setStatus(`Wysyłam ${label}: ${Math.round(progress * 100)}% • ${OverlayCore.formatBytes(blob.size)}`, 'neutral')
    });
    setStatus('Połączono z OBS • logo wysłane', 'ok');
  }

  async function flushQueue() {
    if (!canSend()) return;
    if (Object.keys(queuedPatch).length) {
      const patch = { ...queuedPatch };
      for (const key of Object.keys(queuedPatch)) delete queuedPatch[key];
      await actions.patch.send(patch, { target: overlayPeerId });
    }
    for (const side of ['home', 'away', 'league']) {
      const queued = queuedLogos[side];
      if (!queued) continue;
      queuedLogos[side] = null;
      if (queued.remove) await actions.logoRemove.send({ side }, { target: overlayPeerId });
      else await sendLogo(side, queued.blob, queued.name);
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

    score.addEventListener('change', () => sendPatch({ [`${side}_score`]: OverlayCore.clampScore(score.value) }));

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
      if (canSend()) void actions.logoRemove.send({ side }, { target: overlayPeerId });
      else queuedLogos[side] = { remove: true };
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
      if (canSend()) void actions.logoRemove.send({ side: 'league' }, { target: overlayPeerId });
      else queuedLogos.league = { remove: true };
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
        if (!state.clock_running && state.clock_remaining_seconds > minutes * 60) patch.clock_remaining_seconds = minutes * 60;
        sendPatch(patch);
      });
    });

    clockToggleButton.addEventListener('click', () => setClockRunning(!state.clock_running));
    document.querySelector('#clock-reset').addEventListener('click', resetClock);
    document.querySelectorAll('[data-seconds]').forEach((button) => {
      button.addEventListener('click', () => adjustClock(Number.parseInt(button.dataset.seconds, 10) || 0));
    });
  }

  async function announce() {
    if (!actions) return;
    try {
      await actions.hello.send({ role: 'control', protocol: OverlayCore.PROTOCOL });
    } catch (_) {}
  }

  function setupActions() {
    actions = {
      hello: room.makeAction('hello'),
      challenge: room.makeAction('challenge'),
      auth: room.makeAction('auth'),
      authOk: room.makeAction('auth-ok'),
      patch: room.makeAction('patch'),
      state: room.makeAction('state'),
      logo: room.makeAction('logo'),
      logoRemove: room.makeAction('logo-rm'),
      logoAck: room.makeAction('logo-ack'),
      requestState: room.makeAction('req-state')
    };

    actions.hello.onMessage = (data, { peerId }) => {
      if (data?.role !== 'overlay') return;
      if (overlayPeerId && overlayPeerId !== peerId && authenticated) return;
      overlayPeerId = peerId;
      authenticated = false;
      setStatus('OBS znaleziony • autoryzuję prywatny panel…', 'neutral');
    };

    actions.challenge.onMessage = async (data, { peerId }) => {
      if (!data?.nonce) return;
      if (overlayPeerId && overlayPeerId !== peerId && authenticated) return;
      overlayPeerId = peerId;
      try {
        const signature = await OverlayCore.signChallenge(privateKey, roomId, data.nonce, peerId);
        await actions.auth.send({
          nonce: data.nonce,
          signature,
          knownLogos: { home: !!logoUrls.home, away: !!logoUrls.away, league: !!logoUrls.league }
        }, { target: peerId });
        setStatus('OBS znaleziony • sprawdzam podpis…', 'neutral');
      } catch (error) {
        setStatus(`Błąd autoryzacji: ${error.message || error}`, 'error');
      }
    };

    actions.authOk.onMessage = async (data, { peerId }) => {
      if (peerId !== overlayPeerId) return;
      authenticated = true;
      if (data?.state) Object.assign(state, OverlayCore.normalizeState(data.state));
      applyStateToInputs();
      setStatus(`Połączono z OBS • P2P aktywne${relayCount() ? ` • relaye: ${relayCount()}` : ''}`, 'ok');
      await flushQueue();
      for (const side of ['home', 'away', 'league']) {
        if (localLogoPreferred[side] && logoBlobs[side] instanceof Blob && !data?.logoPresence?.[side]) {
          await sendLogo(side, logoBlobs[side], `${side}-logo`);
        }
      }
    };

    actions.state.onMessage = (incoming, { peerId }) => {
      if (peerId !== overlayPeerId || !authenticated) return;
      Object.assign(state, OverlayCore.normalizeState(incoming));
      applyStateToInputs();
    };

    actions.logo.onMessage = (data, { peerId, metadata }) => {
      if (peerId !== overlayPeerId || !authenticated) return;
      const side = metadata?.side;
      if (!['home', 'away', 'league'].includes(side) || localLogoPreferred[side]) return;
      const blob = data instanceof Blob ? data : new Blob([data], { type: metadata?.mime || 'application/octet-stream' });
      setLogoPreview(side, blob);
    };

    actions.logo.onReceiveProgress = (progress, { peerId, metadata }) => {
      if (peerId !== overlayPeerId) return;
      const side = metadata?.side;
      const label = side === 'league' ? 'logo ligi' : `logo ${side === 'home' ? 'drużyny 1' : 'drużyny 2'}`;
      setStatus(`Odbieram ${label}: ${Math.round(progress * 100)}%`, 'neutral');
    };

    actions.logoAck.onMessage = (data, { peerId }) => {
      if (peerId === overlayPeerId && data?.ok) setStatus('Logo zapisane w OBS', 'ok');
    };
  }

  async function initNetwork() {
    room = joinRoom({
      appId: APP_ID,
      password: publicToken,
      relayConfig: { redundancy: 5, warnOnRelayFailure: false },
      trickleIce: true
    }, roomId, {
      onJoinError: ({ error }) => {
        console.warn('Trystero join error:', error);
        if (!authenticated) setStatus(`P2P nie zestawiło połączenia: ${error?.message || error}`, 'warning');
      }
    });

    setupActions();

    room.onPeerJoin = (peerId) => {
      void actions.hello.send({ role: 'control', protocol: OverlayCore.PROTOCOL }, { target: peerId });
    };

    room.onPeerLeave = (peerId) => {
      if (peerId !== overlayPeerId) return;
      overlayPeerId = '';
      authenticated = false;
      setStatus('OBS offline • czekam na ponowne połączenie', 'warning');
    };

    discoveryInterval = setInterval(() => {
      if (!authenticated) void announce();
    }, 2500);

    relayInterval = setInterval(() => {
      if (authenticated) return;
      const count = relayCount();
      if (overlayPeerId) setStatus('OBS znaleziony • trwa autoryzacja…', 'neutral');
      else if (count) setStatus(`Sieć P2P online • relaye: ${count} • oczekiwanie na OBS`, 'neutral');
      else setStatus('Łączenie z siecią sygnalizacyjną…', 'neutral');
    }, 1500);

    void announce();
  }

  async function init() {
    if (!roomId || !privateToken) {
      fatal('Nieprawidłowy link sterowania: brakuje pokoju lub klucza prywatnego.');
      return;
    }

    try {
      privateKey = await OverlayCore.importPrivateKey(privateToken);
      publicToken = OverlayCore.publicTokenFromPrivateToken(privateToken);
      const overlayUrl = OverlayCore.buildUrl('overlay.html', { room: roomId, pk: publicToken });
      const controllerUrl = OverlayCore.buildUrl('control.html', { room: roomId, sk: privateToken });

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
      setStatus('Łączenie z redundantną siecią P2P…', 'neutral');
      await initNetwork();
    } catch (error) {
      console.error(error);
      fatal(`Nie udało się otworzyć panelu: ${error.message || error}`);
    }
  }

  window.addEventListener('beforeunload', () => {
    clearInterval(uiInterval);
    clearInterval(discoveryInterval);
    clearInterval(relayInterval);
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    for (const side of ['home', 'away', 'league']) {
      if (logoUrls[side]?.startsWith('blob:')) URL.revokeObjectURL(logoUrls[side]);
    }
    try { room?.leave?.(); } catch (_) {}
  }, { once: true });

  void init();
})();
