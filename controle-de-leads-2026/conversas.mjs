// Caixa de entrada do WhatsApp: guarda as conversas (1:1, sem grupos) e as últimas mensagens
// de cada uma em data/conversas.json, para listar, ler, responder e transformar em lead.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { chaveTelefone, digitos } from "./store.mjs";

const MAX_CONVERSAS = 1500;
const MAX_MENSAGENS = 150; // por conversa
const ESPERA_SALVAR_MS = 1500; // a sincronização inicial chega em rajadas; agrupa as escritas

/** Conversa individual? (descarta grupos, status, canais e transmissões) */
export const ehConversaIndividual = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid || ""));

/** Telefone (só dígitos) de um JID de número; vazio para JID anônimo (@lid). */
export const telefoneDoJid = (jid) => (String(jid).endsWith("@s.whatsapp.net") ? digitos(String(jid).split("@")[0].split(":")[0]) : "");

export class Conversas {
  constructor(dir) {
    this.arquivo = path.join(dir, "conversas.json");
    this.dir = dir;
    this.mapa = new Map(); // jid → conversa
    this.timer = null;
    this.fila = Promise.resolve();
  }

  async carregar() {
    await mkdir(this.dir, { recursive: true });
    try {
      const json = JSON.parse(await readFile(this.arquivo, "utf8"));
      for (const c of json.conversas || []) this.mapa.set(c.jid, c);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  agendarSalvar() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.salvarAgora(), ESPERA_SALVAR_MS);
    this.timer.unref?.();
  }

  salvarAgora() {
    clearTimeout(this.timer);
    this.fila = this.fila.then(async () => {
      this.#podar();
      const tmp = this.arquivo + ".tmp";
      await writeFile(tmp, JSON.stringify({ conversas: [...this.mapa.values()] }));
      await rename(tmp, this.arquivo);
    }).catch((e) => console.error("Falha ao salvar conversas:", e));
    return this.fila;
  }

  #podar() {
    if (this.mapa.size <= MAX_CONVERSAS) return;
    const ordenadas = [...this.mapa.values()].sort((a, b) => (b.ultimaEm || "").localeCompare(a.ultimaEm || ""));
    for (const c of ordenadas.slice(MAX_CONVERSAS)) this.mapa.delete(c.jid);
  }

  #garantir(jid) {
    let c = this.mapa.get(jid);
    if (!c) {
      c = { jid, nome: "", nomeContato: "", telefone: telefoneDoJid(jid), naoLidas: 0, ultimaEm: "", ultimaMensagem: "", mensagens: [] };
      this.mapa.set(jid, c);
    }
    return c;
  }

  /** Atualiza dados da conversa vindos do WhatsApp (nome, não lidas, data, telefone). */
  atualizarDados(jid, { nome, nomeContato, telefone, naoLidas, ultimaEm } = {}) {
    if (!ehConversaIndividual(jid)) return;
    const c = this.#garantir(jid);
    if (nome) c.nome = nome;
    if (nomeContato) c.nomeContato = nomeContato;
    if (telefone && !c.telefone) c.telefone = digitos(telefone);
    if (Number.isInteger(naoLidas) && naoLidas >= 0) c.naoLidas = naoLidas;
    if (ultimaEm && ultimaEm > (c.ultimaEm || "")) c.ultimaEm = ultimaEm;
    this.agendarSalvar();
  }

  /**
   * Registra uma mensagem (sem duplicar pelo id). `nova` = chegou agora (conta como não lida);
   * mensagens do histórico entram sem mexer no contador. Devolve true se a mensagem era inédita.
   */
  registrar(jid, msg, { nova = false } = {}) {
    if (!ehConversaIndividual(jid) || !msg.texto) return false;
    const c = this.#garantir(jid);
    if (msg.id && c.mensagens.some((m) => m.id === msg.id)) return false;
    c.mensagens.push({ id: msg.id || "", direcao: msg.direcao, texto: msg.texto, em: msg.em });
    c.mensagens.sort((a, b) => a.em.localeCompare(b.em));
    if (c.mensagens.length > MAX_MENSAGENS) c.mensagens = c.mensagens.slice(-MAX_MENSAGENS);
    const ultima = c.mensagens.at(-1);
    c.ultimaEm = ultima.em;
    c.ultimaMensagem = (ultima.direcao === "saida" ? "Você: " : "") + ultima.texto.slice(0, 120);
    if (msg.direcao === "entrada" && msg.nome && !c.nome) c.nome = msg.nome;
    if (msg.telefone && !c.telefone) c.telefone = digitos(msg.telefone);
    if (nova && msg.direcao === "entrada") c.naoLidas = (c.naoLidas || 0) + 1;
    if (msg.direcao === "saida") c.naoLidas = 0; // respondeu pelo celular ou pelo CRM
    this.agendarSalvar();
    return true;
  }

  marcarLida(jid) {
    const c = this.mapa.get(jid);
    if (c && c.naoLidas) {
      c.naoLidas = 0;
      this.agendarSalvar();
    }
    return c;
  }

  obter(jid) {
    return this.mapa.get(jid);
  }

  /** Conversa ligada a um lead: pelo JID gravado no lead ou pelo mesmo telefone. */
  doLead(lead) {
    if (lead.whatsappJid && this.mapa.has(lead.whatsappJid)) return this.mapa.get(lead.whatsappJid);
    const chave = chaveTelefone(lead.telefone);
    if (!chave) return undefined;
    for (const c of this.mapa.values()) if (c.telefone && chaveTelefone(c.telefone) === chave) return c;
    return undefined;
  }

  /** Lista resumida (sem as mensagens), mais recentes primeiro. */
  listar() {
    return [...this.mapa.values()]
      .filter((c) => c.ultimaEm || c.mensagens.length)
      .sort((a, b) => (b.ultimaEm || "").localeCompare(a.ultimaEm || ""))
      .map(({ mensagens: _m, ...resto }) => resto);
  }
}
