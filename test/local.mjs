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

console.log("1) routing: chat vs search vs status");
{
  const chat = await req("/");
  const chatBody = await chat.text();
  check("root 200", chat.status === 200, chat.status);
  check("root is chat", chatBody.includes('id="chatlog"') && chatBody.includes('id="chatform"'));
  check("root has no status panel", !chatBody.includes("Status sistem"));
  check("brand rendered", chatBody.includes("MyKiraNiaga"));

  const search = await req("/search");
  const searchBody = await search.text();
  check("search 200", search.status === 200, search.status);
  check("search has form", searchBody.includes('action="/search"'));
  check("search has big box", searchBody.includes("search-big"));
  check("search has no chat log", !searchBody.includes('id="chatlog"'));
  check("search has no chat input", !searchBody.includes('id="chatinput"'));
  check("search has no status panel", !searchBody.includes("Status sistem"));

  const results = await req("/search?q=projector");
  const resultsBody = await results.text();
  check("results grid", resultsBody.includes('class="grid view-large"'));
  check("view switcher", resultsBody.includes('class="viewswitch"') && (resultsBody.match(/data-view=/g) ?? []).length === 3);
  check("results have no chat", !resultsBody.includes('id="chatlog"') && !resultsBody.includes('id="chatinput"'));
  check("results have no chips", !resultsBody.includes('class="chip"'));
  check("results have no summary bar", !resultsBody.includes('class="summary"'));
  check("results have no api details", !resultsBody.includes('class="api"'));

  const status = await req("/status");
  const statusBody = await status.text();
  check("status 200", status.status === 200, status.status);
  check("status panel here", statusBody.includes("Status sistem"));
  check("gemini key row", statusBody.includes("GEMINI_API_KEY"));
  check("cj key row", statusBody.includes("CJ_API_KEY"));
  check("aliexpress key row", statusBody.includes("ALIEXPRESS_ADMIN_KEY"));
  check("margin shown", statusBody.includes("Margin <b>20%"));

  const statusJson = await req("/status?format=json");
  check(
    "status json",
    (statusJson.headers.get("content-type") ?? "").includes("json"),
  );
}

console.log("2) json api with RM budget");
{
  const res = await req("/api/search?q=" + encodeURIComponent("earbuds bawah RM80"));
  const data = await res.json();
  check("status 200", res.status === 200);
  check("ok true", data.ok === true);
  check("keyword", data.intent.keyword === "earbuds", JSON.stringify(data.intent));
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
  check("ms is default", msBody.includes("Tanya je"));
  check("dropdown rendered", msBody.includes('class="langmenu"'));
  check("dropdown offers EN", msBody.includes(">English</a>"));

  const en = await req("/?lang=en");
  const enBody = await en.text();
  check("en chat", enBody.includes("Just ask"));
  const enStatus = await req("/status?lang=en");
  check("en status page", (await enStatus.text()).includes("System status"));
  check("en send button", enBody.includes(">Send</button>"));
  check(
    "lang cookie set",
    (en.headers.get("set-cookie") ?? "").includes("mkn_lang=en"),
    en.headers.get("set-cookie") ?? "",
  );

  const enSearch = await req("/search?q=projector&lang=en");
  const searchBody = await enSearch.text();
  check("en results labels", searchBody.includes("products") && searchBody.includes("WhatsApp") && searchBody.includes("Telegram"));
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

console.log("11) conversational chat");
{
  const page = await req("/");
  const pageText = await page.text();
  check("root serves chat UI", pageText.includes('id="chatlog"') && pageText.includes('id="chatform"'));
  check("chat greeting", pageText.includes("Hai! Awak nak cari produk apa"));
  check("chat quick chips", pageText.includes('data-chip="Nak cari laptop murah"'));

  const alias = await req("/chat");
  check("chat alias", (await alias.text()).includes('id="chatlog"'));

  const one = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "nak cari laptop murah" }] }),
  });
  const oneData = await one.json();
  check("chat ok", oneData.ok === true, JSON.stringify(oneData).slice(0, 160));
  check("chat ready", oneData.intent?.ready === true);
  check("chat keyword", oneData.intent?.keyword === "laptop", String(oneData.intent?.keyword));
  check("chat reply text", typeof oneData.reply === "string" && oneData.reply.length > 5);
  check("chat products", Array.isArray(oneData.products) && oneData.products.length > 0);
  check("chat products html", oneData.products_html.includes('class="card"'));
  check("chat order buttons", oneData.products_html.includes("WhatsApp") && oneData.products_html.includes("Telegram"));

  const multi = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "user", content: "nak cari laptop murah" },
        { role: "assistant", content: "Bagi bajet?" },
        { role: "user", content: "bawah RM1500" },
      ],
    }),
  });
  const multiData = await multi.json();
  check("multi-turn keeps keyword", multiData.intent?.keyword === "laptop", String(multiData.intent?.keyword));
  check("multi-turn picks budget", multiData.intent?.max_price_myr === 1500, String(multiData.intent?.max_price_myr));
  check("multi-turn ready", multiData.intent?.ready === true);
  check(
    "budget filter applied",
    (multiData.products ?? []).every((p) => p.total_myr <= 1500),
  );

  const english = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lang: "en", messages: [{ role: "user", content: "cheap laptop" }] }),
  });
  const englishData = await english.json();
  check("english reply", /laptop|budget|search/i.test(englishData.reply), englishData.reply);

  const empty = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  check("empty messages 400", empty.status === 400, empty.status);

  const badJson = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  check("bad json 400", badJson.status === 400, badJson.status);
}

console.log("12) view switcher modes");
{
  const large = await req("/search?q=projector");
  check("default view-large", (await large.text()).includes('class="grid view-large"'));

  const compact = await req("/search?q=projector&view=compact");
  check("view=compact", (await compact.text()).includes('class="grid view-compact"'));

  const list = await req("/search?q=projector&view=list");
  check("view=list", (await list.text()).includes('class="grid view-list"'));

  const bogus = await req("/search?q=projector&view=huge");
  check("invalid view falls back", (await bogus.text()).includes('class="grid view-large"'));

  const chat = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "nak cari projector" }] }),
  });
  const chatData = await chat.json();
  check("chat inline cards", chatData.products_html.includes('class="card"'));
  check("chat metrics", (chatData.metrics?.count ?? -1) === (chatData.products ?? []).length);
}

console.log("13) chat gating: query vs filters");
{
  const base = [{ role: "user", content: "laptop gaming" }];

  const plain = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: base }),
  });
  const plainData = await plain.json();
  check("no search without budget/explicit", plainData.intent?.ready === false, JSON.stringify(plainData.intent));
  check("asks for budget", /bajet|budget/i.test(plainData.reply), plainData.reply);
  check("no products yet", (plainData.products ?? []).length === 0);

  const spec = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "user", content: "laptop gaming" },
        { role: "assistant", content: "Baik, laptop gaming. Ada bajet maksimum?" },
        { role: "user", content: "ada nvidia graphic card" },
      ],
    }),
  });
  const specData = await spec.json();
  check("spec keeps ready=false", specData.intent?.ready === false, JSON.stringify(specData.intent));
  check("spec captured as filter", (specData.intent?.filters ?? []).includes("nvidia"), JSON.stringify(specData.intent?.filters));
  check("spec acknowledged", /nvidia/i.test(specData.reply), specData.reply);
  check("still asks budget", /bajet|budget/i.test(specData.reply), specData.reply);
  check("no premature search", (specData.products ?? []).length === 0);
  check("keyword is base noun", specData.intent?.keyword === "laptop", String(specData.intent?.keyword));
  check("keyword excludes spec", !String(specData.intent?.keyword).includes("nvidia"));

  const withBudget = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "user", content: "laptop gaming" },
        { role: "assistant", content: "Ada bajet maksimum?" },
        { role: "user", content: "ada nvidia graphic card" },
        { role: "assistant", content: "Faham, nak nvidia. Ada bajet khusus?" },
        { role: "user", content: "bawah RM5000" },
      ],
    }),
  });
  const budgetData = await withBudget.json();
  check("budget unlocks search", budgetData.intent?.ready === true, JSON.stringify(budgetData.intent));
  check("budget parsed", budgetData.intent?.max_price_myr === 5000, String(budgetData.intent?.max_price_myr));
  check("filters retained", (budgetData.intent?.filters ?? []).includes("nvidia"));
  check("keyword still base noun", budgetData.intent?.keyword === "laptop", String(budgetData.intent?.keyword));
  check("products returned", (budgetData.products ?? []).length > 0);

  const explicit = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "tunjuk earbuds murah" }] }),
  });
  const explicitData = await explicit.json();
  check("explicit intent searches", explicitData.intent?.ready === true, JSON.stringify(explicitData.intent));
  check("explicit keyword base noun", explicitData.intent?.keyword === "earbuds", String(explicitData.intent?.keyword));
}

console.log("14) category floor");
{
  const laptop = await req("/api/search?q=laptop");
  const laptopData = await laptop.json();
  check("laptop floor 300", laptopData.meta?.floor?.min_total_myr === 300, JSON.stringify(laptopData.meta?.floor));

  const cheapProjector = await req("/api/search?q=" + encodeURIComponent("mini projector bawah RM80"));
  const projData = await cheapProjector.json();
  check(
    "budget below floor wins",
    projData.meta?.floor?.skipped === true,
    JSON.stringify(projData.meta?.floor),
  );

  const chatLaptop = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "user", content: "laptop" },
        { role: "assistant", content: "Ada bajet?" },
        { role: "user", content: "bawah RM5000" },
      ],
    }),
  });
  const chatData = await chatLaptop.json();
  check("chat keyword base noun", chatData.intent?.keyword === "laptop", String(chatData.intent?.keyword));
  check(
    "chat floor rule applied",
    chatData.search?.floor?.min_total_myr === 300,
    JSON.stringify(chatData.search?.floor),
  );
}

console.log("15) split-screen chat layout");
{
  const page = await req("/");
  const body = await page.text();
  check("split container", body.includes('class="split"'));
  check("results pane", body.includes('id="resultspane"'));
  check("chat pane", body.includes('id="chatpane"'));
  check("results area", body.includes('id="products-container"'));
  check("metrics line", body.includes('id="products-metrics"'));
  check("typing hidden by default", /id="typing"[^>]*hidden/.test(body));
  check("view toggles", (body.match(/data-cview=/g) ?? []).length === 3);
  check("mobile tabs", body.includes('class="mobiletabs"') && body.includes('data-tab="results"'));
  check("placeholder", body.includes("results-placeholder"));
  check("js targets products-container", body.includes('getElementById("products-container")'));
  check("js stops spinner", body.includes("stopTyping") && body.includes('typing.style.display = "none"'));
  check("no status on chat", !body.includes("Status sistem"));

  const chat = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "tunjuk laptop" }] }),
  });
  const data = await chat.json();
  check("products html is grid only", data.products_html.startsWith('<div class="grid">'));
  check("metrics count", data.metrics?.count === data.products.length, JSON.stringify(data.metrics));
  check("metrics filters array", Array.isArray(data.metrics?.filters));
}

console.log("16) supplier query normalisation");
{
  const laptop = await req("/api/search?q=laptop");
  const data = await laptop.json();
  check("keyword stays base noun", data.intent?.keyword === "laptop", String(data.intent?.keyword));
  check("laptop results exist", data.results.length > 0, data.results.length);
  check(
    "floor keeps real laptops",
    data.results.every((p) => p.total_myr >= 300),
    JSON.stringify(data.results.map((p) => p.total_myr)),
  );
}

console.log("17) mobile split-screen");
{
  const page = await req("/");
  const body = await page.text();
  check("emoji chat tab", body.includes("💬") && body.includes('data-tab="chat"'));
  check("emoji products tab", body.includes("🛍️") && body.includes('data-tab="results"'));
  check("products pill", body.includes('id="productspill"'));
  check("mobile breakpoint 768", body.includes("@media (max-width:768px)"));
  check("mobile grid 1col", body.includes(".grid.view-large{grid-template-columns:1fr}"));
  check("mobile grid 2col", body.includes(".grid.view-compact{grid-template-columns:repeat(2,minmax(0,1fr))"));
  check("44px touch targets", body.includes("min-height:44px"));
  check("pill text", body.includes("Lihat {n} produk") || body.includes("View {n} products"));
  check("no auto-switch on mobile", body.includes("showPill(m.count)") && body.includes("isMobile()"));
}

console.log("18) multi-currency + multi-language");
{
  const usd = await req("/api/search?q=earbuds&currency=USD");
  const usdData = await usd.json();
  check("currency echo", usdData.currency === "USD", usdData.currency);
  check("rate returned", typeof usdData.rate === "number" && usdData.rate > 0, usdData.rate);
  const p0 = usdData.results[0];
  check("display_currency", p0?.display_currency === "USD", p0?.display_currency);
  check("display_price string", typeof p0?.display_price === "string" && p0.display_price.length > 1, p0?.display_price);
  check("display_margin string", typeof p0?.display_margin === "string");
  check(
    "total_display matches rate",
    Math.abs((p0?.total_display ?? 0) - (p0?.total_myr ?? 0) * usdData.rate) < 0.05,
  );

  const bogus = await req("/api/search?q=earbuds&currency=XYZ");
  check("invalid currency falls back MYR", (await bogus.json()).currency === "MYR");

  const chatId = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lang: "id",
      currency: "USD",
      messages: [{ role: "user", content: "cari earbuds" }],
    }),
  });
  const chatIdData = await chatId.json();
  check("chat lang id", chatIdData.lang === "id", chatIdData.lang);
  check("chat currency usd", chatIdData.currency === "USD", chatIdData.currency);
  check("chat rate", typeof chatIdData.rate === "number" && chatIdData.rate > 0);

  const zhPage = await req("/?lang=zh");
  const zhBody = await zhPage.text();
  check("zh UI", zhBody.includes("直接问") || zhBody.includes("聊天"));
  check("language menu 4", zhBody.includes("Bahasa Indonesia") && zhBody.includes("中文"));
  check("currency selector", zhBody.includes('class="curselect"') && zhBody.includes('value="IDR"'));

  const checkout = await req("/checkout?source=cj&id=x1&base=50&currency=USD");
  const checkoutBody = await checkout.text();
  check("checkout shows USD", checkoutBody.includes("$"), "no $");
  check("checkout shows MYR equivalent", checkoutBody.includes("MYR 60.00"), "no MYR eq");
}

console.log("19) policy pages + footer");
{
  const pages = [
    ["/privacy", "Dasar Privasi"],
    ["/terms", "Terma Perkhidmatan"],
    ["/shipping", "Maklumat Penghantaran"],
    ["/refunds", "Pemulangan"],
    ["/contact", "Hubungi Kami"],
  ];
  for (const [path, title] of pages) {
    const res = await req(path);
    const body = await res.text();
    check(`${path} 200`, res.status === 200, res.status);
    check(`${path} title`, body.includes(title), title);
    check(`${path} back link`, body.includes('class="pback"'));
    check(`${path} footer`, body.includes('class="footerlinks"'));
  }

  const shipping = await req("/shipping");
  const shippingBody = await shipping.text();
  check("shipping timeline", shippingBody.includes("7–18"), "no 7-18");
  check("shipping tracking", /penjejakan|tracking/i.test(shippingBody));

  const refunds = await req("/refunds");
  check("14-day window", (await refunds.text()).includes("14 hari"));

  const contact = await req("/contact");
  check("whatsapp link", (await contact.text()).includes("wa.me/60173735431"));

  const zh = await req("/privacy?lang=zh");
  check("zh policy", (await zh.text()).includes("隐私政策"));

  const id = await req("/terms?lang=id");
  check("id policy", (await id.text()).includes("Syarat Layanan"));

  const json = await req("/shipping?format=json");
  const jsonData = await json.json();
  check("policy json", jsonData.ok === true && Array.isArray(jsonData.sections), JSON.stringify(jsonData).slice(0, 80));

  for (const path of ["/", "/search", "/status"]) {
    const body = await (await req(path)).text();
    check(`footer on ${path}`, body.includes('class="footerlinks"') && body.includes('href="/refunds"'));
  }
}

console.log("20) Telegram checkout + support");
{
  const page = await req("/search?q=earbuds&currency=USD");
  const body = await page.text();
  check("whatsapp button", body.includes("wa.me/60173735431?text="));
  check("telegram button", body.includes("t.me/Mykirashopbot?text="));
  check("dual order row", body.includes('class="buyrow"'));
  const tgMatch = body.match(/https:\/\/t\.me\/Mykirashopbot\?text=([^"&]+)/);
  check("telegram prefill", Boolean(tgMatch), "missing");
  if (tgMatch) {
    const text = decodeURIComponent(tgMatch[1]);
    check("prefill mentions bot", text.includes("@Mykirashopbot"), text.slice(0, 60));
    check("prefill has title", text.includes("Earbuds"), text.slice(0, 80));
    check("prefill has MYR equivalent", text.includes("MYR"), text.slice(0, 80));
  }

  const footer = await (await req("/")).text();
  check("footer telegram", footer.includes("t.me/Mykirashopbot"));
  check("footer whatsapp", footer.includes("wa.me/60173735431"));

  for (const lang of ["ms", "en", "id", "zh"]) {
    const contact = await (await req(`/contact?lang=${lang}`)).text();
    check(`contact telegram ${lang}`, contact.includes("t.me/Mykirashopbot"));
  }

  const checkout = await (await req("/checkout?source=cj&id=x1&base=50")).text();
  check("checkout telegram button", checkout.includes('class="tg-btn"'));
}

console.log("21) trending hot items");
{
  const ms = await req("/search");
  const msBody = await ms.text();
  check("trending section", msBody.includes('class="trending"'));
  check("trending title ms", msBody.includes("Pilihan Hangat"));
  check("trending has cards", (msBody.match(/class="card"/g) ?? []).length >= 4);
  check("trending dual buttons", msBody.includes("wa.me/60173735431") && msBody.includes("t.me/Mykirashopbot"));
  check("trending json-ld", msBody.includes("application/ld+json") && msBody.includes('"@type":"ItemList"'));
  check(
    "trending offers currency",
    msBody.includes('"priceCurrency":"MYR"'),
  );

  const en = await req("/search?lang=en");
  check("trending title en", (await en.text()).includes("Trending Hot Items"));

  const chat = await req("/");
  check("chat pane trending", (await chat.text()).includes('class="trending"'));

  const usd = await req("/search?currency=USD&lang=en");
  const usdBody = await usd.text();
  check("trending usd ld", usdBody.includes('"priceCurrency":"USD"'));
  check("trending usd price", usdBody.includes("$"));
}

console.log("22) chainsaw accuracy");
{
  const res = await req("/api/search?q=" + encodeURIComponent("chainsaw bawah RM500"));
  const data = await res.json();
  check("chainsaw floor 120", data.meta?.floor?.min_total_myr === 120, JSON.stringify(data.meta?.floor));
  check("chainsaw results", data.results.length > 0, data.results.length);
  check(
    "no chainsaw accessories",
    data.results.every(
      (p) =>
        !/\b(sharpening|sharpen|guide plate|tension|sprocket)\b/i.test(p.title) &&
        !/\bchain blades?\b/i.test(p.title),
    ),
    JSON.stringify(data.results.map((p) => p.title).slice(0, 3)),
  );
  check(
    "within budget",
    data.results.every((p) => p.total_myr <= 500),
  );

  const chat = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "cari chainsaw budget below rm500" }],
    }),
  });
  const chatData = await chat.json();
  check("chat chainsaw keyword", chatData.intent?.keyword === "chainsaw", String(chatData.intent?.keyword));
  check("chat chainsaw products", (chatData.products ?? []).length > 0);
  check(
    "chat chainsaw not accessories",
    (chatData.products ?? []).every((p) => /chainsaw|saw/i.test(p.title)),
    JSON.stringify((chatData.products ?? []).map((p) => p.title).slice(0, 3)),
  );
}

console.log("23) tool intelligence + visual guardrail");
{
  const cordless = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "cordless chainsaw bawah RM500" }],
    }),
  });
  const data = await cordless.json();
  check(
    "keeps power qualifier",
    /cordless/i.test(String(data.intent?.keyword)),
    String(data.intent?.keyword),
  );
  check("chat capped at 6", (data.products ?? []).length <= 6, (data.products ?? []).length);

  const search = await req("/api/search?q=" + encodeURIComponent("cordless chainsaw"));
  const searchData = await search.json();
  check(
    "images are https or null",
    searchData.results.every((p) => p.image === null || /^https:\/\//.test(p.image)),
    JSON.stringify(searchData.results.map((p) => p.image).slice(0, 3)),
  );
  check(
    "no accessory titles",
    searchData.results.every(
      (p) => !/\b(sharpening|guide plate|sprocket|tension)\b/i.test(p.title),
    ),
  );

  const drill = await req("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "electric drill bawah RM300" }] }),
  });
  const drillData = await drill.json();
  check("drill keyword", /drill/i.test(String(drillData.intent?.keyword)));
  check("drill products <= 6", (drillData.products ?? []).length <= 6);
}

console.log("24) product detail modal");
{
  const search = await req("/search?q=earbuds");
  const body = await search.text();
  check("detail trigger", body.includes("data-detail") && body.includes("Lihat Detail"));
  check("modal shell", body.includes('id="pm"') && body.includes('id="pmbody"'));
  check("modal script", body.includes("/api/product"));

  const detail = await req(
    "/api/product?source=cj&id=abc123&title=Test+Chainsaw&base=50&lang=ms",
  );
  const data = await detail.json();
  check("product api ok", data.ok === true, JSON.stringify(data).slice(0, 80));
  check("has specs", data.html.includes("Spesifikasi"));
  check("has cost table", data.html.includes("Pecahan Kos"));
  check("has reviews", data.html.includes("Ulasan"));
  check("has sticky actions", data.html.includes('class="pmactions"'));
  check("has wa link", data.wa_url.startsWith("https://wa.me/"));
  check("has tg link", data.tg_url.startsWith("https://t.me/Mykirashopbot"));
  check("in stock", data.html.includes("Dalam stok"));

  const en = await req("/api/product?source=cj&id=abc&title=Drill&base=40&lang=en");
  const enData = await en.json();
  check("english detail", enData.html.includes("Specifications") && enData.html.includes("Customer Reviews"));

  const bad = await req("/api/product?source=xx&id=&base=abc");
  check("invalid detail 400", bad.status === 400, bad.status);
}

console.log("25) tab bar + trending page");
{
  const home = await (await req("/")).text();
  check("tab bar", home.includes('class="tabbar"'));
  check("mygate tab", home.includes("https://mygate.mykira.workers.dev/"));
  check("shop tab", home.includes("https://mykirashop.mykira.workers.dev/"));
  check("chat tab active", home.includes('class="tab active" href="/"'));
  check("trending tab", home.includes('href="/trending"'));

  const search = await (await req("/search")).text();
  check("search tab active", search.includes('class="tab active" href="/search"'));

  const trending = await req("/trending");
  const body = await trending.text();
  check("trending page 200", trending.status === 200, trending.status);
  check("trending page cards", (body.match(/class="card"/g) ?? []).length >= 4);
  check("trending page title", body.includes("Pilihan Hangat"));

  const json = await (await req("/trending?format=json")).json();
  check("trending json", json.ok === true && json.count > 0, JSON.stringify(json).slice(0, 60));
}

console.log("26) AI discovery manifests + markdown");
{
  const res = await req("/api/search?q=earbuds&currency=USD");
  const data = await res.json();
  const p = data.results[0];
  check("markdown_image field", typeof p.markdown_image === "string" && p.markdown_image.startsWith("!["), p.markdown_image);
  check("markdown_image https", /\]\(https:\/\//.test(p.markdown_image), p.markdown_image);
  check("markdown_card field", typeof p.markdown_card === "string");
  check("card has total MYR", p.markdown_card.includes("Total: RM "), p.markdown_card.slice(0, 80));
  check("card has whatsapp", p.markdown_card.includes("wa.me/"));
  check("card has telegram", p.markdown_card.includes("t.me/Mykirashopbot"));
  check(
    "all markdown images valid",
    data.results.every((row) => /\]\(https:\/\/[^\s)]+\)/.test(row.markdown_image)),
  );

  const llms = await req("/llms.txt");
  const llmsBody = await llms.text();
  check("llms status", llms.status === 200);
  check("llms content type", (llms.headers.get("content-type") ?? "").includes("text/plain"));
  check("llms instructions", llmsBody.includes("markdown_image") && llmsBody.includes("![title](url)"));

  const plugin = await req("/.well-known/ai-plugin.json");
  const pluginData = await plugin.json();
  check("plugin schema", pluginData.schema_version === "v1");
  check("plugin name", pluginData.name_for_model === "mykiraniaga");
  check("plugin api url", pluginData.api?.url.endsWith("/openapi.json"));

  const openapi = await req("/openapi.json");
  const spec = await openapi.json();
  check("openapi version", spec.openapi === "3.0.3");
  check("openapi search path", Boolean(spec.paths?.["/api/search"]?.get));
  check("openapi chat path", Boolean(spec.paths?.["/api/chat"]?.post));

  const placeholder = await req("/placeholder.svg");
  check("placeholder svg", placeholder.status === 200 && (placeholder.headers.get("content-type") ?? "").includes("image/svg"));
}

console.log("27) image proxy");
{
  const res = await req("/api/search?q=earbuds");
  const data = await res.json();
  const p = data.results[0];
  const withImage = data.results.find((row) => row.image);
  check(
    "image_proxy field",
    withImage
      ? withImage.image_proxy.includes("/api/image-proxy?url=")
      : p.image_proxy.endsWith("/placeholder.svg"),
    p.image_proxy,
  );
  check(
    "markdown uses proxy",
    p.markdown_image.includes("/api/image-proxy?url=") ||
      p.markdown_image.includes("/placeholder.svg"),
    p.markdown_image,
  );

  const bad = await req("/api/image-proxy?url=" + encodeURIComponent("http://evil.example/a.jpg"), {
    headers: { Accept: "text/html" },
  });
  check("rejects non-https", bad.status === 302 && (bad.headers.get("location") ?? "").includes("/placeholder.svg"), bad.status);

  const weird = await req("/api/image-proxy?url=" + encodeURIComponent("https://example.com/a.jpg"));
  check("unknown host redirect", weird.status === 302, weird.status);

  const empty = await req("/api/image-proxy");
  check("missing url redirect", empty.status === 302, empty.status);

  const okUrl = await req("/api/image-proxy?url=" + encodeURIComponent("https://oss-cf.cjdropshipping.com/product/2026/08/13/10/95a688e6-570d-451b-8224-5d3a7a34ccac.jpg"));
  check(
    "valid image streams or falls back",
    okUrl.status === 200 || okUrl.status === 302,
    okUrl.status,
  );
  if (okUrl.status === 200) {
    check("image content-type", (okUrl.headers.get("content-type") ?? "").startsWith("image/"), okUrl.headers.get("content-type"));
    check("cors header", okUrl.headers.get("access-control-allow-origin") === "*");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
