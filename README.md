# Match Overlay — OBS + GitHub Pages + WebRTC P2P

Statyczny overlay meczowy do **Browser Source w OBS**, hostowany na GitHub Pages. Nie używa Supabase, Firebase ani płatnego backendu.

## Nowości w tej wersji

- sterowanie wynikiem obu drużyn,
- sterowanie nazwami drużyn,
- upload i usuwanie logo obu drużyn,
- **logo i nazwa ligi** z osobnymi przełącznikami pokaż/ukryj,
- **zegar meczu** z trybami `1st half`, `2nd half`, `Extra time`,
- przełączanie długości połowy między **15 min** i **20 min**,
- start/pauza zegara,
- szybkie dodawanie i odejmowanie sekund (`±5 s`, `±30 s`),
- reset zegara do pełnego czasu aktualnej połowy,
- **kontrola długości/szerokości całego overlayu**,
- lokalne zapisywanie stanu oraz wszystkich logotypów w IndexedDB po stronie OBS,
- zdalne sterowanie przez prywatny link P2P z podpisem ECDSA P-256.

## Architektura

Panel sterowania łączy się z overlayem bezpośrednio przez **WebRTC DataChannel**. PeerJS Cloud jest używany wyłącznie jako publiczny serwer sygnalizacyjny do zestawienia połączenia; stan meczu i pliki logo nie są tam przechowywane.

## Pliki

- `index.html` — generator nowych linków i kluczy,
- `control.html` — prywatny panel sterowania,
- `overlay.html` — Browser Source dla OBS,
- `assets/js/core.js` — kryptografia, transfer plików, timer helpers i IndexedDB,
- `assets/js/control.js` — logika panelu sterowania,
- `assets/js/overlay.js` — logika overlayu,
- `.github/workflows/pages.yml` — deployment GitHub Pages.

## Użytkowanie

1. Wejdź na `index.html` na GitHub Pages.
2. Kliknij **Utwórz nakładkę**.
3. Skopiuj:
   - prywatny link sterowania,
   - link overlayu do OBS.
4. W OBS dodaj źródło Browser i ustaw 1920×1080.
5. Otwórz prywatny link sterowania na telefonie lub komputerze.

## Bezpieczeństwo

Prywatny link sterowania zawiera klucz prywatny ECDSA P‑256 zapisany po `#` w URL. Link OBS zawiera wyłącznie klucz publiczny. Overlay akceptuje komendy tylko po poprawnej kryptograficznej autoryzacji.

## Uwaga o sieci

To rozwiązanie pozostaje **0 zł**, dlatego nie używa serwera TURN. W większości typowych sieci zadziała poprawnie, ale w niektórych bardzo restrykcyjnych sieciach WebRTC P2P może się nie zestawić.
