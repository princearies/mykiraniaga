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
  /** CJ Dropshipping access token (OAuth, 180 days). Optional. */
  CJ_ACCESS_TOKEN?: string;
  CJ_BASE_URL?: string;
  /** AliExpress Open Platform (affiliate) credentials. Optional. */
  ALIEXPRESS_APP_KEY?: string;
  ALIEXPRESS_APP_SECRET?: string;
  ALIEXPRESS_TRACKING_ID?: string;
  ALIEXPRESS_BASE_URL?: string;
  /** USD -> MYR rate used to normalise USD-priced sources. */
  DEFAULT_USD_MYR?: string;
  ENVIRONMENT?: string;
}

const SERVICE = "mykiraniaga";
const VERSION = "1.0.0";
const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
const GEMINI_FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.0-flash-lite"];
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

interface Intent {
  keyword: string;
  max_price_myr: number | null;
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
  results: Product[];
  meta: {
    service: string;
    version: string;
    generated_at: string;
    timing_ms: number;
    count: number;
    partial: boolean;
    sources: SourceReport[];
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
      /\b(?:cari|search|find|tolong|please|saya|nak|want|dropship|untuk|for|murah|cheap)\b/gi,
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

  const models = [
    env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    ...GEMINI_FALLBACK_MODELS,
  ];
  const tried = new Set<string>();
  let lastError = "";

  for (const model of models) {
    if (!model || tried.has(model)) continue;
    tried.add(model);

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
        lastError = `gemini ${model}: HTTP ${res.status}`;
        continue;
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
      lastError = `gemini ${model}: unparseable response`;
    } catch (error) {
      lastError = `gemini ${model}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  return {
    ...fallback,
    note: lastError || "Gemini unavailable — heuristic parser used",
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

  return suffixes.map((suffix, index) => {
    const priceUsd = 3.8 + ((seed >> (index * 3)) % 26) + index * 2.15;
    const price = round2(priceUsd * fx);
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

async function searchCj(env: Env, keyword: string, fx: number): Promise<SourceOutcome> {
  const started = Date.now();

  if (!env.CJ_ACCESS_TOKEN) {
    const items = demoProducts("cj", keyword, fx);
    return {
      report: {
        ...emptyReport(
          "cj",
          "placeholder",
          Date.now() - started,
          "CJ_ACCESS_TOKEN not set — demo catalogue",
        ),
        count: items.length,
      },
      items,
    };
  }

  // TODO(cj): confirm against https://developers.cjdropshipping.com/api2.0/v1/
  // The exact product-search path/params change between API revisions; this is
  // the documented list endpoint shape used as a placeholder.
  try {
    const base = env.CJ_BASE_URL || "https://developers.cjdropshipping.com/api2.0/v1";
    const res = await fetch(`${base}/product/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CJ-Access-Token": env.CJ_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        pageNum: 1,
        pageSize: 20,
        productNameEn: keyword,
        countryCode: "MY",
        isWarehouse: false,
      }),
      signal: timeoutSignal(8000),
    });

    if (!res.ok) {
      return {
        report: emptyReport(
          "cj",
          "error",
          Date.now() - started,
          `CJ API HTTP ${res.status}`,
        ),
        items: [],
      };
    }

    const data = (await res.json()) as Record<string, unknown>;
    const result = (data.result ?? data.data ?? {}) as Record<string, unknown>;
    const rows = (Array.isArray(result.list)
      ? result.list
      : Array.isArray(result.content)
        ? result.content
        : []) as Array<Record<string, unknown>>;

    const items: Product[] = [];
    for (const row of rows) {
      const title = str(pick(row, ["productNameEn", "productName"]));
      const id = str(pick(row, ["pid", "productSku", "id"]));
      const priceUsd = num(pick(row, ["sellPrice", "productSellPrice", "price"]));
      if (!title || priceUsd === null) continue;

      const shipping = DEFAULT_SHIPPING.cj;
      const price = round2(priceUsd * fx);
      items.push({
        id: id || `cj-${hash(title)}`,
        source: "cj",
        source_label: SOURCE_META.cj.label,
        title,
        price_myr: price,
        total_myr: round2(price + shipping.cost_myr),
        shipping,
        image: str(pick(row, ["productImage", "imageUrl", "image"])) || null,
        url: `https://www.cjdropshipping.com/product-detail.html?pid=${encodeURIComponent(id)}`,
        moq: num(pick(row, ["moq", "minOrderQuantity"])) ?? 1,
        rating: null,
        orders: null,
        demo: false,
      });
    }

    return {
      report: {
        ...emptyReport(
          "cj",
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
        "cj",
        "error",
        Date.now() - started,
        error instanceof Error ? error.message : "CJ fetch failed",
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

async function searchAliExpress(
  env: Env,
  keyword: string,
  fx: number,
): Promise<SourceOutcome> {
  const started = Date.now();

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
    const response = (data.aliexpress_affiliate_product_query_response ??
      {}) as Record<string, unknown>;
    const result = (response.resp_result ?? {}) as Record<string, unknown>;
    const nested = (result.result ?? {}) as Record<string, unknown>;
    const rows = (Array.isArray(nested.products)
      ? nested.products
      : []) as Array<Record<string, unknown>>;

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
  items: Product[],
  cap: number | null,
  basis: "price" | "total",
): { items: Product[]; removed: number } {
  if (cap === null) return { items, removed: 0 };
  const kept = items.filter((item) =>
    basis === "total" ? item.total_myr <= cap : item.price_myr <= cap,
  );
  return { items: kept, removed: items.length - kept.length };
}

async function runSearch(env: Env, rawQuery: string, limit: number): Promise<SearchPayload> {
  const started = Date.now();
  const fx = fxRate(env);

  const intent = await extractIntent(env, rawQuery);
  const keyword = intent.keyword || rawQuery;

  // Parallel, non-throwing adapters.
  const [cj, aliexpress] = await Promise.all([
    searchCj(env, keyword, fx),
    searchAliExpress(env, keyword, fx),
  ]);

  const merged = [...cj.items, ...aliexpress.items].sort(
    (a, b) => a.total_myr - b.total_myr,
  );

  const budget = applyBudget(merged, intent.max_price_myr, "price");
  const results = budget.items.slice(0, clamp(limit, 1, MAX_RESULTS));

  const sources = [cj.report, aliexpress.report];
  const partial = sources.some(
    (source) => source.status === "error" || source.status === "empty",
  );

  return {
    ok: true,
    query: rawQuery,
    intent,
    budget: {
      max_price_myr: intent.max_price_myr,
      applied: intent.max_price_myr !== null,
      basis: "price",
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
    },
  };
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
.err-box{background:#1a0d0d;border:1px solid #4a1d1d;border-radius:13px;padding:22px}
.err-box h1{font-size:22px;margin:0 0 8px}
`;

function layout(opts: { title: string; description: string; body: string }): string {
  return `<!doctype html>
<html lang="ms">
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
      <span>MyKiraNiaga<small>enjin carian dropship on-demand</small></span>
    </a>
    <nav><a href="/api">API</a><a href="/health">Status</a></nav>
  </header>
  ${opts.body}
  <footer>
    <span>MyKiraNiaga v${VERSION} · Hono + Cloudflare Workers</span>
    <span>Harga indikatif — sahkan stok &amp; harga di platform sumber.</span>
  </footer>
</div>
</body>
</html>`;
}

function searchForm(q: string, autofocus: boolean): string {
  return `<form class="search" action="/search" method="get" role="search">
  <input type="search" name="q" value="${esc(q)}" placeholder="cth: mini projector bawah RM80"
    aria-label="Cari produk" ${autofocus ? "autofocus" : ""} required minlength="2" maxlength="200">
  <button type="submit">Cari</button>
</form>`;
}

function intentChips(payload: SearchPayload): string {
  const chips: string[] = [];
  chips.push(`<span class="chip">Kata kunci: <b>${esc(payload.intent.keyword)}</b></span>`);
  chips.push(
    payload.intent.max_price_myr === null
      ? `<span class="chip">Bajet: <b>tiada had</b></span>`
      : `<span class="chip">Bajet: <b>≤ ${money(payload.intent.max_price_myr)}</b></span>`,
  );
  chips.push(
    `<span class="chip">Intent: <b>${
      payload.intent.engine === "gemini" ? "Gemini Flash-Lite" : "heuristik"
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
      `<span class="chip ${cls}">${esc(source.label)}: <b>${esc(source.status)}</b> · ${source.count}</span>`,
    );
  }
  return `<div class="chips">${chips.join("")}</div>`;
}

function productCard(product: Product): string {
  const thumb = product.image
    ? `<img src="${esc(product.image)}" alt="${esc(product.title)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="tile">${esc(SOURCE_META[product.source].short)}</span>`;

  const rating =
    product.rating === null
      ? ""
      : ` · ★ ${product.rating.toFixed(1)}`;

  return `<article class="card">
  <div class="thumb">${thumb}</div>
  <div class="body">
    <span class="src ${product.source}">${esc(product.source_label)}${
      product.demo ? " · demo" : ""
    }</span>
    <h3 class="title">${esc(product.title)}</h3>
    <div class="price">${money(product.price_myr)}</div>
    <div class="ship">${esc(product.shipping.method)} · ${product.shipping.days_min}–${
      product.shipping.days_max
    } hari · ${money(product.shipping.cost_myr)}${rating}</div>
    <div class="foot">
      <span class="total">Total <b>${money(product.total_myr)}</b></span>
      <a class="cta" href="${esc(product.url)}" target="_blank" rel="noopener nofollow">Lihat →</a>
    </div>
  </div>
</article>`;
}

const EXAMPLES = [
  "mini projector bawah RM80",
  "wireless earbuds under RM50",
  "beg kanvas murah",
  "car vacuum below $15",
];

function landingBody(errorNote?: string): string {
  return `<h1>Cari produk dropship, <span>terus ikut bajet.</span></h1>
<p class="lede">Taip apa yang awak nak dalam bahasa Melayu atau Inggeris. Enjin akan faham hasrat,
cari di CJ Dropshipping &amp; AliExpress secara serentak, dan susun ikut kos penghantaran sebenar.</p>
${searchForm("", true)}
${errorNote ? `<div class="chips"><span class="chip err">${esc(errorNote)}</span></div>` : ""}
<div class="chips">
${EXAMPLES.map(
  (example) =>
    `<a class="chip" href="/search?q=${encodeURIComponent(example)}">${esc(example)}</a>`,
).join("")}
</div>
<div class="steps">
  <div class="step"><b>01</b><h3>Faham hasrat</h3><p>Gemini Flash-Lite tukar ayat biasa jadi kata kunci + had bajet MYR.</p></div>
  <div class="step"><b>02</b><h3>Cari serentak</h3><p>CJ dan AliExpress dipanggil selari, bukan satu-satu.</p></div>
  <div class="step"><b>03</b><h3>Normalisasi</h3><p>Harga ke MYR, kaedah pos lalai, jumlah sebenar, tapis bajet.</p></div>
</div>
<details class="api">
  <summary>Guna sebagai API (bot / curl)</summary>
  <pre>curl "https://mykiraniaga.&lt;subdomain&gt;.workers.dev/api/search?q=mini+projector+bawah+RM80"
curl -H "Accept: application/json" "https://mykiraniaga.&lt;subdomain&gt;.workers.dev/search?q=earbuds"</pre>
</details>`;
}

function resultsBody(payload: SearchPayload): string {
  const cards = payload.results.map(productCard).join("\n");
  const jsonHref = `/search?q=${encodeURIComponent(payload.query)}&amp;format=json`;

  const body = payload.results.length
    ? `<div class="grid">${cards}</div>`
    : `<div class="empty">
        <h2>Tiada produk dalam bajet itu</h2>
        <p>Naikkan bajet, atau cuba kata kunci yang lebih umum.</p>
        <div class="chips" style="justify-content:center">
          ${EXAMPLES.map(
            (example) =>
              `<a class="chip" href="/search?q=${encodeURIComponent(example)}">${esc(example)}</a>`,
          ).join("")}
        </div>
      </div>`;

  return `${searchForm(payload.query, false)}
${intentChips(payload)}
<div class="summary">
  <span><b>${payload.meta.count}</b> produk</span>
  ${payload.budget.applied ? `<span>· ${payload.budget.removed} ditapis keluar (bajet)</span>` : ""}
  <span>· ${payload.meta.timing_ms} ms</span>
  <span>· <a href="${jsonHref}">JSON</a></span>
</div>
${body}
<details class="api">
  <summary>JSON untuk bot</summary>
  <pre>GET /api/search?q=${esc(encodeURIComponent(payload.query))}
Accept: application/json</pre>
</details>`;
}

function errorBody(message: string): string {
  return `<div class="err-box">
  <h1>Ralat</h1>
  <p style="color:#fca5a5;margin:0 0 14px">${esc(message)}</p>
  <a class="chip" href="/">Kembali ke carian</a>
</div>`;
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], maxAge: 86400 }));

app.get("/", (c) => {
  if (wantsJson(c)) {
    return c.json({
      service: SERVICE,
      version: VERSION,
      description:
        "On-demand dropshipping search engine. Gemini Flash-Lite intent extraction, parallel CJ + AliExpress lookup, MYR normalisation and budget filtering.",
      endpoints: {
        "GET /search?q=": "HTML for humans, JSON when ?format=json or Accept: application/json",
        "GET /api/search?q=": "JSON only",
        "GET /health": "health probe",
      },
      examples: [
        "/search?q=mini%20projector%20bawah%20RM80",
        "/api/search?q=wireless%20earbuds%20under%20RM50",
      ],
    });
  }

  return c.html(
    layout({
      title: "MyKiraNiaga — enjin carian dropship on-demand",
      description:
        "Cari produk dropship ikut bajet. Gemini faham hasrat, CJ + AliExpress dicari serentak, harga dinormalisasi ke MYR.",
      body: landingBody(),
    }),
  );
});

app.get("/search", async (c) => {
  const rawQuery = (c.req.query("q") ?? "").trim();

  if (!rawQuery) {
    if (wantsJson(c)) {
      return c.json({ ok: false, error: "missing_query", message: "Parameter q diperlukan." }, 400);
    }
    return c.html(
      layout({
        title: "MyKiraNiaga — carian",
        description: "Taip kata kunci untuk mula cari produk dropship.",
        body: landingBody("Taip kata kunci dulu — contoh: mini projector bawah RM80"),
      }),
    );
  }

  if (rawQuery.length < 2 || rawQuery.length > 200) {
    const message = "Pertanyaan mesti antara 2 hingga 200 aksara.";
    if (wantsJson(c)) {
      return c.json({ ok: false, error: "invalid_query", message }, 400);
    }
    return c.html(
      layout({
        title: "Pertanyaan tidak sah — MyKiraNiaga",
        description: message,
        body: errorBody(message),
      }),
      400,
    );
  }

  const limit = Number(c.req.query("limit") ?? "24");
  const payload = await runSearch(c.env, rawQuery, Number.isFinite(limit) ? limit : 24);

  c.header("Cache-Control", "public, max-age=60");

  if (wantsJson(c)) return c.json(payload);

  return c.html(
    layout({
      title: `${payload.intent.keyword} — MyKiraNiaga`,
      description: `Hasil carian dropship untuk "${payload.intent.keyword}"${
        payload.intent.max_price_myr === null
          ? ""
          : ` bawah ${money(payload.intent.max_price_myr)}`
      }.`,
      body: resultsBody(payload),
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
        message: "Parameter q diperlukan (2-200 aksara).",
      },
      400,
    );
  }

  const limit = Number(c.req.query("limit") ?? "24");
  const payload = await runSearch(c.env, rawQuery, Number.isFinite(limit) ? limit : 24);
  c.header("Cache-Control", "public, max-age=60");
  return c.json(payload);
});

app.get("/api", (c) =>
  c.json({
    service: SERVICE,
    version: VERSION,
    endpoints: {
      "GET /search?q=&format=json": "search (content negotiated)",
      "GET /api/search?q=": "search (JSON)",
      "GET /health": "health",
    },
    params: {
      q: "query string, 2-200 chars",
      format: "json | html (optional)",
      limit: `1-${MAX_RESULTS} (default 24)`,
    },
    response_fields: {
      intent: ["keyword", "max_price_myr", "engine", "model", "note"],
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
    gemini_configured: Boolean(c.env.GEMINI_API_KEY),
    cj_configured: Boolean(c.env.CJ_ACCESS_TOKEN),
    aliexpress_configured: Boolean(
      c.env.ALIEXPRESS_APP_KEY && c.env.ALIEXPRESS_APP_SECRET,
    ),
  }),
);

app.get("/robots.txt", (c) => c.text("User-agent: *\nAllow: /\n"));

app.notFound((c) => {
  if (wantsJson(c)) {
    return c.json({ ok: false, error: "not_found" }, 404);
  }
  return c.html(
    layout({
      title: "Tidak dijumpai — MyKiraNiaga",
      description: "Halaman tidak dijumpai.",
      body: errorBody("Halaman tidak dijumpai."),
    }),
    404,
  );
});

app.onError((error, c) => {
  const message = error instanceof Error ? error.message : "Ralat tidak diketahui";
  if (wantsJson(c)) {
    return c.json({ ok: false, error: "internal_error", message }, 500);
  }
  return c.html(
    layout({
      title: "Ralat — MyKiraNiaga",
      description: message,
      body: errorBody(message),
    }),
    500,
  );
});

export default app;
