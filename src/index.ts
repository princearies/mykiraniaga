/**
 * MyKiraNiaga — on-demand dropshipping search engine
 * ---------------------------------------------------
 * Stack : Hono + Cloudflare Workers (TypeScript)
 * Brain : Gemini Flash-Lite (latest) — extracts { keyword, max_price_myr } from ?q=
 * Sources: CJ Dropshipping + AliExpress (parallel, placeholder-safe)
 *
 * Routes
 *   GET /                    landing page (HTML)  | info JSON with ?format=json
 *   GET /search?q=...        results (HTML or JSON by ?format= / Accept header)
 *   GET /api/search?q=...    always JSON (bots)
 *   GET /api                 endpoint index (JSON)
 *   GET /health              health probe
 *   GET /robots.txt
 *
 * Design notes
 *   - HTML is the default for browsers; JSON is returned when ?format=json is
 *     present or the Accept header prefers application/json / a bot UA calls it.
 *   - Source adapters never throw: each returns { report, items } so one failing
 *     upstream cannot blank the page. Missing credentials => deterministic demo
 *     catalogue tagged status "placeholder" (UI keeps working, data is labelled).
 *   - Budget filter runs on unit price by default; ?strict=1 filters on landed
 *     total (price + default shipping).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

export interface Env {
  /** Google AI Studio key — required for Gemini intent extraction. */
  GEMINI_API_KEY?: string;
  /** Override the default model alias. */
  GEMINI_MODEL?: string;
  /** CJ Dropshipping MCP credentials — stateless token URL (preferred, live). */
  CJ_MCP_USER?: string;
  CJ_MCP_ACCESS_TOKEN?: string;
  /** Legacy CJ Open API token (unused by the MCP path, kept for compatibility). */
  CJ_ACCESS_TOKEN?: string;
  /** AliExpress Open Platform (affiliate) credentials. Optional. */
  ALIEXPRESS_APP_KEY?: string;
  ALIEXPRESS_APP_SECRET?: string;
  ALIEXPRESS_TRACKING_ID?: string;
  ALIEXPRESS_BASE_URL?: string;
  /** MyKiraShop AliExpress gateway (holds the OAuth token + refresh loop). */
  ALIEXPRESS_GATEWAY_URL?: string;
  /** x-admin-key for the gateway. */
  ALIEXPRESS_ADMIN_KEY?: string;
  /** Service binding to the MyKiraShop worker (avoids same-zone 404). */
  MYKIRASHOP?: Fetcher;
  /** CJ MCP token alias — accepted when CJ_MCP_ACCESS_TOKEN is absent. */
  CJ_API_KEY?: string;
  /** USD -> MYR rate used to normalise USD-priced sources. */
  DEFAULT_USD_MYR?: string;
  /** Profit markup percentage applied to supplier price + shipping (default 20). */
  PRICE_MARKUP_PCT?: string;
  /** Flat profit margin in MYR added after the percentage (default 0). */
  PRICE_MARKUP_FLAT_MYR?: string;
  /** WhatsApp order number, digits only (default 60173735431). */
  WHATSAPP_ORDER_NUMBER?: string;
  /** Optional KV namespace for the 12h exchange-rate cache. */
  MYKIRA_KV?: KVNamespace;
  ENVIRONMENT?: string;
}

const SERVICE = "mykiraniaga";
const SITE_URL = "https://mykiraniaga.mykira.workers.dev";
const VERSION = "1.0.0";
const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
// Note: gemini-2.5-flash-lite / gemini-2.0-flash-lite now return 404 for new
// keys (verified Nov 2026), so there is no version fallback — only a retry.
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_FX = 4.72;
const MAX_RESULTS = 40;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type SourceId = "cj" | "aliexpress";

type SourceStatus =
  | "ok"
  | "empty"
  | "placeholder"
  | "missing_credentials"
  | "error";

interface Shipping {
  method: string;
  cost_myr: number;
  days_min: number;
  days_max: number;
}

interface Product {
  id: string;
  source: SourceId;
  source_label: string;
  title: string;
  price_myr: number;
  total_myr: number;
  shipping: Shipping;
  image: string | null;
  url: string;
  moq: number;
  rating: number | null;
  orders: number | null;
  demo: boolean;
}

/**
 * Product after margin + checkout decoration. `price_myr` / `total_myr` are the
 * customer-facing (marked-up) numbers; supplier_* keep the raw cost.
 */
interface PricedProduct extends Product {
  supplier_price_myr: number;
  supplier_total_myr: number;
  margin_myr: number;
  checkout_url: string;
  whatsapp_url: string;
}

interface Pricing {
  markup_pct: number;
  flat_myr: number;
}

interface KeyStatus {
  key: string;
  configured: boolean;
  detail: string;
}

interface ConfigStatus {
  gemini: KeyStatus;
  cj: KeyStatus;
  aliexpress: KeyStatus;
  whatsapp: KeyStatus;
  pricing: Pricing;
}

interface Intent {
  keyword: string;
  max_price_myr: number | null;
  /** Chat-only: specs kept out of the supplier query. */
  filters?: string[];
  engine: "gemini" | "heuristic";
  model?: string;
  note?: string;
}

interface SourceReport {
  source: SourceId;
  label: string;
  status: SourceStatus;
  latency_ms: number;
  count: number;
  note?: string;
}

interface SourceOutcome {
  report: SourceReport;
  items: Product[];
}

interface SearchPayload {
  ok: true;
  query: string;
  intent: Intent;
  budget: {
    max_price_myr: number | null;
    applied: boolean;
    basis: "price" | "total";
    removed: number;
  };
  results: PricedProduct[];
  pricing: Pricing;
  config: ConfigStatus;
  meta: {
    service: string;
    version: string;
    generated_at: string;
    timing_ms: number;
    count: number;
    partial: boolean;
    sources: SourceReport[];
    floor?: {
      min_total_myr: number | null;
      removed: number;
      skipped: boolean;
    };
  };
}

const SOURCE_META: Record<SourceId, { label: string; short: string }> = {
  cj: { label: "CJ Dropshipping", short: "CJ" },
  aliexpress: { label: "AliExpress", short: "AE" },
};

const DEFAULT_SHIPPING: Record<SourceId, Shipping> = {
  cj: { method: "CJPacket Ordinary", cost_myr: 6.5, days_min: 7, days_max: 12 },
  aliexpress: {
    method: "AliExpress Standard Shipping",
    cost_myr: 4.9,
    days_min: 10,
    days_max: 18,
  },
};

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => Math.round(n * 100) / 100;

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.\-]/g, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function money(n: number): string {
  return "RM " + n.toFixed(2);
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fxRate(env: Env): number {
  const parsed = Number(env.DEFAULT_USD_MYR);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 20) return DEFAULT_FX;
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Currency: 12h rate cache (KV or isolate memory) + Intl formatting    */
/* ------------------------------------------------------------------ */

interface RatesCache {
  rates: Record<string, number>;
  fetched_at: number;
  source: string;
}

const RATE_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_KV_KEY = "currency_rates_myr";
let memoryRates: RatesCache | null = null;

function currencyFrom(raw: string | undefined): CurrencyCode {
  const value = (raw ?? "").toUpperCase();
  return (CURRENCIES as string[]).includes(value)
    ? (value as CurrencyCode)
    : "MYR";
}

async function getRates(env: Env): Promise<RatesCache> {
  const now = Date.now();
  if (memoryRates && now - memoryRates.fetched_at < RATE_TTL_MS) {
    return memoryRates;
  }

  if (env.MYKIRA_KV) {
    try {
      const cached = (await env.MYKIRA_KV.get(
        RATE_KV_KEY,
        "json",
      )) as RatesCache | null;
      if (cached?.rates && now - cached.fetched_at < RATE_TTL_MS) {
        memoryRates = cached;
        return cached;
      }
    } catch {
      // KV is optional — fall through to the network.
    }
  }

  try {
    const res = await fetch("https://open.er-api.com/v6/latest/MYR", {
      signal: timeoutSignal(6000),
    });
    if (res.ok) {
      const data = (await res.json()) as { rates?: Record<string, number> };
      if (data.rates) {
        const cache: RatesCache = {
          rates: data.rates,
          fetched_at: now,
          source: "open.er-api.com",
        };
        memoryRates = cache;
        if (env.MYKIRA_KV) {
          await env.MYKIRA_KV.put(RATE_KV_KEY, JSON.stringify(cache), {
            expirationTtl: 43200,
          });
        }
        return cache;
      }
    }
  } catch {
    // Offline / rate limited: use the fallback table below.
  }

  return { rates: FALLBACK_RATES, fetched_at: now, source: "fallback" };
}

function rateFor(cache: RatesCache, currency: CurrencyCode): number {
  const rate = cache.rates[currency];
  if (typeof rate === "number" && rate > 0) return rate;
  return FALLBACK_RATES[currency] ?? 1;
}

/** Convert an MYR amount; returns round2 of the converted value. */
function convertCurrency(amountMyr: number, rate: number): number {
  return round2(amountMyr * rate);
}

function whatsappUrlFor(
  env: Env,
  product: PricedProduct,
  currency: CurrencyCode,
  rate: number,
  lang: Lang,
): string {
  const total = convertCurrency(product.total_myr, rate);
  const amount =
    currency === "MYR"
      ? formatMoney(total, currency, lang)
      : `${formatMoney(total, currency, lang)} (MYR ${product.total_myr.toFixed(2)})`;

  const lines =
    lang === "en"
      ? [
          "I want to order:",
          `1) ${product.title}`,
          `ID: ${product.id}`,
          `Source: ${product.source_label}`,
          `Total: ${amount}`,
        ]
      : lang === "zh"
        ? [
            "我想下单：",
            `1) ${product.title}`,
            `编号: ${product.id}`,
            `来源: ${product.source_label}`,
            `合计: ${amount}`,
          ]
        : lang === "id"
          ? [
              "Saya mau pesan:",
              `1) ${product.title}`,
              `ID: ${product.id}`,
              `Sumber: ${product.source_label}`,
              `Total: ${amount}`,
            ]
          : [
              "Saya nak order:",
              `1) ${product.title}`,
              `ID: ${product.id}`,
              `Sumber: ${product.source_label}`,
              `Jumlah: ${amount}`,
            ];

  return `https://wa.me/${whatsappNumber(env)}?text=${encodeURIComponent(
    lines.join("\n"),
  )}`;
}

/* ------------------------------------------------------------------ */
/* Trending showcase (cached 15 min, SSR for SEO)                      */
/* ------------------------------------------------------------------ */

const TRENDING_KEYWORDS = [
  "bluetooth speaker",
  "smart watch",
  "wireless earbuds",
];
const TRENDING_TTL_MS = 15 * 60 * 1000;
let trendingCache: { at: number; items: PricedProduct[] } | null = null;

async function getTrending(env: Env): Promise<PricedProduct[]> {
  if (trendingCache && Date.now() - trendingCache.at < TRENDING_TTL_MS) {
    return trendingCache.items;
  }

  // Edge cache keeps repeat visits under the 2s budget across isolates.
  const edgeCache = typeof caches === "undefined" ? null : caches.default;
  const cacheKey = new Request("https://cache.mykira.internal/trending-v3");
  if (edgeCache) {
    try {
      const hit = await edgeCache.match(cacheKey);
      if (hit) {
        const items = (await hit.json()) as PricedProduct[];
        if (Array.isArray(items) && items.length > 0) {
          trendingCache = { at: Date.now(), items };
          return items;
        }
      }
    } catch {
      // Cache API unavailable — continue with a live fetch.
    }
  }

  const lists = await Promise.all(
    TRENDING_KEYWORDS.map(async (keyword) => {
      const intent: Intent = {
        keyword,
        max_price_myr: null,
        engine: "heuristic",
      };
      try {
        const payload = await runSearchWithIntent(env, keyword, intent, 6);
        return payload.results;
      } catch {
        return [] as PricedProduct[];
      }
    }),
  );

  // Round-robin so the showcase mixes speakers, watches and earbuds.
  const merged: PricedProduct[] = [];
  const seen = new Set<string>();
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const item = list[index];
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }

  const items = merged.slice(0, 8);
  if (items.length > 0) {
    trendingCache = { at: Date.now(), items };
    if (edgeCache) {
      try {
        await edgeCache.put(
          cacheKey,
          new Response(JSON.stringify(items), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "max-age=900",
            },
          }),
        );
      } catch {
        // Best-effort only.
      }
    }
  }
  return items;
}

function trendingJsonLd(
  items: PricedProduct[],
  currency: CurrencyCode,
  rate: number,
  lang: Lang,
): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: t(lang, "trending_title"),
    itemListElement: items.map((product, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "Product",
        name: product.title,
        ...(product.image ? { image: product.image } : {}),
        url: `${SITE_URL}${product.checkout_url}`,
        offers: {
          "@type": "Offer",
          price: convertCurrency(product.total_myr, rate).toFixed(2),
          priceCurrency: currency,
          availability: "https://schema.org/InStock",
        },
      },
    })),
  };

  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

function trendingBody(
  env: Env,
  lang: Lang,
  currency: CurrencyCode,
  rate: number,
  items: PricedProduct[],
): string {
  if (items.length === 0) return "";
  const cards = items
    .map((product) => productCard(product, lang, currency, rate, env))
    .join("\n");

  return `<section class="trending" aria-labelledby="trending-title">
  <h2 id="trending-title">${esc(t(lang, "trending_title"))}</h2>
  <p class="tlede">${esc(t(lang, "trending_lede"))}</p>
  <div class="grid">${cards}</div>
  ${trendingJsonLd(items, currency, rate, lang)}
</section>`;
}

/** JSON projection with display_* fields for the selected currency. */
function presentProduct(
  product: PricedProduct,
  env: Env,
  currency: CurrencyCode,
  rate: number,
  lang: Lang,
) {
  return {
    ...product,
    display_currency: currency,
    display_price: formatMoney(
      convertCurrency(product.price_myr, rate),
      currency,
      lang,
    ),
    display_total: formatMoney(
      convertCurrency(product.total_myr, rate),
      currency,
      lang,
    ),
    display_margin: formatMoney(
      convertCurrency(product.margin_myr, rate),
      currency,
      lang,
    ),
    price_display: convertCurrency(product.price_myr, rate),
    total_display: convertCurrency(product.total_myr, rate),
    ...(currency === "MYR"
      ? {}
      : { whatsapp_url: whatsappUrlFor(env, product, currency, rate, lang) }),
  };
}

function formatMoney(
  amount: number,
  currency: CurrencyCode = "MYR",
  lang: Lang = "ms",
): string {
  const locale =
    lang === "zh"
      ? "zh-CN"
      : lang === "id"
        ? "id-ID"
        : CURRENCY_LOCALE[currency];
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "IDR" ? 0 : 2,
      minimumFractionDigits: currency === "IDR" ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/* ------------------------------------------------------------------ */
/* Pricing, checkout links and runtime key status                      */
/* ------------------------------------------------------------------ */

const DEFAULT_WHATSAPP = "60173735431";
const TELEGRAM_BOT = "Mykirashopbot";

/** Pre-filled order text shared by the WhatsApp and Telegram buttons. */
function orderMessage(
  product: PricedProduct,
  lang: Lang,
  currency: CurrencyCode,
  rate: number,
): string {
  const total = convertCurrency(product.total_myr, rate);
  const amount =
    currency === "MYR"
      ? formatMoney(total, currency, lang)
      : `${formatMoney(total, currency, lang)} (MYR ${product.total_myr.toFixed(2)})`;
  const ref = `${product.source_label} ${product.id}`;

  switch (lang) {
    case "en":
      return `Hi @${TELEGRAM_BOT}! I want to order: ${product.title}. Total: ${amount}. Supplier: ${ref}.`;
    case "id":
      return `Hai @${TELEGRAM_BOT}! Saya mau pesan: ${product.title}. Total: ${amount}. Pemasok: ${ref}.`;
    case "zh":
      return `你好 @${TELEGRAM_BOT}！我想下单：${product.title}。合计：${amount}。供应商：${ref}。`;
    default:
      return `Hai @${TELEGRAM_BOT}! Saya nak order: ${product.title}. Jumlah: ${amount}. Pembekal: ${ref}.`;
  }
}

function telegramUrl(text: string): string {
  return `https://t.me/${TELEGRAM_BOT}?text=${encodeURIComponent(text)}`;
}

function pricingFromEnv(env: Env): Pricing {
  const pct = num(env.PRICE_MARKUP_PCT);
  const flat = num(env.PRICE_MARKUP_FLAT_MYR);
  return {
    markup_pct: pct === null ? 20 : clamp(round2(pct), 0, 300),
    flat_myr: flat === null ? 0 : clamp(round2(flat), 0, 1000),
  };
}

function whatsappNumber(env: Env): string {
  const digits = (env.WHATSAPP_ORDER_NUMBER ?? DEFAULT_WHATSAPP).replace(/[^0-9]/g, "");
  return digits.length >= 8 ? digits : DEFAULT_WHATSAPP;
}

function configStatus(env: Env): ConfigStatus {
  const cjUser = (env.CJ_MCP_USER ?? "").trim();
  const cjToken = (env.CJ_MCP_ACCESS_TOKEN ?? env.CJ_API_KEY ?? "").trim();
  const aeKey = (env.ALIEXPRESS_APP_KEY ?? "").trim();
  const aeSecret = (env.ALIEXPRESS_APP_SECRET ?? "").trim();
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  return {
    gemini: {
      key: "GEMINI_API_KEY",
      configured: Boolean(env.GEMINI_API_KEY),
      detail: env.GEMINI_API_KEY ? `model ${model}` : "tiada — intent guna heuristik",
    },
    cj: {
      key: "CJ_API_KEY",
      configured: Boolean(cjUser && cjToken),
      detail:
        cjUser && cjToken
          ? `akaun ${cjUser}`
          : "tiada — CJ guna katalog demo",
    },
    aliexpress: {
      key: "ALIEXPRESS_ADMIN_KEY",
      configured: Boolean(
        (env.ALIEXPRESS_ADMIN_KEY ?? "").trim() || (aeKey && aeSecret),
      ),
      detail: (env.ALIEXPRESS_ADMIN_KEY ?? "").trim()
        ? "live via MyKiraShop gateway"
        : aeKey && aeSecret
          ? "kredensial ada · perlu kebenaran Affiliate API"
          : "tiada — AE guna katalog demo",
    },
    whatsapp: {
      key: "WHATSAPP_ORDER_NUMBER",
      configured: true,
      detail: `+${whatsappNumber(env)}`,
    },
    pricing: pricingFromEnv(env),
  };
}

/**
 * Margin = (supplier price + supplier shipping) * pct + flat.
 * Shipping is passed through at cost; the unit price carries the margin so the
 * landed total always equals supplier total + margin.
 */
function applyMargin(
  supplierPrice: number,
  supplierShipping: number,
  pricing: Pricing,
): { supplier_price: number; supplier_total: number; price: number; total: number; margin: number } {
  const supplierTotal = round2(supplierPrice + supplierShipping);
  const margin = round2(supplierTotal * (pricing.markup_pct / 100) + pricing.flat_myr);
  const price = round2(supplierPrice + margin);
  return {
    supplier_price: round2(supplierPrice),
    supplier_total: supplierTotal,
    price,
    total: round2(price + supplierShipping),
    margin: round2(price - supplierPrice),
  };
}

function whatsappOrderUrl(env: Env, product: Product, total: number): string {
  const text = [
    "Saya nak order:",
    `1) ${product.title}`,
    `ID: ${product.id}`,
    `Sumber: ${product.source_label}`,
    `Harga: ${money(total)} (termasuk pos)`,
  ].join("\n");
  return `https://wa.me/${whatsappNumber(env)}?text=${encodeURIComponent(text)}`;
}

function priceProduct(
  product: Product,
  env: Env,
  pricing: Pricing,
  query: string,
): PricedProduct {
  const margin = applyMargin(
    product.price_myr,
    product.shipping.cost_myr,
    pricing,
  );
  const params = new URLSearchParams({
    source: product.source,
    id: product.id,
    title: product.title.slice(0, 120),
    base: margin.supplier_total.toFixed(2),
    q: query,
  });

  return {
    ...product,
    price_myr: margin.price,
    total_myr: margin.total,
    supplier_price_myr: margin.supplier_price,
    supplier_total_myr: margin.supplier_total,
    margin_myr: margin.margin,
    checkout_url: `/checkout?${params.toString()}`,
    whatsapp_url: whatsappOrderUrl(env, product, margin.total),
  };
}

/* ------------------------------------------------------------------ */
/* Content negotiation                                                 */
/* ------------------------------------------------------------------ */

function wantsJson(c: Context): boolean {
  const format = (c.req.query("format") ?? "").toLowerCase();
  if (format === "json") return true;
  if (format === "html") return false;

  const accept = (c.req.header("accept") ?? "").toLowerCase();
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return true;
  }
  if (accept.includes("text/html") || accept.includes("application/xhtml")) {
    return false;
  }

  // No useful Accept header (curl, fetch, bots) -> JSON.
  const ua = (c.req.header("user-agent") ?? "").toLowerCase();
  if (ua === "") return true;
  return /curl|wget|python|httpx|axios|node-fetch|okhttp|go-http-client|java|bot|spider|crawler|postman/.test(
    ua,
  );
}

/* ------------------------------------------------------------------ */
/* Intent extraction                                                   */
/* ------------------------------------------------------------------ */

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

const INTENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    keyword: {
      type: "STRING",
      description:
        "Product search keyword in English, 1-6 words. Keep brand/model names. Drop filler words.",
    },
    max_price_myr: {
      type: "NUMBER",
      nullable: true,
      description:
        "Maximum budget in Malaysian Ringgit (MYR). Convert USD values (x4.72). Null when no budget is stated.",
    },
  },
  required: ["keyword", "max_price_myr"],
  propertyOrdering: ["keyword", "max_price_myr"],
};

function intentPrompt(query: string): string {
  return [
    "You are the query parser for MyKiraNiaga, a Malaysian dropshipping search engine.",
    "Extract the shopping intent from the user's raw search query.",
    "",
    "Rules:",
    "- keyword: short product keyword in English (2-6 words). Translate Malay/Chinese product words to English.",
    "- max_price_myr: numeric budget ceiling in MYR. If the user writes USD or $, multiply by 4.72.",
    "- Accept Malay money phrases: bawah RM50, bajet 30, maksimum 80, kurang dari 100.",
    "- If no budget is mentioned, max_price_myr must be null. Never invent a budget.",
    "- Remove filler: cari, tolong, saya nak, for, under, below, murah.",
    "",
    'Examples:',
    '- "cari mini projector bawah RM80" -> {"keyword":"mini projector","max_price_myr":80}',
    '- "wireless earbuds under $20" -> {"keyword":"wireless earbuds","max_price_myr":94.4}',
    '- "beg kanvas" -> {"keyword":"canvas bag","max_price_myr":null}',
    "",
    "Reply with JSON only. Query:",
    JSON.stringify(query),
  ].join("\n");
}

function parseIntentJson(text: string): {
  keyword: string;
  max_price_myr: number | null;
} | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const row = parsed as Record<string, unknown>;
  const keyword = str(row.keyword).replace(/\s+/g, " ").slice(0, 120);
  if (!keyword) return null;

  const rawPrice = num(row.max_price_myr);
  const maxPrice =
    rawPrice !== null && rawPrice > 0 && rawPrice < 1_000_000
      ? round2(rawPrice)
      : null;

  return { keyword, max_price_myr: maxPrice };
}

function heuristicIntent(query: string): Intent {
  const q = query.trim();
  let maxPrice: number | null = null;

  const patterns: Array<{ re: RegExp; currency: "MYR" | "USD" }> = [
    { re: /(?:rm|myr)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i, currency: "MYR" },
    { re: /(?:usd|us\$)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i, currency: "USD" },
    { re: /\$\s*([0-9]+(?:[.,][0-9]{1,2})?)/i, currency: "USD" },
    {
      re: /(?:under|below|bawah|bajet|budget|max|maks|maksimum|kurang\s+dari|<\s*)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i,
      currency: "MYR",
    },
  ];

  for (const { re, currency } of patterns) {
    const match = q.match(re);
    if (!match || !match[1]) continue;
    const value = Number(match[1].replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) continue;
    maxPrice = round2(currency === "USD" ? value * DEFAULT_FX : value);
    break;
  }

  const keyword = q
    .replace(/(?:rm|myr|usd|us\$|\$)\s*[0-9]+(?:[.,][0-9]{1,2})?/gi, " ")
    .replace(
      /\b(?:under|below|bawah|bajet|budget|max|maks|maksimum|kurang\s+dari)\b/gi,
      " ",
    )
    .replace(
      /\b(?:cari|carikan|search|find|tolong|please|saya|nak|want|dropship|untuk|for|murah|cheap|tunjuk|tunjukkan|senarai|senaraikan|show|recommend|cadang|cadangkan|syorkan|beli)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:\-–—]+|[\s,.;:\-–—]+$/g, "")
    .trim();

  return {
    keyword: (keyword || q).slice(0, 120),
    max_price_myr: maxPrice,
    engine: "heuristic",
  };
}

async function extractIntent(env: Env, query: string): Promise<Intent> {
  const fallback = heuristicIntent(query);
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      ...fallback,
      note: "GEMINI_API_KEY not configured — heuristic parser used",
    };
  }

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const errors: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(
        `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: intentPrompt(query) }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 200,
              responseMimeType: "application/json",
              responseSchema: INTENT_SCHEMA,
            },
          }),
          signal: timeoutSignal(7000),
        },
      );

      if (!res.ok) {
        let detail = "";
        try {
          const err = (await res.json()) as {
            error?: { status?: string; message?: string };
          };
          detail = err.error?.status || err.error?.message?.slice(0, 90) || "";
        } catch {
          detail = "";
        }
        errors.push(
          `${model}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`.slice(0, 120),
        );
        // 400 also proves transient here: the identical body succeeds on retry.
        const retryable =
          res.status === 400 || res.status === 429 || res.status >= 500;
        if (retryable && attempt < 3) {
          await sleep(350 * attempt);
          continue;
        }
        break;
      }

      const data = (await res.json()) as GeminiResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();

      const parsed = parseIntentJson(text);
      if (parsed) {
        return { ...parsed, engine: "gemini", model };
      }
      errors.push(`${model}: unparseable response`);
      break;
    } catch (error) {
      errors.push(
        `${model}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt < 3) {
        await sleep(400);
        continue;
      }
      break;
    }
  }

  return {
    ...fallback,
    note:
      errors.join(" | ").slice(0, 180) || "Gemini unavailable — heuristic parser used",
  };
}

/* ------------------------------------------------------------------ */
/* Source adapters                                                     */
/* ------------------------------------------------------------------ */

function emptyReport(
  source: SourceId,
  status: SourceStatus,
  latency: number,
  note?: string,
): SourceReport {
  return {
    source,
    label: SOURCE_META[source].label,
    status,
    latency_ms: latency,
    count: 0,
    ...(note ? { note } : {}),
  };
}

/** Deterministic hash so demo rows stay stable between requests. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Placeholder catalogue: no network, deterministic, clearly marked demo:true.
 * Used whenever a source has no credentials so the product page still renders.
 */
function demoProducts(source: SourceId, keyword: string, fx: number): Product[] {
  const baseKeyword = keyword || "product";
  const suffixes =
    source === "cj"
      ? ["Portable Mini", "Pro Set", "Rechargeable", "Compact Edition"]
      : ["Premium", "2-in-1 Combo", "Travel Size", "Value Bundle"];

  const seed = hash(`${source}:${baseKeyword.toLowerCase()}`);
  const shipping = DEFAULT_SHIPPING[source];
  const searchUrl =
    source === "cj"
      ? `https://www.cjdropshipping.com/search.html?productNameEn=${encodeURIComponent(baseKeyword)}`
      : `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(baseKeyword)}`;

  const floorRule = categoryRuleFor(baseKeyword);

  return suffixes.map((suffix, index) => {
    const priceUsd = 3.8 + ((seed >> (index * 3)) % 26) + index * 2.15;
    let price = round2(priceUsd * fx);
    // Demo data should look like the real category, not accessories.
    if (floorRule) {
      const floor = round2(
        floorRule.min_total_myr * (1.15 + index * 0.2) + (seed % 40),
      );
      if (price < floor) price = floor;
    }
    return {
      id: `${source}-demo-${hash(`${source}${baseKeyword}${index}`) % 1000000}`,
      source,
      source_label: SOURCE_META[source].label,
      title: `${titleCase(baseKeyword)} ${suffix}`,
      price_myr: price,
      total_myr: round2(price + shipping.cost_myr),
      shipping,
      image: null,
      url: searchUrl,
      moq: 1,
      rating: round2(4.3 + ((seed >> index) % 60) / 100),
      orders: 40 + ((seed >> (index + 2)) % 900),
      demo: true,
    };
  });
}

/** CJ prices arrive as "28.62" or a range "7.35 -- 16.40" (USD). Take the low end. */
function parseCjPrice(raw: string): number | null {
  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function cjImage(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("http")) return raw;
  return null;
}

/**
 * CJ ships an MCP server (cj-dropshipping-mcp 1.1.0). The legacy API-key URL is
 * retired; the supported stateless form is /mcp/API@<userId>@CJ:<accessToken>.
 * No session header is issued, so each tools/call is a single POST.
 */
function cjMcpEndpoint(env: Env): string | null {
  const user = (env.CJ_MCP_USER ?? "").trim();
  const token = (env.CJ_MCP_ACCESS_TOKEN ?? env.CJ_API_KEY ?? "").trim();
  if (!user || !token) return null;
  return `https://developers.cjdropshipping.com/mcp/API@${user}@CJ:${token}`;
}

async function searchCj(env: Env, keyword: string, fx: number): Promise<SourceOutcome> {
  const started = Date.now();
  const endpoint = cjMcpEndpoint(env);

  if (!endpoint) {
    const items = demoProducts("cj", keyword, fx);
    return {
      report: {
        ...emptyReport(
          "cj",
          "placeholder",
          Date.now() - started,
          "CJ_MCP_USER / CJ_MCP_ACCESS_TOKEN not set — demo catalogue",
        ),
        count: items.length,
      },
      items,
    };
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2024-11-05",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_products",
          arguments: { keyword },
        },
      }),
      signal: timeoutSignal(12000),
    });

    if (!res.ok) {
      return {
        report: emptyReport(
          "cj",
          "error",
          Date.now() - started,
          `CJ MCP HTTP ${res.status}`,
        ),
        items: [],
      };
    }

    const data = (await res.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    };

    if (data.error) {
      return {
        report: emptyReport(
          "cj",
          "error",
          Date.now() - started,
          `CJ MCP: ${data.error.message ?? "rpc error"}`.slice(0, 160),
        ),
        items: [],
      };
    }

    // Tool output is prose + JSON ("📋 Found N products total. {...}").
    const text = (data.result?.content ?? [])
      .map((part) => part.text ?? "")
      .join("\n");
    const start = text.indexOf("{");
    if (start === -1) {
      return {
        report: emptyReport(
          "cj",
          "error",
          Date.now() - started,
          `CJ MCP: ${(text || "empty tool output").slice(0, 140)}`,
        ),
        items: [],
      };
    }

    const payload = JSON.parse(text.slice(start)) as Record<string, unknown>;
    const content = Array.isArray(payload.content)
      ? (payload.content as Array<Record<string, unknown>>)
      : [];
    const first = content[0] ?? {};
    const rows = Array.isArray(first.productList)
      ? (first.productList as Array<Record<string, unknown>>)
      : [];

    const items: Product[] = [];
    for (const row of rows) {
      const title = str(pick(row, ["nameEn", "productNameEn", "name"]));
      const id = str(pick(row, ["id", "pid"]));
      const priceUsd = parseCjPrice(str(pick(row, ["sellPrice", "nowPrice"])));
      if (!title || priceUsd === null) continue;

      const shipping = DEFAULT_SHIPPING.cj;
      const price = round2(priceUsd * fx);
      const moq = num(pick(row, ["directMinOrderNum", "moq"]));

      items.push({
        id: id || `cj-${hash(title)}`,
        source: "cj",
        source_label: SOURCE_META.cj.label,
        title,
        price_myr: price,
        total_myr: round2(price + shipping.cost_myr),
        shipping,
        image: cjImage(str(pick(row, ["bigImage", "productImage", "image"]))),
        url: id
          ? `https://www.cjdropshipping.com/product/-p-${id}.html`
          : `https://www.cjdropshipping.com/search.html?productNameEn=${encodeURIComponent(keyword)}`,
        moq: moq && moq > 0 ? moq : 1,
        rating: null,
        orders: null,
        demo: false,
      });
    }

    return {
      report: {
        ...emptyReport("cj", items.length ? "ok" : "empty", Date.now() - started),
        count: items.length,
      },
      items,
    };
  } catch (error) {
    return {
      report: emptyReport(
        "cj",
        "error",
        Date.now() - started,
        (error instanceof Error ? error.message : "CJ fetch failed").slice(0, 160),
      ),
      items: [],
    };
  }
}

/** AliExpress Open Platform signature: HMAC-SHA256 over sorted key+value, UPPERCASE hex. */
async function aliexpressSign(
  params: Record<string, string>,
  secret: string,
): Promise<string> {
  const base = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** AliExpress expects GMT+8 timestamps: yyyy-MM-dd HH:mm:ss */
function aliexpressTimestamp(): string {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace("T", " ").slice(0, 19);
}

const AE_GATEWAY_DEFAULT = "https://mykirashop.mykira.workers.dev/aliexpress/search";

function aeGatewayUrl(env: Env): string | null {
  const key = (env.ALIEXPRESS_ADMIN_KEY ?? "").trim();
  if (!key) return null;
  return (env.ALIEXPRESS_GATEWAY_URL ?? AE_GATEWAY_DEFAULT).trim() || null;
}

/**
 * Primary AliExpress path: a Drop Shipping app gets `InsufficientPermission` on
 * the affiliate API and `IllegalAccessToken` on ds.* without a seller OAuth
 * token, so we reuse the MyKiraShop gateway which already owns a refreshed
 * AliExpress token. Prices are requested in MYR, so no FX conversion is needed.
 */
async function searchAliExpressGateway(
  env: Env,
  keyword: string,
  started: number,
): Promise<SourceOutcome | null> {
  const url = aeGatewayUrl(env);
  if (!url) return null;

  try {
    const endpoint = new URL(url);
    endpoint.searchParams.set("keyword", keyword);
    endpoint.searchParams.set("countryCode", "MY");
    endpoint.searchParams.set("currency", "MYR");
    endpoint.searchParams.set("pageSize", "20");

    const headers = {
      "x-admin-key": (env.ALIEXPRESS_ADMIN_KEY ?? "").trim(),
      Accept: "application/json",
    };

    // A Worker fetching another workers.dev host on the same zone resolves to
    // the zone route (404). The service binding bypasses the public edge.
    const res = env.MYKIRASHOP
      ? await env.MYKIRASHOP.fetch(
          new Request(
            `https://mykirashop/aliexpress/search${endpoint.search}`,
            { headers },
          ),
        )
      : await fetch(endpoint.toString(), {
          headers,
          signal: timeoutSignal(15000),
        });

    if (!res.ok) {
      return {
        report: emptyReport(
          "aliexpress",
          "error",
          Date.now() - started,
          `AE gateway HTTP ${res.status}`,
        ),
        items: [],
      };
    }

    const data = (await res.json()) as {
      success?: boolean;
      message?: string;
      products?: Array<Record<string, unknown>>;
    };

    if (!data.success) {
      return {
        report: emptyReport(
          "aliexpress",
          "error",
          Date.now() - started,
          `AE gateway: ${String(data.message ?? "unknown error").slice(0, 140)}`,
        ),
        items: [],
      };
    }

    const rows = Array.isArray(data.products) ? data.products : [];
    const shipping = DEFAULT_SHIPPING.aliexpress;
    const items: Product[] = [];

    for (const row of rows) {
      const title = str(row.title);
      const id = str(pick(row, ["itemId", "item_id", "product_id"]));
      const price = num(pick(row, ["price", "salePrice", "target_sale_price"]));
      if (!title || price === null || price <= 0) continue;

      let image = str(pick(row, ["image", "itemMainPic"])) || null;
      if (image && image.startsWith("//")) image = `https:${image}`;

      let productUrl = str(pick(row, ["itemUrl", "product_detail_url"]));
      if (productUrl.startsWith("//")) productUrl = `https:${productUrl}`;
      if (!productUrl && id) {
        productUrl = `https://www.aliexpress.com/item/${encodeURIComponent(id)}.html`;
      }

      items.push({
        id: id || `ae-${hash(title)}`,
        source: "aliexpress",
        source_label: SOURCE_META.aliexpress.label,
        title,
        price_myr: round2(price),
        total_myr: round2(price + shipping.cost_myr),
        shipping,
        image,
        url: productUrl,
        moq: 1,
        rating: num(pick(row, ["evaluateRate", "score", "rating"])),
        orders: num(pick(row, ["orders", "lastest_volume"])),
        demo: false,
      });
    }

    return {
      report: {
        ...emptyReport(
          "aliexpress",
          items.length ? "ok" : "empty",
          Date.now() - started,
        ),
        count: items.length,
        ...(items.length ? { note: "via MyKiraShop gateway" } : {}),
      },
      items,
    };
  } catch (error) {
    return {
      report: emptyReport(
        "aliexpress",
        "error",
        Date.now() - started,
        `AE gateway: ${
          error instanceof Error ? error.message : "fetch failed"
        }`.slice(0, 160),
      ),
      items: [],
    };
  }
}

async function searchAliExpress(
  env: Env,
  keyword: string,
  fx: number,
): Promise<SourceOutcome> {
  const started = Date.now();

  const viaGateway = await searchAliExpressGateway(env, keyword, started);
  if (viaGateway) return viaGateway;

  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET) {
    const items = demoProducts("aliexpress", keyword, fx);
    return {
      report: {
        ...emptyReport(
          "aliexpress",
          "placeholder",
          Date.now() - started,
          "AliExpress credentials not set — demo catalogue",
        ),
        count: items.length,
      },
      items,
    };
  }

  // TODO(aliexpress): validate method + params against the affiliate API docs.
  // Placeholder for aliexpress.affiliate.product.query via the sync gateway.
  try {
    const base = env.ALIEXPRESS_BASE_URL || "https://api-sg.aliexpress.com/sync";
    const params: Record<string, string> = {
      app_key: env.ALIEXPRESS_APP_KEY,
      method: "aliexpress.affiliate.product.query",
      format: "json",
      v: "2.0",
      sign_method: "sha256",
      timestamp: aliexpressTimestamp(),
      keywords: keyword,
      target_currency: "MYR",
      target_language: "EN",
      page_size: "20",
      page_no: "1",
      ...(env.ALIEXPRESS_TRACKING_ID
        ? { tracking_id: env.ALIEXPRESS_TRACKING_ID }
        : {}),
    };
    params.sign = await aliexpressSign(params, env.ALIEXPRESS_APP_SECRET);

    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: timeoutSignal(8000),
    });

    if (!res.ok) {
      return {
        report: emptyReport(
          "aliexpress",
          "error",
          Date.now() - started,
          `AliExpress API HTTP ${res.status}`,
        ),
        items: [],
      };
    }

    const data = (await res.json()) as Record<string, unknown>;

    // The gateway answers HTTP 200 even for permission/parameter errors.
    const apiError = (data.error_response ?? {}) as Record<string, unknown>;
    if (apiError && Object.keys(apiError).length > 0) {
      const code = str(pick(apiError, ["code", "type"])) || "error";
      const message =
        str(pick(apiError, ["msg", "message"])) || "AliExpress rejected the call";
      return {
        report: emptyReport(
          "aliexpress",
          "error",
          Date.now() - started,
          `AliExpress ${code}: ${message}${code === "InsufficientPermission" ? " (enable Affiliate API in Open Platform)" : ""}`.slice(0, 200),
        ),
        items: [],
      };
    }

    const response = (data.aliexpress_affiliate_product_query_response ??
      {}) as Record<string, unknown>;
    const result = (response.resp_result ?? {}) as Record<string, unknown>;
    const nested = (result.result ?? {}) as Record<string, unknown>;
    const productNode = nested.products as unknown;
    const productList = (productNode ?? {}) as Record<string, unknown>;
    const rows = (
      Array.isArray(productNode)
        ? productNode
        : Array.isArray(productList.product)
          ? (productList.product as unknown[])
          : []
    ) as Array<Record<string, unknown>>;

    const items: Product[] = [];
    for (const row of rows) {
      const title = str(pick(row, ["product_title", "title"]));
      const id = str(pick(row, ["product_id", "productId"]));
      if (!title) continue;

      const price = num(pick(row, ["target_sale_price", "sale_price"]));
      if (price === null) continue;

      const shipping = DEFAULT_SHIPPING.aliexpress;
      const itemPrice = round2(price);
      items.push({
        id: id || `ae-${hash(title)}`,
        source: "aliexpress",
        source_label: SOURCE_META.aliexpress.label,
        title,
        price_myr: itemPrice,
        total_myr: round2(itemPrice + shipping.cost_myr),
        shipping,
        image:
          str(pick(row, ["product_main_image_url", "image_url"])) || null,
        url:
          str(pick(row, ["promotion_link", "product_detail_url"])) ||
          `https://www.aliexpress.com/item/${encodeURIComponent(id)}.html`,
        moq: 1,
        rating: num(pick(row, ["evaluate_rate"])),
        orders: num(pick(row, ["lastest_volume", "orders"])),
        demo: false,
      });
    }

    return {
      report: {
        ...emptyReport(
          "aliexpress",
          items.length ? "ok" : "empty",
          Date.now() - started,
        ),
        count: items.length,
      },
      items,
    };
  } catch (error) {
    return {
      report: emptyReport(
        "aliexpress",
        "error",
        Date.now() - started,
        error instanceof Error ? error.message : "AliExpress fetch failed",
      ),
      items: [],
    };
  }
}

/* ------------------------------------------------------------------ */
/* Search pipeline                                                     */
/* ------------------------------------------------------------------ */

function applyBudget(
  items: PricedProduct[],
  cap: number | null,
  basis: "price" | "total",
): { items: PricedProduct[]; removed: number } {
  if (cap === null) return { items, removed: 0 };
  const kept = items.filter((item) =>
    basis === "total" ? item.total_myr <= cap : item.price_myr <= cap,
  );
  return { items: kept, removed: items.length - kept.length };
}

interface CategoryRule {
  test: RegExp;
  min_total_myr: number;
  exclude?: RegExp;
}

/** High-value categories: a floor keeps accessories (stands, covers) out. */
const CATEGORY_RULES: CategoryRule[] = [
  {
    test: /\b(laptop|notebook|macbook|ultrabook)\b/i,
    min_total_myr: 300,
    exclude:
      /\b(case|cover|sleeve|skin|stand|mount|holder|bag|mousepad|mat|sticker|dock|charger|adapter|cooling|pad)\b/i,
  },
  {
    test: /\b(monitor|display)\b/i,
    min_total_myr: 250,
    exclude: /\b(stand|mount|arm|cover|cleaner)\b/i,
  },
  {
    test: /\b(smartphone|phone|iphone|android)\b/i,
    min_total_myr: 250,
    exclude: /\b(case|cover|glass|tempered|holder|ring|strap)\b/i,
  },
  {
    test: /\b(tablet|ipad)\b/i,
    min_total_myr: 200,
    exclude: /\b(case|cover|sleeve|stand)\b/i,
  },
  {
    test: /\b(camera|lens)\b/i,
    min_total_myr: 150,
    exclude: /\b(strap|bag|case|cover|cap|filter)\b/i,
  },
  {
    test: /\b(projector)\b/i,
    min_total_myr: 100,
    exclude: /\b(mount|screen|stand|bag)\b/i,
  },
  {
    test: /\b(gpu|graphics card|rtx|gtx)\b/i,
    min_total_myr: 200,
  },
  {
    // A bare "chainsaw" search returns chains, files and sharpening bits.
    test: /\b(chainsaw|chain saw)\b/i,
    min_total_myr: 120,
    exclude:
      /\b(chain|chains|blade|blades|sharpening|sharpener|bit|bits|guide|plate|bar|bars|file|files|oil|helmet|glove|gloves|bag|case|cover|sprocket|rim|tension|accessor|accessories|part|parts|repair|kit|manga|figure|poster|toy|sticker)\b/i,
  },
  {
    test: /\b(drill|driver)\b/i,
    min_total_myr: 80,
    exclude:
      /\b(bit|bits|chuck|charger|battery only|case|bag|stand|holder|accessor|accessories)\b/i,
  },
];

function categoryRuleFor(keyword: string): CategoryRule | null {
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(keyword)) return rule;
  }
  return null;
}

function applyCategoryFloor(
  items: PricedProduct[],
  keyword: string,
  cap: number | null,
): { items: PricedProduct[]; min_total_myr: number | null; removed: number; skipped: boolean } {
  const rule = categoryRuleFor(keyword);
  if (!rule) {
    return { items, min_total_myr: null, removed: 0, skipped: false };
  }
  // A budget below the floor wins: the user explicitly asked for cheap items.
  if (cap !== null && cap < rule.min_total_myr) {
    return { items, min_total_myr: rule.min_total_myr, removed: 0, skipped: true };
  }

  const kept = items.filter(
    (item) =>
      item.total_myr >= rule.min_total_myr &&
      !(rule.exclude ? rule.exclude.test(item.title) : false),
  );

  return {
    items: kept,
    min_total_myr: rule.min_total_myr,
    removed: items.length - kept.length,
    skipped: false,
  };
}

async function runSearchWithIntent(
  env: Env,
  rawQuery: string,
  intent: Intent,
  limit: number,
): Promise<SearchPayload> {
  const started = Date.now();
  const fx = fxRate(env);
  const pricing = pricingFromEnv(env);
  const config = configStatus(env);

  const keyword = intent.keyword || rawQuery;
  const apiKeyword = supplierQuery(keyword);

  // Parallel, non-throwing adapters (supplier-level prices).
  const [cj, aliexpress] = await Promise.all([
    searchCj(env, apiKeyword, fx),
    searchAliExpress(env, apiKeyword, fx),
  ]);

  // Single margin + checkout pass so every source obeys the same rules.
  const priced = [...cj.items, ...aliexpress.items]
    .map((item) => priceProduct(item, env, pricing, rawQuery))
    .sort((a, b) => a.total_myr - b.total_myr);

  const floor = applyCategoryFloor(priced, keyword, intent.max_price_myr);
  const budget = applyBudget(floor.items, intent.max_price_myr, "total");
  const results = budget.items.slice(0, clamp(limit, 1, MAX_RESULTS));

  const sources = [cj.report, aliexpress.report];
  const partial = sources.some(
    (source) => source.status === "error" || source.status === "empty",
  );

  return {
    ok: true,
    query: rawQuery,
    intent,
    pricing,
    config,
    budget: {
      max_price_myr: intent.max_price_myr,
      applied: intent.max_price_myr !== null,
      basis: "total",
      removed: budget.removed,
    },
    results,
    meta: {
      service: SERVICE,
      version: VERSION,
      generated_at: new Date().toISOString(),
      timing_ms: Date.now() - started,
      count: results.length,
      partial,
      sources,
      floor: {
        min_total_myr: floor.min_total_myr,
        removed: floor.removed,
        skipped: floor.skipped,
      },
    },
  };
}
async function runSearch(env: Env, rawQuery: string, limit: number): Promise<SearchPayload> {
  const intent = await extractIntent(env, rawQuery);
  return runSearchWithIntent(env, rawQuery, intent, limit);
}

/* ------------------------------------------------------------------ */
/* Conversational chat (multi-turn Gemini memory + agentic rendering)  */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatResult {
  reply: string;
  keyword: string | null;
  max_price_myr: number | null;
  /** Specs/attributes kept OUT of the supplier query (nvidia, ryzen 7, 16gb…). */
  filters: string[];
  /** True when the user explicitly asked to see products now. */
  explicit: boolean;
  ready: boolean;
  engine: "gemini" | "heuristic";
  model?: string;
  note?: string;
}

const CHAT_MAX_TURNS = 12;

/** Attribute tokens that must never leak into the API search string. */
const SPEC_TOKENS = [
  "nvidia",
  "rtx",
  "gtx",
  "radeon",
  "ryzen",
  "intel",
  "core i3",
  "core i5",
  "core i7",
  "core i9",
  "i5",
  "i7",
  "i9",
  "ssd",
  "hdd",
  "nvme",
  "8gb",
  "16gb",
  "32gb",
  "oled",
  "ips",
  "144hz",
  "120hz",
  "touchscreen",
  "bluetooth",
  "wireless",
  "waterproof",
  "stainless",
  "cotton",
  "leather",
  "samsung",
  "xiaomi",
  "asus",
  "lenovo",
  "dell",
  "acer",
];

const PRODUCT_MODIFIERS = [
  "gaming",
  "mini",
  "portable",
  "wireless",
  "smart",
  "best",
  "cheap",
  "murah",
  "premium",
  "professional",
  "original",
  "new",
  "rechargeable",
  "foldable",
  "compact",
  "bluetooth",
];

/** Reduce a keyword to the base product noun ("gaming laptop" -> "laptop"). */
function baseProductNoun(keyword: string): string {
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => !PRODUCT_MODIFIERS.includes(word));
  const result = (kept.length ? kept : words).join(" ").trim();
  return result || keyword;
}

/** Normalise the supplier query: a bare "laptop" returns accessories on CJ/AE. */
const SUPPLIER_QUERY: Record<string, string> = {
  laptop: "laptop computer",
  notebook: "laptop computer",
  tablet: "tablet pc",
  phone: "smartphone",
  smartphone: "smartphone",
  monitor: "computer monitor",
  gpu: "graphics card",
  camera: "digital camera",
  chainsaw: "electric chainsaw",
  "chain saw": "electric chainsaw",
  drill: "electric drill",
  grinder: "angle grinder",
};

function supplierQuery(keyword: string): string {
  const key = keyword.toLowerCase().trim();
  return SUPPLIER_QUERY[key] ?? keyword;
}

const SEARCH_VERBS =
  /\b(cari|carikan|tunjuk|tunjukkan|senarai|senaraikan|show|find|search|recommend|cadang|cadangkan|syorkan|beli|nak\s+beli)\b/i;

function extractFilters(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const token of SPEC_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(lower)) {
      if (!hits.includes(token)) hits.push(token);
    }
  }
  return hits.slice(0, 6);
}

function parseFilters(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const value = str(item).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);
    if (!value || value.length < 2 || out.includes(value)) continue;
    out.push(value);
    if (out.length >= 6) break;
  }
  return out;
}

/** Remove filter tokens from a keyword so the API only receives the product noun. */
function stripFilters(keyword: string, filters: string[]): string {
  let out = keyword;
  for (const filter of filters) {
    const escaped = filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|\\s)${escaped}(\\s|$)`, "gi"), " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Soft re-rank: products whose title matches requested specs float to the top. */
function rankByFilters(items: PricedProduct[], filters: string[]): PricedProduct[] {
  if (!filters.length) return items;
  const score = (item: PricedProduct): number => {
    const title = item.title.toLowerCase();
    return filters.reduce(
      (total, filter) => total + (title.includes(filter) ? 1 : 0),
      0,
    );
  };
  return [...items].sort((a, b) => score(b) - score(a));
}

const CHAT_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: {
      type: "STRING",
      description:
        "Short conversational reply in the user's language (Malay or English), max 2 sentences. Ask exactly one clarifying question when something is missing.",
    },
    keyword: {
      type: "STRING",
      nullable: true,
      description:
        "Main product noun only, in English, 2-4 words (e.g. 'gaming laptop', 'wireless earbuds'). Never include brands, specs, attributes, budget words, currency or numbers.",
    },
    max_price_myr: {
      type: "NUMBER",
      nullable: true,
      description:
        "Budget ceiling in MYR. Convert USD with x4.72. Null when the user has not given a budget.",
    },
    filters: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Specs/attributes the user asked for (brand, GPU, CPU, RAM, size, colour). Lowercase tokens such as ['nvidia','rtx 4060','16gb']. These are NOT part of the search query. Empty array when none.",
    },
    explicit: {
      type: "BOOLEAN",
      description:
        "True ONLY when the user clearly wants to see products right now (cari, tunjuk, show me, recommend, senaraikan, nak beli) or asks for a concrete product to purchase.",
    },
  },
  required: ["reply", "keyword", "max_price_myr", "filters", "explicit"],
  propertyOrdering: ["reply", "keyword", "max_price_myr", "filters", "explicit"],
};

const CHAT_PERSONA: Record<Lang, string> = {
  ms: "Anda adalah Personal Shopper MyKiraShop yang cekap dan mesra.",
  en: "You are MyKiraShop's efficient and friendly Personal Shopper.",
  id: "Anda adalah Asisten Personal Shopper MyKiraShop yang ramah. Jawab dalam Bahasa Indonesia.",
  zh: "你是MyKiraShop的高效私人购物助理。请用中文回复。",
};

function chatSystemPrompt(
  lang: Lang,
  currency: CurrencyCode = "MYR",
  rate = 1,
): string {
  const currencyLine =
    currency === "MYR"
      ? "The user's currency is MYR (Malaysian Ringgit)."
      : `The user's currency is ${currency}; 1 MYR = ${rate} ${currency}. When the user quotes a budget, convert it to MYR for max_price_myr. Reply about prices in ${currency}.`;

  return [
    CHAT_PERSONA[lang],
    "",
    currencyLine,
    "",
    "Return JSON with: reply, keyword, max_price_myr, filters, explicit.",
    `- reply: 1-2 short sentences, entirely in ONE language (${
      lang === "zh" ? "Chinese" : lang === "id" ? "Indonesian" : lang === "en" ? "English" : "Malay"
    }). Never mix languages.`,
    "- keyword: the MAIN PRODUCT NOUN only (2-4 words, English): 'gaming laptop', 'wireless earbuds'. Keep the previous keyword when the user only adds a spec or a budget. Never include brands, specs, attributes, budget words, currency or numbers.",
    "- filters: specs/attributes the user wants (brand, GPU, CPU, RAM, size, colour) as lowercase tokens. These are NEVER part of the search query.",
    "- max_price_myr: numeric MYR budget (convert from the user's currency when needed); null if not given.",
    "- explicit: true ONLY when the user clearly wants to see products now (cari, tunjuk, show me, recommend, senaraikan, nak beli) or asks for a concrete product to purchase.",
    "",
    "Conversation rules:",
    "- Do NOT confirm a search just because the product is known. First ask for a budget or a key requirement.",
    "- If the user only adds a spec (e.g. 'ada nvidia'), acknowledge that spec naturally and ask for a budget. Do NOT announce that you are searching.",
    "- Once the product and a budget (or an explicit request) exist, confirm the search briefly.",
    "- If the product is still vague, ask ONE short clarifying question.",
    "- Never invent prices, stock or shipping.",
    "- No markdown, emojis or multi-line lists.",
  ].join("\n");
}

function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const role = str(row.role).toLowerCase();
    const content = str(row.content || row.text).slice(0, 1000).trim();
    if (!content) continue;
    if (role !== "user" && role !== "assistant" && role !== "model") continue;
    out.push({ role: role === "user" ? "user" : "assistant", content });
  }
  return out.slice(-CHAT_MAX_TURNS);
}

/** Keyword-only extraction; budget phrases and bare numbers never become a keyword. */
function cleanKeyword(text: string): string | null {
  const parsed = heuristicIntent(text);
  const candidate = parsed.keyword.replace(/\s+/g, " ").trim();
  if (!candidate || candidate.length < 3) return null;
  if (/^[0-9.,\s]+$/.test(candidate)) return null;
  if (/^(rm|myr|usd|bawah|under|below|max|maks|budget|bajet)\b/i.test(candidate)) {
    return null;
  }
  return candidate;
}

function heuristicChat(messages: ChatMessage[], lang: Lang): ChatResult {
  const userTurns = messages.filter((message) => message.role === "user");
  const last = userTurns[userTurns.length - 1]?.content ?? "";

  let keyword: string | null = null;
  let budget: number | null = null;
  const filters: string[] = [];

  for (let i = userTurns.length - 1; i >= 0; i -= 1) {
    const content = userTurns[i].content;
    const parsed = heuristicIntent(content);

    if (budget === null && parsed.max_price_myr !== null) {
      budget = parsed.max_price_myr;
    }

    for (const filter of extractFilters(content)) {
      if (!filters.includes(filter) && filters.length < 6) filters.push(filter);
    }

    const explicitHere = SEARCH_VERBS.test(content);
    const filtersHere = extractFilters(content);
    if (!keyword && (filtersHere.length === 0 || explicitHere)) {
      const candidate = cleanKeyword(content);
      if (candidate) {
        const stripped = stripFilters(candidate, filtersHere);
        if (stripped.length >= 3) keyword = baseProductNoun(stripped);
      }
    }
  }

  const explicit = SEARCH_VERBS.test(last);
  const ready = Boolean(keyword) && (explicit || budget !== null);

  let reply: string;
  if (!keyword) {
    reply =
      lang === "en"
        ? "What product are you looking for? Give me a keyword or a category."
        : "Awak nak cari produk apa? Bagi kata kunci atau kategori dulu.";
  } else if (!ready && filters.length > 0 && budget === null) {
    reply =
      lang === "en"
        ? `Got it — you want ${filters.join(", ")}. Any specific budget?`
        : `Faham, nak ${filters.join(", ")}. Ada bajet khusus?`;
  } else if (!ready) {
    reply =
      lang === "en"
        ? `Noted — ${keyword}. Any maximum budget?`
        : `Baik, ${keyword}. Ada bajet maksimum?`;
  } else {
    const budgetPart =
      budget === null
        ? ""
        : lang === "en"
          ? ` under ${money(budget)}`
          : ` bawah ${money(budget)}`;
    const filterPart =
      filters.length > 0
        ? lang === "en"
          ? ` with ${filters.join(", ")}`
          : ` dengan ${filters.join(", ")}`
        : "";
    reply =
      lang === "en"
        ? `Searching ${keyword}${budgetPart}${filterPart}.`
        : `Mencari ${keyword}${budgetPart}${filterPart}.`;
  }

  return {
    reply,
    keyword,
    max_price_myr: budget,
    filters,
    explicit,
    ready,
    engine: "heuristic",
    note: last ? undefined : "no user message",
  };
}

async function chatTurn(
  env: Env,
  messages: ChatMessage[],
  lang: Lang,
  currency: CurrencyCode = "MYR",
  rate = 1,
): Promise<ChatResult> {
  const fallback = heuristicChat(messages, lang);
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ...fallback, note: "GEMINI_API_KEY not configured — heuristic chat" };
  }

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const contents = messages.map((message) => ({
    role: message.role === "user" ? "user" : "model",
    parts: [{ text: message.content }],
  }));

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(
        `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: chatSystemPrompt(lang, currency, rate) }] },
            contents,
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 340,
              responseMimeType: "application/json",
              responseSchema: CHAT_SCHEMA,
            },
          }),
          signal: timeoutSignal(9000),
        },
      );

      if (!res.ok) {
        if (attempt < 3) {
          await sleep(350 * attempt);
          continue;
        }
        return {
          ...fallback,
          note: `gemini chat: HTTP ${res.status} — heuristic chat`,
        };
      }

      const data = (await res.json()) as GeminiResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();

      const parsed = parseChatJson(text);
      if (parsed) return { ...parsed, engine: "gemini", model };
      if (attempt < 3) {
        await sleep(300 * attempt);
        continue;
      }
      return { ...fallback, note: "gemini chat: unparseable response" };
    } catch (error) {
      if (attempt < 3) {
        await sleep(300 * attempt);
        continue;
      }
      return {
        ...fallback,
        note: `gemini chat: ${
          error instanceof Error ? error.message : "fetch failed"
        }`,
      };
    }
  }

  return fallback;
}

function parseChatJson(text: string): Omit<ChatResult, "engine"> | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start <= -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const row = parsed as Record<string, unknown>;
  const reply = str(row.reply).slice(0, 400);
  if (!reply) return null;

  const filters = parseFilters(row.filters);
  const keywordRaw = str(row.keyword).replace(/\s+/g, " ").trim();
  let keyword =
    keywordRaw && keywordRaw.toLowerCase() !== "null"
      ? cleanKeyword(keywordRaw)
      : null;
  if (keyword) {
    const stripped = stripFilters(keyword, filters);
    keyword = stripped.length >= 3 ? baseProductNoun(stripped) : null;
  }

  const price = num(row.max_price_myr);
  const maxPrice =
    price !== null && price > 0 && price < 1_000_000 ? round2(price) : null;

  const explicit =
    row.explicit === true ||
    str(row.explicit).toLowerCase() === "true" ||
    str(row.explicit) === "1";

  // Never search on product alone: explicit request or a budget is required.
  const ready = Boolean(keyword) && (explicit || maxPrice !== null);

  return { reply, keyword, max_price_myr: maxPrice, filters, explicit, ready };
}
/* ------------------------------------------------------------------ */
/* HTML renderer                                                       */
/* ------------------------------------------------------------------ */

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:radial-gradient(1100px 520px at 15% -10%,#123049 0%,transparent 60%),
             radial-gradient(900px 500px at 90% 0%,#2a1a45 0%,transparent 55%),#070d18;
  color:#e6eefc;line-height:1.55;min-height:100vh;-webkit-font-smoothing:antialiased;
}
a{color:#5eead4;text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:22px 18px 70px}
.top{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:6px 0 26px}
.brand{display:flex;align-items:center;gap:11px;font-weight:700;color:#e6eefc;font-size:17px}
.logo{width:36px;height:36px;border-radius:11px;background:linear-gradient(135deg,#22d3ee,#a78bfa);
  display:grid;place-items:center;color:#061018;font-weight:800;font-size:15px;letter-spacing:.5px}
.brand small{display:block;font-weight:500;color:#8fa3c4;font-size:11.5px;letter-spacing:.3px}
.top nav{display:flex;gap:16px;font-size:13.5px}
.top nav a{color:#9db2d3}
h1{font-size:clamp(26px,4.4vw,40px);line-height:1.15;margin:18px 0 10px;letter-spacing:-.5px}
h1 span{background:linear-gradient(100deg,#22d3ee,#a78bfa 70%);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{color:#9db2d3;font-size:15.5px;max-width:620px;margin:0 0 22px}
form.search{display:flex;gap:8px;background:#0f1b2e;border:1px solid #1e2f4a;border-radius:15px;padding:7px}
form.search:focus-within{border-color:#2c6d8a;box-shadow:0 0 0 3px rgba(34,211,238,.09)}
form.search input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:#e6eefc;
  font-size:16px;padding:11px 13px;font-family:inherit}
form.search input::placeholder{color:#63799b}
form.search button{border:0;border-radius:10px;padding:0 20px;font-size:14.5px;font-weight:700;
  background:linear-gradient(135deg,#22d3ee,#7dd3fc);color:#04121c;cursor:pointer;font-family:inherit}
form.search button:hover{filter:brightness(1.07)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}
.chip{font-size:12.5px;color:#b9cbe6;background:#101d31;border:1px solid #1e2f4a;
  border-radius:999px;padding:6px 12px}
.chip b{color:#e6eefc;font-weight:600}
.chip.demo{color:#fcd34d;border-color:#4a3a12;background:#1d1707}
.chip.err{color:#fca5a5;border-color:#4a1d1d;background:#1d0b0b}
.chip.ok{color:#86efac;border-color:#14432a;background:#08190f}
.summary{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:20px 0 16px;color:#9db2d3;font-size:13.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:15px}
.card{background:#0e1a2d;border:1px solid #1c2b45;border-radius:15px;overflow:hidden;
  display:flex;flex-direction:column;transition:transform .15s ease,border-color .15s ease}
.card:hover{transform:translateY(-2px);border-color:#2b4a6f}
.thumb{aspect-ratio:4/3;background:linear-gradient(140deg,#13294a,#2a1c46);display:grid;place-items:center;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .tile{font-size:26px;font-weight:800;letter-spacing:1px;color:#7c93b8;opacity:.85}
.card .body{padding:13px 14px 12px;display:flex;flex-direction:column;gap:7px;flex:1}
.src{font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;color:#7c93b8;font-weight:700}
.src.cj{color:#67e8f9}
.src.aliexpress{color:#fca5a5}
.title{font-size:14.5px;font-weight:600;line-height:1.35;margin:0;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:39px}
.price{font-size:19px;font-weight:800;color:#fff;letter-spacing:-.3px}
.ship{font-size:11.8px;color:#8fa3c4}
.foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:4px}
.total{font-size:11.8px;color:#9db2d3}
.total b{color:#5eead4}
.cta{font-size:12.5px;font-weight:700;padding:7px 12px;border-radius:9px;
  background:#12283f;color:#7dd3fc;border:1px solid #1e3d5c}
.cta:hover{background:#173451;text-decoration:none}
.empty{background:#0e1a2d;border:1px dashed #24374f;border-radius:15px;padding:34px 22px;text-align:center}
.empty h2{margin:0 0 8px;font-size:18px}
.empty p{margin:0 0 14px;color:#9db2d3;font-size:14px}
details.api{margin-top:36px;background:#0b1526;border:1px solid #1a2a42;border-radius:13px;padding:14px 16px}
details.api summary{cursor:pointer;font-size:13.5px;color:#9db2d3;font-weight:600}
details.api pre{overflow:auto;background:#060d18;border:1px solid #16233a;border-radius:9px;
  padding:12px;font-size:12px;color:#a7c2e6;margin:12px 0 0}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:34px 0 0}
.step{background:#0d1829;border:1px solid #1a2a42;border-radius:13px;padding:16px}
.step b{display:block;color:#22d3ee;font-size:12px;letter-spacing:.8px;margin-bottom:6px}
.step h3{margin:0 0 5px;font-size:15px}
.step p{margin:0;color:#93a8c8;font-size:13px}
footer{margin-top:44px;padding-top:18px;border-top:1px solid #16233a;color:#63799b;font-size:12px;
  display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between}
.footerlinks{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;width:100%;margin-bottom:8px}
.footerlinks a{color:#8fa3c4}
.footerlinks a:hover{color:#5eead4}
.trending{margin:26px 0 0}
.trending h2{font-size:19px;margin:0 0 4px;letter-spacing:-.2px}
.trending .tlede{color:#8fa3c4;font-size:13px;margin:0 0 14px}
.trending .grid{min-height:320px}
.policy{max-width:760px;margin:0 auto}
.pback{display:inline-block;font-size:13px;color:#7dd3fc;margin:4px 0 14px}
.policy h1{font-size:clamp(24px,3.4vw,32px);margin:0 0 8px}
.pintro{color:#9db2d3;font-size:14.5px;margin:0 0 18px}
.policy section{margin:0 0 16px;background:#0d1829;border:1px solid #1a2a42;border-radius:13px;padding:14px 16px}
.policy h2{font-size:15px;margin:0 0 8px;color:#e6eefc}
.policy p{margin:0 0 8px;color:#a8bcd8;font-size:13.8px;line-height:1.62}
.policy p:last-child{margin-bottom:0}
.updated{color:#63799b;font-size:12px;margin:6px 0 12px}
.err-box{background:#1a0d0d;border:1px solid #4a1d1d;border-radius:13px;padding:22px}
.err-box h1{font-size:22px;margin:0 0 8px}
.margin{font-size:11px;color:#8fa3c4;border-top:1px dashed #1c2b45;padding-top:7px;margin-top:2px}
.margin b{color:#fbbf24}
.foot .cta-buy{background:linear-gradient(135deg,#22d3ee,#7dd3fc);color:#04121c;border:0}
.buyrow{display:flex;gap:6px;margin-top:6px}
.buyrow .cta{flex:1;text-align:center;font-size:11.5px;padding:8px 6px;font-weight:700}
.cta-wa{background:#0f3b2e;border-color:#1d6b52;color:#86efac}
.cta-wa:hover{background:#124a38;text-decoration:none}
.cta-tg{background:#122a44;border-color:#1e4a6e;color:#7dd3fc}
.cta-tg:hover{background:#173451;text-decoration:none}
.tg-btn{display:flex;align-items:center;justify-content:center;margin-top:10px;background:#122a44;color:#7dd3fc;border:1px solid #1e4a6e;font-weight:700;border-radius:12px;padding:12px;text-decoration:none;font-size:14px}
.tg-btn:hover{background:#173451;text-decoration:none}
.footsoc{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;width:100%;color:#7c93b8;margin-bottom:6px}
.footsoc a{color:#7dd3fc}
.foot .cta-buy:hover{filter:brightness(1.07)}
.src-link{font-size:11px;color:#7c93b8;margin-top:2px}
.status-card{background:#0d1829;border:1px solid #1a2a42;border-radius:13px;padding:16px 18px;margin-top:26px}
.status-card h3{margin:0 0 10px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:#8fa3c4}
.status-row{display:flex;gap:10px;align-items:baseline;font-size:13px;padding:4px 0;flex-wrap:wrap}
.status-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}
.ok-dot{background:#34d399}.warn-dot{background:#fbbf24}
.status-row code{color:#c7d7ee;font-size:12px}
.status-row .det{color:#8fa3c4;font-size:12px}
.status-foot{margin-top:10px;font-size:12px;color:#8fa3c4}
.checkout{max-width:560px;margin:8px auto 0}
.checkout .box{background:#0e1a2d;border:1px solid #1c2b45;border-radius:16px;padding:22px}
.checkout h1{font-size:22px;margin:0 0 4px;line-height:1.25}
.checkout .oid{color:#8fa3c4;font-size:12.5px;margin-bottom:16px;word-break:break-all}
.crow{display:flex;justify-content:space-between;gap:12px;padding:7px 0;font-size:14px;border-bottom:1px solid #14243a}
.crow span:first-child{color:#9db2d3}
.crow.total{border:0;padding-top:14px;font-size:19px;font-weight:800}
.wa-btn{display:flex;align-items:center;justify-content:center;gap:9px;margin-top:18px;background:#25d366;color:#04120a;font-weight:800;border-radius:12px;padding:14px;text-decoration:none}
.wa-btn:hover{filter:brightness(1.05);text-decoration:none}
.back{display:inline-block;margin-top:14px;font-size:13px;color:#7dd3fc}
.note{font-size:12px;color:#8fa3c4;margin-top:12px;line-height:1.5}
.langmenu{position:relative}
.langmenu summary{list-style:none;cursor:pointer;font-size:12.5px;color:#b9cbe6;background:#101d31;border:1px solid #1e2f4a;border-radius:10px;padding:7px 11px;white-space:nowrap}
.langmenu summary::-webkit-details-marker{display:none}
.curselect{appearance:none;background:#101d31;border:1px solid #1e2f4a;color:#b9cbe6;border-radius:10px;padding:7px 10px;font:inherit;font-size:12.5px;cursor:pointer;min-height:34px}
.curselect:focus{outline:none;border-color:#2c6d8a}
.langmenu[open] summary{border-color:#2c6d8a}
.langlist{position:absolute;right:0;top:calc(100% + 6px);background:#0e1a2d;border:1px solid #1e2f4a;border-radius:11px;padding:5px;min-width:160px;z-index:20;box-shadow:0 12px 30px rgba(0,0,0,.45)}
.langlist a{display:block;padding:7px 10px;border-radius:8px;font-size:13px;color:#c7d7ee}
.langlist a:hover{background:#132441;text-decoration:none}
.langlist a.active{color:#22d3ee;font-weight:700}
.top nav{align-items:center}
.top nav a{white-space:nowrap}
.searchhome{max-width:660px;margin:7vh auto 0;text-align:center}
.searchlogo{font-size:clamp(30px,5vw,44px);font-weight:800;letter-spacing:-1.2px;background:linear-gradient(100deg,#22d3ee,#a78bfa 75%);-webkit-background-clip:text;background-clip:text;color:transparent}
.searchtag{color:#9db2d3;font-size:14.5px;margin:10px auto 22px;max-width:520px}
.search.search-big{padding:9px;border-radius:999px}
.search.search-big input{font-size:17px;padding:13px 18px}
.search.search-big button{border-radius:999px;padding:0 26px;font-size:15px}
.chips.center{justify-content:center}
.statuspage{max-width:720px;margin:8px auto 0}
.statuspage .status-card{margin-top:0}
.statuslinks{display:flex;gap:16px;flex-wrap:wrap;margin-top:16px;font-size:13px;color:#7c93b8}
.resultsbar{display:flex;justify-content:flex-end;align-items:center;margin:16px 0 10px}
.viewswitch{display:inline-flex;gap:4px;background:#0f1b2e;border:1px solid #1e2f4a;border-radius:10px;padding:3px;margin-left:auto}
.viewbtn{width:32px;height:26px;border:0;border-radius:7px;background:transparent;color:#8fa3c4;cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center;font-family:inherit}
.viewbtn:hover{background:#132441;color:#e6eefc}
.viewbtn.active{background:#123049;color:#22d3ee}
.grid.view-compact{grid-template-columns:repeat(auto-fill,minmax(166px,1fr));gap:11px}
.grid.view-compact .thumb{aspect-ratio:1/1}
.grid.view-compact .body{padding:10px 11px;gap:5px}
.grid.view-compact .title{font-size:13px;min-height:35px}
.grid.view-compact .price{font-size:16px}
.grid.view-compact .ship,.grid.view-compact .margin,.grid.view-compact .src-link{display:none}
.grid.view-compact .foot .total{display:none}
.grid.view-compact .foot{justify-content:flex-end}
.grid.view-list{grid-template-columns:1fr;gap:10px}
.grid.view-list .card{flex-direction:row;align-items:stretch}
.grid.view-list .thumb{width:134px;min-width:134px;aspect-ratio:1/1;border-right:1px solid #16233a}
.grid.view-list .body{padding:12px 15px}
.grid.view-list .title{min-height:0;font-size:14.5px;-webkit-line-clamp:2}
.grid.view-list .price{font-size:17px}
.grid.view-list .foot{margin-top:4px}
.chatmeta{font-size:12px;color:#8fa3c4;margin:2px 2px 8px}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,32%);gap:16px;align-items:start;margin-top:10px}
.pane{background:#0b1524;border:1px solid #1a2a42;border-radius:16px;padding:14px;min-width:0}
.panehead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.panehead h2{margin:0;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:#8fa3c4;font-weight:700}
.metrics{font-size:12px;color:#7c93b8;margin:0 0 10px;min-height:16px}
.results-placeholder{border:1px dashed #24374f;border-radius:12px;padding:44px 16px;text-align:center;color:#7c93b8;font-size:13px}
.results-pane{min-height:430px}
.chat-pane{position:sticky;top:12px;display:flex;flex-direction:column;height:clamp(440px,calc(100vh - 270px),760px);min-height:0;overflow:hidden}
.chat-pane .chatlog{flex:1 1 auto;min-height:0;overflow-y:auto}
.chat-pane .typing{flex:0 0 auto}
.chat-pane .chatcompose{flex:0 0 auto;margin-top:8px;align-items:flex-end}
.chat-pane .chatcompose button{height:40px;align-self:flex-end}
.chat-pane .chattools,.chat-pane .quickchips{flex:0 0 auto}
.chatcompose textarea{min-height:44px;max-height:110px;overflow-y:auto;line-height:1.35;padding:9px 12px}
.chat-pane .chattools{margin-top:8px}
.chat-pane .quickchips{margin-top:8px}
.chat-pane .quickchips button{font-size:12px}
.mobiletabs{display:none;gap:6px;margin:12px 0 0}
.mobiletabs button{flex:1;background:#0f1b2e;border:1px solid #1e2f4a;border-radius:10px;color:#9db2d3;padding:9px;font:inherit;font-size:13px;cursor:pointer}
.mobiletabs button.active{background:#123049;color:#22d3ee;border-color:#2c6d8a}
#resultcount{color:#22d3ee;font-weight:700}
.productspill{display:none}
[hidden]{display:none!important}
@media (max-width:768px){
  .split{grid-template-columns:1fr;gap:12px}
  .mobiletabs{display:flex;position:sticky;top:0;z-index:15;background:#070d18;padding:6px 0;margin:10px 0 0}
  .mobiletabs button{min-height:44px;font-size:14px;display:flex;align-items:center;justify-content:center;gap:6px}
  .pane{display:none}
  .pane.active{display:flex;flex-direction:column}
  .chat-pane{position:static;height:auto;max-height:none;min-height:0}
  .chat-pane .chatlog{max-height:52vh;min-height:220px}
  .results-pane{min-height:0}
  .grid.view-large{grid-template-columns:1fr}
  .grid.view-compact{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .grid.view-list{grid-template-columns:1fr}
  .grid.view-compact .thumb{aspect-ratio:1/1}
  .grid.view-compact .ship,.grid.view-compact .margin,.grid.view-compact .src-link{display:none}
  .viewswitch{padding:4px;gap:6px}
  .viewbtn{width:44px;height:44px;font-size:16px}
  .chatcompose{padding:8px}
  .chatcompose textarea{min-height:44px;font-size:16px}
  .chatcompose button{min-height:44px;min-width:76px;font-size:15px}
  .quickchips button{min-height:44px;padding:10px 16px;font-size:13.5px}
  .cta-buy{min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:10px 14px}
  .buyrow .cta{min-height:44px;display:flex;align-items:center;justify-content:center;font-size:12.5px}
  .chattools{font-size:12.5px}
  .chattools button{min-height:44px;padding:6px 4px}
  .productspill{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;margin:10px 0 0;border:0;border-radius:12px;background:linear-gradient(135deg,#22d3ee,#7dd3fc);color:#04121c;font:inherit;font-weight:800;font-size:14px;cursor:pointer;box-shadow:0 8px 24px rgba(34,211,238,.18)}
  .productspill:active{transform:scale(.99)}
  .wrap{padding:14px 12px 56px}
  .top{flex-wrap:wrap;gap:8px;padding-bottom:14px}
  .top nav{width:100%;justify-content:space-between;gap:8px;font-size:12.5px;flex-wrap:wrap}
  .top nav a{padding:6px 0}
  .brand small{font-size:11px}
  h1{font-size:26px;margin:10px 0 8px}
  .lede{font-size:13.5px;margin-bottom:14px}
  .langmenu summary{padding:8px 10px}
  .mobiletabs button{flex:1 1 0;min-width:0;padding:10px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:capitalize}
}
.chatwrap{margin-top:8px}
.chatlog{display:flex;flex-direction:column;gap:12px;background:#0b1524;border:1px solid #1a2a42;border-radius:16px;padding:18px;min-height:280px;max-height:60vh;overflow-y:auto;scroll-behavior:smooth}
.msg{display:flex;gap:10px}
.msg.me{justify-content:flex-end}
.bubble{max-width:min(680px,92%);background:#101d31;border:1px solid #1e2f4a;border-radius:14px;padding:11px 14px;font-size:14.5px;white-space:pre-wrap;word-break:break-word;color:#e6eefc}
.msg.me .bubble{background:linear-gradient(135deg,#123049,#173a56);border-color:#245b7a}
.bubble.products{max-width:100%;width:100%;background:transparent;border:0;padding:0}
.bubble.products .grid{grid-template-columns:repeat(auto-fill,minmax(208px,1fr));gap:12px}
.chatcompose{display:flex;gap:8px;margin-top:12px;background:#0f1b2e;border:1px solid #1e2f4a;border-radius:15px;padding:7px}
.chatcompose:focus-within{border-color:#2c6d8a;box-shadow:0 0 0 3px rgba(34,211,238,.09)}
.chatcompose textarea{flex:1;resize:none;background:transparent;border:0;outline:none;color:#e6eefc;font:inherit;font-size:15px;padding:10px 12px;max-height:120px;line-height:1.4}
.chatcompose textarea::placeholder{color:#63799b}
.chatcompose button{border:0;border-radius:10px;padding:0 18px;font-weight:700;font-size:14.5px;background:linear-gradient(135deg,#22d3ee,#7dd3fc);color:#04121c;cursor:pointer;font-family:inherit}
.chatcompose button:disabled{opacity:.55;cursor:progress}
.typing{display:flex;gap:8px;align-items:center;color:#8fa3c4;font-size:12.5px;margin-top:10px}
.typing[hidden]{display:none!important}
.dot{width:6px;height:6px;border-radius:50%;background:#22d3ee;opacity:.35;animation:blink 1.1s infinite}
.dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}
@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
.quickchips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.quickchips button{font:inherit;font-size:12.5px;color:#b9cbe6;background:#101d31;border:1px solid #1e2f4a;border-radius:999px;padding:6px 12px;cursor:pointer}
.quickchips button:hover{border-color:#2c6d8a;color:#e6eefc}
.chattools{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;font-size:12px;color:#7c93b8;flex-wrap:wrap}
.chattools button{background:none;border:0;color:#7dd3fc;cursor:pointer;font:inherit;font-size:12px;padding:0}
`;

/* ------------------------------------------------------------------ */
/* i18n (Bahasa Melayu default, English via top-right dropdown)        */
/* ------------------------------------------------------------------ */

type Lang = "ms" | "en" | "id" | "zh";

type CurrencyCode = "MYR" | "USD" | "SGD" | "IDR" | "CNY";

const CURRENCIES: CurrencyCode[] = ["MYR", "USD", "SGD", "IDR", "CNY"];

const CURRENCY_LOCALE: Record<CurrencyCode, string> = {
  MYR: "ms-MY",
  USD: "en-US",
  SGD: "en-SG",
  IDR: "id-ID",
  CNY: "zh-CN",
};

/** Used only when open.er-api.com is unreachable (keeps the UI usable). */
const FALLBACK_RATES: Record<CurrencyCode, number> = {
  MYR: 1,
  USD: 0.21,
  SGD: 0.28,
  IDR: 3450,
  CNY: 1.52,
};

/** Windows-explorer style product view. */
type ViewMode = "large" | "compact" | "list";

function viewFrom(raw: string | undefined): ViewMode {
  return raw === "compact" || raw === "list" || raw === "large" ? raw : "large";
}

const STRINGS: Record<Lang, Record<string, string>> = {
  ms: {
    tagline: "enjin carian dropship on-demand",
    nav_api: "API",
    nav_status: "Status",
    lang_name: "Bahasa Melayu",
    trending_title: "Pilihan Hangat",
    trending_lede:
      "Produk rentas sempadan paling dicari minggu ini — harga termasuk penghantaran.",
    back_home: "Kembali",
    policy_updated: "Dikemas kini: November 2026",
    land_h1_a: "Cari produk dropship,",
    land_h1_b: "terus ikut bajet.",
    land_lede:
      "Taip apa yang awak nak dalam bahasa Melayu atau Inggeris. Enjin faham hasrat, cari di CJ Dropshipping & AliExpress serentak, dan susun ikut kos penghantaran sebenar.",
    search_placeholder: "cth: mini projector bawah RM80",
    search_aria: "Cari produk",
    search_btn: "Cari",
    chip_keyword: "Kata kunci",
    chip_budget: "Bajet",
    chip_no_limit: "tiada had",
    chip_intent: "Intent",
    engine_heuristic: "heuristik",
    step1_t: "Faham hasrat",
    step1_d: "Gemini Flash-Lite tukar ayat biasa jadi kata kunci + had bajet MYR.",
    step2_t: "Cari serentak",
    step2_d: "CJ dan AliExpress dipanggil selari, bukan satu-satu.",
    step3_t: "Margin + order",
    step3_d: "Kos supplier ditambah margin, setiap produk dapat butang Order.",
    status_title: "Status sistem",
    status_live: "aktif",
    status_missing: "tiada",
    status_margin_foot:
      "harga jual = kos supplier + margin, pos di-pass-through.",
    api_details: "Guna sebagai API (bot / curl)",
    api_json_details: "JSON untuk bot",
    results_products: "produk",
    results_filtered: "ditapis keluar (bajet)",
    results_margin: "margin",
    empty_title: "Tiada produk dalam bajet itu",
    empty_text: "Naikkan bajet, atau cuba kata kunci yang lebih umum.",
    card_margin: "Margin",
    card_supplier_cost: "kos supplier",
    card_total: "Total",
    card_order: "Order",
    card_view_on: "Lihat di",
    card_days: "hari",
    card_demo: "demo",
    checkout_supplier: "Harga supplier",
    checkout_shipping: "Penghantaran",
    checkout_margin: "Margin",
    checkout_total: "Jumlah",
    checkout_wa: "WhatsApp untuk sahkan",
    checkout_note:
      "Harga akhir disahkan di WhatsApp sebelum bayar. Kalau produk bertanda demo, harga supplier datang dari katalog demo sehingga kredensial sumber dipasang.",
    checkout_back: "Kembali ke carian",
    checkout_product: "Produk",
    error_title: "Ralat",
    error_back: "Kembali ke carian",
    footer_note: "Harga indikatif — sahkan stok & harga di platform sumber.",
    empty_q: "Taip kata kunci dulu — contoh: mini projector bawah RM80",
    invalid_query: "Pertanyaan mesti antara 2 hingga 200 aksara.",
    invalid_checkout: "Parameter checkout tidak sah (source, id, base).",
    missing_query: "Parameter q diperlukan.",
    meta_home_title: "MyKiraNiaga — enjin carian dropship on-demand",
    meta_home_desc:
      "Cari produk dropship ikut bajet. Gemini faham hasrat, CJ + AliExpress dicari serentak, harga dinormalisasi ke MYR.",
    meta_search_title: "MyKiraNiaga — carian",
    meta_search_desc: "Taip kata kunci untuk mula cari produk dropship.",
    meta_invalid_title: "Pertanyaan tidak sah — MyKiraNiaga",
    meta_checkout_title: "Checkout tidak sah — MyKiraNiaga",
    meta_order_desc: "Semak pesanan",
    nav_chat: "Chat",
    nav_search: "Carian",
    chat_h1: "Tanya je — saya carikan.",
    chat_lede:
      "Berbual macam biasa: sebut produk, kemudian bajet. Saya cari di CJ + AliExpress dan tunjuk kad produk terus dalam chat.",
    chat_placeholder: "cth: nak cari laptop murah",
    chat_send: "Hantar",
    chat_clear: "Kosongkan chat",
    chat_greeting:
      "Hai! Awak nak cari produk apa? Boleh sebut jenis produk dan bajet sekali.",
    chat_suggest_1: "Nak cari laptop murah",
    chat_suggest_2: "Earbuds bawah RM80",
    chat_suggest_3: "Beg kanvas untuk kerja",
    chat_typing: "Sedang mencari…",
    chat_empty: "Tak jumpa produk dalam bajet itu — cuba naikkan bajet.",
    chat_hint: "Enter untuk hantar · Shift+Enter baris baru",
    chat_view_products: "Lihat {n} produk ditemui →",
    status_lede:
      "Semakan konfigurasi enjin: kunci API, margin dan nombor WhatsApp.",
    view_label: "Pilihan paparan",
    view_large: "Grid besar",
    view_compact: "Grid kecil",
    view_list: "Senarai",
    floor_empty:
      "Semua hasil bawah harga minimum kategori (aksesori) ditapis keluar. Cuba kata kunci lebih spesifik — tambah jenis seperti \"electric\" atau \"cordless\".",
  },
  en: {
    tagline: "on-demand dropshipping search",
    nav_api: "API",
    nav_status: "Status",
    lang_name: "English",
    trending_title: "Trending Hot Items",
    trending_lede:
      "The most-wanted cross-border picks this week — landed prices include shipping.",
    back_home: "Back",
    policy_updated: "Last updated: November 2026",
    land_h1_a: "Find dropship products,",
    land_h1_b: "straight to your budget.",
    land_lede:
      "Type what you want in Malay or English. The engine extracts intent, searches CJ Dropshipping & AliExpress in parallel, and ranks by real shipping cost.",
    search_placeholder: "e.g. mini projector under RM80",
    search_aria: "Search products",
    search_btn: "Search",
    chip_keyword: "Keyword",
    chip_budget: "Budget",
    chip_no_limit: "no limit",
    chip_intent: "Intent",
    engine_heuristic: "heuristic",
    step1_t: "Read intent",
    step1_d: "Gemini Flash-Lite turns plain language into a keyword + MYR budget.",
    step2_t: "Search in parallel",
    step2_d: "CJ and AliExpress are called simultaneously, not one by one.",
    step3_t: "Margin + order",
    step3_d: "Supplier cost plus margin, every product gets an Order button.",
    status_title: "System status",
    status_live: "live",
    status_missing: "missing",
    status_margin_foot:
      "sell price = supplier cost + margin, shipping passed through.",
    api_details: "Use as API (bot / curl)",
    api_json_details: "JSON for bots",
    results_products: "products",
    results_filtered: "filtered out (budget)",
    results_margin: "margin",
    empty_title: "No products inside that budget",
    empty_text: "Raise the budget, or try a broader keyword.",
    card_margin: "Margin",
    card_supplier_cost: "supplier cost",
    card_total: "Total",
    card_order: "Order",
    card_view_on: "View on",
    card_days: "days",
    card_demo: "demo",
    checkout_supplier: "Supplier price",
    checkout_shipping: "Shipping",
    checkout_margin: "Margin",
    checkout_total: "Total",
    checkout_wa: "Confirm on WhatsApp",
    checkout_note:
      "Final price is confirmed on WhatsApp before payment. Demo rows use the sample catalogue until supplier credentials are set.",
    checkout_back: "Back to search",
    checkout_product: "Product",
    error_title: "Error",
    error_back: "Back to search",
    footer_note: "Indicative pricing — confirm stock & price on the source platform.",
    empty_q: "Type a keyword first — e.g. mini projector under RM80",
    invalid_query: "Query must be between 2 and 200 characters.",
    invalid_checkout: "Invalid checkout parameters (source, id, base).",
    missing_query: "The q parameter is required.",
    meta_home_title: "MyKiraNiaga — on-demand dropshipping search",
    meta_home_desc:
      "Search dropship products by budget. Gemini reads intent, CJ + AliExpress searched in parallel, prices normalised to MYR.",
    meta_search_title: "MyKiraNiaga — search",
    meta_search_desc: "Type a keyword to start searching dropship products.",
    meta_invalid_title: "Invalid query — MyKiraNiaga",
    meta_checkout_title: "Invalid checkout — MyKiraNiaga",
    meta_order_desc: "Review order",
    nav_chat: "Chat",
    nav_search: "Search",
    chat_h1: "Just ask — I'll find it.",
    chat_lede:
      "Chat naturally: name the product, then the budget. I search CJ + AliExpress and drop product cards right into the chat.",
    chat_placeholder: "e.g. cheap laptop under RM1500",
    chat_send: "Send",
    chat_clear: "Clear chat",
    chat_greeting:
      "Hi! What are you looking for? You can mention the product and budget together.",
    chat_suggest_1: "Find a cheap laptop",
    chat_suggest_2: "Earbuds under RM80",
    chat_suggest_3: "Canvas bag for work",
    chat_typing: "Searching…",
    chat_empty: "No products inside that budget — try raising it.",
    chat_hint: "Enter to send · Shift+Enter for a new line",
    chat_view_products: "View {n} products found →",
    status_lede: "Engine configuration check: API keys, margin and WhatsApp number.",
    view_label: "View options",
    view_large: "Large grid",
    view_compact: "Small grid",
    view_list: "List",
    floor_empty:
      "Every result below the category price floor (accessories) was filtered out. Try a more specific keyword — add a type such as \"electric\" or \"cordless\".",
  },
  id: {
    tagline: "pencarian dropship on-demand",
    nav_chat: "Chat",
    nav_search: "Cari",
    nav_api: "API",
    nav_status: "Status",
    lang_name: "Bahasa Indonesia",
    trending_title: "Pilihan Populer",
    trending_lede:
      "Produk lintas negara paling dicari minggu ini — harga sudah termasuk pengiriman.",
    back_home: "Kembali",
    policy_updated: "Terakhir diperbarui: November 2026",
    land_lede:
      "Ketik apa yang Anda cari dalam bahasa Indonesia, Melayu, atau Inggris. Mesin memahami maksud, mencari di CJ + AliExpress, dan menyusun sesuai biaya kirim.",
    search_placeholder: "cth: laptop murah",
    search_btn: "Cari",
    chat_h1: "Tanya saja — saya carikan.",
    chat_lede:
      "Ngobrol seperti biasa: sebut produk, lalu anggaran. Saya cari di CJ + AliExpress dan tampilkan kartu produk di panel kiri.",
    chat_placeholder: "cth: cari laptop murah",
    chat_send: "Kirim",
    chat_clear: "Bersihkan chat",
    chat_greeting: "Hai! Mau cari produk apa? Sebut jenis produk dan anggarannya.",
    chat_suggest_1: "Cari laptop murah",
    chat_suggest_2: "Earbuds murah",
    chat_suggest_3: "Tas kanvas untuk kerja",
    chat_typing: "Mencari…",
    chat_hint: "Enter untuk kirim · Shift+Enter baris baru",
    chat_empty: "Tidak ada produk dalam anggaran itu — coba naikkan anggaran.",
    chat_view_products: "Lihat {n} produk ditemukan →",
    results_products: "produk",
    results_filtered: "disaring (anggaran)",
    empty_title: "Tidak ada produk dalam anggaran itu",
    empty_text: "Naikkan anggaran atau coba kata kunci lain.",
    card_order: "Pesan",
    card_total: "Total",
    card_margin: "Margin",
    card_supplier_cost: "biaya supplier",
    card_view_on: "Lihat di",
    card_days: "hari",
    view_large: "Grid besar",
    view_compact: "Grid kecil",
    view_list: "Daftar",
    checkout_supplier: "Harga supplier",
    checkout_shipping: "Pengiriman",
    checkout_margin: "Margin",
    checkout_total: "Jumlah",
    checkout_wa: "Konfirmasi via WhatsApp",
    checkout_back: "Kembali ke pencarian",
    checkout_product: "Produk",
    status_lede:
      "Pemeriksaan konfigurasi mesin: kunci API, margin, dan nomor WhatsApp.",
    floor_empty:
      "Semua hasil di bawah harga minimum kategori (aksesori) disaring. Coba kata kunci lebih spesifik — tambahkan jenis seperti \"electric\" atau \"cordless\".",
  },
  zh: {
    tagline: "按需代发商品搜索",
    nav_chat: "聊天",
    nav_search: "搜索",
    nav_api: "API",
    nav_status: "状态",
    lang_name: "中文",
    trending_title: "热门推荐",
    trending_lede: "本周最热门的跨境商品 — 价格已含运费。",
    back_home: "返回",
    policy_updated: "最后更新：2026 年 11 月",
    land_lede:
      "用中文、马来语或英语描述需求。引擎理解意图，同时搜索 CJ 与 AliExpress，并按真实运费排序。",
    search_placeholder: "例如：便宜的笔记本电脑",
    search_btn: "搜索",
    chat_h1: "直接问 — 我来找。",
    chat_lede:
      "像聊天一样：先说产品，再说预算。我会搜索 CJ + AliExpress，并在左侧显示商品卡片。",
    chat_placeholder: "例如：找便宜的笔记本电脑",
    chat_send: "发送",
    chat_clear: "清空聊天",
    chat_greeting: "你好！想找什么产品？可以同时说出产品和预算。",
    chat_suggest_1: "找便宜的笔记本电脑",
    chat_suggest_2: "80马币以内的耳机",
    chat_suggest_3: "上班用的帆布包",
    chat_typing: "正在搜索…",
    chat_hint: "Enter 发送 · Shift+Enter 换行",
    chat_empty: "该预算内没有商品 — 试试提高预算。",
    chat_view_products: "查看 {n} 个商品 →",
    results_products: "个商品",
    results_filtered: "已按预算过滤",
    empty_title: "该预算内没有商品",
    empty_text: "提高预算或换个关键词试试。",
    card_order: "下单",
    card_total: "合计",
    card_margin: "利润",
    card_supplier_cost: "供应商成本",
    card_view_on: "查看",
    card_days: "天",
    view_large: "大网格",
    view_compact: "小网格",
    view_list: "列表",
    checkout_supplier: "供应商价格",
    checkout_shipping: "运费",
    checkout_margin: "利润",
    checkout_total: "合计",
    checkout_wa: "通过 WhatsApp 确认",
    checkout_back: "返回搜索",
    checkout_product: "商品",
    status_lede: "引擎配置检查：API 密钥、利润和 WhatsApp 号码。",
    floor_empty:
      "所有低于该类目最低价（配件）的结果已被过滤。请尝试更具体的关键词，例如加上“electric”或“cordless”。",
  },
};

function t(lang: Lang, key: string): string {
  const chain: Lang[] =
    lang === "zh" ? ["zh", "en", "ms"] : lang === "id" ? ["id", "ms"] : [lang, "ms"];
  for (const candidate of chain) {
    const value = STRINGS[candidate][key];
    if (value) return value;
  }
  return key;
}

function langUrl(fullUrl: string, lang: Lang): string {
  const url = new URL(fullUrl, "https://mykiraniaga.local");
  url.searchParams.set("lang", lang);
  return `${url.pathname}${url.search}`;
}

function currencyFromUrl(fullUrl: string): CurrencyCode {
  const url = new URL(fullUrl, "https://mykiraniaga.local");
  return currencyFrom(url.searchParams.get("currency") ?? undefined);
}

function layout(opts: {
  title: string;
  description: string;
  body: string;
  lang: Lang;
  currentUrl: string;
}): string {
  const { lang } = opts;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<meta name="robots" content="index,follow">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="brand" href="/">
      <span class="logo">MK</span>
      <span>MyKiraNiaga<small>${esc(t(lang, "tagline"))}</small></span>
    </a>
    <nav>
      <a href="/">${esc(t(lang, "nav_chat"))}</a>
      <a href="/search">${esc(t(lang, "nav_search"))}</a>
      <a href="/api">${esc(t(lang, "nav_api"))}</a>
      <a href="/status">${esc(t(lang, "nav_status"))}</a>
      <details class="langmenu">
        <summary>${lang === "ms" ? "BM" : lang === "en" ? "EN" : lang === "id" ? "ID" : "中文"} ▾</summary>
        <div class="langlist">
          <a href="${esc(langUrl(opts.currentUrl, "ms"))}" class="${
            lang === "ms" ? "active" : ""
          }">Bahasa Melayu</a>
          <a href="${esc(langUrl(opts.currentUrl, "en"))}" class="${
            lang === "en" ? "active" : ""
          }">English</a>
          <a href="${esc(langUrl(opts.currentUrl, "id"))}" class="${
            lang === "id" ? "active" : ""
          }">Bahasa Indonesia</a>
          <a href="${esc(langUrl(opts.currentUrl, "zh"))}" class="${
            lang === "zh" ? "active" : ""
          }">中文</a>
        </div>
      </details>
      <select class="curselect" aria-label="Currency" onchange="var u=new URL(location.href);u.searchParams.set('currency',this.value);location.href=u.toString()">
        ${CURRENCIES.map(
          (code) =>
            `<option value="${code}" ${
              currencyFromUrl(opts.currentUrl) === code ? "selected" : ""
            }>${code}</option>`,
        ).join("")}
      </select>
    </nav>
  </header>
  ${opts.body}
  <footer>
    <nav class="footerlinks">
      ${POLICY_SLUGS.map(
        (slug) => `<a href="/${slug}">${esc(POLICY[lang][slug].title)}</a>`,
      ).join("\n      ")}
    </nav>
    <div class="footsoc">
      <a href="https://wa.me/${DEFAULT_WHATSAPP}" target="_blank" rel="noopener">WhatsApp</a>
      <a href="https://t.me/${TELEGRAM_BOT}" target="_blank" rel="noopener">Telegram @${TELEGRAM_BOT}</a>
    </div>
    <span>MyKiraNiaga v${VERSION} · Hono + Cloudflare Workers</span>
    <span>${esc(t(lang, "footer_note"))}</span>
  </footer>
</div>
</body>
</html>`;
}

function chatBody(
  env: Env,
  lang: Lang,
  currency: CurrencyCode = "MYR",
  rate = 1,
  trending: PricedProduct[] = [],
): string {
  const suggestions = [
    t(lang, "chat_suggest_1"),
    t(lang, "chat_suggest_2"),
    t(lang, "chat_suggest_3"),
  ];
  const errorText =
    lang === "en" ? "Network error — try again." : "Ralat rangkaian — cuba lagi.";
  const placeholder =
    lang === "en"
      ? "Results appear here while you chat."
      : "Hasil carian akan muncul di sini.";
  const metricsIdle = lang === "en" ? "No results yet" : "Belum ada hasil";

  const script = `
(function () {
  var log = document.getElementById("chatlog");
  var form = document.getElementById("chatform");
  var input = document.getElementById("chatinput");
  var typing = document.getElementById("typing");
  var sendBtn = form.querySelector("button[type=submit]");
  var results = document.getElementById("products-container");
  var metrics = document.getElementById("products-metrics");
  var countBadge = document.getElementById("resultcount");
  var chatPane = document.getElementById("chatpane");
  var resultsPane = document.getElementById("resultspane");
  var pill = document.getElementById("productspill");
  var tabs = document.querySelectorAll("[data-tab]");
  var viewButtons = document.querySelectorAll("[data-cview]");

  var KEY = "mkn_chat_v1";
  var VKEY = "mkn_chat_view";
  var LANG = ${JSON.stringify(lang)};
  var CURRENCY = ${JSON.stringify(currency)};
  var RATE = ${JSON.stringify(rate)};
  var LOCALE = { MYR: "ms-MY", USD: "en-US", SGD: "en-SG", IDR: "id-ID", CNY: "zh-CN" };
  var GREETING = ${JSON.stringify(t(lang, "chat_greeting"))};
  var ERROR = ${JSON.stringify(errorText)};
  var PLACEHOLDER = ${JSON.stringify(placeholder)};
  var METRICS_IDLE = ${JSON.stringify(metricsIdle)};
  var LABEL_PRODUCTS = ${JSON.stringify(t(lang, "results_products"))};
  var LABEL_FILTERED = ${JSON.stringify(t(lang, "results_filtered"))};
  var PILL_TEXT = ${JSON.stringify(t(lang, "chat_view_products"))};

  function isMobile() { return window.matchMedia("(max-width: 768px)").matches; }

  var history = [];
  try { history = JSON.parse(sessionStorage.getItem(KEY) || "[]") || []; } catch (e) { history = []; }

  var view = "large";
  var storedView = null;
  try { storedView = localStorage.getItem(VKEY); } catch (e) {}
  if (window.matchMedia("(max-width: 768px)").matches && !storedView) {
    view = "compact"; // phones default to a 2-column grid
  } else if (storedView) {
    view = storedView;
  }
  if (["large", "compact", "list"].indexOf(view) < 0) view = "large";

  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-40))); } catch (e) {} }

  function stopTyping() { typing.hidden = true; typing.style.display = "none"; }
  function startTyping() { typing.hidden = false; typing.style.display = "flex"; }
  function escHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function formatMoneyNodes(root) {
    var nodes = (root || document).querySelectorAll("[data-money]");
    for (var i = 0; i < nodes.length; i++) {
      var myr = parseFloat(nodes[i].getAttribute("data-money"));
      if (!isFinite(myr)) continue;
      var amount = myr * RATE;
      try {
        nodes[i].textContent = new Intl.NumberFormat(LOCALE[CURRENCY] || "en-US", {
          style: "currency",
          currency: CURRENCY,
          maximumFractionDigits: CURRENCY === "IDR" ? 0 : 2,
          minimumFractionDigits: CURRENCY === "IDR" ? 0 : 2,
        }).format(amount);
      } catch (e) {
        nodes[i].textContent = CURRENCY + " " + amount.toFixed(2);
      }
    }
  }
  function money(value) { return "RM " + Number(value || 0).toFixed(2); }
  function fallbackCards(products) {
    return products.map(function (p) {
      var img = p.image
        ? '<img src="' + escHtml(p.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
        : '<span class="tile">' + (p.source === "cj" ? "CJ" : "AE") + "</span>";
      return '<article class="card"><div class="thumb">' + img + '</div><div class="body">' +
        '<span class="src ' + escHtml(p.source) + '">' + escHtml(p.source_label || p.source) + "</span>" +
        '<h3 class="title">' + escHtml(p.title) + "</h3>" +
        '<div class="price">' + money(p.price_myr) + "</div>" +
        '<div class="foot"><span class="total">' + money(p.total_myr) + "</span>" +
        '<a class="cta cta-buy" href="' + escHtml(p.checkout_url || "#") + '">Order →</a></div>' +
        "</div></article>";
    }).join("");
  }
  function scroll() { log.scrollTop = log.scrollHeight; }

  function bubble(role, text) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "me" : "bot");
    var b = document.createElement("div");
    b.className = "bubble";
    b.textContent = text;
    wrap.appendChild(b);
    return wrap;
  }

  function render() {
    log.innerHTML = "";
    if (!history.length) { log.appendChild(bubble("assistant", GREETING)); }
    for (var i = 0; i < history.length; i++) {
      log.appendChild(bubble(history[i].role === "user" ? "user" : "assistant", history[i].content));
    }
    scroll();
  }

  function push(role, text) {
    history.push({ role: role, content: text });
    save();
    log.appendChild(bubble(role, text));
    scroll();
  }

  function applyView(next, persist) {
    view = next;
    var grid = results.querySelector(".grid");
    if (grid) grid.className = "grid view-" + next;
    for (var i = 0; i < viewButtons.length; i++) {
      var on = viewButtons[i].getAttribute("data-cview") === next;
      viewButtons[i].classList.toggle("active", on);
      viewButtons[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (persist) { try { localStorage.setItem(VKEY, next); } catch (e) {} }
  }

  function activate(tab) {
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === tab);
    }
    if (chatPane) chatPane.classList.toggle("active", tab === "chat");
    if (resultsPane) resultsPane.classList.toggle("active", tab === "results");
    if (pill && tab === "results") pill.hidden = true;
  }

  function showPill(count) {
    if (!pill) return;
    if (!isMobile() || count <= 0) { pill.hidden = true; return; }
    pill.textContent = PILL_TEXT.replace("{n}", String(count));
    pill.hidden = false;
  }

  function renderProducts(data) {
    var html = data.products_html;
    if (!html && data.products && data.products.length) {
      html = '<div class="grid">' + fallbackCards(data.products) + "</div>";
    }
    if (!html) return;

    results.innerHTML = html;
    applyView(view, false);
    formatMoneyNodes(results);

    var m = data.metrics || { count: 0, timing_ms: 0, filters: [] };
    var bits = [m.count + " " + LABEL_PRODUCTS];
    if (m.timing_ms) bits.push(m.timing_ms + " ms");
    if (m.filters && m.filters.length) bits.push(m.filters.join(", "));
    if (m.removed) bits.push(m.removed + " " + LABEL_FILTERED);
    metrics.textContent = bits.join(" · ");
    if (countBadge) countBadge.textContent = m.count ? "(" + m.count + ")" : "";

    // Stay on Chat; offer a pill instead of yanking the view.
    showPill(m.count);
  }

  async function send(text) {
    text = (text || "").trim();
    if (!text) return;

    push("user", text);
    input.value = "";
    input.style.height = "";
    startTyping();
    sendBtn.disabled = true;
    input.disabled = true;

    try {
      var res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, lang: LANG, currency: CURRENCY }),
      });
      var data = await res.json();
      stopTyping(); // spinner gone the moment the response lands
      if (data.currency) CURRENCY = data.currency;
      if (data.rate) RATE = Number(data.rate) || RATE;
      if (!data.ok) throw new Error(data.message || data.error || "error");
      push("assistant", data.reply);
      renderProducts(data);
    } catch (err) {
      stopTyping();
      log.appendChild(bubble("assistant", "⚠ " + ERROR));
      scroll();
    } finally {
      stopTyping();
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  form.addEventListener("submit", function (ev) { ev.preventDefault(); send(input.value); });
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send(input.value); }
  });

  var chips = document.querySelectorAll("[data-chip]");
  for (var c = 0; c < chips.length; c++) {
    chips[c].addEventListener("click", function () { send(this.getAttribute("data-chip")); });
  }

  for (var v = 0; v < viewButtons.length; v++) {
    viewButtons[v].addEventListener("click", function () {
      applyView(this.getAttribute("data-cview"), true);
    });
  }

  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener("click", function () {
      activate(this.getAttribute("data-tab"));
    });
  }

  if (pill) {
    pill.addEventListener("click", function () {
      activate("results");
      if (resultsPane) resultsPane.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  var clear = document.getElementById("chatclear");
  if (clear) {
    clear.addEventListener("click", function () {
      history = [];
      save();
      render();
      results.innerHTML = '<div class="results-placeholder">' + PLACEHOLDER + "</div>";
      metrics.textContent = METRICS_IDLE;
      if (countBadge) countBadge.textContent = "";
      if (pill) pill.hidden = true;
      input.focus();
    });
  }

  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  stopTyping();
  applyView(view, false);
  render();
  formatMoneyNodes(document);

})();
`;

  return `<h1>${esc(t(lang, "chat_h1"))}</h1>
<p class="lede">${esc(t(lang, "chat_lede"))}</p>

<div class="mobiletabs" role="tablist">
  <button type="button" data-tab="chat" class="active">💬 ${esc(t(lang, "nav_chat"))}</button>
  <button type="button" data-tab="results">🛍️ ${esc(
    t(lang, "results_products"),
  )} <span id="resultcount"></span></button>
</div>

<div class="split" id="split">
  <section class="pane results-pane" id="resultspane">
    <div class="panehead">
      <h2>${esc(t(lang, "results_products"))}</h2>
      <div class="viewswitch" role="group" aria-label="${esc(
        t(lang, "view_label"),
      )}">
        <button type="button" class="viewbtn active" data-cview="large" title="${esc(
          t(lang, "view_large"),
        )}" aria-label="${esc(t(lang, "view_large"))}">▦</button>
        <button type="button" class="viewbtn" data-cview="compact" title="${esc(
          t(lang, "view_compact"),
        )}" aria-label="${esc(t(lang, "view_compact"))}">▥</button>
        <button type="button" class="viewbtn" data-cview="list" title="${esc(
          t(lang, "view_list"),
        )}" aria-label="${esc(t(lang, "view_list"))}">☰</button>
      </div>
    </div>
    <div class="metrics" id="products-metrics">${esc(metricsIdle)}</div>
    <div class="results-area" id="products-container" aria-live="polite">
      ${
        trending.length > 0
          ? trendingBody(env, lang, currency, rate, trending)
          : `<div class="results-placeholder">${esc(placeholder)}</div>`
      }
    </div>
  </section>

  <aside class="pane chat-pane active" id="chatpane">
    <div id="chatlog" class="chatlog" aria-live="polite"></div>
    <div id="typing" class="typing" hidden style="display:none"><span class="dot"></span><span class="dot"></span><span class="dot"></span> ${esc(
      t(lang, "chat_typing"),
    )}</div>
    <button type="button" id="productspill" class="productspill" hidden>${esc(
      t(lang, "chat_view_products").replace("{n}", "0"),
    )}</button>
    <form id="chatform" class="chatcompose" autocomplete="off">
      <textarea id="chatinput" rows="2" placeholder="${esc(
        t(lang, "chat_placeholder"),
      )}" aria-label="${esc(t(lang, "chat_placeholder"))}"></textarea>
      <button type="submit">${esc(t(lang, "chat_send"))}</button>
    </form>
    <div class="chattools">
      <span>${esc(t(lang, "chat_hint"))}</span>
      <button type="button" id="chatclear">${esc(t(lang, "chat_clear"))}</button>
    </div>
    <div class="quickchips">
      ${suggestions
        .map(
          (suggestion) =>
            `<button type="button" data-chip="${esc(suggestion)}">${esc(suggestion)}</button>`,
        )
        .join("")}
    </div>
  </aside>
</div>
<script>${script}</script>`;
}
function searchForm(
  q: string,
  autofocus: boolean,
  lang: Lang,
  big = false,
): string {
  return `<form class="search${big ? " search-big" : ""}" action="/search" method="get" role="search">
  <input type="hidden" name="lang" value="${lang}">
  <input type="search" name="q" value="${esc(q)}" placeholder="${esc(
    t(lang, "search_placeholder"),
  )}"
    aria-label="${esc(t(lang, "search_aria"))}" ${
      autofocus ? "autofocus" : ""
    } required minlength="2" maxlength="200">
  <button type="submit">${esc(t(lang, "search_btn"))}</button>
</form>`;
}

function intentChips(payload: SearchPayload, lang: Lang): string {
  const chips: string[] = [];
  chips.push(
    `<span class="chip">${esc(t(lang, "chip_keyword"))}: <b>${esc(
      payload.intent.keyword,
    )}</b></span>`,
  );
  chips.push(
    payload.intent.max_price_myr === null
      ? `<span class="chip">${esc(t(lang, "chip_budget"))}: <b>${esc(
          t(lang, "chip_no_limit"),
        )}</b></span>`
      : `<span class="chip">${esc(t(lang, "chip_budget"))}: <b>≤ ${money(
          payload.intent.max_price_myr,
        )}</b></span>`,
  );
  chips.push(
    `<span class="chip">${esc(t(lang, "chip_intent"))}: <b>${
      payload.intent.engine === "gemini"
        ? "Gemini Flash-Lite"
        : esc(t(lang, "engine_heuristic"))
    }</b></span>`,
  );
  for (const source of payload.meta.sources) {
    const cls =
      source.status === "ok"
        ? "ok"
        : source.status === "placeholder"
          ? "demo"
          : source.status === "error" || source.status === "missing_credentials"
            ? "err"
            : "";
    chips.push(
      `<span class="chip ${cls}" title="${esc(source.note ?? "")}">${esc(
        source.label,
      )}: <b>${esc(source.status)}</b> · ${source.count}</span>`,
    );
  }
  return `<div class="chips">${chips.join("")}</div>`;
}

function productCard(
  product: PricedProduct,
  lang: Lang,
  currency: CurrencyCode = "MYR",
  rate = 1,
  env: Env = {},
): string {
  const thumb = product.image
    ? `<img src="${esc(product.image)}" alt="${esc(product.title)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="tile">${esc(SOURCE_META[product.source].short)}</span>`;

  const rating =
    product.rating === null ? "" : ` · ★ ${product.rating.toFixed(1)}`;
  const fmt = (myr: number): string =>
    formatMoney(convertCurrency(myr, rate), currency, lang);
  const moneyAttr = (myr: number): string =>
    `data-money="${myr.toFixed(2)}"`;

  return `<article class="card">
  <div class="thumb">${thumb}</div>
  <div class="body">
    <span class="src ${product.source}">${esc(product.source_label)}${
      product.demo ? ` · ${esc(t(lang, "card_demo"))}` : ""
    }</span>
    <h3 class="title">${esc(product.title)}</h3>
    <div class="price" ${moneyAttr(product.price_myr)}>${fmt(product.price_myr)}</div>
    <div class="ship">${esc(product.shipping.method)} · ${product.shipping.days_min}–${
      product.shipping.days_max
    } ${esc(t(lang, "card_days"))} · <span ${moneyAttr(
      product.shipping.cost_myr,
    )}>${fmt(product.shipping.cost_myr)}</span>${rating}</div>
    <div class="margin">${esc(t(lang, "card_margin"))} <b ${moneyAttr(
      product.margin_myr,
    )}>${fmt(product.margin_myr)}</b> · ${esc(
      t(lang, "card_supplier_cost"),
    )} <span ${moneyAttr(product.supplier_total_myr)}>${fmt(
      product.supplier_total_myr,
    )}</span></div>
    <div class="foot">
      <span class="total">${esc(t(lang, "card_total"))} <b ${moneyAttr(
        product.total_myr,
      )}>${fmt(product.total_myr)}</b></span>
    </div>
    <div class="buyrow">
      <a class="cta cta-wa" href="https://wa.me/${whatsappNumber(
        env,
      )}?text=${encodeURIComponent(
        orderMessage(product, lang, currency, rate),
      )}" target="_blank" rel="noopener">WhatsApp</a>
      <a class="cta cta-tg" href="${esc(
        telegramUrl(orderMessage(product, lang, currency, rate)),
      )}" target="_blank" rel="noopener">Telegram</a>
    </div>
    <a class="src-link" href="${esc(
      product.url,
    )}" target="_blank" rel="noopener nofollow">${esc(
      t(lang, "card_view_on"),
    )} ${esc(product.source_label)}</a>
  </div>
</article>`;
}

const EXAMPLES = [
  "mini projector bawah RM80",
  "wireless earbuds under RM50",
  "beg kanvas murah",
  "car vacuum below $15",
];

function statusPanel(env: Env, lang: Lang): string {
  const config = configStatus(env);
  const rows = [config.gemini, config.cj, config.aliexpress, config.whatsapp]
    .map((item) => {
      const dot = item.configured ? "ok-dot" : "warn-dot";
      const mark = item.configured
        ? t(lang, "status_live")
        : t(lang, "status_missing");
      return `<div class="status-row"><span class="status-dot ${dot}"></span><code>${esc(
        item.key,
      )}</code><span class="det">${esc(mark)} · ${esc(item.detail)}</span></div>`;
    })
    .join("");
  const p = config.pricing;

  return `<div class="status-card">
  <h3>${esc(t(lang, "status_title"))}</h3>
  ${rows}
  <div class="status-foot">Margin <b>${p.markup_pct}%</b>${
    p.flat_myr ? ` + ${money(p.flat_myr)}` : ""
  } · ${esc(t(lang, "status_margin_foot"))}</div>
</div>`;
}

function statusBody(env: Env, lang: Lang): string {
  return `<h1>${esc(t(lang, "status_title"))}</h1>
<p class="lede">${esc(t(lang, "status_lede"))}</p>
<div class="statuspage">
${statusPanel(env, lang)}
<div class="statuslinks">
  <a href="/health">/health (JSON)</a>
  <a href="/api">/api</a>
  <a href="/">${esc(t(lang, "nav_chat"))}</a>
</div>
</div>`;
}

function searchHomeBody(
  lang: Lang,
  currency: CurrencyCode = "MYR",
  rate = 1,
  env: Env = {},
  trending: PricedProduct[] = [],
  errorNote?: string,
): string {
  return `<div class="searchhome">
  <div class="searchlogo">MyKiraNiaga</div>
  <p class="searchtag">${esc(t(lang, "land_lede"))}</p>
  ${searchForm("", true, lang, true)}
  ${
    errorNote
      ? `<div class="chips center"><span class="chip err">${esc(errorNote)}</span></div>`
      : ""
  }
  <div class="chips center">
    ${EXAMPLES.map(
      (example) =>
        `<a class="chip" href="/search?q=${encodeURIComponent(
          example,
        )}&amp;lang=${lang}">${esc(example)}</a>`,
    ).join("")}
  </div>
</div>
${trendingBody(env, lang, currency, rate, trending)}`;
}
function viewSwitch(lang: Lang, active: ViewMode): string {
  const modes: ViewMode[] = ["large", "compact", "list"];
  const glyph: Record<ViewMode, string> = {
    large: "▦",
    compact: "▥",
    list: "☰",
  };

  return `<div class="viewswitch" role="group" aria-label="${esc(
    t(lang, "view_label"),
  )}">${modes
    .map((mode) => {
      const label = esc(t(lang, `view_${mode}`));
      return `<button type="button" class="viewbtn${
        mode === active ? " active" : ""
      }" data-view="${mode}" title="${label}" aria-label="${label}" aria-pressed="${
        mode === active
      }">${glyph[mode]}</button>`;
    })
    .join("")}</div>`;
}

const VIEW_SCRIPT = `
(function () {
  var grid = document.getElementById("productgrid");
  if (!grid) return;
  var KEY = "mkn_view";
  var buttons = document.querySelectorAll(".viewbtn");
  var query = new URLSearchParams(location.search);
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}

  function apply(view, persist) {
    grid.className = "grid view-" + view;
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute("data-view") === view;
      buttons[i].classList.toggle("active", on);
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (persist) {
      try { localStorage.setItem(KEY, view); } catch (e) {}
      var url = new URL(location.href);
      url.searchParams.set("view", view);
      history.replaceState(null, "", url.toString());
    }
  }

  if (!query.get("view") && stored) apply(stored, false);
  for (var j = 0; j < buttons.length; j++) {
    buttons[j].addEventListener("click", function () {
      apply(this.getAttribute("data-view"), true);
    });
  }
})();
`;

function resultsBody(
  payload: SearchPayload,
  lang: Lang,
  view: ViewMode,
  currency: CurrencyCode = "MYR",
  rate = 1,
  env: Env = {},
): string {
  const cards = payload.results
    .map((product) => productCard(product, lang, currency, rate, env))
    .join("\n");
  const hasResults = payload.results.length > 0;

  // Pure search page: search box, view switcher, product cards. Nothing else.
  const body = hasResults
    ? `<div class="resultsbar">${viewSwitch(lang, view)}</div>
<div class="grid view-${view}" id="productgrid">${cards}</div>
<script>${VIEW_SCRIPT}</script>`
    : `<div class="empty">
        <h2>${esc(t(lang, "empty_title"))}</h2>
        <p>${esc(
          (payload.meta.floor?.removed ?? 0) > 0
            ? t(lang, "floor_empty")
            : t(lang, "empty_text"),
        )}</p>
        <div class="chips" style="justify-content:center">
          ${EXAMPLES.map(
            (example) =>
              `<a class="chip" href="/search?q=${encodeURIComponent(
                example,
              )}&amp;lang=${lang}">${esc(example)}</a>`,
          ).join("")}
        </div>
      </div>`;

  return `${searchForm(payload.query, false, lang)}
${body}`;
}

/* ------------------------------------------------------------------ */
/* Policy pages (privacy, terms, shipping, refunds, contact)           */
/* ------------------------------------------------------------------ */

type PolicySlug = "privacy" | "terms" | "shipping" | "refunds" | "contact";

interface PolicySection {
  heading: string;
  body: string[];
}

interface PolicyDoc {
  title: string;
  intro: string;
  sections: PolicySection[];
}

const POLICY_SLUGS: PolicySlug[] = [
  "privacy",
  "terms",
  "shipping",
  "refunds",
  "contact",
];

const POLICY: Record<Lang, Record<PolicySlug, PolicyDoc>> = {
  ms: {
    privacy: {
      title: "Dasar Privasi",
      intro:
        "Kami menghormati privasi anda. Halaman ini menerangkan data yang diproses oleh MyKiraNiaga dan cara anda boleh mengawalnya.",
      sections: [
        {
          heading: "Data yang kami proses",
          body: [
            "Pertanyaan carian (teks yang anda taip), pilihan bahasa dan mata wang, serta sejarah chat sesi semasa. Sejarah chat disimpan dalam sessionStorage pelayar anda, bukan pada pelayan kami.",
            "Kami tidak menyimpan nama, nombor telefon atau alamat penghantaran di laman ini; maklumat itu hanya dikongsi melalui WhatsApp apabila anda membuat pesanan.",
          ],
        },
        {
          heading: "Cookies & storan tempatan",
          body: [
            "Cookie mkn_lang (30 hari) menyimpan pilihan bahasa. localStorage mkn_view dan mkn_chat_view menyimpan pilihan paparan grid/senarai.",
            "Tiada cookie pengiklanan atau pengesan pihak ketiga dipasang oleh laman ini.",
          ],
        },
        {
          heading: "Pihak ketiga",
          body: [
            "Kata kunci carian dihantar kepada CJ Dropshipping dan AliExpress (melalui gateway MyKiraShop). Hasrat chat diproses oleh Google Gemini. Setiap pihak tertakluk kepada dasar privasi masing-masing.",
          ],
        },
        {
          heading: "Hak anda",
          body: [
            "Anda boleh memadam sejarah chat dengan butang “Kosongkan chat” atau mengosongkan storan pelayar. Untuk pertanyaan privasi, hubungi kami di WhatsApp.",
          ],
        },
      ],
    },
    terms: {
      title: "Terma Perkhidmatan",
      intro:
        "Dengan menggunakan MyKiraNiaga, anda bersetuju dengan terma di bawah. Sila baca sebelum membuat pesanan.",
      sections: [
        {
          heading: "Perkhidmatan",
          body: [
            "MyKiraNiaga ialah enjin carian dan pembanding harga untuk produk dropship. Kami bukan penjual rekod; pesanan diselesaikan dengan pembekal (CJ Dropshipping / AliExpress) melalui pengesahan WhatsApp.",
          ],
        },
        {
          heading: "Harga & ketersediaan",
          body: [
            "Harga dipaparkan dalam mata wang pilihan anda, ditukar daripada harga MYR menggunakan kadar harian, dan mungkin berubah mengikut stok pembekal. Harga muktamad disahkan sebelum pembayaran.",
          ],
        },
        {
          heading: "Tanggungjawab",
          body: [
            "Anda bertanggungjawab memberikan maklumat penghantaran yang tepat. Kami tidak bertanggungjawab atas kelewatan kastam, cukai import, atau kegagalan pembekal di luar kawalan kami.",
          ],
        },
        {
          heading: "Perubahan terma",
          body: [
            "Kami boleh mengemas kini terma ini dari semasa ke semasa. Versi terkini sentiasa dipaparkan di halaman ini.",
          ],
        },
      ],
    },
    shipping: {
      title: "Maklumat Penghantaran",
      intro:
        "Semua pesanan dihantar terus daripada pembekal (dropship) ke alamat anda. Tiada stok disimpan oleh MyKiraNiaga.",
      sections: [
        {
          heading: "Masa pemprosesan",
          body: [
            "Pesanan disemak dan diteruskan kepada pembekal dalam 1–3 hari bekerja selepas pembayaran disahkan.",
          ],
        },
        {
          heading: "Masa penghantaran",
          body: [
            "Penghantaran rentas sempadan standard mengambil 7–18 hari bekerja melalui CJPacket Ordinary atau AliExpress Standard Shipping. Kelewatan kastam atau cuaca boleh menambah masa.",
          ],
        },
        {
          heading: "Nombor penjejakan",
          body: [
            "Nombor penjejakan diberikan melalui WhatsApp (dan e-mel jika anda memberikannya) sebaik ia tersedia daripada pembekal. Anda juga boleh semak status melalui pautan pada halaman pesanan.",
          ],
        },
        {
          heading: "Duti & cukai",
          body: [
            "Duti import atau cukai (jika ada) ditanggung oleh pembeli mengikut peraturan negara destinasi.",
          ],
        },
      ],
    },
    refunds: {
      title: "Pemulangan & Bayaran Balik",
      intro:
        "Kami mahu anda menerima produk yang betul dan berfungsi. Dasar ini terpakai untuk item rosak atau tidak seperti yang dipesan.",
      sections: [
        {
          heading: "Tetingkap 14 hari",
          body: [
            "Item yang rosak atau tidak berfungsi semasa tiba boleh diminta pemulangan dalam 14 hari kalendar selepas penghantaran diterima.",
          ],
        },
        {
          heading: "Bukti diperlukan",
          body: [
            "Sertakan foto atau video unboxing yang menunjukkan label penghantaran, keadaan bungkusan dan kecacatan. Permintaan tanpa bukti mungkin ditolak.",
          ],
        },
        {
          heading: "Aliran kerja",
          body: [
            "Hubungi WhatsApp → semakan 2–3 hari bekerja → pilih ganti atau bayaran balik. Untuk item rosak, kos penghantaran semula ditanggung kami.",
          ],
        },
        {
          heading: "Tidak layak",
          body: [
            "Item yang telah digunakan, diubah suai, atau produk digital yang telah dimuat turun tidak layak untuk pemulangan.",
          ],
        },
      ],
    },
    contact: {
      title: "Hubungi Kami",
      intro:
        "Pasukan sokongan MyKiraNiaga sedia membantu untuk pertanyaan produk, pesanan dan pemulangan.",
      sections: [
        {
          heading: "WhatsApp (saluran utama)",
          body: [
            "WhatsApp Business: +60 17-373 5431 — https://wa.me/60173735431",
          ],
        },
        {
          heading: "Telegram",
          body: ["@Mykirashopbot — https://t.me/Mykirashopbot"],
        },
        {
          heading: "E-mel",
          body: [
            "support@mykiraniaga.example (placeholder — akan dikemas kini apabila domain rasmi siap).",
          ],
        },
        {
          heading: "Waktu operasi",
          body: [
            "Isnin–Sabtu, 9:00 pagi – 6:00 petang (MYT). Balasan biasa dalam 24 jam bekerja.",
          ],
        },
      ],
    },
  },
  en: {
    privacy: {
      title: "Privacy Policy",
      intro:
        "We respect your privacy. This page explains what MyKiraNiaga processes and how you can control it.",
      sections: [
        {
          heading: "Data we process",
          body: [
            "Search queries, language/currency choices and the current chat history. Chat history lives in your browser's sessionStorage, not on our servers.",
            "We do not store names, phone numbers or delivery addresses on this site; those are shared only through WhatsApp when you place an order.",
          ],
        },
        {
          heading: "Cookies & local storage",
          body: [
            "The mkn_lang cookie (30 days) remembers your language. localStorage keys mkn_view and mkn_chat_view remember your grid/list preference.",
            "No advertising cookies or third-party trackers are set by this site.",
          ],
        },
        {
          heading: "Third parties",
          body: [
            "Search keywords are sent to CJ Dropshipping and AliExpress (via the MyKiraShop gateway). Chat intent is processed by Google Gemini. Each provider follows its own privacy policy.",
          ],
        },
        {
          heading: "Your rights",
          body: [
            "Clear chat history with the “Clear chat” button or by clearing browser storage. For privacy requests, contact us on WhatsApp.",
          ],
        },
      ],
    },
    terms: {
      title: "Terms of Service",
      intro:
        "By using MyKiraNiaga you agree to the terms below. Please read them before ordering.",
      sections: [
        {
          heading: "The service",
          body: [
            "MyKiraNiaga is a dropshipping search and price-comparison engine. We are not the seller of record; orders are fulfilled by suppliers (CJ Dropshipping / AliExpress) after WhatsApp confirmation.",
          ],
        },
        {
          heading: "Pricing & availability",
          body: [
            "Prices are shown in your selected currency, converted from MYR using daily rates, and may change with supplier stock. The final price is confirmed before payment.",
          ],
        },
        {
          heading: "Responsibility",
          body: [
            "You are responsible for accurate delivery details. We are not liable for customs delays, import taxes, or supplier failures outside our control.",
          ],
        },
        {
          heading: "Changes",
          body: [
            "We may update these terms from time to time. The current version is always published on this page.",
          ],
        },
      ],
    },
    shipping: {
      title: "Shipping Information",
      intro:
        "Every order ships directly from the supplier (dropship) to your address. MyKiraNiaga holds no stock.",
      sections: [
        {
          heading: "Processing time",
          body: [
            "Orders are reviewed and forwarded to the supplier within 1–3 business days after payment is confirmed.",
          ],
        },
        {
          heading: "Delivery time",
          body: [
            "Standard cross-border delivery takes 7–18 business days via CJPacket Ordinary or AliExpress Standard Shipping. Customs or weather delays may add time.",
          ],
        },
        {
          heading: "Tracking number",
          body: [
            "Tracking numbers are shared via WhatsApp (and email if provided) as soon as the supplier issues them. You can also check the link on the order page.",
          ],
        },
        {
          heading: "Duties & taxes",
          body: [
            "Any import duties or taxes are payable by the buyer according to the destination country's rules.",
          ],
        },
      ],
    },
    refunds: {
      title: "Returns & Refunds",
      intro:
        "We want you to receive the right product in working condition. This policy covers damaged or not-as-described items.",
      sections: [
        {
          heading: "14-day window",
          body: [
            "Items that arrive damaged or faulty can be returned within 14 calendar days of delivery.",
          ],
        },
        {
          heading: "Proof required",
          body: [
            "Include unboxing photos or video showing the shipping label, packaging condition and the defect. Requests without evidence may be declined.",
          ],
        },
        {
          heading: "Workflow",
          body: [
            "Contact WhatsApp → review within 2–3 business days → choose a replacement or refund. For damaged items, return shipping is covered by us.",
          ],
        },
        {
          heading: "Not eligible",
          body: [
            "Used, modified items and downloaded digital products are not eligible for return.",
          ],
        },
      ],
    },
    contact: {
      title: "Contact Us",
      intro:
        "The MyKiraNiaga support team can help with product, order and return questions.",
      sections: [
        {
          heading: "WhatsApp (primary channel)",
          body: [
            "WhatsApp Business: +60 17-373 5431 — https://wa.me/60173735431",
          ],
        },
        {
          heading: "Telegram",
          body: ["@Mykirashopbot — https://t.me/Mykirashopbot"],
        },
        {
          heading: "Email",
          body: [
            "support@mykiraniaga.example (placeholder — will be updated once the official domain is ready).",
          ],
        },
        {
          heading: "Operating hours",
          body: [
            "Monday–Saturday, 9:00am–6:00pm (MYT). Typical reply within 24 business hours.",
          ],
        },
      ],
    },
  },
  id: {
    privacy: {
      title: "Kebijakan Privasi",
      intro:
        "Kami menghormati privasi Anda. Halaman ini menjelaskan data yang diproses MyKiraNiaga.",
      sections: [
        {
          heading: "Data yang diproses",
          body: [
            "Kata kunci pencarian, pilihan bahasa/mata uang, dan riwayat chat sesi ini. Riwayat chat disimpan di sessionStorage peramban Anda, bukan di server kami.",
          ],
        },
        {
          heading: "Cookie & penyimpanan lokal",
          body: [
            "Cookie mkn_lang (30 hari) menyimpan pilihan bahasa. localStorage mkn_view dan mkn_chat_view menyimpan pilihan tampilan.",
            "Tidak ada cookie iklan atau pelacak pihak ketiga.",
          ],
        },
        {
          heading: "Pihak ketiga",
          body: [
            "Pencarian dikirim ke CJ Dropshipping dan AliExpress; maksud chat diproses Google Gemini sesuai kebijakan privasi masing-masing.",
          ],
        },
        {
          heading: "Hak Anda",
          body: [
            "Hapus riwayat chat lewat tombol “Bersihkan chat”. Untuk pertanyaan privasi, hubungi WhatsApp kami.",
          ],
        },
      ],
    },
    terms: {
      title: "Syarat Layanan",
      intro:
        "Dengan menggunakan MyKiraNiaga, Anda menyetujui syarat berikut.",
      sections: [
        {
          heading: "Layanan",
          body: [
            "MyKiraNiaga adalah mesin pencari dan pembanding harga produk dropship. Kami bukan penjual resmi; pesanan dipenuhi pemasok melalui konfirmasi WhatsApp.",
          ],
        },
        {
          heading: "Harga & ketersediaan",
          body: [
            "Harga ditampilkan dalam mata uang pilihan Anda, dikonversi dari MYR dengan kurs harian, dan dapat berubah sesuai stok pemasok. Harga final dikonfirmasi sebelum pembayaran.",
          ],
        },
        {
          heading: "Tanggung jawab",
          body: [
            "Anda bertanggung jawab atas data pengiriman yang akurat. Kami tidak bertanggung jawab atas keterlambatan bea cukai atau kegagalan pemasok di luar kendali kami.",
          ],
        },
      ],
    },
    shipping: {
      title: "Informasi Pengiriman",
      intro:
        "Semua pesanan dikirim langsung dari pemasok (dropship) ke alamat Anda.",
      sections: [
        {
          heading: "Waktu pemrosesan",
          body: [
            "Pesanan diperiksa dan diteruskan ke pemasok dalam 1–3 hari kerja setelah pembayaran dikonfirmasi.",
          ],
        },
        {
          heading: "Waktu pengiriman",
          body: [
            "Pengiriman lintas negara standar 7–18 hari kerja melalui CJPacket Ordinary atau AliExpress Standard Shipping.",
          ],
        },
        {
          heading: "Nomor pelacakan",
          body: [
            "Nomor pelacakan dikirim melalui WhatsApp (dan email jika ada) begitu tersedia dari pemasok.",
          ],
        },
        {
          heading: "Bea & pajak",
          body: [
            "Bea masuk atau pajak (jika ada) ditanggung pembeli sesuai aturan negara tujuan.",
          ],
        },
      ],
    },
    refunds: {
      title: "Pengembalian & Refund",
      intro:
        "Dasar ini berlaku untuk barang rusak atau tidak sesuai pesanan.",
      sections: [
        {
          heading: "Jendela 14 hari",
          body: [
            "Barang rusak atau tidak berfungsi saat tiba dapat dikembalikan dalam 14 hari kalender setelah diterima.",
          ],
        },
        {
          heading: "Bukti diperlukan",
          body: [
            "Sertakan foto/video unboxing yang menunjukkan label pengiriman, kondisi kemasan, dan kerusakan.",
          ],
        },
        {
          heading: "Alur kerja",
          body: [
            "Hubungi WhatsApp → peninjauan 2–3 hari kerja → pilih penggantian atau refund. Untuk barang rusak, ongkos kirim pengganti ditanggung kami.",
          ],
        },
        {
          heading: "Tidak memenuhi syarat",
          body: [
            "Barang yang sudah dipakai/dimodifikasi dan produk digital yang sudah diunduh tidak dapat dikembalikan.",
          ],
        },
      ],
    },
    contact: {
      title: "Hubungi Kami",
      intro: "Tim dukungan MyKiraNiaga siap membantu pertanyaan produk dan pesanan.",
      sections: [
        {
          heading: "WhatsApp (saluran utama)",
          body: ["WhatsApp Business: +60 17-373 5431 — https://wa.me/60173735431"],
        },
        {
          heading: "Email",
          body: [
            "support@mykiraniaga.example (placeholder — akan diperbarui setelah domain resmi siap).",
          ],
        },
        {
          heading: "Jam operasional",
          body: [
            "Senin–Sabtu, 09.00–18.00 (MYT). Balasan biasanya dalam 24 jam kerja.",
          ],
        },
      ],
    },
  },
  zh: {
    privacy: {
      title: "隐私政策",
      intro: "我们尊重您的隐私。本页说明 MyKiraNiaga 处理的数据及您的控制方式。",
      sections: [
        {
          heading: "我们处理的数据",
          body: [
            "搜索关键词、语言/货币选择以及本次会话的聊天记录。聊天记录保存在浏览器的 sessionStorage 中，不在我们的服务器上。",
            "本网站不存储姓名、电话或收货地址；这些信息仅在下单时通过 WhatsApp 共享。",
          ],
        },
        {
          heading: "Cookie 与本地存储",
          body: [
            "Cookie mkn_lang（30 天）记住语言选择；localStorage mkn_view 与 mkn_chat_view 记住网格/列表偏好。",
            "本网站不设置广告 Cookie 或第三方跟踪器。",
          ],
        },
        {
          heading: "第三方",
          body: [
            "搜索关键词发送至 CJ Dropshipping 与 AliExpress；聊天意图由 Google Gemini 处理，各方遵循其隐私政策。",
          ],
        },
        {
          heading: "您的权利",
          body: ["可用“清空聊天”按钮或清除浏览器存储。隐私问题请通过 WhatsApp 联系。"],
        },
      ],
    },
    terms: {
      title: "服务条款",
      intro: "使用 MyKiraNiaga 即表示您同意以下条款。",
      sections: [
        {
          heading: "服务内容",
          body: [
            "MyKiraNiaga 是代发商品的搜索与比价引擎。我们不是销售方；订单经 WhatsApp 确认后由供应商（CJ / AliExpress）履约。",
          ],
        },
        {
          heading: "价格与库存",
          body: [
            "价格以您选择的货币显示，按每日汇率由 MYR 换算，可能随供应商库存变化。最终价格在付款前确认。",
          ],
        },
        {
          heading: "责任",
          body: [
            "您需提供准确的收货信息。对于海关延误、进口税费或供应商原因造成的延误，我们不承担责任。",
          ],
        },
        {
          heading: "条款变更",
          body: ["我们可能不时更新条款，最新版本始终发布在本页。"],
        },
      ],
    },
    shipping: {
      title: "配送信息",
      intro: "所有订单由供应商直接发货（代发）至您的地址，MyKiraNiaga 不持有库存。",
      sections: [
        {
          heading: "处理时间",
          body: ["付款确认后 1–3 个工作日内审核并转交供应商。"],
        },
        {
          heading: "运输时间",
          body: [
            "标准跨境配送约 7–18 个工作日（CJPacket Ordinary 或 AliExpress Standard Shipping）。海关或天气可能延长。",
          ],
        },
        {
          heading: "物流单号",
          body: ["供应商出单后，我们会通过 WhatsApp（如有邮箱则同时发送）提供物流单号。"],
        },
        {
          heading: "关税与税费",
          body: ["进口关税或税费（如有）由买家按目的地国家规定承担。"],
        },
      ],
    },
    refunds: {
      title: "退换与退款",
      intro: "我们希望您收到正确且可用的商品。本政策适用于损坏或与描述不符的商品。",
      sections: [
        {
          heading: "14 天窗口",
          body: ["到货时损坏或无法使用的商品，可在签收后 14 个日历日内申请退换。"],
        },
        {
          heading: "需要凭证",
          body: ["请提供开箱照片或视频，显示运单标签、包装状态与缺陷。"],
        },
        {
          heading: "处理流程",
          body: [
            "联系 WhatsApp → 2–3 个工作日审核 → 选择补发或退款。损坏商品的退回运费由我们承担。",
          ],
        },
        {
          heading: "不适用",
          body: ["已使用、改装过的商品及已下载的数字产品不支持退换。"],
        },
      ],
    },
    contact: {
      title: "联系我们",
      intro: "MyKiraNiaga 支持团队可协助产品、订单与退换问题。",
      sections: [
        {
          heading: "WhatsApp（主要渠道）",
          body: ["WhatsApp Business：+60 17-373 5431 — https://wa.me/60173735431"],
        },
        {
          heading: "邮箱",
          body: ["support@mykiraniaga.example（占位，正式域名准备后更新）。"],
        },
        {
          heading: "营业时间",
          body: ["周一至周六 09:00–18:00（MYT），通常 24 个工作小时内回复。"],
        },
      ],
    },
  },
};

function policyBody(slug: PolicySlug, lang: Lang): string {
  const doc = POLICY[lang][slug];
  const back = `<a class="pback" href="/">← ${esc(t(lang, "back_home"))}</a>`;

  return `<div class="policy">
  ${back}
  <h1>${esc(doc.title)}</h1>
  <p class="pintro">${esc(doc.intro)}</p>
  ${doc.sections
    .map(
      (section) =>
        `<section><h2>${esc(section.heading)}</h2>${section.body
          .map((paragraph) => `<p>${esc(paragraph)}</p>`)
          .join("")}</section>`,
    )
    .join("")}
  <p class="updated">${esc(t(lang, "policy_updated"))}</p>
  ${back}
</div>`;
}

function errorBody(message: string, lang: Lang): string {
  return `<div class="err-box">
  <h1>${esc(t(lang, "error_title"))}</h1>
  <p style="color:#fca5a5;margin:0 0 14px">${esc(message)}</p>
  <a class="chip" href="/">${esc(t(lang, "error_back"))}</a>
</div>`;
}

interface CheckoutOrder {
  id: string;
  source: SourceId;
  source_label: string;
  title: string;
  supplier_price_myr: number;
  supplier_total_myr: number;
  shipping_myr: number;
  shipping_method: string;
  margin_myr: number;
  total_myr: number;
  markup_pct: number;
  flat_myr: number;
  whatsapp_url: string;
  display_currency?: CurrencyCode;
  display_supplier?: string;
  display_shipping?: string;
  display_margin?: string;
  display_total?: string;
  telegram_url?: string;
}

function checkoutBody(order: CheckoutOrder, query: string, lang: Lang): string {
  const back = query ? `/search?q=${encodeURIComponent(query)}&lang=${lang}` : "/";
  const marginLabel = `${order.markup_pct}%${
    order.flat_myr ? ` + ${money(order.flat_myr)}` : ""
  }`;
  const supplier = order.display_supplier ?? money(order.supplier_price_myr);
  const shipping = order.display_shipping ?? money(order.shipping_myr);
  const margin = order.display_margin ?? money(order.margin_myr);
  const total = order.display_total ?? money(order.total_myr);

  return `<div class="checkout"><div class="box">
  <h1>${esc(order.title)}</h1>
  <div class="oid">ID ${esc(order.id)} · ${esc(order.source_label)}</div>
  <div class="crow"><span>${esc(t(lang, "checkout_supplier"))}</span><span>${esc(
    supplier,
  )}</span></div>
  <div class="crow"><span>${esc(t(lang, "checkout_shipping"))} (${esc(
    order.shipping_method,
  )})</span><span>${esc(shipping)}</span></div>
  <div class="crow"><span>${esc(t(lang, "checkout_margin"))} ${esc(
    marginLabel,
  )}</span><span>${esc(margin)}</span></div>
  <div class="crow total"><span>${esc(t(lang, "checkout_total"))}</span><span>${esc(
    total,
  )}</span></div>
  <a class="wa-btn" href="${esc(
    order.whatsapp_url,
  )}" target="_blank" rel="noopener">${esc(t(lang, "checkout_wa"))}</a>
  <a class="tg-btn" href="${esc(order.telegram_url ?? telegramUrl(""))}" target="_blank" rel="noopener">Telegram</a>
  <p class="note">${esc(t(lang, "checkout_note"))}</p>
  <a class="back" href="${esc(back)}">← ${esc(t(lang, "checkout_back"))}</a>
</div></div>`;
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function cookieValue(c: Context, name: string): string {
  const header = c.req.header("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return "";
}

function langFrom(c: Context): Lang {
  const requested = (c.req.query("lang") ?? "").toLowerCase();
  if (requested === "ms" || requested === "en" || requested === "id" || requested === "zh") {
    return requested;
  }
  const cookie = cookieValue(c, "mkn_lang").toLowerCase();
  return cookie === "en" || cookie === "id" || cookie === "zh" ? cookie : "ms";
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const requested = (c.req.query("lang") ?? "").toLowerCase();
  await next();
  if (requested === "ms" || requested === "en" || requested === "id" || requested === "zh") {
    c.header(
      "Set-Cookie",
      `mkn_lang=${requested}; Path=/; Max-Age=2592000; SameSite=Lax`,
    );
  }
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Vary", "Accept, Cookie");
});

app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], maxAge: 86400 }));

app.get("/", async (c) => {
  const lang = langFrom(c);

  if (wantsJson(c)) {
    return c.json({
      service: SERVICE,
      version: VERSION,
      description:
        "On-demand dropshipping search engine with a conversational layer. Gemini Flash-Lite keeps multi-turn context, fires the CJ + AliExpress pipeline, and returns product cards with margin and WhatsApp checkout.",
      endpoints: {
        "GET /": "chat UI (HTML) · this JSON when ?format=json or Accept: application/json",
        "GET /chat": "chat UI alias",
        "POST /api/chat": "multi-turn chat (JSON): {messages:[{role,content}], lang}",
        "GET /search?q=": "classic results (HTML/JSON negotiated)",
        "GET /api/search?q=": "search (JSON only)",
        "GET /checkout?source=&id=&base=&currency=": "order summary + WhatsApp handoff (converted)",
        "GET /status": "system status page (HTML) · JSON with ?format=json",
        "GET /privacy|/terms|/shipping|/refunds|/contact": "policy pages (4 languages)",
        "GET /health": "health probe + key status",
      },
      config: configStatus(c.env),
      examples: [
        "/search?q=mini%20projector%20bawah%20RM80",
        "/api/search?q=wireless%20earbuds%20under%20RM50",
      ],
    });
  }

  return c.html(
    layout({
      title:
        lang === "en"
          ? "MyKiraNiaga — shopping chat"
          : "MyKiraNiaga — chat beli-belah",
      description: t(lang, "chat_lede"),
      body: chatBody(
        c.env,
        lang,
        currencyFrom(c.req.query("currency")),
        rateFor(
          await getRates(c.env),
          currencyFrom(c.req.query("currency")),
        ),
        await getTrending(c.env),
      ),
      lang,
      currentUrl: c.req.url,
    }),
  );
});

app.get("/chat", async (c) => {
  if (wantsJson(c)) {
    return c.json({
      ok: true,
      service: SERVICE,
      endpoint: "POST /api/chat",
      body: { messages: [{ role: "user", content: "nak cari laptop murah" }], lang: "ms|en" },
    });
  }

  const lang = langFrom(c);
  return c.html(
    layout({
      title:
        lang === "en"
          ? "MyKiraNiaga — shopping chat"
          : "MyKiraNiaga — chat beli-belah",
      description: t(lang, "chat_lede"),
      body: chatBody(
        c.env,
        lang,
        currencyFrom(c.req.query("currency")),
        rateFor(
          await getRates(c.env),
          currencyFrom(c.req.query("currency")),
        ),
        await getTrending(c.env),
      ),
      lang,
      currentUrl: c.req.url,
    }),
  );
});

app.get("/status", (c) => {
  if (wantsJson(c)) {
    return c.json({
      ok: true,
      service: SERVICE,
      version: VERSION,
      keys: configStatus(c.env),
      margin: pricingFromEnv(c.env),
      whatsapp: `+${whatsappNumber(c.env)}`,
    });
  }

  const lang = langFrom(c);
  return c.html(
    layout({
      title:
        lang === "en"
          ? "System status — MyKiraNiaga"
          : "Status sistem — MyKiraNiaga",
      description: t(lang, "status_lede"),
      body: statusBody(c.env, lang),
      lang,
      currentUrl: c.req.url,
    }),
  );
});

app.post("/api/chat", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      { ok: false, error: "invalid_json", message: "Body mesti JSON." },
      400,
    );
  }

  const row = (raw ?? {}) as Record<string, unknown>;
  const messages = sanitizeMessages(row.messages);
  if (messages.length === 0) {
    return c.json(
      {
        ok: false,
        error: "missing_messages",
        message: "Hantar messages: [{role:'user', content:'...'}].",
      },
      400,
    );
  }

  const requestedLang = str(row.lang || c.req.query("lang")).toLowerCase();
  const lang: Lang =
    requestedLang === "en" || requestedLang === "id" || requestedLang === "zh"
      ? requestedLang
      : "ms";
  const currency = currencyFrom(
    str(row.currency || c.req.query("currency")) || undefined,
  );
  const rate = rateFor(await getRates(c.env), currency);
  const lastUser =
    [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

  const chat = await chatTurn(c.env, messages, lang, currency, rate);

  let search: SearchPayload | null = null;
  if (chat.ready && chat.keyword) {
    const intent: Intent = {
      keyword: chat.keyword,
      max_price_myr: chat.max_price_myr,
      ...(chat.filters.length ? { filters: chat.filters } : {}),
      engine: chat.engine,
      ...(chat.model ? { model: chat.model } : {}),
      ...(chat.note ? { note: chat.note } : {}),
    };
    search = await runSearchWithIntent(
      c.env,
      lastUser || chat.keyword,
      intent,
      6,
    );
  }

  const ranked = rankByFilters(search?.results ?? [], chat.filters);
  const products = ranked.map((product) =>
    presentProduct(product, c.env, currency, rate, lang),
  );
  const cards = ranked
    .map((product) => productCard(product, lang, currency, rate, c.env))
    .join("\n");
  const productsHtml = products.length ? `<div class="grid">${cards}</div>` : "";

  let reply = chat.reply;

  // Guarantee the spec is acknowledged conversationally, even if the model forgot.
  if (
    chat.filters.length > 0 &&
    !chat.filters.some((filter) => reply.toLowerCase().includes(filter))
  ) {
    const ack =
      lang === "en"
        ? `Got it — ${chat.filters.join(", ")}. `
        : `Faham, nak ${chat.filters.join(", ")}. `;
    reply = ack + reply;
  }

  if (search && products.length === 0) {
    const emptyNote =
      (search.meta.floor?.removed ?? 0) > 0
        ? t(lang, "floor_empty")
        : t(lang, "chat_empty");
    reply = `${reply} ${emptyNote}`.trim();
  }

  c.header("Cache-Control", "no-store");

  return c.json({
    ok: true,
    reply,
    lang,
    intent: {
      keyword: chat.keyword,
      max_price_myr: chat.max_price_myr,
      filters: chat.filters,
      explicit: chat.explicit,
      ready: chat.ready,
      engine: chat.engine,
      ...(chat.model ? { model: chat.model } : {}),
      ...(chat.note ? { note: chat.note } : {}),
    },
    search: search
      ? {
          count: search.meta.count,
          removed: search.budget.removed,
          timing_ms: search.meta.timing_ms,
          partial: search.meta.partial,
          sources: search.meta.sources,
          floor: search.meta.floor,
        }
      : null,
    currency,
    rate,
    products,
    products_html: productsHtml,
    metrics: {
      count: products.length,
      timing_ms: search?.meta.timing_ms ?? 0,
      filters: chat.filters,
      removed: search?.meta.floor?.removed ?? 0,
    },
  });
});
app.get("/search", async (c) => {
  const lang = langFrom(c);
  const rawQuery = (c.req.query("q") ?? "").trim();

  if (!rawQuery) {
    if (wantsJson(c)) {
      return c.json(
        { ok: false, error: "missing_query", message: t(lang, "missing_query") },
        400,
      );
    }
    return c.html(
      layout({
        title: t(lang, "meta_search_title"),
        description: t(lang, "meta_search_desc"),
        body: searchHomeBody(
          lang,
          currencyFrom(c.req.query("currency")),
          rateFor(
            await getRates(c.env),
            currencyFrom(c.req.query("currency")),
          ),
          c.env,
          await getTrending(c.env),
        ),
        lang,
        currentUrl: c.req.url,
      }),
    );
  }

  if (rawQuery.length < 2 || rawQuery.length > 200) {
    const message = t(lang, "invalid_query");
    if (wantsJson(c)) {
      return c.json({ ok: false, error: "invalid_query", message }, 400);
    }
    return c.html(
      layout({
        title: t(lang, "meta_invalid_title"),
        description: message,
        body: errorBody(message, lang),
        lang,
        currentUrl: c.req.url,
      }),
      400,
    );
  }

  const limit = Number(c.req.query("limit") ?? "24");
  const payload = await runSearch(c.env, rawQuery, Number.isFinite(limit) ? limit : 24);

  c.header("Cache-Control", "public, max-age=60");

  if (wantsJson(c)) return c.json(payload);

  const budgetSuffix =
    payload.intent.max_price_myr === null
      ? ""
      : lang === "en"
        ? ` under ${money(payload.intent.max_price_myr)}`
        : ` bawah ${money(payload.intent.max_price_myr)}`;
  const description =
    lang === "en"
      ? `Dropship results for "${payload.intent.keyword}"${budgetSuffix}.`
      : `Hasil carian dropship untuk "${payload.intent.keyword}"${budgetSuffix}.`;

  return c.html(
    layout({
      title: `${payload.intent.keyword} — MyKiraNiaga`,
      description,
      body: resultsBody(
        payload,
        lang,
        viewFrom(c.req.query("view")),
        currencyFrom(c.req.query("currency")),
        rateFor(await getRates(c.env), currencyFrom(c.req.query("currency"))),
        c.env,
      ),
      lang,
      currentUrl: c.req.url,
    }),
  );
});

app.get("/checkout", async (c) => {
  const lang = langFrom(c);
  const source = (c.req.query("source") ?? "").toLowerCase();
  const id = (c.req.query("id") ?? "").trim().slice(0, 140);
  const query = (c.req.query("q") ?? "").trim().slice(0, 200);
  const base = Number(c.req.query("base"));
  const validSource = source === "cj" || source === "aliexpress";

  if (!validSource || !id || !Number.isFinite(base) || base <= 0 || base > 100000) {
    const message = t(lang, "invalid_checkout");
    if (wantsJson(c)) {
      return c.json({ ok: false, error: "invalid_checkout", message }, 400);
    }
    return c.html(
      layout({
        title: t(lang, "meta_checkout_title"),
        description: message,
        body: errorBody(message, lang),
        lang,
        currentUrl: c.req.url,
      }),
      400,
    );
  }

  const sourceId = source as SourceId;
  const shipping = DEFAULT_SHIPPING[sourceId];
  const pricing = pricingFromEnv(c.env);
  // `base` is the supplier landed total carried by the result card.
  const supplierPrice = round2(Math.max(base - shipping.cost_myr, 0.01));
  const margin = applyMargin(supplierPrice, shipping.cost_myr, pricing);
  const title =
    (c.req.query("title") ?? "").trim().slice(0, 140) ||
    `${t(lang, "checkout_product")} ${id}`;
  const label = SOURCE_META[sourceId].label;

  const currency = currencyFrom(c.req.query("currency"));
  const rate = rateFor(await getRates(c.env), currency);
  const display = (myr: number): string =>
    formatMoney(convertCurrency(myr, rate), currency, lang);
  const totalText =
    currency === "MYR"
      ? display(margin.total)
      : `${display(margin.total)} (MYR ${margin.total.toFixed(2)})`;

  const waText =
    lang === "en"
      ? [
          "I want to order:",
          `1) ${title}`,
          `ID: ${id}`,
          `Source: ${label}`,
          `Total: ${totalText} (incl. shipping)`,
        ].join("\n")
      : lang === "zh"
        ? [
            "我想下单：",
            `1) ${title}`,
            `编号: ${id}`,
            `来源: ${label}`,
            `合计: ${totalText}`,
          ].join("\n")
        : lang === "id"
          ? [
              "Saya mau pesan:",
              `1) ${title}`,
              `ID: ${id}`,
              `Sumber: ${label}`,
              `Total: ${totalText}`,
            ].join("\n")
          : [
              "Saya nak order:",
              `1) ${title}`,
              `ID: ${id}`,
              `Sumber: ${label}`,
              `Jumlah: ${totalText} (termasuk pos)`,
            ].join("\n");

  const order: CheckoutOrder = {
    id,
    source: sourceId,
    source_label: label,
    title,
    supplier_price_myr: margin.supplier_price,
    supplier_total_myr: margin.supplier_total,
    shipping_myr: shipping.cost_myr,
    shipping_method: shipping.method,
    margin_myr: margin.margin,
    total_myr: margin.total,
    markup_pct: pricing.markup_pct,
    flat_myr: pricing.flat_myr,
    whatsapp_url: `https://wa.me/${whatsappNumber(c.env)}?text=${encodeURIComponent(
      waText,
    )}`,
    telegram_url: telegramUrl(
      waText.replace("Saya nak order:", `Hai @${TELEGRAM_BOT}! Saya nak order:`)
        .replace("I want to order:", `Hi @${TELEGRAM_BOT}! I want to order:`)
        .replace("Saya mau pesan:", `Hai @${TELEGRAM_BOT}! Saya mau pesan:`)
        .replace("我想下单：", `你好 @${TELEGRAM_BOT}！我想下单：`),
    ),
    display_currency: currency,
    display_supplier: display(margin.supplier_price),
    display_shipping: display(shipping.cost_myr),
    display_margin: display(margin.margin),
    display_total:
      currency === "MYR"
        ? display(margin.total)
        : `${display(margin.total)} (MYR ${margin.total.toFixed(2)})`,
  };

  c.header("Cache-Control", "no-store");

  if (wantsJson(c)) return c.json({ ok: true, order, pricing });

  return c.html(
    layout({
      title: `${id} — MyKiraNiaga`,
      description: `${t(lang, "meta_order_desc")}: ${title} (${money(
        order.total_myr,
      )}).`,
      body: checkoutBody(order, query, lang),
      lang,
      currentUrl: c.req.url,
    }),
  );
});

app.get("/api/search", async (c) => {
  const rawQuery = (c.req.query("q") ?? "").trim();
  if (rawQuery.length < 2 || rawQuery.length > 200) {
    return c.json(
      {
        ok: false,
        error: "invalid_query",
        message: "Parameter q diperlukan (2-200 aksara) / q is required (2-200 chars).",
      },
      400,
    );
  }

  const limit = Number(c.req.query("limit") ?? "24");
  const payload = await runSearch(c.env, rawQuery, Number.isFinite(limit) ? limit : 24);

  const lang = langFrom(c);
  const currency = currencyFrom(c.req.query("currency"));
  const rate = rateFor(await getRates(c.env), currency);
  const results = payload.results.map((product) =>
    presentProduct(product, c.env, currency, rate, lang),
  );

  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    ...payload,
    currency,
    rate,
    results,
  });
});

app.get("/api", (c) =>
  c.json({
    service: SERVICE,
    version: VERSION,
    endpoints: {
      "POST /api/chat": "multi-turn chat (JSON)",
      "GET /search?q=&format=json": "search (content negotiated)",
      "GET /api/search?q=": "search (JSON)",
      "GET /checkout?source=&id=&base=": "checkout summary (HTML or JSON)",
      "GET /status": "status page (HTML or JSON)",
      "GET /health": "health",
    },
    params: {
      q: "query string, 2-200 chars",
      format: "json | html (optional)",
      lang: "ms | en | id | zh (optional, default ms)",
      currency: "MYR | USD | SGD | IDR | CNY (optional, default MYR)",
      limit: `1-${MAX_RESULTS} (default 24)`,
    },
    response_fields: {
      intent: ["keyword", "max_price_myr", "engine", "model", "note"],
      pricing: ["markup_pct", "flat_myr"],
      config: ["gemini", "cj", "aliexpress", "whatsapp", "pricing"],
      budget: ["max_price_myr", "applied", "basis", "removed"],
      results: [
        "id",
        "source",
        "title",
        "price_myr",
        "total_myr",
        "shipping",
        "image",
        "url",
        "demo",
        "supplier_price_myr",
        "supplier_total_myr",
        "margin_myr",
        "checkout_url",
        "whatsapp_url",
      ],
      meta: ["timing_ms", "count", "partial", "sources"],
    },
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: SERVICE,
    version: VERSION,
    time: new Date().toISOString(),
    keys: configStatus(c.env),
    margin: pricingFromEnv(c.env),
    whatsapp: `+${whatsappNumber(c.env)}`,
  }),
);

app.get("/robots.txt", (c) => c.text("User-agent: *\nAllow: /\n"));

for (const slug of POLICY_SLUGS) {
  app.get(`/${slug}`, (c) => {
    const lang = langFrom(c);
    const doc = POLICY[lang][slug];

    if (wantsJson(c)) {
      return c.json({
        ok: true,
        slug,
        lang,
        title: doc.title,
        intro: doc.intro,
        sections: doc.sections,
      });
    }

    return c.html(
      layout({
        title: `${doc.title} — MyKiraNiaga`,
        description: doc.intro,
        body: policyBody(slug, lang),
        lang,
        currentUrl: c.req.url,
      }),
    );
  });
}

app.notFound((c) => {
  const lang = langFrom(c);
  if (wantsJson(c)) {
    return c.json({ ok: false, error: "not_found" }, 404);
  }
  return c.html(
    layout({
      title: lang === "en" ? "Not found — MyKiraNiaga" : "Tidak dijumpai — MyKiraNiaga",
      description: lang === "en" ? "Page not found." : "Halaman tidak dijumpai.",
      body: errorBody(
        lang === "en" ? "Page not found." : "Halaman tidak dijumpai.",
        lang,
      ),
      lang,
      currentUrl: c.req.url,
    }),
    404,
  );
});

app.onError((error, c) => {
  const lang = langFrom(c);
  const message =
    error instanceof Error
      ? error.message
      : lang === "en"
        ? "Unknown error"
        : "Ralat tidak diketahui";
  if (wantsJson(c)) {
    return c.json({ ok: false, error: "internal_error", message }, 500);
  }
  return c.html(
    layout({
      title: lang === "en" ? "Error — MyKiraNiaga" : "Ralat — MyKiraNiaga",
      description: message,
      body: errorBody(message, lang),
      lang,
      currentUrl: c.req.url,
    }),
    500,
  );
});

export default app;