// Local smoke test for the worker bundle (no workerd needed).
// Uses the bundle produced by `wrangler deploy --dry-run --outdir dist`.
import app from "../dist/index.js";

const env = { DEFAULT_USD_MYR: "4.72" };
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function req(path, init = {}) {
  const headers = { "User-Agent": BROWSER_UA, ...(init.headers ?? {}) };
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }), env);
}

console.log("1) landing page + system status");
{
  const res = await req("/");
  const body = await res.text();
  check("status 200", res.status === 200, res.status);
  check("html content-type", (res.headers.get("content-type") ?? "").includes("text/html"));
  check("brand rendered", body.includes("MyKiraNiaga"));
  check("search form", body.includes('action="/search"'));
  check("status panel", body.includes("Status sistem"));
  check("gemini key row", body.includes("GEMINI_API_KEY"));
  check("cj key row", body.includes("CJ_API_KEY"));
  check("aliexpress key row", body.includes("ALIEXPRESS_ADMIN_KEY"));
  check("margin shown", body.includes("Margin <b>20%"));
}

console.log("2) json api with RM budget");
{
  const res = await req("/api/search?q=" + encodeURIComponent("mini projector bawah RM80"));
  const data = await res.json();
  check("status 200", res.status === 200);
  check("ok true", data.ok === true);
  check("keyword", data.intent.keyword === "mini projector", JSON.stringify(data.intent));
  check("budget parsed = 80", data.intent.max_price_myr === 80, data.intent.max_price_myr);
  check("budget applied", data.budget.applied === true);
  check("budget basis = total", data.budget.basis === "total", data.budget.basis);
  check("results non-empty", data.results.length > 0, data.results.length);
  check(
    "all landed totals within budget",
    data.results.every((p) => p.total_myr <= 80),
    JSON.stringify(data.results.map((p) => p.total_myr)),
  );
  check("both sources reported", data.meta.sources.length === 2);
  check("pricing block", data.pricing?.markup_pct === 20, JSON.stringify(data.pricing));
  check("config block", typeof data.config?.gemini?.configured === "boolean");
}

console.log("3) margin + checkout decoration");
{
  const res = await req("/api/search?q=projector");
  const data = await res.json();
  const p = data.results[0];
  check("supplier price present", typeof p.supplier_price_myr === "number");
  check("supplier total present", typeof p.supplier_total_myr === "number");
  check("margin positive", p.margin_myr > 0, p.margin_myr);
  check(
    "total = price + shipping",
    Math.abs(p.total_myr - (p.price_myr + p.shipping.cost_myr)) < 0.011,
    `${p.total_myr} vs ${p.price_myr} + ${p.shipping.cost_myr}`,
  );
  check(
    "margin ~ 20% of supplier total",
    Math.abs(p.margin_myr - p.supplier_total_myr * 0.2) < 0.051,
    `${p.margin_myr} vs ${Math.round(p.supplier_total_myr * 20) / 100}`,
  );
  check("checkout url", p.checkout_url.startsWith("/checkout?"), p.checkout_url);
  check("whatsapp url", p.whatsapp_url.startsWith("https://wa.me/60173735431?text="));
  check("whatsapp carries product id", decodeURIComponent(p.whatsapp_url).includes(p.id));
}

console.log("4) checkout endpoint");
{
  const html = await req("/checkout?source=cj&id=abc123&base=50&title=Test+Widget");
  const body = await html.text();
  check("checkout html 200", html.status === 200, html.status);
  check("checkout shows total", body.includes("Jumlah"));
  check("checkout shows whatsapp", body.includes("wa.me/"));
  check("checkout shows id", body.includes("abc123"));

  const json = await req("/checkout?source=cj&id=abc123&base=50&format=json", {
    headers: { Accept: "application/json" },
  });
  const data = await json.json();
  check("checkout json ok", data.ok === true);
  check("base 50 + 20% margin = 60", data.order.total_myr === 60, data.order.total_myr);
  check("supplier total kept", data.order.supplier_total_myr === 50, data.order.supplier_total_myr);
  check("margin 10", data.order.margin_myr === 10, data.order.margin_myr);

  const bad = await req("/checkout?source=xx&id=&base=abc", {
    headers: { Accept: "application/json" },
  });
  check("invalid checkout 400", bad.status === 400, bad.status);
}

console.log("5) USD budget conversion");
{
  const res = await req("/api/search?q=" + encodeURIComponent("wireless earbuds under $20"));
  const data = await res.json();
  check("usd -> myr (20 * 4.72)", data.intent.max_price_myr === 94.4, data.intent.max_price_myr);
}

console.log("6) no budget");
{
  const res = await req("/api/search?q=" + encodeURIComponent("beg kanvas"));
  const data = await res.json();
  check("budget null", data.intent.max_price_myr === null, data.intent.max_price_myr);
  check("8 demo rows", data.results.length === 8, data.results.length);
  check("placeholder source", data.meta.sources.every((s) => s.status === "placeholder"));
  check("demo flagged", data.results.every((p) => p.demo === true));
}

console.log("7) content negotiation");
{
  const jsonRes = await req("/search?q=earbuds", {
    headers: { Accept: "application/json" },
  });
  check(
    "accept json -> json",
    (jsonRes.headers.get("content-type") ?? "").includes("application/json"),
  );

  const htmlRes = await req("/search?q=earbuds", {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  check(
    "accept html -> html",
    (htmlRes.headers.get("content-type") ?? "").includes("text/html"),
  );

  const forced = await req("/search?q=earbuds&format=json", {
    headers: { Accept: "text/html" },
  });
  check("format=json wins", (forced.headers.get("content-type") ?? "").includes("json"));
}

console.log("8) validation + errors");
{
  const bad = await req("/api/search?q=a");
  check("short query 400", bad.status === 400, bad.status);
  const badJson = await bad.json();
  check("error code", badJson.error === "invalid_query", JSON.stringify(badJson));

  const missing = await req("/search");
  check("empty q -> 200 html", missing.status === 200, missing.status);

  const notFound = await req("/nope");
  check("404", notFound.status === 404, notFound.status);
}

console.log("9) health + api index");
{
  const health = await req("/health");
  const data = await health.json();
  check("health ok", data.ok === true && data.service === "mykiraniaga");
  check("keys block", typeof data.keys?.gemini?.configured === "boolean");
  check("margin block", data.margin?.markup_pct === 20);
  check("whatsapp", data.whatsapp === "+60173735431", data.whatsapp);

  const index = await req("/api");
  check("api index", index.status === 200);
}

console.log("10) bilingual dropdown (ms default / en)");
{
  const ms = await req("/");
  const msBody = await ms.text();
  check("ms is default", msBody.includes("Cari produk dropship"));
  check("dropdown rendered", msBody.includes('class="langmenu"'));
  check("dropdown offers EN", msBody.includes(">English</a>"));

  const en = await req("/?lang=en");
  const enBody = await en.text();
  check("en landing", enBody.includes("Find dropship products"));
  check("en status panel", enBody.includes("System status"));
  check("en search button", enBody.includes(">Search</button>"));
  check(
    "lang cookie set",
    (en.headers.get("set-cookie") ?? "").includes("mkn_lang=en"),
    en.headers.get("set-cookie") ?? "",
  );

  const enSearch = await req("/search?q=projector&lang=en");
  const searchBody = await enSearch.text();
  check("en results labels", searchBody.includes("products") && searchBody.includes("Order →"));
  check(
    "lang switch keeps query",
    searchBody.includes("q=projector") && searchBody.includes("lang=ms"),
  );

  const enCheckout = await req("/checkout?source=cj&id=x1&base=50&lang=en");
  const checkoutText = await enCheckout.text();
  check(
    "en checkout",
    checkoutText.includes("Confirm on WhatsApp") && checkoutText.includes("Total"),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
