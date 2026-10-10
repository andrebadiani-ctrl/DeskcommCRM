import { chromium } from "/home/user/DeskcommCRM/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs";
import fs from "node:fs";
const ext = "/home/user/DeskcommCRM/chrome-extension/whatsapp-crm";
const html = fs.readFileSync(new URL("./fake.html", import.meta.url), "utf8");
const ctx = await chromium.launchPersistentContext("", { executablePath: "/opt/pw-browsers/chromium", headless: true,
  args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
await ctx.route("https://web.whatsapp.com/**", (r) => {
  const u = new URL(r.request().url()); const tel = u.searchParams.get("phone");
  r.fulfill({ contentType: "text/html", body: html.replaceAll("__TITULO__", tel ? `+${tel}` : "Maria Souza") });
});
const page = await ctx.newPage();
page.on("console", (m) => console.log("  [page]", m.type(), m.text()));
await page.goto("https://web.whatsapp.com/");
const host = page.locator("#deskcomm-crm");
await host.waitFor({ state: "attached", timeout: 15000 });
await page.locator("#deskcomm-crm >> [data-ref=lancador]").click();
await page.screenshot({ path: "1-contato.png" });
await page.locator("#deskcomm-crm >> [data-ref=estagio]").selectOption("proposta");
await page.locator("#deskcomm-crm >> [data-ref=notas]").fill("Quer orçamento <b>x</b>");
await page.locator("#deskcomm-crm >> [data-ref=salvar]").click();
await page.waitForTimeout(300);
console.log("msgContato:", await page.locator("#deskcomm-crm >> [data-ref=msgContato]").textContent());
await page.locator("#deskcomm-crm >> nav button[data-aba=disparo]").click();
await page.locator("#deskcomm-crm >> [data-ref=lista]").fill("31999999999;Ana Lima\n5500000000000;Fantasma\n31888888888;Bruno");
await page.locator("#deskcomm-crm >> [data-ref=mensagem]").fill("{Olá|Oi} {{primeiro_nome}}, tudo bem?");
await page.locator("#deskcomm-crm >> [data-ref=delayMin]").fill("5");
await page.locator("#deskcomm-crm >> [data-ref=delayMax]").fill("5");
await page.locator("#deskcomm-crm >> [data-ref=horaInicio]").fill("0");
await page.locator("#deskcomm-crm >> [data-ref=horaFim]").fill("0");
page.once("dialog", (d) => { console.log("confirm:", d.message().split("\n")[0]); d.accept(); });
await page.locator("#deskcomm-crm >> [data-ref=iniciar]").click();
const t0 = Date.now();
for (;;) {
  await page.waitForTimeout(2000);
  let resumo = ""; try { resumo = await page.locator("#deskcomm-crm >> [data-ref=resumo]").textContent({ timeout: 3000 }); } catch {}
  if (/Concluída/.test(resumo) || Date.now() - t0 > 120000) { console.log("resumo:", resumo); break; }
}
await page.screenshot({ path: "2-disparo.png" });
console.log("enviados:", await page.evaluate(() => localStorage.getItem("enviados")));
console.log("itens:", await page.locator("#deskcomm-crm >> [data-ref=itens]").innerText());
await ctx.close();
