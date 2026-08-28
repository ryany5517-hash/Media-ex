# Arsitektur

```
┌─ MAIN world (halaman, semua frame) ──────────────────────────────┐
│ src/page/inject.js                                                │
│  L1  fetch / XHR.open+send / WebSocket / EventSource             │
│  L3  MediaSource.addSourceBuffer · SourceBuffer.appendBuffer ·   │
│      URL.createObjectURL · HTMLMediaElement.src · EME            │
│  L5  inline-script regex · document.write · performance        │
│      · probe JWPlayer/Video.js/Plyr/HLS.js/DASH.js · window cfg  │
│      postMessage({srad:1,kind:'media',…})                         │
└───────────────┬──────────────────────────────────────────────────┘
                │ window.message (nonce-less, satu arah ke UI sendiri)
┌───────────────▼──────────────────────────────────────────────────┐
│ ISOLATED world (content script)                                  │
│  src/content/content.js  ← src/shared/dom-scanner.js (L2, L4)   │
│  src/content/ui.js + ui-styles.js (closed Shadow DOM)            │
│  fallback: inject <script src=web_accessible_resources> bila     │
│            browser mengabaikan `world:"MAIN"`                     │
└───────────────┬──────────────────────────────────────────────────┘
                │ chrome.runtime.sendMessage
┌───────────────▼──────────────────────────────────────────────────┐
│ background service worker  (src/background.js)                   │
│  L1b webRequest.onHeadersReceived <all_urls> (semua frame/SW)    │
│  src/shared/store.js  → MediaStore: dedupe · agregasi segmen ·  │
│                         klasifikasi · ranking · parse m3u8/mpd    │
│  src/shared/title-cleaner.js · src/shared/subtitles.js           │
│  badge · notifikasi · context menu · chrome.downloads · storage  │
│  WatchParty hand-off (srad:party:<tabId>, TTL 6 menit)           │
└──────┬───────────────────────────────┬──────────────────────────┘
       │ runtime.onMessage             │ runtime.onMessage
┌──────▼───────────┐        ┌──────────▼─────────┐  ┌──────────────────────┐
│ popup (toolbar)  │        │ options (settings) │  │ watchparty/watchparty │
└──────────────────┘        └────────────────────┘  │  + shared/watchparty- │
                                                     │    auto.js (form fill)│
                                                     └──────────────────────┘
```

## Modul bersama (dipakai extension **dan** userscript)

| File | Isi | Kenapa bersama |
|---|---|---|
| `shared/util.js` | helper murni + adapter storage (`chrome.storage` ⇄ `localStorage`) + `SR.settings` | satu sumber default |
| `shared/rules.js` | klasifikasi URL/mime, daftar iklan, host embed, `unwrapUrl`, parse HLS/DASH | keputusan “ini media bukan” harus identik di semua layer |
| `shared/title-cleaner.js` | pipeline cleansing + ekstraksi tahun/episode/imdb | 30+ test unit |
| `shared/store.js` | `MediaStore` (dedupe, agregasi segmen, enrichment, view-model) | background & userscript tidak boleh beda hasil |
| `shared/dom-scanner.js` | L2 (mutation+poll+iframe) & L4 (Cache API) + `title.resolve` | content script & host userscript |
| `shared/subtitles.js` | 3 provider, ranking, unzip/gunzip, SRT→VTT | sama |
| `shared/watchparty-auto.js` | otomasi form WatchParty + inject `<track>` | extension & userscript |
| `shared/i18n.js` | kamus en/id | UI konsisten |

## Build (tools/build.mjs)

1. copy `src/` → `dist/{chrome,firefox}`
2. **inline prelude**: file `shared/*.js` dikatenin ke depan `background.js` (MV3 service worker cuma boleh 1 file,
   dan Firefox tidak selalu mendukung `importScripts` di SW)
3. **tweak manifest per target**: Chrome → buang `browser_specific_settings`, `author`, `background.scripts`,
   `match_origin_as_fallback`; Firefox → buang `minimum_chrome_version`, pakai `background.scripts`
4. **validasi**: manifest JSON, semua path di `content_scripts`/`web_accessible_resources`/`icons` ada,
   `node --check` semua `.js`, dan setiap `data-key` di `options.html` harus ada di `SR.defaults`
5. pack → `dist/stream-radar-chrome-<ver>.zip`, `dist/stream-radar-firefox-<ver>.xpi` (zip writer sendiri,
   `tools/lib/zip.mjs`, tanpa dependency)
6. `tools/build-userscript.mjs` → `userscript/stream-radar.user.js` (header + 12 modul, 253 KB)

## Data & state

- `MediaStore` keyed by `origin + pathname + category` — query token (`?expires=`, `&sig=`) diabaikan supaya
  1 stream tidak muncul 6×; URL lengkap tetap disimpan untuk download.
- Segmen (`.ts`, `.m4s`, …) **tidak** ditampilkan satu-satu: digabung per folder (`segmentgroup`) dengan jumlah
  byte, dan ditandai `coveredBy` kalau playlist-nya sudah ada.
- Item di-cap `settings.maxItems` (default 80) per tab; state di-slim ke `srad:tab:<tabId>` (debounce 1.5 dtk)
  supaya reload/Service Worker restart tidak menghilangkan daftar.
- `srad:history` = 150 stream terakhir lintas tab (dipakai popup “Recent streams”), bisa dihapus.
- Body manifest (maks 700 KB) diambil sekali buat parsing kualitas; tidak ada body media yang disimpan.

## Kenapa `webRequest` bukan `declarativeNetRequest`

Kami tidak memblokir/mengubah request sama sekali — hanya membaca header. `webRequest` read-only adalah satu-satunya
cara melihat respons lintas-origin di semua frame tanpa proxy, dan tidak memerlukan izin `webRequestBlocking`
(yang bahkan dilarang di MV3 Chrome).
