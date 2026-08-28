# API key & penyedia subtitle

Stream Radar **tidak** mengumpulkan data kamu; key disimpan di `chrome.storage.local` browser kamu saja.

## 1. SubDL — direkomendasi (subtitle Indonesia paling lengkap)

1. Daftar gratis di https://subdl.com → *Account* → *API* (atau https://subdl.com/panel/api)
2. Copy key-nya → tempel di **Options → Subtitles & API keys → SubDL API key**
3. Provider “SubDL” aktifkan (checkbox)

Request yang dipakai:

```
GET https://api.subdl.com/api/v1/subtitles?api_key=…&query=<judul>&year=<tahun>&formats=srt&lang=id
GET https://api.subdl.com/api/v1/subtitles/download?api_key=…&id=<id>   → { results.attributes.link }
```

File hasilnya `.zip`; Stream Radar membuka zip-nya sendiri (`DecompressionStream`, tanpa library).

## 2. OpenSubtitles REST v1 — gratis, tapi perlu approval User-Agent

1. https://www.opensubtitles.com/en/api-keys → *Create new application*
2. Isi **User-Agent** yang sama persis dengan kolom “OpenSubtitles User-Agent” di Options
   (default: `StreamRadar/1.0 (media detector extension)`); mereka binding key ↔ UA
3. Paste key → auto prefix `ApiKey ` boleh dikosongkan (kami tambahin)

```
GET  https://api.opensubtitles.com/api/v1/subtitles?query=…&language_id=id&format=srt
     headers: Authorization: ApiKey <key>, User-Agent: <ua>
POST https://api.opensubtitles.com/api/v1/download   body: { files: [{ file_id }] } → { link }
```

Link download berlaku ±10 menit dan berupa `.zip`/`.gz`.

## 3. YIFY Subtitles — tanpa key, sering offline

Diaktifkan sebagai fallback. Endpoint publiknya (`/chrome-api?q=`) hilang-timbul; kalau gagal, panel cuma
menampilkan “YIFY: unreachable” dan pencarian tetap sukses dari provider lain. Tidak ada yang perlu diatur.

## 4. Tanpa key sama sekali?

Bisa: semua layer deteksi + copy/download/WatchParty tetap jalan. Panel subtitle menampilkan
“Add an API key in Settings” (status `skipped`) alih-alih error. Untuk kasus ini:
- tombol **Copy URL** → tempel ke mpv/VLC (`mpv --sub-file=id.srt <url>`);
- atau download playlist `.m3u8` + `.vtt` manual.

## 5. Testing manual

Options → **Subtitles & API keys → Test the search** → isi judul/tahun/episode → *Search now*.
Output menampilkan status tiap provider + skor ranking, jadi kamu tahu apakah masalahnya key, network, atau
match judul.

## 6. Keamanan key

- Key dikirim hanya ke domain-nya sendiri (`@connect`/`host_permissions`).
- Tidak pernah ditulis ke log, tidak ikut di-`Export settings` kalau kamu hapus centang? (catatan: export
  mencantumkan key karena praktis untuk backup — simpan file-nya baik-baik.)
- Rate limit: pencarian di-debounce 1.8 dtk per tab dan di-cache 10 menit per judul (`st.sub.at`).
