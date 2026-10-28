# MCP Gateway

Satu endpoint MCP yang menggabungkan banyak MCP server (stdio, HTTP, SSE). Agen cukup tersambung ke gateway, dan gateway meneruskan panggilan ke backend yang sesuai.

Fitur utama:

- **Satu endpoint, banyak backend.** Tool diberi awalan nama server: `github__search_issues`, `vercel__get_deployment`.
- **Hemat konteks.** Backend bermode *lazy* disembunyikan dari daftar tool dan diakses lewat tiga meta-tool pencarian.
- **Profil.** `/mcp/<profil>` hanya menampilkan sebagian server.
- **OAuth ke backend.** Backend seperti Vercel cukup diberi `"auth": { "type": "oauth" }`. Login sekali, token disimpan dan di-refresh otomatis.
- **OAuth dari agen.** Gateway sendiri adalah authorization server OAuth 2.1, jadi agen/klien MCP bisa tersambung dengan login password, tanpa token statis.
- **Reconnect otomatis** dengan backoff dan cache daftar tool.

## Daftar isi

1. [Prasyarat dan instalasi](#prasyarat-dan-instalasi)
2. [Menjalankan](#menjalankan)
3. [Menyambungkan agen](#menyambungkan-agen)
4. [Referensi konfigurasi (schema)](#referensi-konfigurasi-schema)
5. [Mode expose: full, lazy, auto](#mode-expose-full-lazy-auto)
6. [Profil](#profil)
7. [OAuth](#oauth)
8. [Endpoint HTTP](#endpoint-http)
9. [Menjalankan di produksi](#menjalankan-di-produksi)
10. [Keamanan](#keamanan)
11. [Pemecahan masalah](#pemecahan-masalah)
12. [Batasan](#batasan)

---

## Prasyarat dan instalasi

- Node.js 18 atau lebih baru (diuji di Node 22).
- Paket `@modelcontextprotocol/sdk` versi 1.x.

```bash
mkdir mcp-gateway && cd mcp-gateway
# letakkan gateway.mjs di sini
npm init -y
npm i @modelcontextprotocol/sdk@^1
```

Ekstensi `.mjs` membuat Node memperlakukannya sebagai ES module, jadi `package.json` tidak perlu diubah.

## Menjalankan

1. Salin contoh konfigurasi dan sesuaikan:

   ```bash
   cp gateway.example.json gateway.json
   ```

2. Atur variabel lingkungan yang dirujuk konfigurasi (`${NAMA}`):

   ```bash
   export GATEWAY_TOKEN="$(openssl rand -hex 32)"      # token statis untuk skrip/curl
   export GATEWAY_PASSWORD="password-login-oauth-anda"  # password halaman persetujuan OAuth
   ```

3. Jalankan:

   ```bash
   node gateway.mjs                      # memakai ./gateway.json
   node gateway.mjs -c /path/conf.json   # konfigurasi lain
   ```

Contoh log saat start:

```
INFO gateway di http://0.0.0.0:8000/mcp
INFO profil: http://0.0.0.0:8000/mcp/dev -> github, vercel, deepwiki
INFO OAuth gateway aktif. Issuer diterima untuk: https://gw.example.com, http://localhost:8000, http://127.0.0.1:8000
INFO OAuth redirect URI: http://localhost:8000/oauth/callback  (token disimpan di /.../tokens.json)
INFO backend 'deepwiki' terhubung
```

Tes cepat:

```bash
curl -s localhost:8000/health
curl -s -X POST localhost:8000/mcp \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Gateway membuat dua file di folder yang sama dengan file konfigurasi: `tokens.json` (token OAuth ke backend) dan `oauth-server.json` (client dan token agen, dalam bentuk hash). Keduanya berizin `0600`. **Jangan di-commit.**

```
# .gitignore
gateway.json
tokens.json
oauth-server.json
```

## Menyambungkan agen

Ada dua cara autentikasi ke `/mcp`. Keduanya bisa aktif bersamaan.

**A. Token statis** (skrip, curl, klien yang mendukung header kustom):

```
Authorization: Bearer <GATEWAY_TOKEN>
```

**B. OAuth** (klien MCP yang mendukung OAuth, seperti connector kustom di Claude): masukkan URL `https://gw.example.com/mcp` atau `https://gw.example.com/mcp/dev`. Klien akan:

1. mendapat 401 beserta alamat metadata,
2. mendaftarkan dirinya otomatis (Dynamic Client Registration),
3. membuka browser ke halaman persetujuan gateway,
4. setelah Anda memasukkan password dan menekan **Izinkan**, menukar code dengan token.

Kalau `auth_token` dan `oauth` sama-sama tidak diisi, `/mcp` terbuka tanpa autentikasi. Jangan dilakukan di jaringan yang tidak tepercaya.

---

## Referensi konfigurasi (schema)

Nilai string mendukung `${NAMA_ENV}`. Variabel yang tidak ada diganti string kosong.

### Tingkat atas

| Kunci | Tipe | Default | Keterangan |
|---|---|---|---|
| `server` | objek | `{}` | Pengaturan gateway, lihat di bawah. |
| `separator` | string | `"__"` | Pemisah nama server dan tool: `<server><separator><tool>`. |
| `servers` | objek | `{}` | Backend. Kunci = nama server. |
| `profiles` | objek | `{}` | Nama profil -> array nama server. |
| `compact` | objek | tidak ada | Pemadatan opsional. Ada blok ini = aktif. |

### `server`

| Kunci | Tipe | Default | Keterangan |
|---|---|---|---|
| `name` | string | `"mcp-gateway"` | Nama server MCP yang dilihat agen. |
| `host` | string | `"0.0.0.0"` | Alamat bind. |
| `port` | angka | `8000` | Port. |
| `public_url` | string | `http://localhost:<port>` | URL yang dilihat agen. Menjadi *issuer* OAuth gateway. Wajib HTTPS untuk akses remote. |
| `extra_public_urls` | array string | `[]` | Alamat tambahan yang boleh menjadi issuer, misalnya IP LAN. `localhost` dan `127.0.0.1` pada port gateway otomatis diizinkan. |
| `backend_redirect_url` | string | `<public_url>/oauth/callback` | Redirect URI untuk login **ke backend** (mis. Vercel). Harus berakhiran `/oauth/callback`. |
| `trust_proxy` | boolean | `false` | Percayai `X-Forwarded-For` / `X-Forwarded-Host` dari reverse proxy. |
| `auth_token` | string | tidak ada | Token statis untuk `/mcp` dan `/health` terperinci. Juga menjadi password OAuth bila `oauth.password` kosong. |
| `oauth` | objek | tidak ada | Mengaktifkan OAuth agen -> gateway. Lihat tabel berikutnya. |
| `token_store` | string | `tokens.json` | File token OAuth ke backend, relatif terhadap file konfigurasi. |
| `call_timeout` | angka (detik) | `60` | Batas waktu satu panggilan tool. |
| `lazy_threshold` | angka | `40` | Untuk `expose: "auto"`: server dengan tool lebih dari ini menjadi lazy. |
| `tools_cache_ttl` | angka (detik) | `60` | Lama cache daftar tool backend. Dibatalkan otomatis saat backend putus atau mengirim `list_changed`. |

### `server.oauth`

| Kunci | Tipe | Default | Keterangan |
|---|---|---|---|
| `enabled` | boolean | `true` | Set `false` untuk menonaktifkan sementara. |
| `password` | string | `server.auth_token` | Password di halaman persetujuan. Gateway menolak start bila keduanya kosong. |
| `access_ttl` | angka (detik) | `3600` | Umur access token. |
| `refresh_ttl` | angka (detik) | `2592000` (30 hari) | Umur refresh token. |
| `store` | string | `oauth-server.json` | File penyimpanan client dan token agen. |

### `servers.<nama>`

| Kunci | Tipe | Berlaku untuk | Keterangan |
|---|---|---|---|
| `type` | `"http"` \| `"sse"` \| `"stdio"` | semua | Default `"http"` (Streamable HTTP). |
| `url` | string | http, sse | Alamat server MCP. |
| `headers` | objek | http, sse | Header tambahan di tiap request, mis. `Authorization`. |
| `command` | string | stdio | Perintah yang dijalankan. |
| `args` | array string | stdio | Argumen perintah. |
| `env` | objek | stdio | Variabel lingkungan tambahan (digabung dengan env gateway). |
| `enabled` | boolean | semua | `false` = dilewati. Default `true`. |
| `expose` | `"full"` \| `"lazy"` \| `"auto"` | semua | Lihat [Mode expose](#mode-expose-full-lazy-auto). Default `"auto"`. |
| `allow_tools` | array glob | semua | Bila diisi, hanya tool yang cocok yang ditampilkan dan bisa dipanggil. |
| `deny_tools` | array glob | semua | Tool yang cocok disembunyikan dan ditolak. Dicek setelah `allow_tools`. |
| `auth` | objek | http, sse | OAuth ke backend. Lihat tabel berikutnya. |

Pola glob memakai `*` untuk "sembarang karakter", dan dicocokkan dengan nama tool **tanpa** awalan server.

### `servers.<nama>.auth`

| Kunci | Tipe | Keterangan |
|---|---|---|
| `type` | `"oauth"` | Wajib. Mengaktifkan OAuth ke backend. |
| `client_name` | string | Nama client saat registrasi dinamis. Default `"MCP Gateway"`. |
| `client_id` | string | Pakai client yang sudah ada, bukan registrasi dinamis. |
| `client_secret` | string | Bersama `client_id`, bila backend butuh confidential client. |
| `scope` | string | Scope yang diminta. |

### `compact`

| Kunci | Tipe | Default | Keterangan |
|---|---|---|---|
| `max_description` | angka | `0` | Batas panjang deskripsi tool. `0` atau tidak diisi = **tidak dipotong**. |
| `strip_param_descriptions` | boolean | `false` | Hapus deskripsi tiap parameter di schema. |
| `strip_output_schema` | boolean | `true` | Hapus `outputSchema` dari tool yang tampil penuh. |

Kalau Anda tidak ingin pemadatan sama sekali, hapus seluruh blok `compact`. `describe_tool` selalu mengembalikan schema lengkap.

---

## Mode expose: full, lazy, auto

Daftar tool dikirim ke model di setiap percakapan, jadi ratusan tool memakan banyak konteks.

- **`full`**: semua tool server tampil di `tools/list` dengan nama `<server>__<tool>`.
- **`lazy`**: tool server **tidak** tampil. Agen memakai tiga meta-tool (hanya muncul bila ada server lazy):
  1. `gateway__search_tools` mencari tool berdasarkan kata kunci (parameter `query`, `server`, `limit`).
  2. `gateway__describe_tool` mengambil schema lengkap satu tool.
  3. `gateway__call_tool` menjalankan tool (`name` = nama lengkap, `arguments` = objek).
- **`auto`** (default): `full` bila jumlah tool server tidak lebih dari `lazy_threshold`, selain itu `lazy`.

`gateway__status` selalu tersedia: menampilkan status tiap backend (jumlah tool, mode) dan URL login OAuth bila ada yang perlu login.

Memanggil tool tersembunyi langsung dengan nama lengkapnya (mis. `vercel__get_deployment_logs`) tetap berfungsi. Sebagian klien menampilkan peringatan "not listed by server", yang tidak berbahaya.

## Profil

Profil membatasi server yang terlihat di satu endpoint:

```json
"profiles": {
  "dev": ["github", "vercel"],
  "browse": ["playwright"]
}
```

- `/mcp` -> semua server
- `/mcp/dev` -> hanya `github` dan `vercel`
- `/mcp/browse` -> hanya `playwright`

Nama profil hanya boleh berisi `A-Z a-z 0-9 _ . -`. Profil yang menyebut server yang tidak ada akan menghasilkan peringatan di log. Token OAuth/statis berlaku untuk semua profil (tidak dibatasi per profil).

---

## OAuth

Ada **dua arah** OAuth yang berbeda. Jangan tertukar.

```
Agen --(OAuth A)--> Gateway --(OAuth B)--> Backend (mis. Vercel)
```

### A. Agen ke gateway (gateway = authorization server)

Aktif bila `server.oauth` ada. Standar yang diimplementasikan: OAuth 2.1, PKCE S256 (wajib), Dynamic Client Registration (RFC 7591), metadata RFC 8414 dan RFC 9728, revoke RFC 7009.

Konfigurasi minimal:

```json
"server": {
  "public_url": "https://gw.example.com",
  "oauth": { "password": "${GATEWAY_PASSWORD}" }
}
```

Perilaku penting:

- **Issuer mengikuti host yang dipakai klien** (RFC 8414 §3.3 mewajibkan issuer sama dengan alamat tempat metadata diambil). Host yang diterima: `public_url`, `localhost` dan `127.0.0.1` pada port gateway, serta `extra_public_urls`. Host lain jatuh ke `public_url`.
- Authorization code sekali pakai dan berlaku 5 menit.
- Refresh token berputar: yang lama hangus setelah dipakai.
- 5 password salah dari satu IP mengunci login selama 15 menit.
- Access dan refresh token disimpan sebagai hash SHA-256, dan tetap valid setelah gateway di-restart.
- Pilih **satu alamat per connector** (localhost atau domain). Client ID dan token terikat pada issuer.

### B. Gateway ke backend (gateway = OAuth client)

Untuk backend yang butuh login (mis. `https://mcp.vercel.com`), tambahkan `"auth": { "type": "oauth" }`.

1. Saat start, backend membalas 401. Gateway melakukan discovery, mendaftarkan client, dan membuat URL login.
2. URL login dicetak di log, dan juga tersedia di tool `gateway__status` dan di `/health` (field `auth_urls`, hanya untuk pemegang token gateway).
3. Buka URL itu di browser, login, lalu klik Allow.
4. Browser diarahkan ke `backend_redirect_url` (`.../oauth/callback`). Gateway menukar code menjadi token, menyimpannya di `tokens.json`, lalu menyambung ulang.
5. Setelah itu token di-refresh otomatis. Login ulang hanya perlu bila refresh token dicabut.

Catatan:

- Token agen **tidak pernah** diteruskan ke backend.
- Browser yang dipakai login harus bisa membuka `backend_redirect_url`. Bila itu `http://localhost:8000/...`, browsernya harus di komputer yang sama dengan gateway, atau gunakan port-forward: `ssh -L 8000:localhost:8000 <server>`.
- **Vercel MCP hanya menerima redirect URI dari klien yang disetujui Vercel.** Redirect `http://localhost:...` diterima (sudah dicoba), sedangkan domain publik biasanya ditolak dengan `invalid_redirect_uri`. Karena itu `backend_redirect_url` dipisah dari `public_url`.
- Bila redirect URI berubah, registrasi lama dianggap tidak valid dan gateway mendaftar ulang otomatis.

---

## Endpoint HTTP

| Endpoint | Metode | Autentikasi | Keterangan |
|---|---|---|---|
| `/mcp` | POST | Bearer | Semua server. |
| `/mcp/<profil>` | POST | Bearer | Server dalam profil. |
| `/health` | GET | tidak | Status backend. Field `auth_urls` hanya tampil bila ada Bearer yang valid. |
| `/oauth/callback` | GET | `state` acak | Tujuan redirect login backend. |
| `/.well-known/oauth-protected-resource[/mcp[/<profil>]]` | GET | tidak | Metadata resource (RFC 9728). |
| `/.well-known/oauth-authorization-server` | GET | tidak | Metadata authorization server (RFC 8414). |
| `/register` | POST | tidak | Dynamic Client Registration. |
| `/authorize` | GET, POST | password | Halaman persetujuan. |
| `/token` | POST | client | `authorization_code` dan `refresh_token`. |
| `/revoke` | POST | client | Cabut token. |

Endpoint OAuth (empat baris terakhir dan `.well-known`) hanya ada bila `server.oauth` aktif. Gateway berjalan **stateless**: hanya `POST` yang dipakai di `/mcp`, sedangkan `GET` dan `DELETE` dibalas 405.

---

## Menjalankan di produksi

### Reverse proxy / tunnel

Letakkan gateway di belakang HTTPS (Caddy, nginx, Cloudflare Tunnel, dsb.), lalu:

- isi `public_url` dengan alamat HTTPS publik,
- set `trust_proxy: true` bila proxy menambahkan `X-Forwarded-For` / `X-Forwarded-Host`,
- teruskan header `Host` asli ke gateway (jangan menimpanya).

Contoh Caddy:

```
gw.example.com {
  reverse_proxy localhost:8000
}
```

### systemd

```ini
# /etc/systemd/system/mcp-gateway.service
[Unit]
Description=MCP Gateway
After=network-online.target

[Service]
WorkingDirectory=/opt/mcp-gateway
EnvironmentFile=/etc/mcp-gateway.env
ExecStart=/usr/bin/node gateway.mjs -c /opt/mcp-gateway/gateway.json
Restart=on-failure
User=mcp

[Install]
WantedBy=multi-user.target
```

`/etc/mcp-gateway.env` (izin `0600`):

```
GATEWAY_TOKEN=...
GATEWAY_PASSWORD=...
GITHUB_TOKEN=...
```

```bash
sudo systemctl enable --now mcp-gateway
journalctl -u mcp-gateway -f
```

---

## Keamanan

- Selalu isi `auth_token` dan/atau `oauth` bila gateway dapat diakses dari luar mesin Anda.
- Gunakan password yang kuat. Halaman persetujuan dibatasi 5 percobaan per IP, tetapi itu bukan pengganti password yang baik.
- Gunakan HTTPS untuk akses remote. Token dan password lewat jaringan.
- `tokens.json` dan `oauth-server.json` berisi kredensial. Jaga izin `0600` dan jangan di-commit.
- Gunakan `allow_tools` / `deny_tools` untuk membatasi tool berbahaya (tulis, hapus, eksekusi) pada backend yang tidak sepenuhnya Anda percayai.
- `redirect_uri` klien OAuth dicocokkan persis, dan skema berbahaya (`javascript:`, `data:`, dll.) ditolak saat registrasi.
- Host header hanya diterima bila ada di daftar issuer yang diizinkan, sehingga tidak bisa dipakai untuk menyuntikkan issuer palsu.

## Pemecahan masalah

| Gejala | Penyebab dan solusi |
|---|---|
| `issuer mismatch in authorization server metadata` | Klien mengakses lewat alamat yang tidak ada di daftar issuer. Tambahkan ke `extra_public_urls`, atau gunakan alamat yang sama dengan `public_url`. Hapus connector lama lalu tambahkan ulang. |
| Vercel: `The provided redirect URIs are not approved...` | Vercel MCP memakai allowlist klien. Set `backend_redirect_url` ke `http://localhost:<port>/oauth/callback`. Untuk domain publik, Vercel harus menyetujui redirect URI Anda (formulir review di dokumentasi Vercel MCP). |
| Login backend selesai tetapi tidak tersambung | Pastikan browser bisa membuka `backend_redirect_url`. Untuk localhost, gunakan komputer yang sama atau port-forward. |
| `server.oauth aktif tetapi tidak ada password` | Isi `server.oauth.password` atau `server.auth_token`. |
| `backend '...' error: fetch failed` | Server backend tidak berjalan atau alamatnya salah. Jalankan servernya atau set `"enabled": false`. |
| Gateway terus retry ke backend yang menolak | Backoff naik 1, 2, 4, ... hingga 30 detik. Set `"enabled": false` selama masalahnya belum selesai. |
| Login OAuth terkunci (429) | 5 password salah dari satu IP. Tunggu 15 menit. Di belakang proxy, set `trust_proxy: true` agar yang dikunci adalah IP asli, bukan IP proxy. |
| `401 invalid_token` setelah lama | Access token kedaluwarsa dan refresh tidak berjalan. Hapus lalu tambahkan ulang connector di agen. |
| Perubahan konfigurasi tidak terbaca | Konfigurasi dibaca saat start. Restart gateway. |

## Batasan

- Satu pengguna: satu password, tanpa akun atau scope per agen.
- Token tidak dibatasi per profil: token yang sah dapat mengakses `/mcp` maupun `/mcp/<profil>` mana pun.
- Tidak ada deteksi pemakaian ulang refresh token lama.
- Mode stateless: tidak ada stream server-ke-klien, sehingga notifikasi dari backend tidak diteruskan ke agen.
- Konfigurasi tidak di-reload otomatis.
