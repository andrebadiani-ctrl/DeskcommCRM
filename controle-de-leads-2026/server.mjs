// Controle de Leads 2026 — servidor HTTP (API REST + eventos em tempo real + frontend estático).
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Conversas } from "./conversas.mjs";
import { ErroValidacao, Store, chaveTelefone } from "./store.mjs";
import { Followups } from "./followups.mjs";
import { WhatsApp } from "./whatsapp.mjs";
import { WhatsAppSimulado } from "./whatsapp-simulado.mjs";

const raiz = path.dirname(fileURLToPath(import.meta.url));
const PORTA = Number(process.env.PORT || 3000);
// O modo demonstração guarda tudo à parte, para nunca misturar com os dados reais.
const DADOS = process.env.DATA_DIR || path.join(raiz, process.env.WA_SIMULADO === "1" ? "data-demonstracao" : "data");
const SENHA = process.env.APP_PASSWORD || "";

const store = new Store(DADOS);
await store.carregar();
const conversas = new Conversas(DADOS);
await conversas.carregar();
// WA_SIMULADO=1: modo demonstração, sem celular (ver whatsapp-simulado.mjs).
const whatsapp = process.env.WA_SIMULADO === "1" ? new WhatsAppSimulado() : new WhatsApp(DADOS);

// ---- eventos em tempo real (Server-Sent Events) ----
const clientes = new Set();
function transmitir(evento, dados) {
  const linha = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of clientes) res.write(linha);
}
whatsapp.on("estado", (estado) => transmitir("whatsapp", estado));

const followups = new Followups(store, whatsapp, (id) => transmitir("leads", { motivo: "followup", id }));

// A sincronização inicial manda centenas de eventos de uma vez: avisa as telas no máximo 2x/s.
let avisoConversas = null;
function avisarConversas() {
  if (avisoConversas) return;
  avisoConversas = setTimeout(() => {
    avisoConversas = null;
    transmitir("conversas", {});
  }, 500);
}

/** Lead ligado a uma conversa: pelo JID gravado no lead ou pelo mesmo telefone. */
function leadDaConversa(jid, telefone) {
  return store.listar().find((l) => l.whatsappJid === jid) || (telefone ? store.porTelefone(telefone) : undefined);
}

whatsapp.on("conversa", (dados) => {
  conversas.atualizarDados(dados.jid, dados);
  avisarConversas();
});

// Toda mensagem (recebida, enviada pelo celular ou pelo CRM, ou do histórico) entra na caixa de
// entrada. Se a conversa é de um lead, entra também no histórico dele.
whatsapp.on("mensagem", async ({ jid, id, fromMe, telefone, nome, texto, em, nova, historico }) => {
  try {
    const msg = { id, direcao: fromMe ? "saida" : "entrada", texto, em };
    const inedita = conversas.registrar(jid, { ...msg, nome, telefone }, { nova });
    avisarConversas();
    if (!inedita || historico) return; // histórico antigo só vai para o lead quando ele é ligado

    let lead = leadDaConversa(jid, telefone);
    if (!lead && !fromMe && nova && store.config.autoCriarLeads) {
      const pais = telefone.startsWith("55") ? "Brasil" : telefone.startsWith("351") ? "Portugal" : "";
      lead = await store.criar({
        nome: nome || (telefone ? `+${telefone}` : "Contato do WhatsApp"),
        telefone: telefone ? `+${telefone}` : "",
        pais,
        whatsappJid: jid,
        etapa: "Novo Lead",
        observacoes: "Lead criado automaticamente a partir de uma mensagem no WhatsApp.",
      });
    }
    if (!lead) return;
    if (!fromMe) followups.aoReceberMensagem(lead, msg); // resposta do lead cancela follow-ups; "PARAR" descadastra
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
  let lead = await store.criar(req.body);
  // Lead criado a partir de uma conversa: traz o histórico dela.
  const conversa = lead.whatsappJid && conversas.obter(lead.whatsappJid);
  if (conversa) lead = await store.importarMensagens(lead.id, conversa.mensagens);
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
  if (!lead.telefone && !lead.whatsappJid) throw new ErroValidacao("Lead sem telefone");
  let enviada;
  try {
    enviada = await whatsapp.enviarParaLead(lead, texto);
  } catch (e) {
    return res.status(409).json({ error: { message: e.message } });
  }
  const msg = { id: enviada.id, direcao: "saida", texto, em: enviada.em };
  conversas.registrar(enviada.jid, msg);
  avisarConversas();
  const atualizado = await store.registrarMensagem(lead.id, msg);
  transmitir("leads", { motivo: "mensagem", id: lead.id });
  res.json({ data: atualizado });
}));

// ---- caixa de entrada do WhatsApp ----
function resumoLead(lead) {
  return lead ? { id: lead.id, nome: lead.nome, etapa: lead.etapa } : null;
}

app.get("/api/conversas", (_req, res) => {
  // Índices para achar o lead de cada conversa sem varrer a lista inteira a cada uma.
  const porJid = new Map();
  const porTelefone = new Map();
  for (const l of store.listar()) {
    if (l.whatsappJid) porJid.set(l.whatsappJid, l);
    const chave = chaveTelefone(l.telefone);
    if (chave && !porTelefone.has(chave)) porTelefone.set(chave, l);
  }
  const data = conversas.listar().map((c) => ({
    ...c,
    lead: resumoLead(porJid.get(c.jid) || (c.telefone ? porTelefone.get(chaveTelefone(c.telefone)) : undefined)),
  }));
  res.json({ data });
});

app.get("/api/conversas/:jid", (req, res) => {
  const c = conversas.obter(req.params.jid);
  if (!c) return res.status(404).json({ error: { message: "Conversa não encontrada" } });
  res.json({ data: { ...c, lead: resumoLead(leadDaConversa(c.jid, c.telefone)) } });
});

app.post("/api/conversas/:jid/lida", (req, res) => {
  if (!conversas.marcarLida(req.params.jid)) return res.status(404).json({ error: { message: "Conversa não encontrada" } });
  avisarConversas();
  res.status(204).end();
});

app.post("/api/conversas/:jid/mensagens", assincrono(async (req, res) => {
  const c = conversas.obter(req.params.jid);
  if (!c) return res.status(404).json({ error: { message: "Conversa não encontrada" } });
  const texto = String(req.body?.texto || "").trim().slice(0, 4000);
  if (!texto) throw new ErroValidacao("Mensagem vazia");
  let enviada;
  try {
    enviada = await whatsapp.enviarParaJid(c.jid, texto);
  } catch (e) {
    return res.status(409).json({ error: { message: e.message } });
  }
  const msg = { id: enviada.id, direcao: "saida", texto, em: enviada.em };
  conversas.registrar(c.jid, msg);
  const lead = leadDaConversa(c.jid, c.telefone);
  if (lead) {
    await store.registrarMensagem(lead.id, msg);
    transmitir("leads", { motivo: "mensagem", id: lead.id });
  }
  avisarConversas();
  res.json({ data: { ...c, lead: resumoLead(lead) } });
}));

// Liga a conversa a um lead que já existe (útil quando o WhatsApp esconde o número).
app.post("/api/conversas/:jid/vincular", assincrono(async (req, res) => {
  const c = conversas.obter(req.params.jid);
  if (!c) return res.status(404).json({ error: { message: "Conversa não encontrada" } });
  const alvo = store.obter(String(req.body?.leadId || ""));
  if (!alvo) return res.status(404).json({ error: { message: "Lead não encontrado" } });
  // Uma conversa pertence a um lead só: tira de quem a tinha antes.
  for (const outro of store.listar()) if (outro.whatsappJid === c.jid && outro.id !== alvo.id) await store.atualizar(outro.id, { whatsappJid: "" });
  const dados = { whatsappJid: c.jid };
  if (!alvo.telefone && c.telefone) dados.telefone = `+${c.telefone}`;
  await store.atualizar(alvo.id, dados);
  const lead = await store.importarMensagens(alvo.id, c.mensagens);
  transmitir("leads", { motivo: "vinculado", id: lead.id });
  avisarConversas();
  res.json({ data: lead });
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
  if (process.env.ABRIR_NAVEGADOR === "1") abrirNavegador(`http://localhost:${PORTA}`);
  followups.iniciar();
  whatsapp.iniciarSeHouverSessao().catch((e) => console.error("WhatsApp:", e));
});


// Usado pelos atalhos de início (INICIAR-WINDOWS.bat / iniciar-mac-linux.sh).
function abrirNavegador(url) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // sem navegador (servidor sem tela): o endereço já foi mostrado no terminal
  }
}
