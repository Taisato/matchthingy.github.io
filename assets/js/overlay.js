import { joinRoom, selfId, getRelaySockets } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.3/+esm';

(() => {
  'use strict';

  const APP_ID = 'grupa-format-match-overlay-v3';
  const params = OverlayCore.parseFragment();
  const previewMode = params.preview === '1';
  const roomId = params.room || '';
  const publicToken = params.pk || '';

  const shell = document.querySelector('#overlay-shell');
  const leagueStrip = document.querySelector('#league-strip');
  const debug = document.querySelector('#overlay-error');

  const state = OverlayCore.normalizeState();
  const logoBlobs = { home: null, away: null, league: null };
  const logoUrls = { home: '', away: '', league: '' };
  const authenticatedPeers = new Set();
  const pendingChallenges = new Map();

  let publicKey = null;
  let room = null;
  let actions = null;
  let renderInterval = null;
  let announceInterval = null;

  function relayCount() {
    try {
      return Object.values(getRelaySockets?.() || {}).filter((socket) => socket?.readyState === WebSocket.OPEN).length;
    } catch (_) {
      return 0;
    }
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  }

  function setLogo(side, source) {
    const image = side === 'league' ? document.querySelector('#league-logo') : document.querySelector(`#${side}-team-logo`);
    const fallback = side === 'league' ? null : document.querySelector(`#${side}-fallback`);
    if (logoUrls[side] && logoUrls[side].startsWith('blob:')) URL.revokeObjectURL(logoUrls[side]);
    logoUrls[side] = '';

    if (source instanceof Blob) {
      logoBlobs[side] = source;
      logoUrls[side] = URL.createObjectURL(source);
    } else if (typeof source === 'string' && source) {
      logoBlobs[side] = null;
      logoUrls[side] = source;
    } else {
      logoBlobs[side] = null;
    }

    if (logoUrls[side]) {
      image.src = logoUrls[side];
      image.hidden = false;
      if (fallback) fallback.hidden = true;
    } else {
      image.removeAttribute('src');
      image.hidden = true;
      if (fallback) fallback.hidden = false;
    }
  }

  function renderTeam(side) {
    const name = state[`${side}_name`];
    document.querySelector(`#${side}-team-name`).textContent = name;
    document.querySelector(`#${side}-team-score`).textContent = state[`${side}_score`];
    document.querySelector(`#${side}-fallback`).textContent = initials(name);
  }

  function renderLeague() {
    const showLogo = state.show_league_logo && !!logoUrls.league;
    const showName = state.show_league_name && !!state.league_name.trim();
    const logoBox = document.querySelector('#league-logo-box');
    const leagueName = document.querySelector('#league-name');
    logoBox.hidden = !showLogo;
    leagueName.hidden = !showName;
    leagueName.textContent = state.league_name || 'VRFS';
    leagueStrip.hidden = !showLogo && !showName;
  }

  function renderClock() {
    document.querySelector('#match-period').textContent = state.clock_period;
    document.querySelector('#match-clock').textContent = OverlayCore.formatClock(OverlayCore.getClockRemaining(state));
  }

  function render() {
    renderTeam('home');
    renderTeam('away');
    renderLeague();
    renderClock();
    shell.style.setProperty('--overlay-width', `${state.overlay_width}px`);
    shell.classList.add('is-ready');
  }

  function showError(message) {
    console.warn(message);
    debug.textContent = message;
    debug.hidden = false;
  }

  function clearError() {
    debug.hidden = true;
    debug.textContent = '';
  }

  async function persistState() {
    try { await OverlayCore.storageSet(`${roomId}:state`, { ...state }); }
    catch (error) { console.warn('Nie udało się zapisać stanu:', error); }
  }

  async function persistLogo(side, blob) {
    try {
      if (blob) await OverlayCore.storageSet(`${roomId}:logo:${side}`, blob);
      else await OverlayCore.storageDelete(`${roomId}:logo:${side}`);
    } catch (error) { console.warn('Nie udało się zapisać logo:', error); }
  }

  async function loadLocalState() {
    try {
      const savedState = await OverlayCore.storageGet(`${roomId}:state`);
      if (savedState) Object.assign(state, OverlayCore.normalizeState(savedState));
      for (const side of ['home', 'away', 'league']) {
        const blob = await OverlayCore.storageGet(`${roomId}:logo:${side}`);
        if (blob instanceof Blob) setLogo(side, blob);
      }
    } catch (error) { console.warn('Nie udało się odczytać lokalnego stanu:', error); }
    render();
  }

  async function sendStoredLogos(peerId, knownLogos = {}) {
    for (const side of ['home', 'away', 'league']) {
      if (knownLogos?.[side]) continue;
      const blob = logoBlobs[side];
      if (!(blob instanceof Blob)) continue;
      try {
        await actions.logo.send(blob, {
          target: peerId,
          metadata: { side, name: `${side}-logo`, mime: blob.type || 'application/octet-stream', size: blob.size }
        });
      } catch (error) { console.warn('Nie udało się zsynchronizować logo:', error); }
    }
  }

  function setupPreviewMode() {
    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || message.type !== 'overlay-preview') return;
      Object.assign(state, OverlayCore.normalizeState(message.state));
      for (const side of ['home', 'away', 'league']) {
        if (Object.prototype.hasOwnProperty.call(message.logos || {}, side)) setLogo(side, message.logos[side] || '');
      }
      render();
    });
    render();
    window.parent?.postMessage({ type: 'overlay-preview-ready' }, window.location.origin);
  }

  async function sendChallenge(peerId) {
    const nonce = OverlayCore.randomHex(32);
    pendingChallenges.set(peerId, nonce);
    try {
      await actions.challenge.send({ nonce }, { target: peerId });
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
      if (data?.role !== 'control') return;
      void actions.hello.send({ role: 'overlay', protocol: OverlayCore.PROTOCOL }, { target: peerId });
      if (!authenticatedPeers.has(peerId)) void sendChallenge(peerId);
    };

    actions.auth.onMessage = async (data, { peerId }) => {
      const expectedNonce = pendingChallenges.get(peerId);
      if (!expectedNonce || data?.nonce !== expectedNonce || !data?.signature) return;
      pendingChallenges.delete(peerId);
      try {
        const ok = await OverlayCore.verifyChallenge(publicKey, roomId, expectedNonce, data.signature, selfId);
        if (!ok) return;
        authenticatedPeers.add(peerId);
        clearError();
        await actions.authOk.send({
          state: { ...state },
          logoPresence: { home: !!logoUrls.home, away: !!logoUrls.away, league: !!logoUrls.league }
        }, { target: peerId });
        await sendStoredLogos(peerId, data?.knownLogos || {});
      } catch (error) { console.warn('Auth verify error:', error); }
    };

    actions.patch.onMessage = async (incoming, { peerId }) => {
      if (!authenticatedPeers.has(peerId)) return;
      const patch = OverlayCore.sanitizePatch(incoming);
      Object.assign(state, patch);
      render();
      await persistState();
      await actions.state.send({ ...state }, { target: peerId });
    };

    actions.logo.onMessage = async (data, { peerId, metadata }) => {
      if (!authenticatedPeers.has(peerId)) return;
      const side = metadata?.side;
      if (!['home', 'away', 'league'].includes(side)) return;
      const blob = data instanceof Blob ? data : new Blob([data], { type: metadata?.mime || 'application/octet-stream' });
      setLogo(side, blob);
      render();
      await persistLogo(side, blob);
      await actions.logoAck.send({ ok: true, side, size: blob.size }, { target: peerId });
    };

    actions.logoRemove.onMessage = async (data, { peerId }) => {
      if (!authenticatedPeers.has(peerId)) return;
      const side = data?.side;
      if (!['home', 'away', 'league'].includes(side)) return;
      setLogo(side, null);
      render();
      await persistLogo(side, null);
      await actions.logoAck.send({ ok: true, side, removed: true }, { target: peerId });
    };

    actions.requestState.onMessage = async (data, { peerId }) => {
      if (!authenticatedPeers.has(peerId)) return;
      await actions.state.send({ ...state }, { target: peerId });
      await sendStoredLogos(peerId, data?.knownLogos || {});
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
        console.warn('Trystero OBS join error:', error);
        showError(`P2P: ${error?.message || error}`);
      }
    });

    setupActions();

    room.onPeerJoin = (peerId) => {
      void actions.hello.send({ role: 'overlay', protocol: OverlayCore.PROTOCOL }, { target: peerId });
    };
    room.onPeerLeave = (peerId) => {
      authenticatedPeers.delete(peerId);
      pendingChallenges.delete(peerId);
    };

    announceInterval = setInterval(() => {
      void actions.hello.send({ role: 'overlay', protocol: OverlayCore.PROTOCOL }).catch(() => {});
      if (relayCount() > 0) clearError();
    }, 2500);

    void actions.hello.send({ role: 'overlay', protocol: OverlayCore.PROTOCOL }).catch(() => {});
  }

  async function init() {
    renderInterval = setInterval(renderClock, 250);

    if (previewMode) {
      setupPreviewMode();
      return;
    }

    if (!roomId || !publicToken) {
      showError('Nieprawidłowy link overlayu: brakuje pokoju lub klucza publicznego.');
      return;
    }

    await loadLocalState();

    try {
      publicKey = await OverlayCore.importPublicKey(publicToken);
      clearError();
      await initNetwork();
    } catch (error) {
      showError(`Nie udało się uruchomić overlayu: ${error.message || error}`);
    }
  }

  window.addEventListener('beforeunload', () => {
    clearInterval(renderInterval);
    clearInterval(announceInterval);
    for (const side of ['home', 'away', 'league']) {
      if (logoUrls[side]?.startsWith('blob:')) URL.revokeObjectURL(logoUrls[side]);
    }
    try { room?.leave?.(); } catch (_) {}
  }, { once: true });

  void init();
})();
