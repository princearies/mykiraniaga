// Local smoke test for the worker bundle (no workerd needed).
// Uses the bundle produced by `wrangler deploy --dry-run --outdir dist`.
import app from "../dist/index.js";

const env = { DEFAULT_USD_MYR: "4.72" };
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

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

async function req(path, init = {}) {
  const headers = { "User-Agent": BROWSER_UA, ...(init.headers ?? {}) };
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }), env);
}

console.log("1) landing page");
{
  const res = await req("/");
  const body = await res.text();
  check("status 200", res.status === 200, res.status);
  check("html content-type", (res.headers.get("content-type") ?? "").includes("text/html"));
  check("brand rendered", body.includes("MyKiraNiaga"));
  check("search form", body.includes('action="/search"'));
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
  check("results non-empty", data.results.length > 0, data.results.length);
  check(
    "all within budget",
    data.results.every((p) => p.price_myr <= 80),
    JSON.stringify(data.results.map((p) => p.price_myr)),
  );
  check("both sources reported", data.meta.sources.length === 2);
  check("shipping normalised", Boolean(data.results[0]?.shipping?.method));
  check("timing reported", typeof data.meta.timing_ms === "number");
}

console.log("3) USD budget conversion");
{
  const res = await req("/api/search?q=" + encodeURIComponent("wireless earbuds under $20"));
  const data = await res.json();
  check("usd -> myr (20 * 4.72)", data.intent.max_price_myr === 94.4, data.intent.max_price_myr);
}

console.log("4) no budget");
{
  const res = await req("/api/search?q=" + encodeURIComponent("beg kanvas"));
  const data = await res.json();
  check("budget null", data.intent.max_price_myr === null, data.intent.max_price_myr);
  check("8 demo rows", data.results.length === 8, data.results.length);
  check("placeholder source", data.meta.sources.every((s) => s.status === "placeholder"));
  check("demo flagged", data.results.every((p) => p.demo === true));
}

console.log("5) content negotiation");
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

console.log("6) validation + errors");
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

console.log("7) health + api index");
{
  const health = await req("/health");
  const data = await health.json();
  check("health ok", data.ok === true && data.service === "mykiraniaga");
  check("gemini flag boolean", typeof data.gemini_configured === "boolean");

  const index = await req("/api");
  check("api index", index.status === 200);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
