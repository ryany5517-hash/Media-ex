# Integrasi pihak ketiga

## WatchParty.me (PART 3)

**Kenapa lewat WatchParty, bukan player sendiri?** Permintaan aslinya: *“Do NOT build your own video player or
website.”* WatchParty (open source: https://github.com/howardchung/watchparty) sudah mendukung *direct video URLs*
**dan HLS `.m3u8`** di dalam room-nya, sinkron play/pause/seek, chat, dan voice. Jadi kami cuma otomasi.

Yang kami kirim:

```
https://www.watchparty.me/watchNow?url=<media-url>&name=<judul bersih>
```

Lalu content script `src/watchparty/watchparty.js` + inti `src/shared/watchparty-auto.js` mengisi form
**Room name** / **User name**, optionally menekan *Join*, dan menyuntik `<track>` WebVTT ke `<video>` room
(re-attach tiap React re-render). Payload hand-off: `srad:party:<tabId>` di storage, TTL 6 menit, dihapus
setelah dipakai → tidak ada data yang numpuk.

Kenapa DOM automation, bukan API? WatchParty tidak punya REST untuk create-room (yang ada: Discord bot
`/watch video <url>` yang juga cuma ngarahin ke `watchNow?url=`). Matching field kami **semantik** (label /
placeholder / aria-label / name / id), bukan selector CSS, supaya tahan redesign. Kalau tetap meleset,
sisa alurnya (URL media + subtitle + copy) tetap jalan manual.

Keterbatasan yang kami deteksi dan kabari:
- URL `.mpd` (DASH) atau segmen `.m4s` tidak bisa diputar WatchParty → toast “open the .mp4 / .m3u8 variant instead”.
- `blob:` (MSE) tidak mungkin dibagikan → tombol Watch Party menolak dengan alasan, bukan gagal diam-diam.

## SubDL (PART 4, prioritas)

`GET https://api.subdl.com/api/v1/subtitles` + `GET /download` (lihat docs/API-KEYS.md). Peringkat: exact title,
tahun, `season/episode`, format `srt`, verified, jumlah download; bahasa Indonesia diberi bonus besar.

## OpenSubtitles REST v1

`GET /api/v1/subtitles` → `POST /api/v1/download` → link zip/gz. Perlu `Authorization: ApiKey` **dan**
`User-Agent` yang terdaftar.

## YIFY Subtitles

Tanpa key, `…/chrome-api?q=<imdb-id|judul>`; dipakai terakhir dan kegagalan di-*swallow* (dilaporkan di panel,
tidak melempar error). Coba 3 mirror sebelum nyerah.

## Konversi & unpack (tanpa dependency)

- SRT → **WebVTT**: normalisasi `00:00:01,000` → `.000`, buang nomor cue, `<font>` → `<c>`, `\N` → baris baru.
- `.gz` → `DecompressionStream('gzip')`; `.zip` → reader ZIP manual (central directory + `deflate-raw`).
  Ini kenapa tidak ada JSZip di repo.
- Encoding: UTF-8 (deteksi BOM), fallback `windows-1252` / `windows-1250` biar subtitle lama tidak mojibake.

## Yang secara sadar TIDAK kami bikin

- Player/video overlay sendiri (permintaan eksplisit: jangan).
- Server proxy/ungsite sendiri: tidak ada backend, jadi tidak ada yang bisa mati atau bocor.
- Decrypter Widevine/FairPlay: tidak legal dan tidak kami sentuh.
