# Troubleshooting

### “Tidak ada yang terdeteksi” di situs X

Cek berurutan (buka DevTools → Console):

1. **Apakah konten script masuk ke frame player?** Di Console, ganti *context* dari `top` ke iframe player
   (dropdown di atas Console), lalu:
   ```js
   typeof SR !== 'undefined' && SR.VERSION      // → "1.0.0"
   window.streamRadar && window.streamRadar.detected()   // → [ …keys… ]
   ```
   Kalau `SR` undefined di frame itu → situs memblokir inject (CSP / frame di-`sandbox`). Layer jaringan tetap
   harusnya nangkep; lanjut no. 2.
2. **Badge / popup extension** → kalau popup kosong padahal player jalan, matikan dulu filter:
   - Settings → *Detection layers* → pastikan **Layer 1** & **Layer 5** nyala
   - Options → *Advanced* → “Block patterns” kosong? per-site opt-out ke-isi? (Options → Advanced → per-site list)
   - ikon ◉ → toggle “Auto-detect” di footer panel (kamu bisa gak sengaja matiin)
3. **Player pakai DRM?** Panel akan nunjukin chip merah **“DRM protected”** (kami deteksi EME +
   `#EXT-X-KEY:SAMPLE-AES` / `<ContentProtection>`). Untuk DRM, memang tidak ada URL yang bisa diambil.
4. **Cuma `blob:` yang muncul?** Normal untuk MSE. Aktifkan Settings → *Detection layers* →
   **“Allow MSE buffer recording”**, play 10–20 dtk, lalu klik **Rekam buffer** di item blob → file `.m4v/.webm`.
5. **Situs P2P (WebTorrent/HLS via WASM)?** Tidak ada HTTP → tidak ada yang bisa dideteksi. Ini batasan teknis,
   bukan bug.

### “Subtitle tidak ketemu”

| Penyebab | Cara pastiin |
|---|---|
| API key kosong | panel status: “Add an API key in Settings” |
| Key OpenSubtitles ditolak | panel: `OpenSubtitles: API key ditolak (401/403)` → samakan User-Agent persis |
| Judul salah karena situs pakai title aneh | klik Copy di baris judul panel, bandingkan; atau test manual di Options → *Test the search* |
| Series, episode belum rilis | subtitle memang belum ada — coba `Search again` |
| Provider Indonesia telat | matikan filter bahasa (Options → *Language filter* → All languages) buat cek apakah ada sama sekali |

### Extension tidak mau install / hilang tiap restart

- Chrome: **Load unpacked** harus nunjuk ke `dist/chrome`, bukan `src/` dan bukan file `.zip`.
- Firefox: “Load Temporary Add-on” memang sementara (± 24 jam / restart). Untuk permanen harus XPI ber-signature
  (lihat docs/INSTALL.md §2).
- `manifest.json` error “Input version cannot be empty” → kamu load folder yang salah; jalankan `npm run build`.
- **“Failed to load extension … Could not find key specification for `command[N].suggested_key`: Either specify a
  key for `windows`, or specify a default key.”** → `dist/` kamu masih versi lama. Penyebabnya: kalau `suggested_key`
  ditulis per-platform, **semua** platform harus ada (`default`, `windows`, `mac`, `linux`, `chromeos`) — atau cukup
  pakai satu `default`. Fix: `npm run build` (validator-nya sekarang menolak manifest seperti ini sebelum ke-release),
  lalu **Remove** extension lama di `chrome://extensions` dan **Load unpacked** ulang.

### Web-ext lint warning

```
UNSAFE_VAR_ASSIGNMENT (18×)  Unsafe assignment to innerHTML
```
Diperbaiki? Tidak perlu — semua nilai dinamis dilewatkan `util.esc()` dulu (lihat `src/content/ui.js::itemHtml`),
dan UI ada di Shadow DOM. AMO tidak menolak warning “innerHTML” kalau datanya escaped; kalau mau publish,
tambahkan catatan ini di “misc” form review.

### Error di Service Worker

`chrome://extensions` → *Stream Radar* → **Inspect views: service worker** → Console.
Atau Firefox: `about:debugging` → This Firefox → Stream Radar → **Inspect**.
Nyalakan **Debug logging** (Options → Advanced) buat log keputusan (`manifest fetch failed`, `webRequest error`, dsb.)
lalu lampirkan saat buka issue.

### Panel menutupi tombol situs

- Drag ◉ ke tempat lain (posisi disimpan), atau
- klik ikon 👁 (hide) di header panel untuk menyembunyikan FAB sementara, atau
- Settings → **“Show the floating button on pages”** off; panel tetap bisa dibuka dari popup toolbar / `Alt+Shift+S`.

### Situs marah / lambat

Layer 5 membaca `performance` dan inline script — ringan, tapi di halaman 5 MB bisa terasa. Matikan:
Options → Detection layers → **“Regex-scan scripts”**, dan/atau **Probe player instances**. Deteksi jaringan tetap jalan.
