// Service worker do app instalado. Guarda só a "casca" da tela (HTML, JS, CSS, ícones) para o app
// abrir mesmo com a rede instável. Dados (/api) e páginas de impressão nunca passam pelo cache.
// Estratégia "rede primeiro": com rede, sempre a versão mais nova; sem rede, a última guardada.
const CACHE = "controle-de-leads-casca";
const CASCA = ["./", "app.js", "styles.css", "regioes.js", "manifest.webmanifest", "icones/icone-192.png", "icones/icone-512.png"];

self.addEventListener("install", (e) => {
  // Cada arquivo separado: um que falhe (ex.: senha pedida) não impede a instalação.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(CASCA.map((url) => c.add(url).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/pedidos/")) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === "navigate" ? "./" : req, copia)).catch(() => {});
        }
        return res;
      })
      .catch(async () => (await caches.match(req.mode === "navigate" ? "./" : req)) || Response.error()),
  );
});
