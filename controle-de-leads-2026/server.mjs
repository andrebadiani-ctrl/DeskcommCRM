// Controle de Leads 2026 — servidor HTTP (API REST + eventos em tempo real + frontend estático).
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { Conversas, previa } from "./conversas.mjs";
import { ErroValidacao, Store, chaveTelefone } from "./store.mjs";
import { Followups } from "./followups.mjs";
import { LIMITE_IMPORTACAO, normalizarLinha } from "./importacao.mjs";
import { paginaDoPedido } from "./impressao.mjs";
import { resumoDoPainel } from "./painel.mjs";
import { Pedidos, STATUS_PEDIDO, STATUS_VENDA, resumoPagamento } from "./pedidos.mjs";
import { Tarefas } from "./tarefas.mjs";
import { WhatsApp } from "./whatsapp.mjs";
import { WhatsAppSimulado } from "./whatsapp-simulado.mjs";

const raiz = path.dirname(fileURLToPath(import.meta.url));
// Versão e data da versão vêm do package.json (mudam a cada atualização, sem editar código).
const PACOTE = JSON.parse(await readFile(path.join(raiz, "package.json"), "utf8"));
const VERSAO = { versao: PACOTE.version, data: PACOTE.dataVersao || "" };
const PORTA = Number(process.env.PORT || 3000);
// O modo demonstração guarda tudo à parte, para nunca misturar com os dados reais.
const DADOS = process.env.DATA_DIR || path.join(raiz, process.env.WA_SIMULADO === "1" ? "data-demonstracao" : "data");
const SENHA = process.env.APP_PASSWORD || "";

const store = new Store(DADOS);
await store.carregar();
const pedidos = new Pedidos(DADOS);
await pedidos.carregar();
const tarefas = new Tarefas(DADOS);
await tarefas.carregar();
const conversas = new Conversas(DADOS);
await conversas.carregar();
// WA_SIMULADO=1: modo demonstração, sem celular (ver whatsapp-simulado.mjs).
const whatsapp =
  process.env.WA_SIMULADO === "1"
    ? new WhatsAppSimulado()
    : new WhatsApp(DADOS, { buscarMensagem: (id) => conversas.mensagemPorId(id) });

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
// O WhatsApp revelou o número de um contato que estava como LID: junta as conversas e os leads.
whatsapp.on("unificar", async ({ lid, pn }) => {
  try {
    const juntou = conversas.unificar(lid, pn);
    for (const lead of store.listar()) if (lead.whatsappJid === lid) await store.atualizar(lead.id, { whatsappJid: pn });
    if (juntou) avisarConversas();
  } catch (e) {
    console.error("Falha ao unificar conversa:", e);
  }
});

whatsapp.on("mensagem", async ({ jid, jidWhatsapp, id, fromMe, telefone, nome, texto, midia, em, nova, historico }) => {
  try {
    const msg = { id, direcao: fromMe ? "saida" : "entrada", texto, em, midia };
    const inedita = conversas.registrar(jid, { ...msg, nome, telefone, jidWhatsapp }, { nova });
    avisarConversas();
    if (!inedita || historico) return; // histórico antigo só vai para o lead quando ele é ligado
    // Aviso para as telas abertas (som e notificação do navegador).
    if (nova && !fromMe) {
      const c = conversas.obter(jid);
      transmitir("mensagem-nova", { jid, nome: c?.nomeContato || c?.nome || nome || (telefone ? `+${telefone}` : "Contato"), previa: previa(msg).slice(0, 120) });
    }

    let lead = leadDaConversa(jid, telefone);
    if (!lead && !fromMe && nova && store.config.autoCriarLeads) {
      const pais = telefone.startsWith("55") ? "Brasil" : telefone.startsWith("351") ? "Portugal" : "";
      lead = await store.criar({
        nome: nome || (telefone ? `+${telefone}` : "Contato do WhatsApp"),
        telefone: telefone ? `+${telefone}` : "",
        pais,
        whatsappJid: jid,
        origem: "WhatsApp",
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
// JSON pequeno em tudo, menos na importação de planilha (que tem rota própria, com limite maior).
const jsonPequeno = express.json({ limit: "200kb" });
app.use((req, res, next) => (req.path === "/api/leads/importar" ? next() : jsonPequeno(req, res, next)));

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

app.get("/api/versao", (_req, res) => res.json({ data: VERSAO }));

// Painel de resultados. ?dias=7|30|90|365; sem dias (ou 0) = desde o começo.
app.get("/api/painel", (req, res) => {
  const dias = Number(req.query.dias) || 0;
  if (dias < 0 || dias > 3650) return res.status(400).json({ error: { message: "Período inválido" } });
  res.json({ data: resumoDoPainel({ leads: store.listar(), pedidos: pedidos.listar(), conversas: [...conversas.mapa.values()], dias }) });
});

app.get("/api/leads", (_req, res) => res.json({ data: store.listar() }));

app.post("/api/leads", assincrono(async (req, res) => {
  let lead = await store.criar(req.body);
  // Lead criado a partir de uma conversa: traz o histórico dela.
  const conversa = lead.whatsappJid && conversas.obter(lead.whatsappJid);
  if (conversa) lead = await store.importarMensagens(lead.id, conversa.mensagens);
  transmitir("leads", { motivo: "criado", id: lead.id });
  res.status(201).json({ data: lead });
}));

// Importação de planilha: a tela manda as linhas já com as colunas mapeadas.
app.post("/api/leads/importar", express.json({ limit: "15mb" }), assincrono(async (req, res) => {
  const linhas = req.body?.linhas;
  if (!Array.isArray(linhas) || !linhas.length) throw new ErroValidacao("Nenhuma linha para importar");
  if (linhas.length > LIMITE_IMPORTACAO) throw new ErroValidacao(`No máximo ${LIMITE_IMPORTACAO} linhas por importação`);
  const padroes = { etapa: req.body.padroes?.etapa, origem: String(req.body.padroes?.origem || "").slice(0, 60) };
  const entradas = linhas.map((l, i) => ({ linha: Number(l?.linha) || i + 2, ...normalizarLinha(l?.campos, padroes) }));
  const resultado = await store.criarVarios(entradas, { pularDuplicados: req.body.pularDuplicados !== false });
  if (resultado.criados) transmitir("leads", { motivo: "importacao" });
  res.json({ data: resultado });
}));

app.patch("/api/leads/:id", assincrono(async (req, res) => {
  const lead = await store.atualizar(req.params.id, req.body);
  if (!lead) return res.status(404).json({ error: { message: "Lead não encontrado" } });
  if ("nome" in (req.body || {})) tarefas.atualizarLead(lead);
  transmitir("leads", { motivo: "atualizado", id: lead.id });
  res.json({ data: lead });
}));

app.delete("/api/leads/:id", assincrono(async (req, res) => {
  const excluido = store.obter(req.params.id);
  if (!(await store.excluir(req.params.id))) return res.status(404).json({ error: { message: "Lead não encontrado" } });
  tarefas.atualizarLead(excluido, { excluido: true }); // a tarefa fica, com o nome de quem era
  pedidos.desligarLead(req.params.id); // os pedidos ficam, com o nome do cliente
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

// ---- tarefas e lembretes ----
const avisarTarefas = () => transmitir("tarefas", {});
function leadDaTarefa(body) {
  if (!body?.leadId) return null;
  const lead = store.obter(String(body.leadId));
  if (!lead) throw new ErroValidacao("Lead não encontrado");
  return lead;
}
app.get("/api/tarefas", (_req, res) => res.json({ data: tarefas.listar() }));
app.post("/api/tarefas", assincrono(async (req, res) => {
  const t = await tarefas.criar(req.body, leadDaTarefa(req.body));
  avisarTarefas();
  res.status(201).json({ data: t });
}));
app.patch("/api/tarefas/:id", assincrono(async (req, res) => {
  const t = await tarefas.atualizar(req.params.id, req.body);
  if (!t) return res.status(404).json({ error: { message: "Tarefa não encontrada" } });
  avisarTarefas();
  res.json({ data: t });
}));
app.delete("/api/tarefas/:id", assincrono(async (req, res) => {
  if (!(await tarefas.excluir(req.params.id))) return res.status(404).json({ error: { message: "Tarefa não encontrada" } });
  avisarTarefas();
  res.status(204).end();
}));

// ---- pedidos, produtos e condições de pagamento ----
const naoEncontrado = (res, o) => res.status(404).json({ error: { message: `${o} não encontrado` } });
const avisarPedidos = () => transmitir("pedidos", {});

app.get("/api/pedidos", (_req, res) => {
  res.json({
    data: {
      pedidos: pedidos.listar(),
      produtos: pedidos.dados.produtos,
      condicoes: pedidos.dados.condicoes,
      vendedores: pedidos.dados.vendedores,
      config: pedidos.dados.config,
      status: STATUS_PEDIDO,
    },
  });
});

for (const [rota, criar, atualizar, excluir, nome] of [
  ["produtos", "criarProduto", "atualizarProduto", "excluirProduto", "Produto"],
  ["condicoes", "criarCondicao", "atualizarCondicao", "excluirCondicao", "Condição de pagamento"],
  ["vendedores", "criarVendedor", "atualizarVendedor", "excluirVendedor", "Vendedor"],
]) {
  app.post(`/api/${rota}`, assincrono(async (req, res) => {
    const item = await pedidos[criar](req.body);
    avisarPedidos();
    res.status(201).json({ data: item });
  }));
  app.patch(`/api/${rota}/:id`, assincrono(async (req, res) => {
    const item = await pedidos[atualizar](req.params.id, req.body);
    if (!item) return naoEncontrado(res, nome);
    avisarPedidos();
    res.json({ data: item });
  }));
  app.delete(`/api/${rota}/:id`, assincrono(async (req, res) => {
    if (!(await pedidos[excluir](req.params.id))) return naoEncontrado(res, nome);
    avisarPedidos();
    res.status(204).end();
  }));
}

/** Cliente do pedido: o lead escolhido; sem lead, vale o nome digitado (clienteNome). */
function leadDoPedido(body, atual) {
  const leadId = body && "leadId" in body ? body.leadId : atual?.leadId;
  if (!leadId) return null;
  const lead = store.obter(String(leadId));
  if (!lead) throw new ErroValidacao("Cliente (lead) não encontrado");
  return lead;
}

app.patch("/api/pedidos-config", assincrono(async (req, res) => {
  const config = await pedidos.atualizarConfig(req.body);
  avisarPedidos();
  res.json({ data: config });
}));

/** Venda fechada (pedido confirmado em diante): o lead vai para "Ganho" no Kanban. */
async function ganharLead(pedido) {
  if (!pedidos.dados.config.moverLeadParaGanho || !STATUS_VENDA.includes(pedido.status) || !pedido.leadId) return;
  const lead = store.obter(pedido.leadId);
  if (!lead || lead.etapa === "Ganho") return;
  await store.atualizar(lead.id, { etapa: "Ganho" });
  transmitir("leads", { motivo: "atualizado", id: lead.id });
}
const comResumo = (p) => ({ ...p, ...resumoPagamento(p) });

app.post("/api/pedidos", assincrono(async (req, res) => {
  const pedido = await pedidos.criar(req.body, leadDoPedido(req.body));
  await ganharLead(pedido);
  avisarPedidos();
  res.status(201).json({ data: comResumo(pedido) });
}));
app.patch("/api/pedidos/:id", assincrono(async (req, res) => {
  const atual = pedidos.obter(req.params.id);
  if (!atual) return naoEncontrado(res, "Pedido");
  const pedido = await pedidos.atualizar(req.params.id, req.body, leadDoPedido(req.body, atual));
  await ganharLead(pedido);
  avisarPedidos();
  res.json({ data: comResumo(pedido) });
}));
app.post("/api/pedidos/:id/status", assincrono(async (req, res) => {
  const pedido = await pedidos.mudarStatus(req.params.id, req.body?.status);
  if (!pedido) return naoEncontrado(res, "Pedido");
  await ganharLead(pedido);
  avisarPedidos();
  res.json({ data: comResumo(pedido) });
}));
app.patch("/api/pedidos/:id/pagamentos/:numero", assincrono(async (req, res) => {
  const pedido = await pedidos.atualizarParcela(req.params.id, req.params.numero, req.body || {});
  if (!pedido) return res.status(404).json({ error: { message: "Parcela não encontrada" } });
  avisarPedidos();
  res.json({ data: comResumo(pedido) });
}));

// Pedido em página própria, pronta para imprimir ou "Salvar como PDF" no navegador.
app.get("/pedidos/:id/imprimir", (req, res) => {
  const pedido = pedidos.obter(req.params.id);
  if (!pedido) return res.status(404).send("Pedido não encontrado");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:");
  res.type("html").send(paginaDoPedido(pedido, pedido.leadId ? store.obter(pedido.leadId) : null, pedidos.dados.config.empresa));
});

app.delete("/api/pedidos/:id", assincrono(async (req, res) => {
  if (!(await pedidos.excluir(req.params.id))) return naoEncontrado(res, "Pedido");
  avisarPedidos();
  res.status(204).end();
}));

// Manda o resumo do pedido para o cliente pelo WhatsApp (e registra na conversa e no lead).
app.post("/api/pedidos/:id/whatsapp", assincrono(async (req, res) => {
  const pedido = pedidos.obter(req.params.id);
  if (!pedido) return naoEncontrado(res, "Pedido");
  const lead = pedido.leadId && store.obter(pedido.leadId);
  if (!lead) throw new ErroValidacao("Este pedido não está ligado a um lead com WhatsApp");
  if (!lead.telefone && !lead.whatsappJid) throw new ErroValidacao("O lead não tem telefone");
  const texto = pedidos.resumoParaWhatsApp(pedido);
  let enviada;
  try {
    enviada = await whatsapp.enviarParaLead(lead, texto);
  } catch (e) {
    return res.status(409).json({ error: { message: e.message } });
  }
  const msg = { id: enviada.id, direcao: "saida", texto, em: enviada.em, origem: "pedido" };
  conversas.registrar(enviada.jid, msg);
  await store.registrarMensagem(lead.id, msg);
  avisarConversas();
  transmitir("leads", { motivo: "mensagem", id: lead.id });
  res.json({ data: { texto } });
}));

// ---- caixa de entrada do WhatsApp ----
function resumoLead(lead) {
  return lead ? { id: lead.id, nome: lead.nome, etapa: lead.etapa } : null;
}

/** Conversa para a tela: a mídia vai só com a descrição (as chaves de download ficam no servidor). */
function paraTela(c, lead) {
  const mensagens = c.mensagens.map(({ midia, ...m }) => (midia ? { ...m, midia: { tipo: midia.tipo, mimetype: midia.mimetype, nome: midia.nome, tamanho: midia.tamanho, segundos: midia.segundos, ptt: midia.ptt } } : m));
  return { ...c, mensagens, lead: resumoLead(lead) };
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
  res.json({ data: paraTela(c, leadDaConversa(c.jid, c.telefone)) });
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
  res.json({ data: paraTela(c, lead) });
}));

// ---- mídia: fotos, vídeos, áudios e documentos ----
const PASTA_MIDIA = path.join(DADOS, "midia");
await mkdir(PASTA_MIDIA, { recursive: true });
const LIMITE_DOWNLOAD = 200 * 1024 * 1024;
const LIMITE_ENVIO = "64mb";
const EXTENSOES = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp", "video/webm": "webm", "video/quicktime": "mov",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/webm": "weba",
  "application/pdf": "pdf",
};
// Só estes tipos abrem dentro do navegador. Todo o resto é baixado como arquivo: um "documento"
// HTML ou SVG mandado por um contato nunca roda dentro do CRM.
const ABRE_NO_NAVEGADOR = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|3gpp|quicktime)|audio\/[\w.+-]+|application\/pdf)$/;
const baixando = new Map(); // id → download em andamento (dois cliques não baixam duas vezes)

function nomeDeArquivoSeguro(nome, padrao = "arquivo") {
  return String(nome || padrao).replace(/[\\/:*?"<>|\r\n\t]/g, "_").slice(0, 150) || padrao;
}

function baixarParaDisco(m) {
  if (baixando.has(m.id)) return baixando.get(m.id);
  const tarefa = (async () => {
    const arquivo = `${String(m.id).replace(/[^\w-]/g, "").slice(0, 80) || randomUUID()}.${EXTENSOES[m.midia.mimetype] || "bin"}`;
    const destino = path.join(PASTA_MIDIA, arquivo);
    const parcial = destino + ".parcial";
    const conteudo = await whatsapp.baixarMidia(m.midia.wa);
    try {
      if (Buffer.isBuffer(conteudo)) await writeFile(parcial, conteudo);
      else await pipeline(conteudo, createWriteStream(parcial));
      await rename(parcial, destino);
    } catch (e) {
      await unlink(parcial).catch(() => {});
      throw e;
    }
    return arquivo;
  })().finally(() => baixando.delete(m.id));
  baixando.set(m.id, tarefa);
  return tarefa;
}

// Entrega a mídia de uma mensagem. Na primeira vez baixa do WhatsApp e guarda em data/midia.
app.get("/api/midia/:id", assincrono(async (req, res) => {
  const m = conversas.mensagemPorId(req.params.id);
  if (!m?.midia) return res.status(404).json({ error: { message: "Mídia não encontrada" } });
  const midia = m.midia;
  if (midia.arquivo && !existsSync(path.join(PASTA_MIDIA, midia.arquivo))) delete midia.arquivo; // apagaram a pasta
  if (!midia.arquivo) {
    if (!midia.wa) return res.status(410).json({ error: { message: "Arquivo indisponível" } });
    if (midia.tamanho > LIMITE_DOWNLOAD) return res.status(413).json({ error: { message: "Arquivo grande demais para abrir aqui; abra no celular." } });
    try {
      midia.arquivo = await baixarParaDisco(m);
      conversas.agendarSalvar();
    } catch (e) {
      const desconectado = whatsapp.status !== "conectado";
      return res.status(desconectado ? 409 : 502).json({
        error: { message: desconectado ? "Conecte o WhatsApp para baixar esta mídia." : `Não foi possível baixar a mídia do WhatsApp (${e.message}).` },
      });
    }
  }
  const mime = midia.mimetype || "application/octet-stream";
  const abrir = ABRE_NO_NAVEGADOR.test(mime) && req.query.baixar !== "1";
  const nome = nomeDeArquivoSeguro(midia.nome, `${midia.tipo}.${EXTENSOES[mime] || "bin"}`);
  res.set({
    "Content-Type": abrir ? mime : "application/octet-stream",
    "Content-Disposition": `${abrir ? "inline" : "attachment"}; filename="${nome.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(nome)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "private, max-age=86400",
  });
  res.sendFile(path.join(PASTA_MIDIA, midia.arquivo)); // aceita Range: áudio e vídeo avançam/voltam
}));

// Envia um arquivo pela conversa. O corpo é o próprio arquivo; nome, tipo e legenda vão em cabeçalhos.
app.post("/api/conversas/:jid/anexos", express.raw({ type: "application/octet-stream", limit: LIMITE_ENVIO }), assincrono(async (req, res) => {
  const c = conversas.obter(req.params.jid);
  if (!c) return res.status(404).json({ error: { message: "Conversa não encontrada" } });
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ErroValidacao("Arquivo vazio");
  const decodificar = (v) => {
    try { return decodeURIComponent(String(v || "")); } catch { return ""; }
  };
  const mimetype = decodificar(req.get("x-tipo-arquivo")).split(";")[0].trim().toLowerCase() || "application/octet-stream";
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimetype)) throw new ErroValidacao("Tipo de arquivo inválido");
  const nome = nomeDeArquivoSeguro(decodificar(req.get("x-nome-arquivo")));
  const legenda = decodificar(req.get("x-legenda")).trim().slice(0, 1000);
  const extensao = EXTENSOES[mimetype] || path.extname(nome).slice(1).replace(/[^\w]/g, "").slice(0, 8) || "bin";
  const arquivo = `envio-${randomUUID()}.${extensao}`;
  const caminho = path.join(PASTA_MIDIA, arquivo);
  await writeFile(caminho, req.body);
  let enviada;
  try {
    enviada = await whatsapp.enviarMidiaParaJid(c.jid, { caminho, mimetype, nome, legenda });
  } catch (e) {
    await unlink(caminho).catch(() => {});
    return res.status(409).json({ error: { message: e.message } });
  }
  // O WhatsApp não mostra legenda em áudio: nesse caso ela segue como mensagem de texto.
  const legendaSeparada = enviada.tipo === "audio" && legenda;
  const msgs = [{ id: enviada.id, direcao: "saida", texto: legendaSeparada ? "" : legenda, em: enviada.em, midia: { tipo: enviada.tipo, mimetype, nome, tamanho: req.body.length, arquivo } }];
  if (legendaSeparada) {
    const texto = await whatsapp.enviarParaJid(c.jid, legenda).catch(() => null);
    if (texto) msgs.push({ id: texto.id, direcao: "saida", texto: legenda, em: texto.em });
  }
  const lead = leadDaConversa(c.jid, c.telefone);
  for (const msg of msgs) {
    conversas.registrar(c.jid, msg);
    if (lead) await store.registrarMensagem(lead.id, msg);
  }
  if (lead) transmitir("leads", { motivo: "mensagem", id: lead.id });
  avisarConversas();
  res.json({ data: paraTela(c, lead) });
}));

// Pede ao celular mensagens mais antigas desta conversa (chegam em seguida, pela sincronização).
app.post("/api/conversas/:jid/anteriores", assincrono(async (req, res) => {
  const c = conversas.obter(req.params.jid);
  if (!c) return res.status(404).json({ error: { message: "Conversa não encontrada" } });
  const maisAntiga = c.mensagens.find((m) => m.id);
  if (!maisAntiga) throw new ErroValidacao("Ainda não há mensagens nesta conversa para continuar a partir delas");
  try {
    await whatsapp.pedirAnteriores(c.jidWhatsapp || c.jid, { id: maisAntiga.id, fromMe: maisAntiga.direcao === "saida" }, maisAntiga.em);
  } catch (e) {
    return res.status(409).json({ error: { message: e.message } });
  }
  res.status(202).json({ data: { pedido: true } });
}));

// Fixar no topo e fila de atendimento.
app.post("/api/conversas/:jid/fixar", (req, res) => {
  const c = conversas.fixar(req.params.jid, req.body?.fixada !== false);
  if (!c) return res.status(404).json({ error: { message: "Conversa não encontrada" } });
  avisarConversas();
  res.json({ data: { jid: c.jid, fixada: c.fixada } });
});
app.post("/api/conversas/:jid/baixa", (req, res) => {
  const c = conversas.darBaixa(req.params.jid);
  if (!c) return res.status(404).json({ error: { message: "Conversa não encontrada" } });
  avisarConversas();
  res.json({ data: { jid: c.jid, fila: c.fila } });
});
app.post("/api/conversas/:jid/fila", (req, res) => {
  const c = conversas.colocarNaFila(req.params.jid);
  if (!c) return res.status(404).json({ error: { message: "Conversa não encontrada" } });
  avisarConversas();
  res.json({ data: { jid: c.jid, fila: c.fila } });
});

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
  console.info(`Controle de Leads 2026 v${VERSAO.versao} rodando em http://localhost:${PORTA}`);
  // Endereços para abrir de outros aparelhos da mesma rede (celular, outro computador).
  const ipsDaRede = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  for (const ip of ipsDaRede) console.info(`Na rede local: http://${ip}:${PORTA}`);
  if (!SENHA) console.warn("Aviso: APP_PASSWORD não definida — o painel está sem senha.");
  if (process.env.ABRIR_NAVEGADOR === "1") abrirNavegador(`http://localhost:${PORTA}`);
  followups.iniciar();
  // Chegou a hora de uma tarefa: as telas abertas tocam o aviso.
  tarefas.iniciar((t) => {
    transmitir("lembrete", { id: t.id, titulo: t.titulo, leadId: t.leadId, leadNome: t.leadNome, quando: t.quando });
    avisarTarefas();
  });
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
