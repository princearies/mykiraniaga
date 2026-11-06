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
| `GET /` | Landing page (HTML) · info JSON dengan `?format=json` |
| `GET /search?q=...` | HTML untuk manusia · JSON bila `?format=json` atau `Accept: application/json` |
| `GET /api/search?q=...` | JSON sahaja (bot) |
| `GET /checkout?source=&id=&base=` | Ringkasan order + butang WhatsApp (HTML atau JSON) |
| `GET /api` | Indeks endpoint |
| `GET /health` | Status, key config, margin |

Query params: `q` (2–200 aksara), `format=json\|html`, `lang=ms\|en`, `limit=1..40`.

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
