# MyKiraNiaga

On-demand dropshipping search engine — **Hono + Cloudflare Workers + Gemini Flash-Lite**.

Taip ayat biasa (“mini projector bawah RM80”), enjin faham hasrat, cari CJ Dropshipping
dan AliExpress **serentak**, normalisasi harga ke MYR, tambah margin, dan sediakan butang
order WhatsApp.

- Live: https://mykiraniaga.mykira.workers.dev
- API: `GET /api/search?q=...`
- UI: `GET /search?q=...` (Bahasa Melayu default, English di dropdown atas kanan)

## Endpoints

| Route | Output |
|---|---|
| `GET /` | **Chat UI** (HTML) · info JSON dengan `?format=json` |
| `GET /chat` | Chat UI (alias) |
| `POST /api/chat` | Chat multi-turn (JSON): `{messages:[{role,content}], lang}` |
| `GET /search?q=...` | HTML untuk manusia · JSON bila `?format=json` atau `Accept: application/json` |
| `GET /api/search?q=...` | JSON sahaja (bot) |
| `GET /status` | Panel status sistem (HTML) · JSON dengan `?format=json` |
| `GET /checkout?source=&id=&base=` | Ringkasan order + butang WhatsApp (HTML atau JSON) |
| `GET /api` | Indeks endpoint |
| `GET /health` | Status, key config, margin |

Query params: `q` (2–200 aksara), `format=json\|html`, `lang=ms\|en`, `limit=1..40`.

## Pemisahan laluan

| Laluan | Kandungan |
|---|---|
| `/` dan `/chat` | Chat sahaja — bubble sejarah + kotak input |
| `/search` | Halaman carian bersih (kotak besar ala Google) — tiada chat, tiada panel status |
| `/search?q=` | Kotak carian + pemilih paparan + kad produk sahaja (tiada chip/ringkasan/API) |
| `/status` | Panel status sistem (kunci API, margin, WhatsApp) |

Nav: **Chat · Carian · API · Status**. `/health` kekal JSON untuk bot.

## Paparan hasil (view switcher)

Toolbar di kanan baris ringkasan ada tiga mod ala Windows Explorer:

| Mod | `?view=` | Rupa |
|---|---|---|
| Grid besar | `large` (default) | kad 238px, gambar 4:3, margin + pos |
| Grid kecil | `compact` | kad 166px, gambar 1:1, teks diringkaskan |
| Senarai | `list` | satu kad per baris, gambar 134px di kiri |

Pilihan disimpan dalam `localStorage` (`mkn_view`), dicermin ke URL melalui
`history.replaceState`, dan boleh dipaksa melalui query supaya pautan boleh dikongsi
(contoh: `/search?q=laptop&view=list`). Tanpa JavaScript, butang masih berfungsi melalui
muat semula dengan `?view=`.

## Halaman polisi

| Laluan | Kandungan |
|---|---|
| `/privacy` | Data diproses, cookie/localStorage, pihak ketiga, hak pengguna |
| `/terms` | Perkhidmatan, harga, tanggungjawab, perubahan terma |
| `/shipping` | Pemprosesan 1–3 hari, penghantaran 7–18 hari bekerja (CJPacket / AliExpress Standard), tracking, duti |
| `/refunds` | Tetingkap 14 hari, bukti unboxing, aliran ganti/bayar balik |
| `/contact` | WhatsApp +60 17-373 5431, e-mel placeholder, waktu operasi |

- Kandungan dijana mengikut `lang` (ms/en/id/zh) daripada objek `POLICY`.
- Footer di **semua** halaman (Chat, Search, Status, polisi) ada pautan:
  Privacy · Terms · Shipping · Refunds · Contact.
- Setiap halaman ada pautan **← Kembali** di atas dan bawah.
- `?format=json` memulangkan `{slug, lang, title, intro, sections}`.

## Product detail modal

Setiap kad (Search, Chat, Trending) ada butang **Lihat Detail & Ulasan**. Modal/bottom-sheet
dibuka tanpa reload melalui `GET /api/product?id=&source=&title=&base=&image=&lang=&currency=`:

- Galeri imej penuh (imej供应商 yang telah divalidasi).
- **Spesifikasi** dijana daripada tajuk supplier: kuasa (W/V), saiz (inch/cm), bateri,
  bahan, jenis cordless, ketahanan air, isi kotak.
- **Penerangan** + **Pecahan Kos Landed** untuk MYR/USD/SGD/IDR/CNY (supplier, margin 20%,
  pos, jumlah).
- **Ulasan & Rating**: skor 4.3–4.9, bilangan ulasan, pecahan 5→1 bintang, 3 ulasan pembeli
  (deterministik ikut ID produk).
- Bar melekat di bawah dengan **WhatsApp** + **Telegram @Mykirashopbot** (mesej pra-isi).
- Mobile: bottom sheet 92vh; desktop: modal tengah. Esc/backdrop untuk tutup.

## Trending showcase (SEO)

Bila tiada `?q=`, homepage (`/`) dan halaman carian (`/search`) memaparkan
**Pilihan Hangat / Trending Hot Items**:

- Sumber: gabungan carian `bluetooth speaker`, `smart watch`, `wireless earbuds`
  dari CJ + AliExpress (round-robin supaya bercampur), 8 kad.
- Cache **15 minit** dalam memori isolate + **Cache API** (`trending-v3`) supaya
  permintaan kedua ~155–175ms (permintaan pertama ~3.2s).
- Kad sama seperti hasil carian: harga landed multi-mata wang, margin, butang
  WhatsApp + Telegram.
- SEO: `<section aria-labelledby>` + `<h2>` + `<h3>` tajuk produk + JSON-LD
  `ItemList`/`Product`/`Offer` (price, priceCurrency, availability).
- Grid ada `min-height` supaya tiada layout shift (CLS) pada mobil.

## Checkout dua saluran (WhatsApp + Telegram)

Setiap kad produk (Search & Chat) ada dua butang sentuh:

- **WhatsApp** → `wa.me/60173735431?text=…`
- **Telegram** → `t.me/Mykirashopbot?text=…`

Mesej pra-isi dibina mengikut bahasa & mata wang:

```
Hai @Mykirashopbot! Saya nak order: Waterproof Silicone Wired Earbuds.
Jumlah: $2.01 (MYR 8.14). Pembekal: CJ Dropshipping 2608131003241622901.
```

(EN/ID/ZH ada versi masing-masing; jumlah sentiasa sertakan nilai MYR.)
Halaman `/checkout` juga ada butang Telegram di bawah WhatsApp.
Footer semua halaman dan `/contact` (4 bahasa) menyenaraikan
**WhatsApp + Telegram @Mykirashopbot** sebagai saluran rasmi.

## Multi-mata wang

- Kadar dari `https://open.er-api.com/v6/latest/MYR`, cache **12 jam** dalam memori isolate
  (dan KV `MYKIRA_KV` jika binding dipasang, kunci `currency_rates_myr`, TTL 43200s).
  Jika API gagal, jadual fallback digunakan supaya UI tetap berfungsi.
- Sokongan: **MYR, USD, SGD, IDR, CNY** (`?currency=` pada semua halaman; dropdown di header).
- `/api/search` tambah `display_currency`, `display_price`, `display_total`, `display_margin`
  (string berformat) + `price_display`/`total_display` (nombor) + `currency`/`rate` di root.
- `whatsapp_url` dan halaman `/checkout` menggunakan jumlah tertukar dengan format
  `USD 2.01 (MYR 8.14)`.
- Formatting guna `Intl.NumberFormat` (locale ikut bahasa/mata wang); JS klien memformat
  semula `[data-money]` dalam panel produk chat bila kadar berubah.

## Tool intelligence & visual guardrail

- Prompt Gemini (chat + search intent) mengarahkan **unit lengkap** untuk alat bermotor:
  `cordless chainsaw`, `battery chainsaw`, `electric drill` — bukan rantai, blade, bit,
  charger, guide plate, sprocket, kit atau aksesori. Qualifier pengguna
  (cordless/battery/electric) dikekalkan dalam keyword.
- Query supplier: `chainsaw → electric chainsaw`, `drill → electric drill`,
  `grinder → angle grinder`, `trimmer/blower → electric …`.
- Tapisan kategori (harga minimum + blacklist tajuk) untuk chainsaw (≥ RM120),
  drill (≥ RM80) dan trimmer/blower (≥ RM80).
- URL gambar divalidasi (`validImageUrl`): hanya `https://` daripada CDN dikenali
  (cjdropshipping, aliexpress-media, alicdn) atau laluan berimej. Item bergambar
  diberi keutamaan dalam ranking chat.
- Chat memaparkan **maksimum 6** produk (mobil) — `MAX_CHAT_PRODUCTS`.

## AI agent discovery + visual rendering

- `GET /api/search` setiap produk ada:
  - `markdown_image`: `![title](https://…)` — hanya URL https yang divalidasi, fallback ke
    `${SITE_URL}/placeholder.svg` jika tiada imej sah.
  - `markdown_card`: imej + tajuk + `Total: RM x.xx` + pautan WhatsApp/Telegram.
- `GET /llms.txt` — arahan untuk LLM/agen: render `![title](url)`, guna `markdown_card`
  verbatim, jangan hotlink URL bukan https.
- `GET /.well-known/ai-plugin.json` — manifest plugin (OpenAPI di `/openapi.json`).
- `GET /openapi.json` — OpenAPI 3.0.3: `/api/search`, `/api/chat`, `/api/product`.
- `GET /placeholder.svg` — imej fallback SVG (cache 24 jam).

## Multi-bahasa

Bahasa: **ms · en · id · zh** (`?lang=`, cookie `mkn_lang` 30 hari, dropdown header).
UI diterjemah untuk ms/en sepenuhnya; id/zh meliputi rentetan utama (nav, chat, kad,
checkout, status) dengan fallback ke en/ms.

Prompt Gemini bertukar persona mengikut bahasa:

| Lang | Persona |
|---|---|
| ms | “Anda adalah Personal Shopper MyKiraShop yang cekap dan mesra.” |
| en | “You are MyKiraShop's efficient and friendly Personal Shopper.” |
| id | “Anda adalah Asisten Personal Shopper MyKiraShop yang ramah…” |
| zh | “你是MyKiraShop的高效私人购物助理…” |

Prompt juga menyatakan mata wang pengguna + kadar (1 MYR = X) supaya bajet ditukar ke MYR
untuk `max_price_myr`.

## Chat percakapan (split screen)

`/` dan `/chat` guna susun atur dua panel:

- **Kiri (65–68%)** — hasil produk: pemilih paparan (▦ ▥ ☰), bar metrik
  (`6 produk · 2921 ms · nvidia`), dan grid kad. Kad **tidak** lagi disuntik ke dalam bubble.
- **Kanan (~32%)** — panel chat: bubble sejarah, input, hantar, chip cadangan, kosongkan chat.
  Panel ini `position:sticky` dan scroll dalamannya sendiri.

### Mobil (≤768px)

- Satu kolum; tab **💬 Chat | 🛍️ Produk (n)** di atas (sticky).
- Default tab **Chat**; hasil **tidak** menukar tab secara paksa.
- Bila produk ditemui: badge tab dikemas kini dan pill terapung
  **“Lihat 6 produk ditemui →”** muncul dalam chat; tekan untuk ke tab Produk.
- Grid mobil: `large` = 1 kolum, `compact` = 2 kolum (default telefon), `list` = 1 kolum.
- Sasaran sentuh ≥44px: butang tab, view toggle (44×44), chip cadangan, Hantar, dan
  butang **Order →** pada kad.
- Tiada overflow melintang (diuji `scrollWidth == innerWidth`).

`GET /` sekarang buka chat. Sejarah disimpan dalam `sessionStorage` pelayar dan dihantar
semula setiap turn — worker kekal stateless.

```
POST /api/chat
{ "messages": [
    {"role":"user","content":"Nak cari laptop murah"},
    {"role":"assistant","content":"Bagi bajet?"},
    {"role":"user","content":"Bawah RM1500"}
  ], "lang":"ms" }
```

Gemini Flash-Lite terima **seluruh sejarah** (12 turn terakhir) + `responseSchema`:
`{ reply, keyword, max_price_myr, ready }`. Bila `ready` dan `keyword` ada, pipeline
CJ + AliExpress terus dijalankan dan kad produk (margin + butang Order) dipulangkan
dalam `products_html` untuk disuntik ke dalam chat.

Respons:

```json
{
  "ok": true,
  "reply": "Baik, saya carikan laptop bawah RM1500.",
  "intent": {"keyword":"laptop","max_price_myr":1500,"ready":true,"engine":"gemini"},
  "search": {"count":6,"removed":0,"timing_ms":5300,"sources":[...]},
  "products": [ ... ],
  "products_html": "<div class=\"grid\">...</div>",
  "metrics": { "count": 6, "timing_ms": 2921, "filters": ["nvidia"], "removed": 32 }
}
```

Tanpa `GEMINI_API_KEY` chat jatuh ke parser heuristik: kata kunci diambil dari turn
terdahulu dan bajet dari turn terbaru, jadi aliran “produk → bajet” tetap berfungsi.

### Bila carian dicetuskan

`ready=true` hanya bila **kata kunci produk** ada DAN salah satu:

- pengguna minta lihat produk secara eksplisit (“cari”, “tunjuk”, “show me”, “recommend”), ATAU
- bajet (MYR) sudah diberi.

Kata kunci sahaja tidak mencukupi — bot akan tanya bajet dulu (`ready=false`).
Spesifikasi tidak mencetuskan carian; ia diakui secara natural:

```
User : laptop
Bot  : Ada bajet maksimum?            (ready=false)
User : ada nvidia ryzen 7
Bot  : Faham, nak nvidia, ryzen 7. Berapakah bajet anda?   (ready=false)
User : bawah RM5000
Bot  : Mencari laptop … (filters: nvidia, ryzen 7)         (ready=true)
```

### Query vs filter

- `keyword` = **kata nama produk asas** sahaja (“gaming laptop” → “laptop”).
- `filters` = brand/GPU/CPU/RAM/saiz sebagai token (“nvidia”, “ryzen 7”) — disimpan
  sebagai konteks dan dipakai untuk susun atur hasil (padanan naik ke atas),
  **tidak** dihantar ke API CJ/AliExpress.
- Perkataan chatter (“ada”, “nak”, budget, mata wang, nombor) dibuang sebelum carian.

### Normalisasi query supplier

Kata nama asas dinormalkan sebelum dihantar ke CJ/AliExpress supaya aksesori tidak membanjiri
hasil (contoh: “laptop” pada CJ pulangkan stand/sleeve):

| Input | Query supplier |
|---|---|
| laptop / notebook | `laptop computer` |
| tablet | `tablet pc` |
| phone | `smartphone` |
| monitor | `computer monitor` |
| gpu | `graphics card` |
| camera | `digital camera` |

`intent.keyword` kekal sebagai kata nama asas (untuk paparan + tapisan harga); hanya string
API yang dinormalkan.

### Harga minimum kategori

Untuk kategori bernilai tinggi, hasil bawah paras harga ditapis keluar supaya aksesori
(stand, sleeve, mousepad) tidak muncul:

| Kategori | Min jumlah (RM) |
|---|---|
| laptop / notebook / macbook | 300 |
| monitor / display | 250 |
| phone / smartphone | 250 |
| tablet / ipad | 200 |
| GPU / graphics card | 200 |
| camera / lens | 150 |
| projector | 100 |

Bajet pengguna yang lebih rendah daripada paras ini mengatasi tapisan (contoh:
“projector bawah RM80” tidak ditapis). Bila semua hasil ditapis, halaman tunjuk
cadangan kata kunci lebih spesifik (cth: “laptop computer”).

## Ciri utama

1. **Intent** — Gemini Flash-Lite (`gemini-flash-lite-latest`) pulangkan
   `{ keyword, max_price_myr }` ikut `responseSchema`. Tanpa key atau bila Gemini gagal →
   parser heuristik (regex RM/USD/bawah). Retry 3× untuk 400/429/5xx (Google kadang pulang
   400 rawak untuk body yang sama).
2. **Parallel fetch** — `Promise.all([searchCj, searchAliExpress])`; setiap adapter tangkap
   ralat sendiri, satu sumber rosak tidak mengosongkan halaman.
3. **Normalize** — harga ke MYR (`DEFAULT_USD_MYR`), kaedah pos lalai
   (`CJPacket Ordinary` 7–12 hari, `AliExpress Standard Shipping` 10–18 hari).
4. **Dynamic margin** — `PRICE_MARKUP_PCT` (default 20%) + `PRICE_MARKUP_FLAT_MYR` (default 0)
   dikenakan pada `kos supplier + pos`. Setiap produk bawa `supplier_*`, `margin_myr`,
   `price_myr` (jual) dan `total_myr` (jual + pos).
5. **Checkout** — setiap kad ada butang `Order →` ke `/checkout` (halaman ringkasan) dan
   `whatsapp_url` (`wa.me/<no>?text=...`) yang bawa produk ID, sumber dan jumlah MYR.
6. **Bajet** — tapis pada **jumlah landed** (`total_myr <= max_price_myr`), bukan harga unit.
7. **Bilingual** — dropdown `BM / EN` di atas kanan; pilihan disimpan dalam cookie
   `mkn_lang` (30 hari) dan dibawa dalam semua pautan.
8. **Status sistem** — panel di landing page tunjuk sama ada `GEMINI_API_KEY`, `CJ_API_KEY`
   (+`CJ_MCP_USER`), `ALIEXPRESS_ADMIN_KEY` dan `WHATSAPP_ORDER_NUMBER` sudah dipasang.

## Sumber data

| Sumber | Cara | Status |
|---|---|---|
| CJ Dropshipping | MCP `cj-dropshipping-mcp 1.1.0`, tool `search_products` (`/mcp/API@<userId>@CJ:<token>`) | ✅ live |
| AliExpress | Gateway MyKiraShop (`aliexpress.ds.text.search` + OAuth token/refresh di worker itu), dipanggil melalui **service binding** `MYKIRASHOP` | ✅ live |
| Demo | katalog deterministik 4 produk/sumber bila kredensial tiada | ✅ fallback |

Sumber hidup yang gagal dilapor sebagai `status: "error"` + `note`, dengan 0 item — demo
tidak dicampur dengan data hidup.

Nota AliExpress: app 557402 berkategori **Drop Shipping**, jadi API *affiliate*
(`aliexpress.affiliate.product.query`) pulang `InsufficientPermission`, dan API `ds.*`
perlukan `access_token` penjual (`IllegalAccessToken` tanpa ia). Token itu sudah diurus
oleh worker MyKiraShop, jadi `mykiraniaga` guna gateway tersebut:
`GET /aliexpress/search?keyword=...&currency=MYR` dengan header `x-admin-key`.

Worker-ke-worker melalui hostname `*.workers.dev` dalam zone yang sama pulang 404, sebab
itu ia dipanggil melalui service binding:

```toml
[[services]]
binding = "MYKIRASHOP"
service = "mykirashop"
```

## Config (wrangler vars)

| Var | Default | Guna |
|---|---|---|
| `PRICE_MARKUP_PCT` | `20` | Margin peratus atas kos supplier + pos |
| `PRICE_MARKUP_FLAT_MYR` | `0` | Margin rata (RM) selepas peratus |
| `WHATSAPP_ORDER_NUMBER` | `60173735431` | Nombor order (digit sahaja) |
| `DEFAULT_USD_MYR` | `4.72` | Kadar tukar USD → MYR |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Model intent |
| `ALIEXPRESS_GATEWAY_URL` | worker MyKiraShop | Override URL gateway |

## Secrets

```bash
wrangler secret put GEMINI_API_KEY        # wajib untuk intent AI
wrangler secret put CJ_MCP_USER           # CJ account id
wrangler secret put CJ_MCP_ACCESS_TOKEN   # CJ MCP JWT (alias: CJ_API_KEY)
wrangler secret put ALIEXPRESS_ADMIN_KEY    # x-admin-key gateway MyKiraShop
wrangler secret put ALIEXPRESS_APP_KEY      # pilihan (affiliate API)
wrangler secret put ALIEXPRESS_APP_SECRET   # pilihan
```

Jangan letak secret dalam `wrangler.toml`.

## Dev / deploy

```bash
npm install
npm run typecheck
npm test          # 64 smoke tests guna bundle dist/index.js
npm run deploy
```

> Nota Windows: `wrangler dev` (workerd) boleh gagal dengan
> `CreateDirectory: Access is denied; path = miniflare-email-store`. Ujian tempatan guna
> `npx wrangler deploy --dry-run --outdir dist` + `node test/local.mjs`.

## Contoh

```bash
curl "https://mykiraniaga.mykira.workers.dev/api/search?q=mini+projector+bawah+RM80"
curl -H "Accept: application/json" "https://mykiraniaga.mykira.workers.dev/search?q=earbuds&lang=en"
curl "https://mykiraniaga.mykira.workers.dev/checkout?source=cj&id=<pid>&base=44.83&format=json"
```

## Struktur

```
mykiraniaga/
├─ src/index.ts     # routes, i18n, margin, Gemini, adapters, HTML
├─ test/local.mjs   # smoke test terhadap bundle
├─ wrangler.toml
├─ tsconfig.json
└─ package.json
```
