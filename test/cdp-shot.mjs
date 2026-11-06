// CDP driver: send a chat message on the live page and screenshot the result.
import { writeFileSync } from "node:fs";

const port = process.argv[2] ?? "9223";
const out = process.argv[3] ?? "shot.png";
const message = process.argv[4] ?? "tunjuk earbuds";

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("mykiraniaga"));
if (!page) {
  console.error("no page target", list.map((t) => t.url));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
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

await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

const expr = `
(() => {
  const input = document.getElementById("chatinput");
  const form = document.getElementById("chatform");
  input.value = ${JSON.stringify(message)};
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  return "sent";
})()
`;

const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log("evaluate:", JSON.stringify(res.result?.result?.value ?? res.error ?? null));

await new Promise((resolve) => setTimeout(resolve, 9000));

const state = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    pillHidden: document.getElementById("productspill")?.hidden,
    pillText: document.getElementById("productspill")?.textContent?.trim(),
    cards: document.querySelectorAll("#products-container .card").length,
    badge: document.getElementById("resultcount")?.textContent,
    typing: getComputedStyle(document.getElementById("typing")).display,
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth
  })`,
  returnByValue: true,
});
console.log("state:", state.result?.result?.value);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("wrote", out);

// click the pill and capture the products tab
await send("Runtime.evaluate", {
  expression: `document.getElementById("productspill")?.click(); "clicked"`,
  returnByValue: true,
});
await new Promise((resolve) => setTimeout(resolve, 900));
const shot2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out.replace(/\.png$/, "-products.png"), Buffer.from(shot2.result.data, "base64"));
console.log("wrote products view");

ws.close();
