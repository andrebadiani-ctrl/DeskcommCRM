// Controle de Leads 2026 — servidor HTTP (API REST + eventos em tempo real + frontend estático).
import { timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ErroValidacao, Store } from "./store.mjs";
import { Followups } from "./followups.mjs";
import { WhatsApp } from "./whatsapp.mjs";

const raiz = path.dirname(fileURLToPath(import.meta.url));
const PORTA = Number(process.env.PORT || 3000);
const DADOS = process.env.DATA_DIR || path.join(raiz, "data");
const SENHA = process.env.APP_PASSWORD || "";

const store = new Store(DADOS);
await store.carregar();
const whatsapp = new WhatsApp(DADOS);

// ---- eventos em tempo real (Server-Sent Events) ----
const clientes = new Set();
function transmitir(evento, dados) {
  const linha = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of clientes) res.write(linha);
}
whatsapp.on("estado", (estado) => transmitir("whatsapp", estado));

const followups = new Followups(store, whatsapp, (id) => transmitir("leads", { motivo: "followup", id }));

// Mensagem recebida: registra no lead do mesmo telefone ou cria um lead novo.
whatsapp.on("mensagem", async ({ telefone, nome, texto, em }) => {
  try {
    let lead = store.porTelefone(telefone);
    if (!lead) {
      if (!store.config.autoCriarLeads) return;
      const pais = telefone.startsWith("55") ? "Brasil" : telefone.startsWith("351") ? "Portugal" : "";
      lead = await store.criar({
        nome: nome || `+${telefone}`,
        telefone: `+${telefone}`,
        pais,
        etapa: "Novo Lead",
        observacoes: "Lead criado automaticamente a partir de uma mensagem no WhatsApp.",
      });
    }
    const msg = { direcao: "entrada", texto, em };
    followups.aoReceberMensagem(lead, msg); // resposta do lead cancela follow-ups; "PARAR" descadastra
    await store.registrarMensagem(lead.id, msg);
    transmitir("leads", { motivo: "mensagem", id: lead.id });
  } catch (e) {
    console.error("Falha ao registrar mensagem do WhatsApp:", e);
  }
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));

// Senha opcional (HTTP Basic). Recomendado em qualquer servidor exposto na internet.
if (SENHA) {
  const esperado = Buffer.from(SENHA);
  app.use((req, res, next) => {
    const [tipo, valor] = (req.headers.authorization || "").split(" ");
    const senha = tipo === "Basic" && valor ? Buffer.from(valor, "base64").toString().split(":").slice(1).join(":") : "";
    const recebido = Buffer.from(senha);
    if (recebido.length === esperado.length && timingSafeEqual(recebido, esperado)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Controle de Leads 2026", charset="UTF-8"').status(401).send("Acesso restrito");
  });
}

const assincrono = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get("/api/leads", (_req, res) => res.json({ data: store.listar() }));

app.post("/api/leads", assincrono(async (req, res) => {
  const lead = await store.criar(req.body);
  transmitir("leads", { motivo: "criado", id: lead.id });
  res.status(201).json({ data: lead });
}));

app.patch("/api/leads/:id", assincrono(async (req, res) => {
  const lead = await store.atualizar(req.params.id, req.body);
  if (!lead) return res.status(404).json({ error: { message: "Lead não encontrado" } });
  transmitir("leads", { motivo: "atualizado", id: lead.id });
  res.json({ data: lead });
}));

app.delete("/api/leads/:id", assincrono(async (req, res) => {
  if (!(await store.excluir(req.params.id))) return res.status(404).json({ error: { message: "Lead não encontrado" } });
  transmitir("leads", { motivo: "excluido", id: req.params.id });
  res.status(204).end();
}));

app.post("/api/leads/:id/notas", assincrono(async (req, res) => {
  const lead = await store.adicionarNota(req.params.id, req.body?.texto);
  if (!lead) return res.status(404).json({ error: { message: "Lead não encontrado" } });
  transmitir("leads", { motivo: "nota", id: lead.id });
  res.json({ data: lead });
}));

// ---- respostas rápidas e regras de follow-up ----
for (const colecao of ["respostas", "regras"]) {
  app.post(`/api/${colecao}`, assincrono(async (req, res) => {
    const item = await store.criarItem(colecao, req.body);
    transmitir("config", { colecao });
    res.status(201).json({ data: item });
  }));
  app.patch(`/api/${colecao}/:id`, assincrono(async (req, res) => {
    const item = await store.atualizarItem(colecao, req.params.id, req.body);
    if (!item) return res.status(404).json({ error: { message: "Item não encontrado" } });
    transmitir("config", { colecao });
    res.json({ data: item });
  }));
  app.delete(`/api/${colecao}/:id`, assincrono(async (req, res) => {
    if (!(await store.excluirItem(colecao, req.params.id))) return res.status(404).json({ error: { message: "Item não encontrado" } });
    transmitir("config", { colecao });
    res.status(204).end();
  }));
}

// ---- follow-ups de um lead ----
app.post("/api/leads/:id/followups", assincrono(async (req, res) => {
  const lead = await followups.agendar(req.params.id, req.body || {});
  if (!lead) return res.status(404).json({ error: { message: "Lead não encontrado" } });
  transmitir("leads", { motivo: "followup", id: lead.id });
  res.status(201).json({ data: lead });
}));
app.delete("/api/leads/:id/followups/:fid", assincrono(async (req, res) => {
  const lead = await followups.cancelar(req.params.id, req.params.fid);
  if (!lead) return res.status(404).json({ error: { message: "Follow-up pendente não encontrado" } });
  transmitir("leads", { motivo: "followup", id: lead.id });
  res.json({ data: lead });
}));
app.post("/api/leads/:id/followups/:fid/enviar", assincrono(async (req, res) => {
  try {
    const lead = await followups.enviarAgora(req.params.id, req.params.fid);
    if (!lead) return res.status(404).json({ error: { message: "Follow-up pendente não encontrado" } });
    res.json({ data: lead });
  } catch (e) {
    res.status(409).json({ error: { message: e.message } });
  }
}));

app.get("/api/config", (_req, res) => res.json({ data: store.config }));
app.patch("/api/config", assincrono(async (req, res) => {
  const config = await store.atualizarConfig(req.body);
  transmitir("config", { colecao: "config" });
  res.json({ data: config });
}));

app.get("/api/whatsapp", (_req, res) => res.json({ data: whatsapp.estado() }));

app.post("/api/whatsapp/conectar", assincrono(async (_req, res) => {
  await whatsapp.conectar();
  res.json({ data: whatsapp.estado() });
}));

app.post("/api/whatsapp/desconectar", assincrono(async (req, res) => {
  if (req.body?.apenasParar) whatsapp.parar();
  else await whatsapp.desconectar();
  res.json({ data: whatsapp.estado() });
}));

app.post("/api/leads/:id/whatsapp", assincrono(async (req, res) => {
  const lead = store.obter(req.params.id);
  if (!lead) return res.status(404).json({ error: { message: "Lead não encontrado" } });
  const texto = String(req.body?.texto || "").trim().slice(0, 4000);
  if (!texto) throw new ErroValidacao("Mensagem vazia");
  if (!lead.telefone) throw new ErroValidacao("Lead sem telefone");
  try {
    await whatsapp.enviar(lead.telefone, texto, lead.pais);
  } catch (e) {
    return res.status(409).json({ error: { message: e.message } });
  }
  const atualizado = await store.registrarMensagem(lead.id, { direcao: "saida", texto, em: new Date().toISOString() });
  transmitir("leads", { motivo: "mensagem", id: lead.id });
  res.json({ data: atualizado });
}));

app.get("/api/eventos", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write(`event: whatsapp\ndata: ${JSON.stringify(whatsapp.estado())}\n\n`);
  clientes.add(res);
  const pulso = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(pulso);
    clientes.delete(res);
  });
});

app.use(express.static(path.join(raiz, "public")));

app.use((erro, _req, res, _next) => {
  if (erro instanceof ErroValidacao) return res.status(400).json({ error: { message: erro.message } });
  if (erro.type === "entity.parse.failed") return res.status(400).json({ error: { message: "JSON inválido" } });
  console.error(erro);
  res.status(500).json({ error: { message: "Erro interno" } });
});

app.listen(PORTA, () => {
  console.info(`Controle de Leads 2026 rodando em http://localhost:${PORTA}`);
  // Endereços para abrir de outros aparelhos da mesma rede (celular, outro computador).
  const ipsDaRede = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  for (const ip of ipsDaRede) console.info(`Na rede local: http://${ip}:${PORTA}`);
  if (!SENHA) console.warn("Aviso: APP_PASSWORD não definida — o painel está sem senha.");
  followups.iniciar();
  whatsapp.iniciarSeHouverSessao().catch((e) => console.error("WhatsApp:", e));
});

