# Implementation Plan

Zero-config startup: `mcp-gateway` dengan konfigurasi tidak ada lagi langsung membuat
konfigurasinya sendiri, menampilkan URL yang bisa dihubungi ala Vite, dan menerima override
runtime lewat flag.

Ringkas: resolution order yang ada **tidak berubah** — hanya diberi satu cabang baru di
akhirnya, yaitu "tidak ketemu → buat". Auto-create itu hanya menyalin broker yang sudah
dibuktikan bekerja; ia tidak mengubah apa pun yang sudah ada. Startup banner memakai
`os.networkInterfaces()`, sehingga daftar URL yang dicetak benar-benar berasal dari
interface mesin ini, bukan daftar statis. Tiga flag runtime (`--hostname`, `--port`,
`--public-url`) bekerja sebagai override **per-proses** dan tidak pernah ditulis ke file
konfigurasi — mengikuti preseden `-c`, yang sudah bersifat otoritatif dan tidak
menyentuh disk.

---

## [Types]

### `src/config/schema.ts` — melepas penjaga, menambah mode terbuka

`gatewayGuarded` saat ini menolak `auth.keys: []` + tanpa `authOAuth`. Permintaan human:
API key jadi opsional, dengan peringatan saat runtime. Konsekuensinya harus disadari:
`createBearerAuth([])` di `src/server/auth.ts:42` **bukan** "terbuka" melainkan "tolak
semua" — `digests` kosong, loop tidak jalan, `foundIndex` tetap `-1`, jadi setiap request
balas `invalid`. Melepas `superRefine` tanpa tambahan akan menghasilkan gateway yang
mematikan diri sendiri, bukan gateway terbuka. Maka butuh state ketiga yang eksplisit:

```ts
export type InboundAuthMode = 'bearer' | 'open';

export interface AuthDecision {
  mode: InboundAuthMode;
  /** True when /mcp accepts any caller. Drives the startup warning and the banner. */
  unprotected: boolean;
  /** Only for reporting; never a key value. */
  keyCount: number;
}
```

Fungsi baru:

```ts
// src/config/schema.ts
export function resolveInboundAuth(value: {
  auth: { keys: string[] };
  authOAuth?: unknown;
}): AuthDecision;
```

Semantik: `authOAuth` ada → `bearer` (JWT jalur lain masih hidup, key statis boleh kosong).
`auth.keys` non-kosong → `bearer`. Selain itu → `open`, **tapi hanya pada bind loopback**.

### Supervisor baru — `open` hanya sah di loopback (SUDAH PUTUSAN HUMAN)

Human memutuskan: **`--hostname` tanpa API key ditolak**, dengan penjelasan error.
Jadi `gatewayGuarded` tidak simply dihapus — ia **diganti** dengan supervisor yang
kondisinya dibalik. `open` hanya boleh pada loopback:

| `host` | `auth.keys` | Hasil |
|---|---|---|
| loopback (`127.0.0.1`, `::1`, `localhost`) | kosong | **`open`** — jalan + peringatan keras |
| `0.0.0.0` / `::` / LAN IP / hostname | kosong | **DITOLAK**, exit 1, pesan menjelaskan |
| apa pun | ada | `bearer`, normal |

Penolakan terjadi **sebelum** `app.listen`, jadi tidak pernah ada jendela di mana gateway
terbuka di jaringan — itu yang membedakannya dari sekadar "warning" yang bisa terlewat.

Supervisor baru ini juga harus membaca **host setelah flag override diterapkan**, bukan
`config.gateway.host` mentah. Kalau tidak, `mcp-gateway --hostname 0.0.0.0` dengan config
yang tidak punya key akan lolos validasi lalu terbuka di LAN. Urutan di `startGateway`
karena itu: `loadConfig` → `applyOverrides` → supervisor → `listen`.

Bentuk pesannya, supaya menyebut jalan keluarnya:

```
gateway.auth.keys is empty and gateway.host is "0.0.0.0", which would expose POST /mcp to
every host that can reach this port.
Choose one:
  - bind to loopback:  --hostname 127.0.0.1   (an unauthenticated gateway is then allowed)
  - or set an inbound credential:  gateway.auth.keys: ["..."]  (or gateway.authOAuth)
```

Nama **flag** dan **key path** muncul; nilai apa pun tidak pernah. Dan karena supervisor
sekarang hanya menolak kasus yang **berbahaya**, ia tidak lagi menolak kombinasi
`keys: []` + `authOAuth` — itu sah dan sudah didukung ADR 0009.

### `src/config/auth-mode.ts` — mode terbuka, konsekuensi eksplisit

`AuthDecision` adalah data; Putuskan di mana konsekuensinya hidup. Modul baru ini
mengumpulkan **satu** keputusan supaya tidak ada tempat lain yang menebak-nebak apakah
`/mcp` terbuka:

```ts
export interface UnprotectedGateway {
  readonly: true;
  /** One-line reason, safe to print. Names the key path, never a value. */
  reason: string;
}

export function describeUnprotected(config: GatewayConfig): UnprotectedGateway | undefined;
```

`src/server/http.ts` memakai hasilnya untuk dua hal: melewati `createBearerAuth`, dan
menambah field `authMode` ke `/status` supaya kondisi "terbuka" terlihat dari luar, bukan
hanya dari banner startup yang sekali lalu hilang.

### Banner — tipe baru

```ts
// src/server/banner.ts
export type EndpointKind = 'local' | 'network' | 'public' | 'tunnel';

export interface Endpoint {
  kind: EndpointKind;
  /** Rendered form, e.g. "http://192.168.1.7:3000/mcp". IPv6 hosts are bracketed. */
  url: string;
  /** Interface name from os.networkInterfaces(). Empty for loopback/publicUrl. */
  iface?: string;
}

export interface BannerInput {
  host: string;          // the effective bind host, after flag overrides
  port: number;          // the ACTUAL bound port, not config.gateway.port
  publicUrl?: string;    // gateway.publicUrl, after flag overrides
  endpoints: readonly Endpoint[];
  upstreamCount: number;
  protectedGateway: boolean;
  /** True when this run created a config that did not exist. */
  configCreatedAt?: string;
  /** Absolute path of the resolved config. */
  configPath: string;
}

export function renderBanner(input: BannerInput): string;
```

`renderBanner` adalah fungsi murni — string masuk, string keluar. Tidak ada I/O, tidak ada
`process`, tidak ada jam. Itu yang membuatnya bisa diuji tanpa spawn apa pun.

### Override runtime

```ts
// src/cli.ts
export interface ServeFlags {
  configPath?: string;
  hostname?: string;
  port?: number;
  publicUrl?: string;
}

export interface ServeOutcome extends CliOutcome {
  serve?: boolean;
  flags?: ServeFlags;
}
```

### Parsing flag — bentuk yang perlu ditangani

`parseConfigFlag` saat ini menolak apa pun yang bukan `-c`/`--config` dengan
`unexpected argument: X`. Ia harus 소개排放 `parseServeFlags` yang menerima
`--hostname H`, `--hostname=H`, `--port P`, `--port=P`, `--public-url U`,
`--public-url=U`, dan mengabaikan `--` agar argumen setelahnya tidak diparsing.
`--port` harus integer 1–65535 dan gagal dengan `EXIT_USAGE`, bukan diam-diam jatuh ke
default. Nilai kosong ditolak dengan pesan yang menyebut flag-nya, mengikuti gaya
`parseConfigFlag` yang sudah ada.

---

## [Files]

### Baru: `src/config/auth-mode.ts`

Menjawab "apakah `/mcp` terbuka?" dalam satu tempat. Berisi
`describeUnprotected(config)`, tipe `UnprotectedGateway`, dan
`AUTH_OPEN_WARNING` — kalimat peringatan yang sama dipakai di startup banner, di log
`warn`, dan di `/status`, supaya tidak ada tiga versi pesan yang berbedaPjedi.

Menjadi salah satu-satunya tempat yang tahu bahwa mode terbuka adalah kondisi yang
dilarang-tapi-diperbolehkan. Eksplisit di sini; di tempat lain hanya dipanggil.

### Baru: `src/server/banner.ts`

Berisi `Endpoint`, `BannerKind`, `collectEndpoints()`, dan `renderBanner()`.
`collectEndpoints()` adalah satu-satunya fungsi yang menyentuh
`os.networkInterfaces()` — যাত test dapat meng-inject daftar interface dan tidak
pernah bergantung pada interface mesin CI.

Aturan pemilihan alamat,的理由nya harus ditulis di kode:

- Buang `internal === true` (loopback) dari daftar jaringan — loopback sudah dicetak
  sendiri sebagai `local`.
- Hanya IPv4 dan IPv6; abaikan `family` bernilai angka (`4`/`6` pada Node lama) **dan**
  string — bentuk keduanya masih muncul di versi Node berbeda.
- Abaikan alamat IPv6 yang berawalan `fe80` (link-local) dan yang mengandung `%` (scope
  id). `http://[fe80::1%3]:3000/mcp` tidak bisa dipakai klien dan hanya menambah noise;
  tapi ini **tidak** dibuang diam-diam — lihat catatan di bawah.
- Dedupe per alamat, karena beberapa interface bisa melaporkan IP yang sama.
- Quando `host` adalah `0.0.0.0` atau `::`, banner mencetak `local` sebagai
  `http://localhost:<port>/mcp` **bukan** `http://0.0.0.0:<port>/mcp`. Alasan yang sama
  sudah dipakai di `src/auth/oauth-client/service.ts:73`; mengulangnya di sini
 ogie menjaga dua tempat konsisten.
- IPv6 di URL dibungkus `[` `]` — tanpa itu URL-nya tidak valid dan `curl` menolaknya.

### Baru: `src/cli/serve-flags.ts`

_MEMBATAS_: nama file `serve-flags.ts`, bukan `src/cli/serve-flags.ts`, karena `src/cli.ts`
sudah ada sebagai entry point dan `src/cli/` akan cohabit dengan file yang/module berbeda
dan membingungkan. Taruh sebagai `src/serve-flags.ts`.

Berisi `parseServeFlags(argv)` dan `applyOverrides(config, flags)`. `applyOverrides`
mengembalikan **objek config baru** dengan `gateway.host`, `gateway.port`,
`gateway.publicUrl` ditimpa; objek asli tidak dimutasi, karena `ConfigReloader`
menyimpan konfigurasi yang sama dan mutasi diam-diam akan membuatnya terlihat berubah
saat file ditulis ulang.

Override berlaku untuk **proses ini saja** dan tidak pernah ditulis ke disk. Kalau
`--public-url` ikut ditulis ke file, setiap tunel akan menimpa `publicUrl` milik user dan
menggateway-nya memakai `publicUrl` yang salah saat dijalankan ulang tanpa flag.

### Baru: `test/unit/banner.test.ts`

Lihat bagian [Testing].

### Baru: `test/unit/serve-flags.test.ts`

Lihat bagian [Testing].

### Ubah: `src/config/schema.ts`

1. **Lepas** `gatewayGuarded` dan gunakannnn `gatewayWithAuth` langsung di
   `gatewayConfigSchema`. `superRefine` itu yang menolak `keys: []`; selama masih ada,
   "API key opsional" tidak akan pernah bisa dipakai.
2. **Hapus** import/tipe yang jadi tak terpakai setelah itu (`AuthDecision` baru自己去
   import type dari `auth-mode.ts`).
3. `gateway.auth.keys` tetap `z.array(z.string().min(1))` — array-nya boleh kosong,
   elemennya tetap tidak boleh string kosong.
4. **Jangan** menambahkan `authMode` ke schema. Ini keputusan runtime, bukan field yang
   ditulis user; field config yang berasal dari flag akan想知道 cara validating-nya,
   dan tidak ada yang perlu divalidasi.

### Ubah: `src/server/http.ts`

1. Panggil `describeUnprotected(config)` sekali di `buildHttpApp`.
2. `const auth = createBearerAuth(...)` diganti conditional: kalau terbuka, pakai
   verifier yang selalu `ok: true` dengan `keyIndex: -1`; kalau tidak, `createBearerAuth`
   seperti sekarang. Verifier terbuka harus tetap mengurai header — `Authorization:`
   dengan format rusak tetap deserve 400/401, bukan 200, supaya_"kirim saja apa pun"_
   tidak menjadi jalan pintas.Buat ini sebagai `alwaysAuthorized()` di
   `src/server/auth.ts`, bukan inline.
3. `/status` tambah dua field: `authMode: 'bearer' | 'open'` dan, kalau `open`, satu
   `warning` berisi kalimat yang sama dengan banner. Tanpa ini, kondisi terbuka hanya
   terlihat di 3 detik pertama startup lalu hilang selamanya.
4. **`/healthz` tetap tanpa auth dan tetap `{"ok":true}`** — tidak berubah. D9.

### Ubah: `src/server/auth.ts`

Tambah `alwaysAuthorized(): BearerAuth` yang selalu `ok: true` dengan `keyIndex: -1`,
tapi menolak header yang tidak berbentuk `Bearer <token>` dengan `reason: 'malformed'`.
Dipakai hanya ketika `describeUnprotected` bilang terbuka.

### Ubah: `src/cli.ts`

1. `USAGE` ditulis ulang:_AUTO_CREATE, tiga flag baru, dan urutan resolusi yang
   sekarang memuat cabang "buat".
2. `runInitCommand` **tidak diubah** — `init` dan `init --local` tetap utuh. Permintaan
   human Ongoing eksplisit: "command init masih ada, karena butuh di init --local".
3. `parseConfigFlag` **tidak diubah** — ia tetap khusus `-c`, dipanggil oleh
   `runValidate`. Parseaksi flag serve pindah ke `src/serve-flags.ts`.
4. Entry point: `const rest = process.argv.slice(2)` lalu `parseServeFlags(rest)`
   menggantikan `parseConfigFlag` + offset `rest[0] === 'serve' ? 3 : 2` yangrapikan.
   Offset itu rapuh karena ia menghitung ulang penentuan command yang sudah dilakukan
   `run()`; sekarang keduanya membaca hasil yang sama.

### Ubah: `src/index.ts`

1. `startGateway` menerima `ServeFlags` lewat `StartOptions.flags`, dan menerapkan
   override **setelah** `loadConfig` tapi **sebelum** `buildHttpApp` — karena
   `resolveAllowedOrigins`, `ResourceServer` audience, dan CIMD `client_id` semuanya
   membaca `config.gateway.publicUrl` saat app dibangun. Override yang diterapkan
   belakangan tidak akan sampai ke sana.
2. Banner dicetak setelah `server.listen` berhasil **dan** `manager.start()` selesai,
   memakai `server.address()` untuk port sebenarnya.
3. Peringatan mode terbuka dicetak di titik yang sama dengan banner, supaya keduanya
   tidak tercecer atau terbalik urutan.
4. Auto-create dipanggil sebelum `loadConfig`, hanya di jalur serve.

### Ubah: `src/config/init.ts`

`runInit` menerima opsi baru agar template auto-create tidak menduplikasi logika file:

```ts
export interface InitOptions {
  // ...yang ada sekarang
  /** Document to write instead of the bundled example. Used by auto-create. */
  contents?: string;
}
```

`readExampleConfig()` tetap jadi default. Auto-create mengoper `contents` berisi
template minimum yang valid, sehingga `withPublishedSchema` tetap berlaku dan `$schema`
tetap menunjuk ke paket yang dipublikasikan.

### Ubah: `.gitignore`

Tidak perlu. `.mcp-gateway/` sudah ada di baris 21 — sudah diverifikasi dengan
`git check-ignore -v`. Tidak ada perubahan.

### Tidak diubah: `Dockerfile`, `docker-compose.example.yml`, `scripts/smoke.sh`, CI

Auto-create **tidak boleh** aktif di CI smoke. Job smoke menaruh
`GATEWAY_CONFIG=/app/spikes/smoke/gateway.json` di environment, jadi resolution
berhenti di level 2 dan auto-create tidak pernah tereksekusi. Tidak perlu perubahan —
dan plan ini tidak akan将它 mengubah, supaya smoke tetap menguji jalur yang sama seperti
sekarang.

---

## [Functions]

### `collectEndpoints` — baru, `src/server/banner.ts`

```ts
export function collectEndpoints(options: {
  host: string;
  port: number;
  publicUrl?: string;
  /** Injected; defaults to os.networkInterfaces(). Tests pass a fixed list. */
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): Endpoint[];
```

Mengembalikan `Endpoint[]` yang sudah terurut: `local` dulu, lalu `network` menurut
urutan abjad alamat (deterministik — urutan `os.networkInterfaces()` tidak dijamin sama
antarmuka ke antarmuka), lalu `public`/`tunnel` terakhir.

### `renderBanner` — baru, `src/server/banner.ts`

Fungsi murni. Keluaranoja dirancang supaya **dibaca orang**, bukan di-`grep`:

```
  mcp-gateway 0.1.0

  ➜  Local:   http://localhost:3000/mcp
  ➜  Network: http://192.168.1.7:3000/mcp (Ethernet)
  ➜  Network: http://100.80.147.14:3000/mcp (Tailscale)
  ➜  Public:  https://gateway.example.com/mcp

  config     C:\Users\ahsan\.mcp-gateway\gateway.json
  upstreams  2
  auth       bearer (1 key)

  press h + enter to show help
```

Baris `press h + enter` **dihapus dari scope v1** — itupti_Vite dengan watch mode yang
tidak ada padanannya di sini; promesa yang tidak dipenuhi lebih buruk daripada tidak
mencantumkan sama sekali.

Setiap baris yang menampilkan host non-loopback diberi penanda `auth: OPEN` bila
terbuka, karena_itulah satu-satunya informasi yang paling sering luput dari banner.

### `renderTemplate` — baru, `src/config/init.ts`

```ts
export function renderTemplate(host: string, key: string): string;
```

Menghasilkan dokumen JSONC minimum yang **pasti lolos** schema:

```jsonc
{
  "$schema": "https://cdn.jsdelivr.net/npm/@ahsansuryana/mcp-gateway@0.1.0/gateway.schema.json",

  "gateway": {
    "host": "127.0.0.1",
    "port": 3000,
    "auth": { "type": "bearer", "keys": ["<key>"] }
  },

  // Add upstreams below. Tools are exposed as <name>_<tool>.
  // See docs/CONFIG.md for every field.
  "mcp": {
    // "example": {
    //   "type": "remote",
    //   "url": "https://api.githubcopilot.com/mcp/",
    //   "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" }
    // }
  }
}
```

Host default `127.0.0.1`, bukan `0.0.0.0`. Alasan: template ini dibuat otomatis oleh
seorang user yang belum mengambil keputusan conscious soal jaringan. Default `0.0.0.0`
berarti gateway freshly-created langsung mendengarkan di seluruh LAN dengan API key
yang baru saja dicetak ke terminal — sebuah perubahan postur keamanan yang tidak pernah
diminta. `--hostname 0.0.0.0` adalah cara memintanya secara eksplisit. Ini **perubahan
dari** default `gateway.host` di schema (`src/config/schema.ts:129`), dan disengaja:
default schema tetap `0.0.0.0` untuk config yang ditulis manual, sementara template
auto-create memakai `127.0.0.1`.

Komentar `#` valid: parser memakai `jsonc-parser` dengan `disallowComments: false`
(`src/config/load.ts:141`).

### `ensureConfig` — baru, `src/config/ensure.ts`

```ts
export interface EnsureResult {
  status: 'found' | 'created' | 'failed';
  /** Absolute path. Present for every status. */
  path: string;
  /** Absolute path that was written, for 'created'. */
  createdPath?: string;
  /** True when this call is what created the file. */
  created: boolean;
  /** Only when this call generated it — safe to print ONCE, to the owner. */
  generatedKey?: string;
  reason?: string;
}

export function ensureConfig(options: {
  env?: Record<string, string | undefined>;
  cwd?: string;
  exists?: (p: string) => boolean;
  write?: (path: string, contents: string) => void;
  generateKey?: () => string;
}): EnsureResult;
```

Urutan: panggil `resolveConfigLocation`. Kalau dapat path → `found`. Kalau tidak →
tulis ke `join(homeRoot(env), '.mcp-gateway', 'gateway.json')`.

**Tidak** pernah menulis ke `./.mcp-gateway/` (lokasi project). Auto-create hanya boleh
membuat file **global**; membuat file di CWD saat user menjalankan `mcp-gateway` dari
direktori acak akan menyentuh filesystem yang tidak diminta dan sering kali read-only.
Kalau CWD tidak writable, tidak ada yang gagal di lokasi project.

Kalau file sudah ada tapi **invalid**, `ensureConfig` tidak menyentuhnya —
`loadConfig` yang melaporkan. `ensureConfig` hanya-surgical: ia menjawab "ada atau tidak",
tidak "bagus atau tidak".

### `generateApiKey` — baru, `src/config/keys.ts`

```ts
export function generateApiKey(bytes?: number): string;
```

`randomBytes(bytes ?? 32).toString('base64url')`. Sengaja `base64url`: tidak ada
`+`, `/`, atau `=` yang perlu di-escape saat key masuk ke header bearer, JSON, atau
`.env`. Panjang 32 byte = 43 karakter, melewati `MIN_SCRUBBABLE_SECRET` (8) sehingga
`createLogger` akan menycrub-nya dari free text — penting, karena key ini **akan**
muncul di banner.

### `applyOverrides` — baru, `src/serve-flags.ts`

```ts
export function applyOverrides(config: GatewayConfig, flags: ServeFlags): GatewayConfig;
```

Salinan dangkal pada level `gateway`, dengan objek `auth` **di-share** (tidak diubah).
`publicUrl: undefined` di flags berarti "jangan sentuh" — jadi ada flag boolean
`publicUrlSet` terpisah, atau `undefined` yang berarti no-op (bukan "hapus").Flag tidak
pernah menghapus nilai, hanya menimpanya.

### Hapus / ubah

- `src/config/schema.ts`: `gatewayGuarded` **dihapus**.
- Tidak ada fungsi yang dihapus dari file lain.
- `parseConfigFlag` **tidak dihapus** — masih dipakai `runValidate`.

---

## [Classes]

Tidak ada kelas baru yangFebru_Disesuaikan. Yang perlu diketahui:

- **`ConfigReloader`** (`src/server/reload.ts:44`) tidak berubah kodenya, tapi
  **berinteraksi** dengan override. `reconfigure(next)` hanya Fassung upstreams — ia tidak
  menyentuh `gateway.host`/`port`/`publicUrl`. Artinya: flag override bertahan sepanjang
  hidup proses meski file ditulis ulang, dan perubahan `publicUrl` di file **tidak**
  berlaku selama proses berjalan dengan `--public-url`. Ini konsisten dengan perilaku
  yang sudah ada (flag host/port di reload juga tidak diterapkan) dan harus didokumentasikan
  di OPERATIONS, bukan dibaiki di sini.
- **`UpstreamManager`** tidak berubah.
- **`ResourceServer`** tidak berubah; ia hanya menerima `publicUrl` yang berbeda karena
  override diterapkan sebelum `buildHttpApp`.

Tidak ada pewarisan kelas yang berubah, tidak ada pola constructor yang berubah.

---

## [Dependencies]

Tidak ada dependency baru. semuanya dari `node:crypto` dan `node:os` yang keduanya
sudah dipakai repo ini(`node:os` di `src/config/paths.ts`, `node:crypto` di
`src/server/auth.ts`).

Tidak ada perubahan pada `package.json`. Tidak ada perubahan pada `package-lock.json`.

Yang **tidak** boleh ditambahkan, dan alasannya:

- **Library deteksi IP publik** (ipify, os-name, dan sejenisnya). Butuh panggilan
  jaringan keluar saat startup. PLAN.md D15 melarang test menyentuh jaringan; menaruha
 -IP-publik di jalur startup membuat setiap boot bergantung pada pihak ketiga yang bisa
  lambat atau mati.
- **CLI framework** (commander, yargs). `run()` sudah fungsi murni dengan
  `CliOutcome` yang mengembalikan string, yang membuatnya lebih mudah diuji daripada
  parser berbasis side effect. Menambah framework berarti menulis ulang `src/cli.ts`
  beserta testnya tanpa developmentallyydrofit yang sepadan.

---

## [Testing]

Baseline saat ini: **29 file, 329 passed + 4 skipped**. Target setelah semua: subset ini
menambah file baru, tidak mengubah angka existing.

### `test/unit/banner.test.ts` — baru

Cases yang harus ada, masing-masing dengan alasan:

1. **`0.0.0.0` tidak pernah muncul sebagai URL yang bisa dihubungi.** `host: '0.0.0.0'`
   dengan port 3000 menghasilkan `http://localhost:3000/mcp`, bukan
   `http://0.0.0.0:3000/mcp`. Ini regresi yang paling mungkin terjadi dan paling mungkin
   tidak terlihat — URL-nya "terlihat benar".
2. **Port yang dipakai banner adalah port sebenarnya, bukan `config.gateway.port`.**
   Kasus `port: 0` → banner harus memakai port yang diteruskan (`45678`), karena
   `server.address()` sudah memberikannya di `src/index.ts:150`. Kalau banner memakai
   nilai config, setiap `--port 0` menghasilkan URL yang tidak bisa dihubungi.
3. **Loopback tidak masuk daftar `network`.** `internal: true` di-discard; hanya baris
   `local` yang memakainya.
4. **IPv6 dibungkus kurung siku.** `::1` → `http://[::1]:3000/mcp`.
5. **Link-local dan scope-id di-discard** (`fe80::…`, `fe80::…%3`).
6. **Address dari `internal: false` milik interface yang tidak dalam use** (VPN yang
   mati, Docker yang tertinggal) tetap dicetak. Ini yang membuat `Tailscale
   100.80.147.14` muncul di banner — dan itu benar: interface itu up dan bisa
   dihubungi.
7. **Dedupe.** Dua interface melaporkan IP sama → satu baris.
8. **`family` string dan angka keduanya diterima** (`'IPv4'` dan `4`), karena keduanya
   masih muncul di versi Node berbeda.
9. **Urutan deterministik.** Dua interface dengan urutan input berbeda menghasilkan
   output identik.
10. **`publicUrl` jadi baris `public`, bukan `network`**, dan tidak diduplikasi kalau
    host-nya kebetulan sama dengan salah satu IP LAN.
11. **Banner mode terbuka memuat penanda.**
12. **Nilai secret tidak pernah muncul di banner.** `renderBanner` diberi input yang
    contains `generatedApiKey` di godikan di field lain — misalnya `configPath` yang
    berisi key sebagai substring — lalu hasilnya di-assert tidak mengandung key tersebut.

### `test/unit/serve-flags.test.ts` — baru

1. Semua bentuk: `--hostname H`, `--hostname=H`, `--port 3001`, `--port=3001`,
   `--public-url U`, `--public-url=U`.
2. `-c` dan `--config=<path>` tetap diparse oleh `parseServeFlags` dan tidak_,
   betanya,bikin `runValidate` yang memanggil `parseConfigFlag` — keduanya hidup berdampingan.
3. `--port` bukan integer → `EXIT_USAGE`, pesan menyebut `--port`.
4. `--port 0` → ditolak; hanya 1–65535.
5. `--port 70000` → ditolak.
6. Flag dengan value kosong (`--hostname=`) → ditolak dengan pesan yang menyebut flag.
7. `--` menghentikan parsing; sisanya bukan error.
8. `applyOverrides` tidak memutasi objek asli (Object.freeze input, tidak melempar).
9. `applyOverrides` dengan flags kosong mengembalikan config yang setara.
10. `--public-url` tidak menghapus `publicUrl` yang sudah ada di config saat flags tidak
    menyentuhnya.

### `test/unit/ensure-config.test.ts` — baru

1. Config ada di project → `found`, **tidak ada file yang ditulis**.
2. Config ada di home → `found`.
3. Tidak ada di mana pun → `created`, di `homeRoot/.mcp-gateway/gateway.json`.
4. **Tidak pernah menulis ke `./.mcp-gateway/`** — CWD yang read-only tetap berhasil.
5. `generatedKey` hanya ada di status `created`.
6. File yang sudah ada tapi invalid **tidak** ditimpa atau diubah.
7. Template yang dihasilkan **lolos `loadConfig` sungguhan** — bukan hanya
   `gatewayConfigSchema.safeParse`, tapi `loadConfig()` lengkap dengan substitusi dan
   validasi cross-field. Ini yang membuktikan template benar-benar bisa dipakai.
8. `exists`/`write`/`generateKey` di-inject, jadi test tidak pernah menyentuh home asli.
9. Direktori ditulis dengan mode 0700 dan file 0600 — POSIX-only, `it.skipIf(win32)`,
   mengikuti pola yang sudah dipakai di `test/unit/config-paths.test.ts:255`.

### Perubahan pada test yang ada

- **`test/unit/cli.test.ts`**: tambah assertion bahwa `run([]).serve === true` masih
  benar (sudah ada di baris 79-81, tidak berubah), dan bahwa `run(['init','--local'])`
  masih menunjuk path yang sama. Guard agar refactor flag tidak injurekan `init`.
- **`test/unit/schema.test.ts`**: hapus/tambah test untuk `gatewayGuarded`. Kalau ada test
  yang asserting `keys: []` ditolak, **test itu dibalik** — bukan dihapus — supaya
  perubahan Horstopperoderasi tercatat sebagai keputusan, bukan dihapus diam-diam.
 _assert baru: config dengan `keys: []` dan tanpa `authOAuth` **lolos** schema.
- **`test/unit/config-paths.test.ts`**: tidak berubah. Resolution order tidak berubah, dan
  test itu mengunci order itu. Ini bukti Regressionprotection yang gratis.

### Verifikasi manual (setelah `npm run build`)

1. `mcp-gateway` di direktori kosong dengan `GATEWAY_HOME` diarahkan ke temp →
   membuat config, mencetak banner, `/healthz` 200.
2. `mcp-gateway` lagi di direktori yang sama → **tidak** membuat apa pun, path sama.
3. `mcp-gateway --hostname 0.0.0.0 --port 3111` → banner menunjukkan Network dengan
   port 3111; `curl http://<LAN-IP>:3111/healthz` 200.
4. `mcp-gateway --public-url https://x.example.com` → banner baris Public; dan
   `GET /.well-known/oauth-protected-resource/mcp` **hanya** bila `authOAuth` disetel.
5. Banner(stdout) dan log JSON(stderr) dipisahkan: `mcp-gateway > out.txt 2> err.txt`
   → `out.txt` hanya banner, `err.txt` hanya JSON.

---

## [Implementation Order]

Nomor urut dipilih agar setiap langkah bisa diuji berdiri sendiri, dan tidak ada commit
yang broke.

1. **Pisahkan output logger.** `createLogger` default `process.stderr` bukan
   `process.stdout` (`src/observability/logger.ts:117`). Tidak ada test yang bergantung
   pada stdout logger — diverifikasi dengan grep, tapi ini langkah pertama karena semua
   banner afterward bergantung padanya. Commit: `refactor(logger): send JSON logs to stderr`.

2. **Flags runtime.** `src/serve-flags.ts` + `test/unit/serve-flags.test.ts` + hook ke
   `cli.ts` + `index.ts`. `applyOverrides` diterapkan sebelum `buildHttpApp`. Banner belum
   ada — flag belum terlihat efeknya dari terminal, dan itu memang urutan yang benar:
   logika override harus benar sebelum ada yang menampilkan. Commit:
   `feat(cli): add --hostname, --port and --public-url runtime overrides`.

3. **Banner.** `src/server/banner.ts` + `test/unit/banner.test.ts` + cetak setelah
   listen. Commit: `feat(serve): print reachable MCP URLs on startup`.

4. **API key opsional.** Lepas `gatewayGuarded`, tambah `src/config/auth-mode.ts`,
   `alwaysAuthorized()` di `auth.ts`, `authMode` di `/status`, peringatan di banner.
   Commit: `feat(auth): allow an unauthenticated gateway with a loud startup warning`.

5. **Auto-create.** `src/config/keys.ts` (`generateApiKey`) +
   `src/config/ensure.ts` (`ensureConfig`) + `renderTemplate` di `init.ts` +
   `test/unit/ensure-config.test.ts` + sambung ke jalur serve. Commit:
   `feat(serve): create a starter config when none exists`.

6. **Dokumentasi.** README (bagian quick start + bagian baru "Where the config lives"
   yang menjawab pertanyaan "di mana config disimpan" secara langsung — hari ini
   informasinya tersebar di README dan OPERATIONS §2), OPERATIONS §2, ADR 0013 untuk
   keputusan auto-create + mode terbuka, BACKLOG, `docs/reports/`. Commit:
   `docs: record the zero-config startup decisions`.

7. **Regenerate.** `npm run gen:schema` — schema berubah, jadi `gateway.schema.json`
   dan `docs/CONFIG.md` harus di-regenerate atau keduanya akan **drift** dari
   `src/config/schema.ts`. Ini B-16 yang masih terbuka. Commit: `chore: regenerate
   gateway.schema.json and docs/CONFIG.md`.

8. **Verifikasi penuh.** `npm run typecheck && npm run lint && npm test && npm run build`,
   lalu pemeriksaan manual 1–5 di atas, lalu fresh-clone dari repo publik untuk memastikan
   `npm i -g` → `mcp-gateway` → banner tetap jalan. Setelah itu PR + CI.

---

## [Risiko dan keputusan]

### 1. Mode terbuka — SUDAH DIPUTUSKAN ✅

Human: `--hostname` tanpa API key **ditolak**, dengan penjelasan error. Detail di
[Types](#supervisor-baru--open-hanya-sah-di-loopback-sudah-putusan-human). Yang tersisa
adalah implementasinya, bukan keputusannya. Residual risk yang tersisa: pada bind
loopback dengan `keys: []`, siapa pun yang bisa menjalankan proses di mesin yang sama bisa
memanggil `/mcp`. Itu konsekuensi yang disepakati, dan sekarang **terlihat** — di banner,
di `/status.authMode`, dan di log `warn` — bukan tersembunyi.

### 2. Default host template `127.0.0.1` — SUDAH DISETUJUI ✅

Berbeda dari default schema (`0.0.0.0`), dan itu disengaja: template auto-create dibuat
diam-diam oleh user yang belum memutuskan apa pun soal jaringan. `--hostname 0.0.0.0` adalah
cara memintanya secara eksplisit.

### 3. OAuth untuk Claude — TERPISAH DARI PLAN INI, dan ini alasannya

Riset Anthropic yang sudah ada di repo ini
(`docs/ref/claude-connector-requirements.md` §3.5) mengonfirmasi klaim human:

> "A machine-to-machine `client_credentials` grant isn't supported" — Claude requires
> **authorization_code with a logged-in user**. There is no headless service-account path.

Jadi benar: **claude.ai hosted connector tidak bisa memakai header statis.** Static bearer
key hanya berlaku untuk Claude Desktop dan Claude Code, yang memang bisa menyetel header.

Yang penting untukить scope: **sisi resource server sudah selesai.** Sprint 6 sudah
menerapkan `gateway.authOAuth`, PRM RFC 9728, challenge `401` dengan
`resource_metadata`, dan validasi JWT + audience. Yang belum ada hanyalah
**authorization server** — komponen yang harus_redirect-kan browser Claude. Dan ADR 0005
(keputusan human di S6.0 gate) menundanya, dengan alasan tertulis: meletakkan kode
otorisasi di proses yang sama dengan `npx` children dan token store OAuth upstream.

Yang bisa dibangun di luar gateway, dengan aman, adalah **AS sebagai proses terpisah** —
container/service sendiri, signing key sendiri, tidak ada satu baris kode AS di dalam
proses gateway. Yang dibutuhkan, semuanya sudah terdaftar di
`docs/ref/claude-connector-requirements.md` §3 dan §5:

- `GET /.well-known/oauth-authorization-server` dengan `client_id_metadata_document_supported: true`
  **dan** `"none"` di `token_endpoint_auth_methods_supported` (aturan dua-flag CIMD),
  `code_challenge_methods_supported: ["S256"]`, `issuer` yang identik dengan `iss` di token
- `GET /authorize` — halaman login tempat user **paste API key gateway**, PKCE S256,
  redirect ke `https://claude.ai/api/mcp/auth_callback`
- `POST /token` — form-urlencoded (lain itu `415`), code exchange + refresh dengan
  rotasi dan `invalid_grant` pada replay
- `GET /jwks.json`, signing key yang **bisa dirotasi** (jangan mengulangi B-33, di mana
  `GATEWAY_TOKEN_KEY` tidak bisa dirotasi sama sekali)
- `aud` di token = URL MCP kanonik gateway

Nice property dari desain "API key = password": **tidak ada user store, tidak ada
password hashing, tidak ada reset password.** "User" dibuktikan dengan mengetahui API key
gateway — level keamanan setara dengan static key itu sendiri, tidak lebih lemah.

**Rekomendasi:kerjakan plan ini dulu, AS sebagai proyek terpisah dengan ADR sendiri.**
Alasannya nyata, bukan formal: plan iniChanges resolution, output, dan auth — tiga hal
yang sudah punya test dan gate. AS punya threat model sendiri, key rotation sendiri, dan
butuh domain + TLS + deployment nyata untuk diverifikasi (S5-MANUAL masih tertunda karena
itu). Menggabungkannya jadi satu sprint akan menghasilkan dua hal yang sama-sama belum
terverifikasi.

Human menyatakan *"kalau pake claude tuh harus pake oauth koneknya"* — dikonfirmasi benar
oleh riset Anthropic yang sudah ada di repo ini
(`docs/ref/claude-connector-requirements.md` §3.5): *"A machine-to-machine
`client_credentials` grant isn't supported"*; Claude mewajibkan authorization_code dengan
user yang login, dan tidak ada jalur headless. Header statis hanya berlaku untuk Claude
Desktop dan Claude Code, bukan untuk claude.ai hosted connector.

Kalau human ingin keduanya dikerjakan sekarang juga, jawabannya tetap: ya, tapi jadi plan
terpisah dengan ADR terpisah — bukan tambahan kecil di plan ini.

### 4. `--public-url` BUKAN soal CORS — dan `--hostname` tetap perlu — SUDAH DISETUJUI ✅

Human mengira `--public-url` hanya untuk CORS. Verified **salah**, dan fortunately untuk yang
memma. Zero header `Access-Control-*` ada di `src/` maupun di
`@modelcontextprotocol/express` — CORS memang tidak dipakai, karena Claude Desktop /
Claude Code / claude.ai bukan browser dan tidak mengirim header `Origin`. YangROUqz
dipakai adalah **DNS-rebinding protection**, yang **menolak** (403), tidak pernah
mengizinkan:

```js
// @modelcontextprotocol/server/dist/index.mjs:1598
if (originHeader === null || originHeader === undefined || originHeader === "") return { ok: true };
```

Jadi Origin yang tidak ada **lolos**. Yang penting: `gateway.publicUrl` dibaca di **lima**
tempat, dan **empat** di antaranya adalah identitas keamanan, bukan CORS:

| # | Dipakai untuk | Client |
|---|---|---|
| 1 | Origin allowlist (`src/server/http.ts:54`) | browser saja |
| 2 | `authOAuth.audience` default = `publicUrl`+`/mcp` (`:125`) | OAuth |
| 3 | PRM RFC 9728, field `resource` (`:138`) | OAuth |
| 4 | CIMD `client_id` + `client_uri` (`oauth-client/service.ts:118-129`) | OAuth |
| 5 | Redirect URI callback upstream (`:72-75`) | OAuth |

Disukai human: `--public-url` tetap dipakai, dan `--hostname` **tetap** dipakai karena
beberapa device harus menghubungi gateway dari jaringan berbeda. Konsekuensi untuk
supervisor di [Types](#supervisor-baru--open-hanya-sah-di-loopback-sudah-putusan-human):
justru karena `--hostname` sah untuk akses lintas-perangkat, larangan "non-loopback tanpa
key" adalah satu-satunya pagar antara gateway terbuka dan seluruh LAN. Supervisor itu
wajib ada, bukan opsional.

**Jebakan operasional yang harus didokumentasikan (human sudah,false,sbp tahu):** URL
tunnel ngrok/cloudflared ephemeral berubah tiap restart, dan karena `publicUrl` =
`aud`, nilai basi menghasilkan `audience mismatch` yang penyebabnya tidak terlihat dari
pesan error. Handle-nya adalah pilihan operator: Zero Trust tunnel dengan domain sendiri
(sekali set, tidak berubah) atau ngrok dengan URL di-set eksplisit. Ini dicatat di
OPERATIONS, bukan diselesaikan di kode — menebak URL tunnel yang aktif adalah tebakan.