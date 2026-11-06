# MyKiraNiaga

On-demand dropshipping search engine — **Hono + Cloudflare Workers + Gemini Flash-Lite**.

Taip ayat biasa (“mini projector bawah RM80”), enjin faham hasrat, cari CJ Dropshipping
dan AliExpress **serentak**, normalisasi harga ke MYR, dan tapis ikut bajet.

## Endpoints

| Route | Output |
|---|---|
| `GET /` | Landing page (HTML) · info JSON dengan `?format=json` |
| `GET /search?q=...` | HTML untuk manusia · JSON bila `?format=json` atau `Accept: application/json` |
| `GET /api/search?q=...` | JSON sahaja (bot) |
| `GET /api` | Indeks endpoint |
| `GET /health` | Status + konfigurasi sumber |

Query params: `q` (2–200 aksara), `format=json\|html`, `limit=1..40`.

## Bagaimana ia berfungsi

1. **Intent** — Gemini Flash-Lite (`gemini-flash-lite-latest`, fallback 2.5/2.0 flash-lite)
   pulangkan `{ keyword, max_price_myr }` ikut `responseSchema` JSON. Tanpa API key atau bila
   Gemini gagal → parser heuristik (regex RM/USD/bawah) supaya enjin tetap hidup.
2. **Parallel fetch** — `Promise.all([searchCj, searchAliExpress])`; setiap adapter menangkap
   ralat sendiri, jadi satu sumber rosak tidak mengosongkan halaman.
3. **Normalize** — harga ke MYR (`DEFAULT_USD_MYR`, default 4.72), kaedah pos lalai
   (`CJPacket Ordinary` 7–12 hari, `AliExpress Standard Shipping` 10–18 hari), `total_myr`.
4. **Budget filter** — tapis `price_myr <= max_price_myr`; `removed` dilaporkan dalam meta.

## Placeholder semantics

Bila `CJ_ACCESS_TOKEN` atau `ALIEXPRESS_APP_KEY/SECRET` tiada, adapter pulangkan katalog demo
deterministik (4 produk/sumber) bertanda `demo: true`, dan `meta.sources[].status` =
`placeholder`. Bila kredensial ada, kod memanggil endpoint sebenar dan melaporkan
`ok` / `empty` / `error` — tiada demo dicampur dengan data hidup.

> ⚠️ Endpoint CJ/AliExpress dalam `src/index.ts` ditanda `TODO(...)`: path & parameter perlu
> disahkan dengan dokumentasi rasmi sebelum production. Struktur normalisasi sudah sedia.

## Secrets

```bash
wrangler secret put GEMINI_API_KEY        # wajib untuk intent AI
wrangler secret put CJ_ACCESS_TOKEN       # pilihan
wrangler secret put ALIEXPRESS_APP_KEY    # pilihan
wrangler secret put ALIEXPRESS_APP_SECRET # pilihan
wrangler secret put ALIEXPRESS_TRACKING_ID
```

Jangan letak sebarang secret dalam `wrangler.toml`.

## Dev / deploy

```bash
npm install
npm run typecheck
npm run dev      # http://127.0.0.1:8787
npm run deploy
```

## Contoh

```bash
curl "https://<worker>.workers.dev/api/search?q=mini+projector+bawah+RM80"
curl -H "Accept: application/json" "https://<worker>.workers.dev/search?q=earbuds"
```

## Struktur

```
mykiraniaga/
├─ src/index.ts     # semua: routes, Gemini, adapters, normalisasi, HTML
├─ wrangler.toml
├─ tsconfig.json
└─ package.json
```
