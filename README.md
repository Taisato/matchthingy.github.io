# Match Overlay MVP — OBS + GitHub Pages + WebRTC P2P

Statyczny overlay meczowy do **Browser Source w OBS**, hostowany na GitHub Pages. Nie używa Supabase, Firebase ani płatnego backendu.

Panel sterowania łączy się z overlayem bezpośrednio przez **WebRTC DataChannel**. PeerJS Cloud jest używany wyłącznie jako publiczny serwer sygnalizacyjny do zestawienia połączenia; stan meczu i pliki logo nie są tam przechowywane.

## Co działa

- zdalna zmiana wyniku obu drużyn,
- zmiana nazw obu drużyn,
- upload i usuwanie logo obu drużyn,
- wysyłanie **oryginalnego pliku logo bez kompresji, WebP i limitu 180 KB**,
- transfer dużych plików logo w małych fragmentach przez WebRTC,
- transparentny overlay 1920×1080 do OBS,
- podgląd overlayu w panelu sterowania,
- automatyczne ponawianie połączenia,
- osobny link OBS i osobny prywatny link sterowania,
- kryptograficzne uwierzytelnienie panelu przez ECDSA P-256,
- lokalne zapisywanie stanu oraz logotypów w IndexedDB po stronie OBS.

## Model bezpieczeństwa

Przy kliknięciu **Utwórz nakładkę** przeglądarka tworzy lokalnie:

1. losowy identyfikator pokoju,
2. parę kluczy ECDSA P-256.

Prywatny link panelu wygląda logicznie tak:

```text
control.html#room=...&sk=PRYWATNY_KLUCZ
```

Link OBS wygląda logicznie tak:

```text
overlay.html#room=...&pk=PUBLICZNY_KLUCZ
```

Klucz prywatny znajduje się tylko po `#` w URL. Fragment URL nie jest wysyłany do serwera GitHub Pages w żądaniu HTTP.

Gdy panel próbuje połączyć się z OBS:

1. overlay generuje jednorazowe losowe wyzwanie,
2. panel podpisuje je kluczem prywatnym,
3. overlay sprawdza podpis kluczem publicznym,
4. dopiero po poprawnej weryfikacji przyjmuje zmiany wyniku, nazw i logo.

Osoba posiadająca sam link OBS nie ma klucza prywatnego i nie może wygenerować poprawnego podpisu sterującego.

**Prywatny link sterowania działa jak klucz administratora. Nie publikuj go, nie wklejaj do OBS i nie wysyłaj osobom, które nie powinny sterować transmisją.**

## Logotypy

Logo nie jest zmniejszane ani konwertowane. Panel odczytuje wskazany plik i przesyła jego oryginalne bajty do OBS w fragmentach po WebRTC.

Po odebraniu plik jest zapisywany lokalnie w IndexedDB przeglądarki OBS. Dzięki temu zwykłe odświeżenie źródła Browser nie wymaga ponownego wysłania logo.

Nie ma sztucznego limitu 180 KB. Praktyczna maksymalna wielkość zależy wyłącznie od pamięci i limitu lokalnego storage przeglądarki/OBS, dlatego do transmisji nadal warto używać rozsądnych plików PNG/WebP/SVG zamiast wielusetmegabajtowych obrazów.

## 1. GitHub Pages

Repozytorium zawiera workflow `.github/workflows/pages.yml`.

1. Wrzuć cały katalog do repozytorium GitHub.
2. Ustaw główną gałąź jako `main`.
3. Wejdź w **Settings → Pages**.
4. W **Build and deployment → Source** wybierz **GitHub Actions**.
5. Push do `main` uruchomi deployment.

Nie trzeba tworzyć projektu Supabase, bazy danych, tabel, API key ani konta w dodatkowym backendzie.

## 2. Utworzenie nakładki

1. Wejdź na główny adres GitHub Pages.
2. Kliknij **Utwórz nakładkę**.
3. Skopiuj **prywatny link sterowania** i zapisz go w bezpiecznym miejscu.
4. Skopiuj **link Browser Source do OBS**.

Generator niczego nie rejestruje w bazie. Nowy pokój istnieje dzięki losowemu ID i kluczom zapisanym w linkach.

## 3. OBS

1. Dodaj `Browser` / `Źródło przeglądarki`.
2. Wklej link overlayu.
3. Ustaw:
   - Width: `1920`,
   - Height: `1080`.
4. Pozostaw źródło aktywne podczas transmisji.

Tło strony jest transparentne.

## 4. Sterowanie z innego urządzenia

Otwórz prywatny link sterowania na telefonie, laptopie albo innym komputerze. Panel automatycznie szuka aktywnego overlayu w OBS i po poprawnej autoryzacji umożliwia sterowanie.

Oba urządzenia muszą mieć dostęp do Internetu podczas zestawiania połączenia.

## Jak działa sieć

PeerJS Cloud jest tylko sygnalizacją WebRTC. Po zestawieniu DataChannel dane lecą bezpośrednio pomiędzy panelem a OBS i są szyfrowane przez WebRTC.

To rozwiązanie nie ma miesięcznego abonamentu ani storage w chmurze.

### Ważne ograniczenie WebRTC

Przy większości zwykłych sieci domowych, firmowych i mobilnych połączenie P2P powinno zostać zestawione przez STUN. Istnieją jednak sieci z restrykcyjnym firewallem lub tzw. symmetric NAT, w których bez serwera TURN bezpośrednie WebRTC może się nie zestawić.

Nie dodajemy płatnego TURN, ponieważ celem tej wersji jest **0 zł**. Jeśli kiedyś będzie wymagana gwarancja działania w każdej możliwej sieci, technicznie potrzebny będzie własny TURN lub inny relay dostępny z Internetu.

## Pliki

- `index.html` — generator nowych linków i kluczy,
- `control.html` — prywatny panel sterowania,
- `overlay.html` — Browser Source dla OBS,
- `assets/js/core.js` — kryptografia, transfer plików i IndexedDB,
- `assets/js/control.js` — połączenie i logika panelu,
- `assets/js/overlay.js` — uwierzytelnienie i logika overlayu,
- `.github/workflows/pages.yml` — deployment GitHub Pages.

## Zależność

Panel i overlay korzystają z przypiętej wersji **PeerJS 1.5.5** ładowanej z jsDelivr z kontrolą SRI. PeerJS domyślnie używa `0.peerjs.com` jako darmowego serwera sygnalizacyjnego.

## Dalszy rozwój

Do obecnego protokołu można bez zmiany modelu bezpieczeństwa dodać m.in.:

- zegar meczu,
- połowę / kwartę / set,
- faule i kartki,
- nazwę ligi i rundy,
- sponsorów,
- animacje zdobycia punktu,
- skróty klawiaturowe,
- kilka wariantów graficznych overlayu.
