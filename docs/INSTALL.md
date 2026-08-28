# Install & pakai

Repo ini **tidak** dipublikasikan ke Chrome Web Store / AMO. Semua cara di bawah resmi untuk developer dan
tidak butuh akun developer berbayar (kecuali opsi “permanen di Firefox”, yang butuh akun AMO gratis).

## 0. Build dulu

```bash
npm install
npm run build          # → dist/chrome, dist/firefox, dist/stream-radar-*.zip|*.xpi, userscript/
npm test               # 41 test, harus semua ✔
npm run lint           # web-ext lint → 0 errors (warning innerHTML itu normal, semua data sudah di-escape)
```

## 1. Chrome / Edge / Brave (desktop)

1. `chrome://extensions` (Edge: `edge://extensions`)
2. aktifkan **Developer mode** (kanan atas)
3. **Load unpacked** → pilih folder **`dist/chrome`** (bukan `src/`!)
4. ikon ◉ muncul di toolbar; badge = jumlah stream yang terdeteksi di tab itu

Catatan:
- Chrome menampilkan peringatan “mode developer” tiap buka browser — itu normal untuk unpacked.
- Jangan load `src/` di Chrome kalau kamu juga mau pakai di Chrome lama: `src/background.js` butuh
  `importScripts` (jalan di Chrome) tapi folder `dist/` sudah lebih aman untuk kedua browser.
- Shortcut: `chrome://extensions/shortcuts` → set Alt+Shift+S / D / F kalau belum kebaca.

## 2. Firefox desktop

1. `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pilih **`dist/firefox/manifest.json`**
3. Add-on temporary hilang saat browser ditutup. Untuk permanen (tanpa review publik):

```bash
npm i -g web-ext
cd dist/firefox
web-ext sign --api-key <AMO_API_KEY> --api-secret <AMO_API_SECRET> \
  --artifacts-dir ../../signed
# → ../../signed/stream-radar-<ver>.xpi  (unlisted = tidak masuk katalog AMO)
```

API key AMO: https://addons.mozilla.org/developers/add-on/api-credentials → “Submit unlisted add-ons for review”.
Kunci ini untuk **signing**, tidak perlu publish/ listing publik. Setelah ter-sign:
`about:addons` → ⚙ → *Install Add-on From File* → pilih `.xpi`.

Versi minimum: Firefox **128** (untuk `content_scripts.world = "MAIN"`). Di Firefox lama, fallback lewat
`<script src=web_accessible_resources>` dipakai; kalau situs punya CSP ketat, Layer 1 page-hook bisa tidak aktif
— Layer webRequest tetap jalan.

## 3. Firefox Android (Fenix)

Firefox Android hanya menerima add-on yang ditandatangani AMO. Pilihan:

| Cara | Detail | Deteksi |
|---|---|---|
| **Userscript** (paling gampang) | install Violentmonkey dari AMO → install `userscript/stream-radar.user.js` dari repo | L1 (JS hook) + L2 + L3 + L4 + L5 |
| **XPI unlisted** | sign seperti langkah 2, kirim file `.xpi` ke HP, buka dengan Firefox | penuh (termasuk webRequest) |
| **ADB / web-ext run** | `web-ext run -t android` untuk debugging (perlu USB debug) | penuh, tapi sementara |

## 4. Setelah install — cek cepat (2 menit)

```bash
npm run demo     # serve repo di http://localhost:8088
```
buka `http://localhost:8088/demo/index.html`, klik play di player demo, lalu klik tombol ◉.
Yang harus muncul di panel:

- 1 entri **HLS** `master.m3u8` dengan chip `1080p` (dan varian 720p kalau di-expand),
- 1 entri **MP4** (`backup/movie-720p.mp4`),
- 1 entri **BLOB/MSE** dengan keterangan “tidak bisa diunduh langsung”,
- judul **“Dune: Part Two” (2024)** — bukan title SEO panjang.

Kalau panel kosong: buka DevTools → Console → ketik `streamRadar.detected()` (userscript/MAIN world) atau
cek `chrome.storage.local` key `srad:tab:<id>` (extension).

## 5. Uninstall / reset

- Hapus add-on seperti biasa; data preferensi ikut kehapus untuk Chrome. Firefox menyimpan `storage.local`:
  Options → *Advanced* → **Reset everything** (atau `browser.storage.local.clear()` dari DevTools di halaman options).
