# Update otomatis tanpa install ulang

Masalah yang mau dihilangkan: extension terpasang manual (unpacked / temporary add-on), jadi setiap kali ada
aturan deteksi yang perlu diperbaiki, user harus melepas lalu pasang lagi. Dengan channel di bawah, perbaikan
turun sendiri ke setiap install, dan user tidak menyentuh apa pun.

## Dua channel

| Channel | Isi | Default | Risiko |
|---|---|---|---|
| Rule pack | data: domain embed baru, domain iklan, ekstensi media, kata sampah judul | aktif | rendah (hanya menambah aturan, tidak menjalankan kode) |
| Code patch | JavaScript untuk script konten | **mati** | tinggi, karena itu butuh tanda tangan + opt-in eksplisit |

Keduanya dibaca dari branch `live`:

```
rules/rules.json      + rules/rules.json.sig
patch/patch.js        + patch/patch.js.sig      (opsional)
patch/meta.json       { version, minAppVersion, file, changelog }
```

## Cara kerjanya

1. Service worker memanggil `SR.updater.checkForUpdates()` saat install, saat start-up, lalu tiap
   `updateCheckHours` (default 12 jam) lewat `chrome.alarms`.
2. Isi `rules.json` di-parse, **diverifikasi tanda tangannya** dengan public key ECDSA P-256 yang ditanam di
   `src/shared/updater.js`. Tanpa tanda tangan valid: ditolak, tidak ada perubahan sama sekali.
3. Kalau oke, pack disimpan di `chrome.storage.local['srad:rules']` (bisa dipakai offline) dan dipakai di semua
   frame lewat pesan `{type:'rules'}` ke content script.
4. `SR.dynamic` cuma boleh **menambah** aturan (`rules.classify`, `title.clean` membacanya), jadi pack lama/rusak
   tidak bisa membuat deteksi jadi buta.
5. Versi tercatat di settings (`rulesVersion`, `patchVersion`, `lastUpdateCheck`) dan muncul di panel
   tab Diagnostics + Options, jadi selalu jelas pack mana yang aktif.

## Menerbitkan perbaikan

```bash
# 1. satu kali: bikin kunci (private TIDAK masuk git)
npm run keygen
# simpan isinya ke secret GitHub: STREAMRADAR_UPDATE_KEY

# 2. setiap kali ada aturan baru
$EDITOR rules/live-rules.json      # naikkan "version" (integer, mis. 2026082802)
npm run live                        # cek hasil di dist-live/ (berkas .sig ikut dibuat)
npm run live:push                   # commit dist-live/ ke branch `live`
```

Atau biarkan CI yang melakukan: aktifkan workflow (lihat bawah) dan simpan kunci di secret; setiap push ke
`main` yang mengubah `rules/**` akan menerbitkan pack baru.

Code patch: taruh `patch/patch.js` + `patch/meta.json` di repo, jalankan perintah yang sama. Untuk mencabut,
hapus foldernya dari branch `live` (klien berhenti mengambil; versi yang sudah dipakai tidak di-rollback
otomatis, jadi biasakan menambah aturan, bukan mengubah perilaku).

## Dev: `npm run watch` (tidak perlu klik Reload di chrome://extensions)

Saat kamu ngoding di mesin sendiri, rule pack 12-jam itu terlalu lambat. Jalankan:

```bash
npm run watch
```

Itu nge-watch `src/`, `rules/`, `userscript/`, rebuild `dist/` tiap ada perubahan, dan inject snippet di service worker yang nge-poll `http://127.0.0.1:18765/stamp`. Kalau stamp berubah, extension memanggil `chrome.runtime.reload()` sendiri, lalu me-refresh tab `http(s)` yang terbuka. Load unpacked **sekali** ke `dist/chrome` (atau `dist/firefox`) selagi `watch` jalan. Build produksi (`npm run build`) **tidak** menyertakan snippet itu.

## Yang TIDAK bisa di-hot-update

Perubahan pada `background.js` (izin, observer jaringan, API subtitle) tidak bisa ditambal dari jauh: MV3
melarang eksekusi kode jarak jauh di service worker. Untuk itu tetap perlu `git pull && npm run build`
di mesin user, atau tombol **Reload extension** di halaman Options (memanggil `chrome.runtime.reload()` setelah
folder unpacked diperbarui). Aturan, pola judul, dan UI content script: semuanya lewat pack di atas.

## Keamanan

- Public key di-rename/rotasi dengan `npm run keygen -- --force` lalu ganti konstanta `PUBLIC_KEY_JWK` di
  `src/shared/updater.js` (rilis berikutnya; kunci lama berhenti valid).
- Signature memakai `crypto.subtle` yang hanya tersedia di secure context, jadi verifikasi sengaja dilakukan di
  service worker, bukan di content script.
- Batas ketat: 400 host, 40 ekstensi, 400 kata, 4 KB pola, 120 KB kode; string di-sanitasi (huruf non
  alfanumerik dibuang) sebelum dipakai.
- `web-ext lint` menandai satu `DANGEROUS_EVAL` di `updater.js` (yaitu `new Function` untuk code patch).
  Kalau nanti maupublish ke AMO, tulis di form review: aktif secara default **off**, butuh tanda tangan, dan
  dieksekusi di isolated world content script.

## Mematikan

Options, tab Updates: hilangkan centang "Ambil rule pack otomatis". Tidak ada request keluar sama sekali
(dites di `tools/test/updater.test.mjs`: `disabled switch short-circuits everything`).

## Workflow CI

File `ci/github-actions-build.yml` sudah punya step "Publish live rule pack". Agent tidak punya izin menulis ke
`.github/workflows`, jadi aktifkan dengan:

```bash
mkdir -p .github/workflows
git mv ci/github-actions-build.yml .github/workflows/build.yml
git add -A && git commit -m "ci: build, test, publish live rule pack" && git push
```
