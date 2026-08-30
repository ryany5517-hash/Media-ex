# Stream Radar — deteksi semua stream video + WatchParty + subtitle Indonesia

Browser extension (Manifest V3) untuk **Chrome, Edge, Brave & Firefox desktop**, plus **userscript** untuk
**Firefox Android**. Bukan lagi userscript biasa: extension bisa melihat trafik jaringan **di semua frame**
lewat `webRequest`, yang mustahil dilakukan Tampermonkey — itu sebabnya versi userscript kemarin gagal total di
67movies (player-nya ada di iframe lintas-origin bertingkat).

> **Status:** 64 test otomatis (unit, simulasi halaman 67movies end-to-end, audit 12 fitur lewat chrome.*
> runtime mock, render UI, boot userscript, verifier update), `web-ext lint` 0 error.
> **Tidak perlu publikasi ke Chrome Web Store / AMO** — dimuat sebagai unpacked / temporary add-on, dan
> perbaikan aturan deteksi turun sendiri lewat rule pack bertanda tangan (lihat `docs/AUTO-UPDATE.md`).
> **Pratinjau desain tanpa install:** `npm run preview` lalu buka `docs/preview/ui.html`.

```
extension   → dist/chrome/   dist/firefox/   (siap load, ada zip & xpi di dist/)
userscript  → userscript/stream-radar.user.js   (Android / tanpa extension)
demo        → demo/index.html   (npm run demo, buat verifikasi deteksi sendiri)
```

---

## 1. Kenapa extension, bukan userscript

| Kemampuan | Userscript | **Stream Radar extension** |
|---|---|---|
| Hook `fetch` / `XHR` / `WebSocket` di frame sendiri | ✅ | ✅ |
| Liat **semua** request HTTP di semua frame & service worker (`webRequest`) | ❌ mustahil | ✅ **ini kunci buat 67movies/vidlink/filemoon** |
| Jalan di iframe lintas-origin (harus match + inject) | sering gagal | ✅ `all_frames` + `match_origin_as_fallback` |
| Badge di toolbar, popup, notifikasi desktop, context menu, shortcut | ❌ | ✅ |
| Download via browser (`chrome.downloads`, resume) | ❌ | ✅ |
| Otomasi form WatchParty.me | sebagian | ✅ content script khusus |
| Parse master `.m3u8` / `.mpd` → daftar kualitas + kunci AES-128 | ✅ (manual) | ✅ otomatis |
| Keperluan install | 1 klik | 2 menit (unpacked) |

## 1b. Aku mau pakai sekarang juga, tanpa nerbitin apa pun?

Bisa. Ringkasnya:

| Browser | Cara | Permanen? |
|---|---|---|
| Chrome / Edge / Brave | `chrome://extensions` → *Load unpacked* → `dist/chrome` | **ya**, sampai kamu hapus sendiri |
| Firefox desktop | `about:debugging` → *Load Temporary Add-on* → `dist/firefox/manifest.json` | sampai browser ditutup |
| Firefox desktop (permanen, tanpa listing publik) | Developer Edition/Nightly + `xpinstall.signatures.required=false`, install `dist/stream-radar-firefox-1.0.0.xpi` | **ya** |
| Firefox desktop (stabil) | `web-ext sign` sebagai *unlisted* (akun AMO gratis, tidak masuk katalog) | **ya** |
| Firefox Android | userscript (Violentmonkey) atau XPI unlisted | **ya** |

Dan supaya kamu tidak perlu lepas-pasang lagi tiap ada perbaikan: [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md).
Intinya: push perubahan `rules/live-rules.json` ke GitHub → CI menandatangani → semua install menariknya dalam
≤ 12 jam. Yang bisa ditambal tanpa install: domain embed/iklan baru, ekstensi media baru, kata sampah judul baru,
dan (kalau kamu aktifkan) patch script konten. Yang tetap perlu build ulang: perubahan `background.js`.

## 2. Install (tidak perlu publish, tidak perlu akun developer)

**Firefox desktop (developer edition / normal):**
1. `npm install && npm run build` (atau unduh artifact `stream-radar-firefox-<ver>.xpi` dari Releases)
2. Buka `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pilih `dist/firefox/manifest.json`
   ⚠ “Temporary” = hilang saat browser ditutup. Buat permanen tanpa AMO: `npm i -g web-ext && cd dist/firefox && web-ext sign --api-key … --api-secret …` (butuh akun AMO gratis, **tidak perlu review publik** — mode *Unlisted*), lalu install `.xpi` hasil sign.
3. Butuh Firefox ≥ **128** (dukungan `world: MAIN`; di bawah itu fallback inject script tetap jalan, tapi Layer 1 bisa ketahan CSP).

**Chrome / Edge / Brave:**
1. `npm run build`
2. `chrome://extensions` → nyalakan **Developer mode** → **Load unpacked** → pilih folder `dist/chrome`
3. Extension “unpacked” tidak pernah kedetect sebagai malware-prompt seperti CRX tanpa signature; kalau Chrome bilang “Disable developer extensions”, hapus flag `--disable-extensions-except` atau gunakan mode *Load unpacked* tanpa parameter itu.

**Firefox Android (FX Fenix):** install add-on non-AMO **tidak didukung**. Pakai userscript:
1. Install **Violentmonkey** (dari AMO, resmi)
2. Buka `https://raw.githubusercontent.com/ryany5517-hash/Media-ex/main/userscript/stream-radar.user.js` → Install
3. Fungsi yang hilang vs extension: tidak ada observer `webRequest` dan badge toolbar (deteksi tetap 5 layer, cuma lewat JS hook). Alternatif: sign XPI sebagai *Unlisted* lalu kirim ke HP — Firefox Android menerima add-on ber-signature AMO.

## 3. Setup pertama (2 menit)

1. Buka video → play → tombol **◉** muncul di kanan-bawah dengan counter.
2. Klik ⚙ (gear) → **isi API key Wyzie / SubDL** (gratis) → subtitle Indonesia otomatis nyari.
   - Wyzie Subs: https://store.wyzie.io/redeem (cari berdasarkan **ID IMDb/TMDB** — dideteksi otomatis dari URL halaman kayak `67movies.nl/watch/movie/10389`, `?tmdb=…`, `?imdb=tt…`, embed, dsb.)
   - SubDL: https://subdl.com/panel/api
   - OpenSubtitles: https://www.opensubtitles.com/en/api-keys (wajib isi **User-Agent** yang sama persis seperti di form)
3. Klik **Putar** pada stream yang terdeteksi. Player bawaan mengambil file dengan Referer halaman aslinya (cara yang sama IDM mendeteksi media). **Nonton Bareng** tetap membuka room WatchParty.me.
4. Shortcut: `Alt+Shift+S` (panel) · `Alt+Shift+D` (scan ulang) · `Alt+Shift+F` (cari subtitle). Bisa diganti di `chrome://extensions/shortcuts` / `about:addons` → Manage → Shortcuts.

## 4. Fitur (checklist vs request awal)

**PART 1 — 5 layer deteksi**
- **L1 network:** `unsafeWindow.fetch`, `XMLHttpRequest.open/send`, `WebSocket` (URL + isi frame), `EventSource`, header `Content-Type: video/*`, + observer `webRequest` (semua frame, redirect, 206/range, `Content-Disposition`).
- **L2 DOM:** `MutationObserver` subtree penuh, polling 2 dtk, `video.src` / `currentSrc` / semua `<source>`, `iframe/embed/object`, `link[rel=preload]`, `a[download]`, rekursif ke iframe same-origin.
- **L3 MSE:** `MediaSource.addSourceBuffer`, `SourceBuffer.appendBuffer`, `URL.createObjectURL`, setter `HTMLMediaElement.src`, EME `requestMediaKeySystemAccess` (deteksi Widevine/PlayReady/FairPlay).
- **L4 SW/Cache:** scan `caches.keys()/cache.keys()` untuk response video + probe service worker.
- **L5 heuristik:** regex inline `<script>` + `document.write`, `performance.getEntriesByType('resource')`, probe internal **JWPlayer / Video.js / Plyr / HLS.js / DASH.js / Clappr**, scan object config di `window`, dan **unwrap URL** (`?url=…m3u8`, double-encoded, base64) — trik yang bikin embed provider kebongkar.
- Semua hasil: dedupe (query token diabaikan), kategori (MP4/HLS/DASH/BLOB/SEGMENT/TEXTTRACK), label kualitas/size/durasi, segmen di-agregasi (nggak nampilin 4000 baris `.ts`), iklan (VAST/doubleclick) dipisah + disembunyikan default.

**PART 2 — judul:** JSON-LD (`Movie`/`TVEpisode`/`VideoObject`) → `og:title` → `twitter:title` → `h1` → `document.title`; cleansing `Nonton/Streaming/Sub Indo/Subtitle Indonesia/HD/4K/720p/1080p/Full Movie/Gratis/Download/LK21/Indoxxi/Layarkaca21/domain sitescene…`; tahun + `SxxEyy` / `3x04` / `Episode 5` dipisah; IMDb/TMDB id ikut di-ekstrak. Output: `{ title:"Dune: Part Two", year:"2024", episode:null }`.

**PART 3 — WatchParty:** `https://www.watchparty.me/watchNow?url=<stream>&name=<judul>` + content script pengisi form (room name / user name / join). **Tidak** bikin player atau website sendiri — WatchParty sudah support file HTTP dan HLS. Payload hand-off disimpan 6 menit, cuma untuk tab itu, lalu dihapus.

**PART 4 — subtitle ID:** Wyzie Subs (`sub.wyzie.io`, cari by **ID IMDb/TMDB**) → SubDL (`api.subdl.com`) → OpenSubtitles REST (`api.opensubtitles.com`) → YIFY (fallback tanpa key). ID film dideteksi otomatis dari URL/kanonikal/iframe/meta halaman (`/watch/movie/10389`, `/embed/tv/1396`, `?tmdb=…`, `?imdb=…`, `tt0314196`, slug-`10389`); kalau cuma ada ID TMDB dari URL, nama film + IMDb di-resolve lewat halaman TMDB (tanpa key). Filter bahasa Indonesia, ranking kemiripan judul+tahun+episode, download → **unzip/gunzip internal** → SRT→**VTT** → tombol *Pasang di sini* (inject `<track>` ke video halaman), *Download .vtt*, atau dikirim ke room WatchParty.

**PART 5 — UI/UX:** FAB glassmorphism (bisa di-drag, posisi disimpan), badge counter, animasi pulse saat stream baru; panel di atas FAB (judul, tipe, kualitas, thumbnail/poster, status subtitle, tombol Watch Party / Copy / Download / Subs / Open / ffmpeg / varian kualitas); toast pojok atas (auto 4 dtk); dark/light/system + toggle manual; settings via ⚙; semua di dalam **closed Shadow DOM** (tidak bisa di-restyle situs); target sentuh ≥44px, sheet full-width di layar ≤720px, navigasi Tab/Enter/Esc/↑↓, ARIA di semua kontrol.

## 5. Verifikasi sendiri

```bash
npm install
npm test          # 64 test: rules, judul, SRT-VTT, unzip, provider, simulasi halaman 67movies, audit 12 fitur, UI, userscript, verifier update
npm run qa        # design QA: kontras WCAG, target sentuh, kelas yatim, kebijakan tanpa emoji/emdash
npm run lint      # web-ext lint (Firefox) → 0 errors
npm run demo      # http://localhost:8088/demo/index.html → harus muncul 1 HLS (1080p + 720p) + 1 MP4 + 1 blob
npm run test:demo # 3 test yang menjalankan server demo + pipeline deteksi lewat HTTP beneran
npm run preview   # docs/preview/ui.html → panel UI dirender dari modul UI yang asli
npm run build     # regenerasi dist/chrome + dist/firefox (snapshot sudah ikut repo), arsip zip/xpi, userscript/
```

CI siap pakai (opsional): `ci/github-actions-build.yml` — salin ke `.github/workflows/build.yml`
buat otomatis ngejalanin test + publish artifact `zip/xpi/userscript` di tiap push/release.

Desain & motion: [docs/DESIGN.md](docs/DESIGN.md) · Update otomatis: [docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md)
Detail: [docs/INSTALL.md](docs/INSTALL.md) · [docs/API-KEYS.md](docs/API-KEYS.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) · [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)

## 6. Batasan jujur (bukan alasan, tapi fisika web)

- **DRM (Widevine/FairPlay/PlayReady)**: stream di-encrypt di level CDM → tidak ada URL yang bisa diunduh. Stream Radar **melabeli** “🔒 DRM” biar jelas, bukan pura-pura sukses.
- **`blob:` + MSE**: itu pipeline, bukan file. Ada **“Rekam buffer (beta)”** (aktifkan di Settings) yang nglumpukin `appendBuffer()` jadi file `.m4v/.webm` — works for fragmented MP4/WebM, dibatasi `recordCapMB`.
- **P2P/WebTorrent/WASM demuxer**: segmen lewat WebRTC, bukan HTTP → tidak keliatan oleh layer mana pun.
- **YIFY Subtitles**: endpoint publiknya sering mati → di-treat sebagai fallback, failure dilaporkan di panel, tidak bikin error.
- **WatchParty**: tidak punya API room publik; kalau mereka redesign form, auto-fill bisa meleset (URL media & subtitle tetap jalan manual via tombol Copy).
- **Situs dengan CSP sangat ketat** bisa nge-blok inject; extension tetap aman karena `world:"MAIN"` (Firefox ≥128 / Chrome ≥111) bypass CSP, userscript tidak.

## 7. Keamanan & privasi

- Tidak ada server kami. Tidak ada analytics. Request keluar hanya ke: situs yang kamu buka (observer read-only), provider subtitle yang kamu aktifkan, dan watchparty.me saat kamu klik.
- `<all_urls>` + `webRequest` memang izin lebar — itu harga untuk deteksi lintas-frame; kodenya read-only dan tidak pernah menyimpan body media (hanya manifest teks, maks 700 KB, untuk parsing kualitas).
- Semua preferensi & riwayat singkat ada di `chrome.storage.local` browser kamu; tombol *Clear / Reset* tersedia di Options.

## 8. Struktur repo

```
src/manifest.json              MV3 manifest (Chrome & Firefox, di-tweak per target saat build)
src/background.js              webRequest observer, store per-tab, subtitle, WatchParty, badge, menus
src/page/inject.js             LAYER 1/3/5 — MAIN-world hooks
src/content/content.js         bridge + LAYER 2/4 via dom-scanner + mount UI
src/content/ui.js,ui-styles.js FAB/panel/toast/settings (closed Shadow DOM)
src/popup/ · src/options/      toolbar popup & halaman pengaturan
src/watchparty/watchparty.js   adapter WatchParty (payload dari background)
src/shared/                    util · rules (klasifikasi) · title-cleaner · store (dedupe/rank) ·
                               subtitles (4 provider: Wyzie/SubDL/OpenSubtitles/YIFY + SRT→VTT + unzip) · dom-scanner · i18n (en/id) ·
                               icons (generate dari Lucide) · updater (rule pack + patch bertanda tangan) ·
                               watchparty-auto (otomasi form)
src/vendor/                    motion.min.js (UMD, animasi) + catatan lisensi
src/userscript/host.js         host untuk build userscript (Tampermonkey/Violentmonkey)
rules/live-rules.json          sumber rule pack; terbit ke branch `live` lewat npm run live:push
src/userscript/host.js         host untuk build userscript (Tampermonkey/Violentmonkey)
tools/build.mjs                bundling prelude, tweak manifest per browser, validasi, zip/xpi
tools/build-userscript.mjs     generate userscript/stream-radar.user.js (+header @grant dll.)
tools/test/*.test.mjs          61 test (node:test): unit, integrasi, audit fitur, UI, design QA, updater
tools/design-qa.mjs            audit desain terprogramm (kontras, target sentuh, simbol)
tools/render-preview.mjs       render panel ke docs/preview/ui.html (lihat desain tanpa install)
tools/{keygen,sign,publish-live}.mjs  kanal update otomatis (rule pack bertanda tangan)
demo/                          halaman uji deteksi
```

Lisensi MIT — lihat [LICENSE](LICENSE). Proyek ini alat bantu teknis; hormati hukum hak cipta di wilayahmu.
