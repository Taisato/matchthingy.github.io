(() => {
  'use strict';

  const createButton = document.querySelector('#create-overlay');
  const status = document.querySelector('#setup-status');
  const result = document.querySelector('#created-room');
  const controlLink = document.querySelector('#control-link');
  const overlayLink = document.querySelector('#overlay-link');
  const openControl = document.querySelector('#open-control');

  function setStatus(message, kind = 'neutral') {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  async function copyFrom(element, button) {
    await OverlayCore.copyText(element.value);
    const old = button.textContent;
    button.textContent = 'Skopiowano';
    setTimeout(() => { button.textContent = old; }, 1300);
  }

  document.querySelector('#copy-control').addEventListener('click', (event) => copyFrom(controlLink, event.currentTarget));
  document.querySelector('#copy-overlay').addEventListener('click', (event) => copyFrom(overlayLink, event.currentTarget));

  if (!window.isSecureContext || !crypto?.subtle) {
    setStatus('Ta strona wymaga HTTPS. GitHub Pages spełnia ten warunek.', 'error');
    createButton.disabled = true;
  } else {
    setStatus('Gotowe. Linki i klucze powstaną wyłącznie w tej przeglądarce.', 'ok');
  }

  createButton.addEventListener('click', async () => {
    createButton.disabled = true;
    result.hidden = true;
    setStatus('Generuję pokój i klucz sterowania…', 'neutral');

    try {
      const room = OverlayCore.randomHex(20);
      const { privateToken, publicToken } = await OverlayCore.generateSigningKeys();

      const controllerUrl = OverlayCore.buildUrl('control.html', { room, sk: privateToken });
      const browserSourceUrl = OverlayCore.buildUrl('overlay.html', { room, pk: publicToken });

      controlLink.value = controllerUrl;
      overlayLink.value = browserSourceUrl;
      openControl.href = controllerUrl;
      result.hidden = false;
      setStatus('Gotowe. Do OBS wklej link overlayu, a link sterowania zachowaj prywatnie.', 'ok');
    } catch (error) {
      console.error(error);
      setStatus(`Błąd: ${error.message || error}`, 'error');
    } finally {
      createButton.disabled = false;
    }
  });
})();
