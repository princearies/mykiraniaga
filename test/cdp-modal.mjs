// Open the product detail modal on the live page and screenshot it.
import { writeFileSync } from "node:fs";

const port = process.argv[2] ?? "9231";
const url = process.argv[3] ?? "https://mykiraniaga.mykira.workers.dev/search?q=earbuds&currency=USD";
const out = process.argv[4] ?? "modal.png";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("no page");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

await send("Emulation.setDeviceMetricsOverride", {
  width: 500,
  height: 900,
  deviceScaleFactor: 1,
  mobile: true,
});

await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 6000));

const click = await send("Runtime.evaluate", {
  expression: `(() => {
    const btn = document.querySelector("[data-detail]");
    if (!btn) return "no button";
    btn.click();
    return "clicked";
  })()`,
  returnByValue: true,
});
console.log("click:", click.result?.result?.value);

await new Promise((r) => setTimeout(r, 4000));

const state = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    open: !document.getElementById("pm").hidden,
    specs: document.querySelectorAll(".pmspecs li").length,
    rows: document.querySelectorAll(".pmcost tbody tr").length,
    reviews: document.querySelectorAll(".pmreview").length,
    wa: !!document.querySelector(".pmactions .cta-wa"),
    tg: !!document.querySelector(".pmactions .cta-tg")
  })`,
  returnByValue: true,
});
console.log("state:", state.result?.result?.value);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("wrote", out);

await send("Runtime.evaluate", {
  expression: `(() => { const s = document.querySelector(".pmsheet"); s.scrollTop = s.scrollHeight; return s.scrollTop; })()`,
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 700));
const shot2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out.replace(/\.png$/, "-reviews.png"), Buffer.from(shot2.result.data, "base64"));
console.log("wrote reviews view");
ws.close();
