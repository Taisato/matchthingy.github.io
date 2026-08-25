import { joinRoom, selfId, getRelaySockets } from 'https://cdn.jsdelivr.net/npm/trystero@0.25.3/+esm';

(() => {
  'use strict';

  const APP_ID = 'grupa-format-match-overlay-v31';
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
  const acceptedPeers = new Set();
  const peerHandshakeData = new Map();

  let publicKey = null;
  let room = null;
  let actions = null;
  let renderInterval = null;

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

  async function overlayHandshake(peerId, send, receive) {
    await send({
      type: 'match-overlay-handshake',
      role: 'overlay',
      protocol: OverlayCore.PROTOCOL
    });

    const { data: hello } = await receive();
    if (hello?.type !== 'match-overlay-handshake' || hello?.role !== 'control' || hello?.protocol !== OverlayCore.PROTOCOL) {
      throw new Error('Odrzucono peer, który nie jest panelem sterowania.');
    }

    const nonce = OverlayCore.randomHex(32);
    await send({ type: 'auth-challenge', nonce });

    const { data: proof } = await receive();
    if (proof?.type !== 'auth-proof' || proof?.nonce !== nonce || !proof?.signature) {
      throw new Error('Panel nie przesłał poprawnego dowodu autoryzacji.');
    }

    const ok = await OverlayCore.verifyChallenge(publicKey, roomId, nonce, proof.signature, selfId);
    if (!ok) throw new Error('Nieprawidłowy podpis prywatnego panelu.');

    peerHandshakeData.set(peerId, { knownLogos: proof.knownLogos || {} });

    await send({
      type: 'auth-ok',
      nonce,
      state: { ...state },
      logoPresence: { home: !!logoUrls.home, away: !!logoUrls.away, league: !!logoUrls.league }
    });
  }

  function setupActions() {
    actions = {
      patch: room.makeAction('patch'),
      state: room.makeAction('state'),
      logo: room.makeAction('logo'),
      logoRemove: room.makeAction('logo-rm'),
      logoAck: room.makeAction('logo-ack'),
      requestState: room.makeAction('req-state')
    };

    actions.patch.onMessage = async (incoming, { peerId }) => {
      if (!acceptedPeers.has(peerId)) return;
      const patch = OverlayCore.sanitizePatch(incoming);
      Object.assign(state, patch);
      render();
      await persistState();
      await actions.state.send({ ...state }, { target: peerId });
    };

    actions.logo.onMessage = async (data, { peerId, metadata }) => {
      if (!acceptedPeers.has(peerId)) return;
      const side = metadata?.side;
      if (!['home', 'away', 'league'].includes(side)) return;
      const blob = data instanceof Blob ? data : new Blob([data], { type: metadata?.mime || 'application/octet-stream' });
      setLogo(side, blob);
      render();
      await persistLogo(side, blob);
      await actions.logoAck.send({ ok: true, side, size: blob.size }, { target: peerId });
    };

    actions.logoRemove.onMessage = async (data, { peerId }) => {
      if (!acceptedPeers.has(peerId)) return;
      const side = data?.side;
      if (!['home', 'away', 'league'].includes(side)) return;
      setLogo(side, null);
      render();
      await persistLogo(side, null);
      await actions.logoAck.send({ ok: true, side, removed: true }, { target: peerId });
    };

    actions.requestState.onMessage = async (data, { peerId }) => {
      if (!acceptedPeers.has(peerId)) return;
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
      handshakeTimeoutMs: 12000,
      onPeerHandshake: overlayHandshake,
      onJoinError: ({ error, peerId }) => {
        const message = String(error?.message || error || 'nieznany błąd');
        console.warn('Trystero OBS join error:', peerId, message);
        // Nie zasłaniaj transmisji błędem po pojedynczej odrzuconej próbie.
        // Pokazujemy błąd tylko gdy nie ma żadnego poprawnie połączonego panelu.
        if (!acceptedPeers.size && !/handshake|auth|rejected|odrzu|podpis/i.test(message)) {
          showError(`P2P: ${message}`);
        }
      }
    });

    setupActions();

    room.onPeerJoin = (peerId) => {
      acceptedPeers.add(peerId);
      clearError();
      const handshake = peerHandshakeData.get(peerId) || {};
      peerHandshakeData.delete(peerId);
      void sendStoredLogos(peerId, handshake.knownLogos || {});
    };

    room.onPeerLeave = (peerId) => {
      acceptedPeers.delete(peerId);
      peerHandshakeData.delete(peerId);
    };
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
    for (const side of ['home', 'away', 'league']) {
      if (logoUrls[side]?.startsWith('blob:')) URL.revokeObjectURL(logoUrls[side]);
    }
    try { room?.leave?.(); } catch (_) {}
  }, { once: true });

  void init();
})();
