(() => {
  'use strict';

  const PROTOCOL = 'match-overlay-p2p-v1';
  const TEXT_ENCODER = new TextEncoder();
  const TEXT_DECODER = new TextDecoder();
  const CHUNK_SIZE = 48 * 1024;
  const PERIOD_OPTIONS = ['1st half', '2nd half', 'Extra time'];

  function parseFragment() {
    const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
  }

  function bytesToBase64Url(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const padded = String(value).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(value).length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function encodeJson(value) {
    return bytesToBase64Url(TEXT_ENCODER.encode(JSON.stringify(value)));
  }

  function decodeJson(value) {
    return JSON.parse(TEXT_DECODER.decode(base64UrlToBytes(value)));
  }

  function randomHex(byteLength = 18) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function peerIdForRoom(room) {
    return `matchoverlay-${String(room).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  }

  async function generateSigningKeys() {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return {
      privateToken: encodeJson(privateJwk),
      publicToken: encodeJson(publicJwk)
    };
  }

  async function importPrivateKey(privateToken) {
    const jwk = decodeJson(privateToken);
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
  }

  async function importPublicKey(publicToken) {
    const jwk = decodeJson(publicToken);
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  }

  function publicTokenFromPrivateToken(privateToken) {
    const privateJwk = decodeJson(privateToken);
    const publicJwk = {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
      y: privateJwk.y,
      ext: true,
      key_ops: ['verify']
    };
    return encodeJson(publicJwk);
  }

  function authMessage(room, nonce) {
    return TEXT_ENCODER.encode(`${PROTOCOL}|auth|${room}|${nonce}`);
  }

  async function signChallenge(privateKey, room, nonce) {
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      authMessage(room, nonce)
    );
    return bytesToBase64Url(new Uint8Array(signature));
  }

  async function verifyChallenge(publicKey, room, nonce, signature) {
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      base64UrlToBytes(signature),
      authMessage(room, nonce)
    );
  }

  function buildUrl(file, params) {
    const url = new URL(file, window.location.href);
    url.search = '';
    url.hash = new URLSearchParams(params).toString();
    return url.toString();
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }

  function clampInt(value, min, max, fallback = min) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function clampScore(value) {
    return clampInt(value, 0, 999, 0);
  }

  function normalizePeriod(value) {
    const normalized = String(value || '').trim();
    return PERIOD_OPTIONS.includes(normalized) ? normalized : '1st half';
  }

  function normalizeState(source = {}) {
    const clockMinutes = clampInt(source.clock_minutes, 15, 20, 15) === 20 ? 20 : 15;
    const fallbackClock = clockMinutes * 60;
    return {
      home_name: String(source.home_name ?? 'GOSPODARZE').slice(0, 40),
      away_name: String(source.away_name ?? 'GOŚCIE').slice(0, 40),
      home_score: clampScore(source.home_score),
      away_score: clampScore(source.away_score),
      league_name: String(source.league_name ?? 'VRFS').slice(0, 40),
      show_league_name: Boolean(source.show_league_name ?? true),
      show_league_logo: Boolean(source.show_league_logo ?? true),
      overlay_width: clampInt(source.overlay_width, 760, 1500, 1120),
      clock_period: normalizePeriod(source.clock_period),
      clock_minutes: clockMinutes,
      clock_running: Boolean(source.clock_running ?? false),
      clock_remaining_seconds: clampInt(source.clock_remaining_seconds, 0, 3599, fallbackClock),
      clock_anchor_epoch: clampInt(source.clock_anchor_epoch, 0, 9999999999999, 0)
    };
  }

  function sanitizePatch(source = {}) {
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(source, 'home_name')) patch.home_name = String(source.home_name ?? '').slice(0, 40);
    if (Object.prototype.hasOwnProperty.call(source, 'away_name')) patch.away_name = String(source.away_name ?? '').slice(0, 40);
    if (Object.prototype.hasOwnProperty.call(source, 'home_score')) patch.home_score = clampScore(source.home_score);
    if (Object.prototype.hasOwnProperty.call(source, 'away_score')) patch.away_score = clampScore(source.away_score);
    if (Object.prototype.hasOwnProperty.call(source, 'league_name')) patch.league_name = String(source.league_name ?? '').slice(0, 40);
    if (Object.prototype.hasOwnProperty.call(source, 'show_league_name')) patch.show_league_name = Boolean(source.show_league_name);
    if (Object.prototype.hasOwnProperty.call(source, 'show_league_logo')) patch.show_league_logo = Boolean(source.show_league_logo);
    if (Object.prototype.hasOwnProperty.call(source, 'overlay_width')) patch.overlay_width = clampInt(source.overlay_width, 760, 1500, 1120);
    if (Object.prototype.hasOwnProperty.call(source, 'clock_period')) patch.clock_period = normalizePeriod(source.clock_period);
    if (Object.prototype.hasOwnProperty.call(source, 'clock_minutes')) patch.clock_minutes = clampInt(source.clock_minutes, 15, 20, 15) === 20 ? 20 : 15;
    if (Object.prototype.hasOwnProperty.call(source, 'clock_running')) patch.clock_running = Boolean(source.clock_running);
    if (Object.prototype.hasOwnProperty.call(source, 'clock_remaining_seconds')) patch.clock_remaining_seconds = clampInt(source.clock_remaining_seconds, 0, 3599, 0);
    if (Object.prototype.hasOwnProperty.call(source, 'clock_anchor_epoch')) patch.clock_anchor_epoch = clampInt(source.clock_anchor_epoch, 0, 9999999999999, 0);
    return patch;
  }

  function getClockRemaining(state, now = Date.now()) {
    const normalized = normalizeState(state);
    if (!normalized.clock_running || !normalized.clock_anchor_epoch) return normalized.clock_remaining_seconds;
    const elapsed = Math.max(0, Math.floor((now - normalized.clock_anchor_epoch) / 1000));
    return Math.max(0, normalized.clock_remaining_seconds - elapsed);
  }

  function formatClock(totalSeconds) {
    const safe = Math.max(0, Number.parseInt(totalSeconds, 10) || 0);
    const minutes = Math.floor(safe / 60).toString().padStart(2, '0');
    const seconds = (safe % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = value / 1024;
    let unit = units[0];
    for (let i = 1; i < units.length && size >= 1024; i += 1) {
      size /= 1024;
      unit = units[i];
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForWritable(conn) {
    while (conn?.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 4 * 1024 * 1024) {
      await delay(15);
    }
    if (!conn?.open) throw new Error('Połączenie zostało przerwane podczas wysyłania pliku.');
  }

  async function sendBlob(conn, side, blob, options = {}) {
    if (!conn?.open) throw new Error('Brak połączenia z overlayem.');
    const transferId = randomHex(12);
    const totalChunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));
    const name = options.name || `${side}-logo`;
    const purpose = options.purpose || 'logo';

    conn.send({
      type: 'asset-start',
      transferId,
      purpose,
      side,
      name,
      mime: blob.type || 'application/octet-stream',
      size: blob.size,
      totalChunks
    });

    if (blob.size === 0) {
      conn.send({ type: 'asset-chunk', transferId, index: 0, data: new ArrayBuffer(0) });
      options.onProgress?.(1);
    } else {
      for (let index = 0; index < totalChunks; index += 1) {
        await waitForWritable(conn);
        const start = index * CHUNK_SIZE;
        const end = Math.min(blob.size, start + CHUNK_SIZE);
        const data = await blob.slice(start, end).arrayBuffer();
        conn.send({ type: 'asset-chunk', transferId, index, data });
        options.onProgress?.((index + 1) / totalChunks);
      }
    }

    await waitForWritable(conn);
    conn.send({ type: 'asset-end', transferId });
    return transferId;
  }

  function createAssetReceiver({ onComplete, onProgress, onError } = {}) {
    const transfers = new Map();

    async function handle(message) {
      try {
        if (message?.type === 'asset-start') {
          if (!['home', 'away', 'league'].includes(message.side)) return true;
          const totalChunks = Math.max(1, Number.parseInt(message.totalChunks, 10) || 1);
          transfers.set(message.transferId, {
            purpose: message.purpose || 'logo',
            side: message.side,
            name: String(message.name || ''),
            mime: String(message.mime || 'application/octet-stream'),
            size: Math.max(0, Number(message.size) || 0),
            totalChunks,
            chunks: new Array(totalChunks),
            received: 0
          });
          onProgress?.({ side: message.side, progress: 0, size: message.size, direction: 'receive' });
          return true;
        }

        if (message?.type === 'asset-chunk') {
          const transfer = transfers.get(message.transferId);
          if (!transfer) return true;
          const index = Number.parseInt(message.index, 10);
          if (index < 0 || index >= transfer.totalChunks || transfer.chunks[index]) return true;

          let bytes;
          if (message.data instanceof ArrayBuffer) bytes = new Uint8Array(message.data);
          else if (ArrayBuffer.isView(message.data)) bytes = new Uint8Array(message.data.buffer, message.data.byteOffset, message.data.byteLength);
          else return true;

          transfer.chunks[index] = bytes;
          transfer.received += 1;
          onProgress?.({
            side: transfer.side,
            progress: transfer.received / transfer.totalChunks,
            size: transfer.size,
            direction: 'receive'
          });
          return true;
        }

        if (message?.type === 'asset-end') {
          const transfer = transfers.get(message.transferId);
          if (!transfer) return true;
          transfers.delete(message.transferId);
          if (transfer.received !== transfer.totalChunks) {
            throw new Error(`Niepełny transfer logo (${transfer.received}/${transfer.totalChunks} fragmentów).`);
          }
          const blob = new Blob(transfer.chunks, { type: transfer.mime });
          await onComplete?.({ ...transfer, blob, transferId: message.transferId });
          return true;
        }
      } catch (error) {
        onError?.(error);
        return true;
      }
      return false;
    }

    return { handle, clear: () => transfers.clear() };
  }

  const DB_NAME = 'match-overlay-p2p-v1';
  const STORE_NAME = 'kv';
  let dbPromise = null;

  function openDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB jest niedostępne.'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Nie udało się otworzyć pamięci lokalnej.'));
      });
    }
    return dbPromise;
  }

  async function storageGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Błąd odczytu pamięci lokalnej.'));
    });
  }

  async function storageSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Błąd zapisu pamięci lokalnej.'));
    });
  }

  async function storageDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Błąd usuwania z pamięci lokalnej.'));
    });
  }

  window.OverlayCore = Object.freeze({
    PROTOCOL,
    PERIOD_OPTIONS,
    parseFragment,
    encodeJson,
    decodeJson,
    randomHex,
    peerIdForRoom,
    generateSigningKeys,
    importPrivateKey,
    importPublicKey,
    publicTokenFromPrivateToken,
    signChallenge,
    verifyChallenge,
    buildUrl,
    copyText,
    clampInt,
    clampScore,
    normalizeState,
    sanitizePatch,
    getClockRemaining,
    formatClock,
    formatBytes,
    sendBlob,
    createAssetReceiver,
    storageGet,
    storageSet,
    storageDelete
  });
})();
