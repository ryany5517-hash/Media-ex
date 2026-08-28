# Desain UI

Prinsip: alat kerja, bukan mainan. Tidak ada emoji, tidak ada simbol dekoratif, tidak ada tanda hubung panjang
di string UI. Semua ikon datang dari **Lucide** (`src/shared/icons.js`, digenerate oleh
`node tools/gen-icons.mjs` dari package `lucide-static`).

## Lihat hasilnya tanpa install

```bash
npm run preview      # → docs/preview/ui.html (dibuka di browser mana pun)
```
Berkas itu dirender dari modul UI asli (`src/content/ui-styles.js` + `src/content/ui.js`) dengan state contoh
(HLS 1080p + varian, MP4 2 GB, blob/MSE, iklan tersembunyi, status subtitle), jadi yang kamu lihat adalah kode
yang jalan, bukan mockup.

## Token

`src/content/ui-styles.js` satu-satunya sumber nilai: warna, skala spasi 4/8/12/16/22, radius, durasi
(120/190/280 ms), dua kurva gerak (`--ease-out`, `--ease-spring`), font. Dark dan light hanya menukar blok
token, bukan aturan.

```
aksen   #5b5bf0 (light) / #7d7bff (dark)
mint    #0f9e88 / #34e0c0   → indikator "yakin" dan confidence dots
netral  bg translusen + border 1 px + shadow lembut, blur 18-22 px (glass, tapi tidak berlapis-lapis)
```

## Gerak dan umpan balik

- **Motion** (vendored, `src/vendor/motion.min.js`) dipakai untuk: entrance FAB, pulse saat stream baru,
  stagger masuk baris, FLIP saat peringkat list berubah, sheet settings, toast, dan morph ikon "tersalin".
  Kalau Motion tidak ada (browser lama / userscript), semua jatuh ke `Element.animate` lalu ke CSS, jadi
  tidak pernah ada yang hilang.
- **Ripple** di setiap tombol (delegasi `pointerdown` di shadow root) + `navigator.vibrate(8)` pada perangkat
  sentuh. Ini yang bikin setiap klik terasa menjawab.
- `prefers-reduced-motion` mematikan seluruh animasi (durasi jadi 1 ms) danripple tidak dibuat.
- `prefers-contrast: more` mengganti token ke warna sistem.

## Komponen

- **FAB**: kartu 56 px dengan ikon radar; badge jumlah, ring pulse dua kali saat ada stream baru, bisa diseret
  (posisi disimpan di settings), anchor panel otomatis ikut sisi FAB.
- **Panel**: header (merek, judul, aksi tema/refresh/settings/tutup), tab `Media | Subtitle | Diagnostik`,
  baris chip meta (tahun, episode, DRM, layer aktif, versi rule pack), list, footer (jumlah, toggle iklan,
  bersihkan, pengaturan penuh).
- **Baris media**: thumbnail/poster, nama, URL dipendekkan, chip (kualitas, ukuran, durasi, LIVE, AES, DRM,
  jumlah segmen, jumlah sumber, status subtitle), titik confidence, aksi Watch Party / Salin / Unduh / Subtitle /
  perintah ffmpeg, dan pelembut "kualitas" (varian master playlist) bila ada.
- **Toast**: satu baris, ikon dalam kotak kecil, bar progres 4 detik, pause saat hover, maksimal 4.
- **Sheet settings**: daftar switch aksesibel (`role="switch"`, `aria-checked`) + segmen tema/bahasa, tanpa
  membuka tab baru.

## Aksesibilitas

FAB `role="button"` + `aria-haspopup` + `aria-expanded`; panel `role="dialog"`; list `role="list"` dan baris
`role="listitem"` yang bisa difokus (↑/↓ pindah baris, `e`/Enter membuka varian, `c` salin, `s` subtitle,
Esc tutup, Tab dijebak selama panel terbuka); status toast lewat `role="status"`/`role="alert"` plus live
region tersembunyi. Target sentuh minimal 44 px pada layar sentuh/lebar ≤ 720 px.

## Test tampilan

`tools/test/ui.test.mjs` (render semua jenis baris, tidak melempar) dan `tools/test/features.test.mjs`
(F9: klik FAB, aksi per baris, Esc, shortcut, drag-FAB tersimpan, setiap kontrol punya nama aksesibel).
