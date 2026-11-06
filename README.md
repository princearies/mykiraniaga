# MyKiraNiaga

On-demand dropshipping search engine — **Hono + Cloudflare Workers + Gemini Flash-Lite**.

Taip ayat biasa (“mini projector bawah RM80”), enjin faham hasrat, cari CJ Dropshipping
dan AliExpress **serentak**, normalisasi harga ke MYR, dan tapis ikut bajet.

- Live: https://mykiraniaga.mykira.workers.dev
- API: `GET /api/search?q=...`
- UI: `GET /search?q=...`

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

1. **Intent** — Gemini Flash-Lite (`gemini-flash-lite-latest`) pulangkan
   `{ keyword, max_price_myr }` ikut `responseSchema` JSON. Tanpa API key atau bila Gemini
   gagal → parser heuristik (regex RM/USD/bawah) supaya enjin tetap hidup. Retry sekali untuk
   400/429/5xx (Google kadang pulang 400 secara rawak untuk body yang sama).
2. **Parallel fetch** — `Promise.all([searchCj, searchAliExpress])`; setiap adapter menangkap
   ralat sendiri, jadi satu sumber rosak tidak mengosongkan halaman.
3. **Normalize** — harga ke MYR (`DEFAULT_USD_MYR`, default 4.72), kaedah pos lalai
   (`CJPacket Ordinary` 7–12 hari, `AliExpress Standard Shipping` 10–18 hari), `total_myr`.
4. **Budget filter** — tapis `price_myr <= max_price_myr`; `removed` dilaporkan dalam meta.

## Sumber data

| Sumber | Cara | Status |
|---|---|---|
| CJ Dropshipping | MCP server `cj-dropshipping-mcp 1.1.0`, tool `search_products` (`/mcp/API@<userId>@CJ:<token>`, stateless) | ✅ live |
| AliExpress | Open Platform `aliexpress.affiliate.product.query` (HMAC-SHA256) | ⚠️ app tiada permission (`InsufficientPermission`) |
| Demo | katalog deterministik 4 produk/sumber bila kredensial tiada | ✅ fallback |

Bila sumber hidup gagal, `meta.sources[].status` = `error` + `note` (contoh:
`AliExpress InsufficientPermission: ...`) dan sumber itu pulang 0 item — demo **tidak**
dicampur dengan data hidup.

## Secrets

```bash
wrangler secret put GEMINI_API_KEY        # wajib untuk intent AI
wrangler secret put CJ_MCP_USER           # CJ account id  (live CJ)
wrangler secret put CJ_MCP_ACCESS_TOKEN   # CJ MCP JWT     (live CJ)
wrangler secret put ALIEXPRESS_APP_KEY    # pilihan (perlu permission affiliate API)
wrangler secret put ALIEXPRESS_APP_SECRET # pilihan
wrangler secret put ALIEXPRESS_TRACKING_ID
```

Jangan letak sebarang secret dalam `wrangler.toml`.

## Dev / deploy

```bash
npm install
npm run typecheck
npm test                     # 29 smoke tests (guna bundle dist/index.js)
npm run deploy
```

> Nota Windows: `wrangler dev` (workerd) boleh gagal dengan
> `CreateDirectory: Access is denied; path = miniflare-email-store` pada sesetengah mesin.
> Ujian tempatan guna `npx wrangler deploy --dry-run --outdir dist` + `node test/local.mjs`.

## Contoh

```bash
curl "https://mykiraniaga.mykira.workers.dev/api/search?q=mini+projector+bawah+RM80"
curl -H "Accept: application/json" "https://mykiraniaga.mykira.workers.dev/search?q=earbuds"
```

## Struktur

```
mykiraniaga/
├─ src/index.ts     # routes, Gemini, adapters (CJ MCP + AliExpress), normalisasi, HTML
├─ test/local.mjs   # smoke test terhadap bundle
├─ wrangler.toml
├─ tsconfig.json
└─ package.json
```
