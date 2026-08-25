(() => {
  'use strict';

  const params = OverlayCore.parseFragment();
  const previewMode = params.preview === '1';
  const room = params.room || '';
  const publicToken = params.pk || '';
  const root = document.querySelector('#scoreboard');
  const debug = document.querySelector('#overlay-error');

  const state = OverlayCore.normalizeState();
  const logoBlobs = { home: null, away: null };
  const logoUrls = { home: '', away: '' };
  let peer = null;
  let activeConnection = null;
  let publicKey = null;

  function initials(name) {
    return String(name || '?')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '?';
  }

  function setLogo(side, source) {
    const image = document.querySelector(`#${side}-team-logo`);
    const fallback = document.querySelector(`#${side}-fallback`);
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
      fallback.hidden = true;
    } else {
      image.removeAttribute('src');
      image.hidden = true;
      fallback.hidden = false;
    }
  }

  function renderTeam(side) {
    const name = state[`${side}_name`];
    const score = state[`${side}_score`];
    document.querySelector(`#${side}-team-name`).textContent = name;
    document.querySelector(`#${side}-team-score`).textContent = score;
    document.querySelector(`#${side}-fallback`).textContent = initials(name);
  }

  function render() {
    renderTeam('home');
    renderTeam('away');
    root.classList.add('is-ready');
  }

  function showError(message) {
    console.error(message);
    debug.textContent = message;
    debug.hidden = false;
  }

  function clearError() {
    debug.hidden = true;
    debug.textContent = '';
  }

  async function persistState() {
    try {
      await OverlayCore.storageSet(`${room}:state`, { ...state });
    } catch (error) {
      console.warn('Nie udało się zapisać stanu lokalnie:', error);
    }
  }

  async function persistLogo(side, blob) {
    try {
      if (blob) await OverlayCore.storageSet(`${room}:logo:${side}`, blob);
      else await OverlayCore.storageDelete(`${room}:logo:${side}`);
    } catch (error) {
      console.warn('Nie udało się zapisać logo lokalnie:', error);
    }
  }

  async function loadLocalState() {
    try {
      const savedState = await OverlayCore.storageGet(`${room}:state`);
      if (savedState) Object.assign(state, OverlayCore.normalizeState(savedState));
      for (const side of ['home', 'away']) {
        const blob = await OverlayCore.storageGet(`${room}:logo:${side}`);
        if (blob instanceof Blob) setLogo(side, blob);
      }
    } catch (error) {
      console.warn('Nie udało się odczytać lokalnego stanu:', error);
    }
    render();
  }

  async function sendStoredLogos(conn, knownLogos = {}) {
    for (const side of ['home', 'away']) {
      if (knownLogos?.[side]) continue;
      const blob = logoBlobs[side];
      if (blob instanceof Blob && conn?.open) {
        try {
          await OverlayCore.sendBlob(conn, side, blob, { purpose: 'sync-logo', name: `${side}-logo` });
        } catch (error) {
          console.warn('Nie udało się zsynchronizować logo z panelem:', error);
          return;
        }
      }
    }
  }

  function setupPreviewMode() {
    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (!message || message.type !== 'overlay-preview') return;
      Object.assign(state, OverlayCore.normalizeState(message.state));
      if (Object.prototype.hasOwnProperty.call(message.logos || {}, 'home')) setLogo('home', message.logos.home || '');
      if (Object.prototype.hasOwnProperty.call(message.logos || {}, 'away')) setLogo('away', message.logos.away || '');
      render();
    });
    render();
    window.parent?.postMessage({ type: 'overlay-preview-ready' }, window.location.origin);
  }

  async function setupConnection(conn) {
    const nonce = OverlayCore.randomHex(32);
    let authenticated = false;

    const receiver = OverlayCore.createAssetReceiver({
      onComplete: async ({ side, blob, transferId }) => {
        if (!authenticated) return;
        setLogo(side, blob);
        await persistLogo(side, blob);
        conn.send({ type: 'asset-ack', side, transferId, size: blob.size });
      },
      onError: (error) => console.error('Błąd odbioru logo:', error)
    });

    conn.on('open', () => {
      conn.send({ type: 'challenge', protocol: OverlayCore.PROTOCOL, room, nonce });
    });

    conn.on('data', async (message) => {
      try {
        if (!authenticated) {
          if (message?.type !== 'auth' || message.nonce !== nonce) return;
          const ok = await OverlayCore.verifyChallenge(publicKey, room, nonce, message.signature || '');
          if (!ok) {
            conn.send({ type: 'auth-failed' });
            conn.close();
            return;
          }

          authenticated = true;
          if (activeConnection && activeConnection !== conn && activeConnection.open) activeConnection.close();
          activeConnection = conn;
          clearError();
          conn.send({
            type: 'auth-ok',
            state: { ...state },
            logoPresence: { home: logoBlobs.home instanceof Blob, away: logoBlobs.away instanceof Blob }
          });
          void sendStoredLogos(conn, message.knownLogos || {});
          return;
        }

        if (await receiver.handle(message)) return;

        if (message?.type === 'patch') {
          const patch = OverlayCore.sanitizePatch(message.patch);
          Object.assign(state, patch);
          render();
          await persistState();
          conn.send({ type: 'state', state: { ...state } });
          return;
        }

        if (message?.type === 'logo-remove' && ['home', 'away'].includes(message.side)) {
          setLogo(message.side, null);
          await persistLogo(message.side, null);
          conn.send({ type: 'logo-removed', side: message.side });
          return;
        }

        if (message?.type === 'request-state') {
          conn.send({ type: 'state', state: { ...state } });
          void sendStoredLogos(conn);
        }
      } catch (error) {
        console.error(error);
      }
    });

    conn.on('close', () => {
      receiver.clear();
      if (activeConnection === conn) activeConnection = null;
    });

    conn.on('error', (error) => console.warn('Błąd połączenia kontrolera:', error));
  }

  async function init() {
    if (previewMode) {
      setupPreviewMode();
      return;
    }

    if (!room || !publicToken) {
      showError('Nieprawidłowy link overlayu: brakuje pokoju lub klucza publicznego.');
      return;
    }
    if (!window.Peer) {
      showError('Nie udało się załadować modułu połączenia P2P.');
      return;
    }

    await loadLocalState();

    try {
      publicKey = await OverlayCore.importPublicKey(publicToken);
      peer = new Peer(OverlayCore.peerIdForRoom(room));

      peer.on('open', () => clearError());
      peer.on('connection', (conn) => void setupConnection(conn));
      peer.on('disconnected', () => {
        if (!activeConnection?.open) showError('Utracono serwer sygnalizacyjny. Ponawiam połączenie…');
        try { peer.reconnect(); } catch (_) {}
      });
      peer.on('error', (error) => {
        if (error?.type === 'unavailable-id') {
          showError('Ten link overlayu jest już otwarty w innym OBS/przeglądarce. Zamknij drugą kopię.');
        } else {
          showError(`P2P: ${error?.message || error}`);
        }
      });
    } catch (error) {
      showError(`Nie udało się uruchomić overlayu: ${error.message || error}`);
    }
  }

  window.addEventListener('beforeunload', () => {
    for (const side of ['home', 'away']) {
      if (logoUrls[side]?.startsWith('blob:')) URL.revokeObjectURL(logoUrls[side]);
    }
    try { peer?.destroy(); } catch (_) {}
  }, { once: true });

  void init();
})();
