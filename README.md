# Match Overlay v3 — OBS + GitHub Pages + WebRTC P2P

Wersja v3 usuwa zależność od publicznego `0.peerjs.com`. Discovery urządzeń odbywa się przez **Trystero 0.25.3 + Nostr**, z kilkoma równoległymi relayami dla większej odporności.

## Dlaczego zmiana

Publiczny PeerJS Cloud potrafił długo nie rejestrować peerów albo rozłączać WebSocket, przez co panel widział `OBS offline`, mimo że obie strony były uruchomione. W v3 PeerJS został usunięty.

## Co pozostaje bez zmian

- GitHub Pages jako hosting statyczny,
- 0 zł, bez konta backendowego,
- prywatny link sterowania z kluczem ECDSA P-256,
- osobny link read-only do OBS,
- wynik, timer, faza meczu, 15/20 min,
- logo i nazwy drużyn,
- logo i nazwa ligi z przełącznikami,
- regulowana szerokość overlayu,
- oryginalne pliki logo bez kompresji,
- lokalne zapisywanie stanu i logo w IndexedDB OBS.

## Sieć

Trystero używa Nostr tylko do discovery i wymiany danych potrzebnych do zestawienia WebRTC. Właściwe dane aplikacji po zestawieniu połączenia idą bezpośrednio P2P i są szyfrowane przez WebRTC.

Konfiguracja używa kilku relayów równolegle (`redundancy: 5`), więc awaria pojedynczego endpointu nie powinna zatrzymać zestawiania połączenia.

## Bezpieczeństwo sterowania

Overlay nadal wymaga podpisu ECDSA P-256. Challenge jest dodatkowo związany z konkretnym identyfikatorem peer overlayu, aby podpisu nie dało się przekazać do innego peera.

## Aktualizacja z v2

1. Podmień wszystkie pliki z paczki w repozytorium.
2. Zrób commit/push.
3. Poczekaj na zielony GitHub Action.
4. W OBS: Browser Source → Properties → **Refresh cache of current page**.
5. Otwórz ponownie panel sterowania.

Stare linki `control.html#room=...&sk=...` i `overlay.html#room=...&pk=...` pozostają zgodne — nie trzeba generować nowego pokoju.

## Ważne

WebRTC nadal może wymagać TURN w skrajnie restrykcyjnych/symmetric-NAT sieciach. To osobny etap od discovery. Jeśli OBS zostanie znaleziony, ale UI pokaże błąd zestawiania P2P, wtedy przyczyną jest NAT/firewall, nie relaye Nostr.
