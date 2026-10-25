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

const ROTULO_MIDIA = { imagem: "📷 Foto", video: "🎥 Vídeo", audio: "🎤 Áudio", documento: "📄 Documento", figurinha: "Figurinha" };

/** Texto curto de uma mensagem, para a lista de conversas. */
export function previa(m) {
  if (!m.midia) return m.texto;
  const rotulo = m.midia.tipo === "documento" && m.midia.nome ? `📄 ${m.midia.nome}` : ROTULO_MIDIA[m.midia.tipo] || "Anexo";
  return m.texto ? `${rotulo} · ${m.texto}` : rotulo;
}

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
  atualizarDados(jid, { nome, nomeContato, telefone, naoLidas, ultimaEm, jidWhatsapp } = {}) {
    if (!ehConversaIndividual(jid)) return;
    const c = this.#garantir(jid);
    if (jidWhatsapp) c.jidWhatsapp = jidWhatsapp;
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
    if (!ehConversaIndividual(jid) || (!msg.texto && !msg.midia)) return false;
    const c = this.#garantir(jid);
    if (msg.jidWhatsapp) c.jidWhatsapp = msg.jidWhatsapp;
    const repetida = msg.id && c.mensagens.find((m) => m.id === msg.id);
    if (repetida) {
      // O eco do WhatsApp pode chegar antes de o CRM registrar o envio: completa o que faltar
      // (arquivo local, tamanho, duração, nome) e a citação.
      let mudou = false;
      if (msg.midia && repetida.midia) {
        for (const campo of ["arquivo", "tamanho", "segundos", "nome", "ptt"]) {
          if (msg.midia[campo] && !repetida.midia[campo]) {
            repetida.midia[campo] = msg.midia[campo];
            mudou = true;
          }
        }
      }
      if (msg.origem && !repetida.origem) {
        repetida.origem = String(msg.origem).slice(0, 20);
        mudou = true;
      }
      if (msg.citacao?.id && !repetida.citacao) {
        repetida.citacao = { id: String(msg.citacao.id).slice(0, 100), texto: String(msg.citacao.texto || "").slice(0, 300) };
        mudou = true;
      }
      if (mudou) this.agendarSalvar();
      return false;
    }
    const nova_ = { id: msg.id || "", direcao: msg.direcao, texto: msg.texto || "", em: msg.em };
    if (msg.midia) nova_.midia = msg.midia;
    if (msg.origem) nova_.origem = String(msg.origem).slice(0, 20);
    if (msg.citacao?.id) nova_.citacao = { id: String(msg.citacao.id).slice(0, 100), texto: String(msg.citacao.texto || "").slice(0, 300) };
    c.mensagens.push(nova_);
    c.mensagens.sort((a, b) => a.em.localeCompare(b.em));
    if (c.mensagens.length > MAX_MENSAGENS) c.mensagens = c.mensagens.slice(-MAX_MENSAGENS);
    const ultima = c.mensagens.at(-1);
    c.ultimaEm = ultima.em;
    c.ultimaMensagem = (ultima.direcao === "saida" ? "Você: " : "") + previa(ultima).slice(0, 120);
    if (msg.direcao === "entrada" && msg.nome && !c.nome) c.nome = msg.nome;
    if (msg.telefone && !c.telefone) c.telefone = digitos(msg.telefone);
    if (nova && msg.direcao === "entrada") {
      c.naoLidas = (c.naoLidas || 0) + 1;
      // Fila de atendimento: entra na ordem de chegada e só sai quando alguém dá baixa.
      if (!c.fila) c.fila = { desde: msg.em };
    }
    if (msg.direcao === "saida") c.naoLidas = 0; // respondeu pelo celular ou pelo CRM
    this.agendarSalvar();
    return true;
  }

  /**
   * O WhatsApp revelou que o contato com número oculto (lid) é o número pn: junta as duas
   * conversas na do número, sem perder mensagens, fila, fixação ou não lidas.
   */
  unificar(lid, pn) {
    const daLid = this.mapa.get(lid);
    if (!daLid || lid === pn) return false;
    const destino = this.#garantir(pn);
    const ids = new Set(destino.mensagens.map((m) => m.id).filter(Boolean));
    destino.mensagens = [...destino.mensagens, ...daLid.mensagens.filter((m) => !m.id || !ids.has(m.id))]
      .sort((a, b) => a.em.localeCompare(b.em))
      .slice(-MAX_MENSAGENS);
    destino.nome ||= daLid.nome;
    destino.nomeContato ||= daLid.nomeContato;
    destino.jidWhatsapp ||= daLid.jidWhatsapp || lid;
    destino.naoLidas = (destino.naoLidas || 0) + (daLid.naoLidas || 0);
    destino.fixada = !!(destino.fixada || daLid.fixada);
    if (daLid.fila && (!destino.fila || daLid.fila.desde < destino.fila.desde)) destino.fila = daLid.fila;
    const ultima = destino.mensagens.at(-1);
    if (ultima && ultima.em >= (destino.ultimaEm || "")) {
      destino.ultimaEm = ultima.em;
      destino.ultimaMensagem = (ultima.direcao === "saida" ? "Você: " : "") + previa(ultima).slice(0, 120);
    } else if ((daLid.ultimaEm || "") > (destino.ultimaEm || "")) {
      destino.ultimaEm = daLid.ultimaEm;
    }
    this.mapa.delete(lid);
    this.agendarSalvar();
    return true;
  }

  /** Fixa (ou solta) a conversa no topo da lista. */
  fixar(jid, fixada) {
    const c = this.mapa.get(jid);
    if (!c) return undefined;
    c.fixada = !!fixada;
    this.agendarSalvar();
    return c;
  }

  /** Tira a conversa da fila de atendimento ("dar baixa"); ela volta para a lista normal. */
  darBaixa(jid) {
    const c = this.mapa.get(jid);
    if (!c) return undefined;
    const agora = new Date().toISOString();
    // Guarda quanto tempo esperou na fila: é o "tempo de espera" do Painel.
    if (c.fila?.desde) c.esperas = [...(c.esperas || []), { desde: c.fila.desde, baixaEm: agora }].slice(-50);
    c.fila = null;
    c.baixaEm = agora;
    this.agendarSalvar();
    return c;
  }

  /** Põe a conversa na fila de atendimento à mão (ex.: voltou a precisar de atenção). */
  colocarNaFila(jid) {
    const c = this.mapa.get(jid);
    if (!c) return undefined;
    if (!c.fila) c.fila = { desde: new Date().toISOString() };
    this.agendarSalvar();
    return c;
  }

  /** Acha uma mensagem pelo id (para servir a mídia dela). */
  mensagemPorId(id) {
    for (const c of this.mapa.values()) {
      const m = c.mensagens.find((x) => x.id === id);
      if (m) return m;
    }
    return undefined;
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
      // Fixadas primeiro; depois as mais recentes.
      .sort((a, b) => Number(!!b.fixada) - Number(!!a.fixada) || (b.ultimaEm || "").localeCompare(a.ultimaEm || ""))
      .map(({ mensagens: _m, ...resto }) => resto);
  }
}
