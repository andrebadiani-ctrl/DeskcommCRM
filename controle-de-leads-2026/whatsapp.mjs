// Integração com o WhatsApp (WhatsApp Web multi-device via Baileys), login por QR Code.
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, statSync, truncateSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { ehConversaIndividual, telefoneDoJid } from "./conversas.mjs";
import { digitos } from "./store.mjs";

const ehPn = (jid) => String(jid || "").endsWith("@s.whatsapp.net");
const ehLid = (jid) => String(jid || "").endsWith("@lid");
const STUB_CIPHERTEXT = 2; // mensagem que chegou mas não pôde ser descriptografada

// Mensagens temporárias / de visualização única vêm embrulhadas.
function desembrulhar(bruta = {}) {
  return (
    bruta.ephemeralMessage?.message ||
    bruta.viewOnceMessage?.message ||
    bruta.viewOnceMessageV2?.message ||
    bruta.viewOnceMessageV2Extension?.message ||
    bruta.documentWithCaptionMessage?.message ||
    bruta
  );
}

const numero = (v) => Number(v?.toString?.() ?? v ?? 0) || 0; // fileLength pode vir como Long

/** Texto e, se houver, a mídia (foto, vídeo, áudio, documento, figurinha) de uma mensagem. */
function conteudoDaMensagem(m) {
  const msg = desembrulhar(m.message || {});
  const midia = (tipo, c, extra = {}) => ({
    tipo,
    mimetype: String(c.mimetype || "").split(";")[0].trim(),
    nome: c.fileName || c.title || "",
    tamanho: numero(c.fileLength),
    segundos: numero(c.seconds),
    ...extra,
  });
  if (msg.imageMessage) return { texto: msg.imageMessage.caption || "", midia: midia("imagem", msg.imageMessage) };
  if (msg.videoMessage) return { texto: msg.videoMessage.caption || "", midia: midia("video", msg.videoMessage) };
  if (msg.audioMessage) return { texto: "", midia: midia("audio", msg.audioMessage, { ptt: !!msg.audioMessage.ptt }) };
  if (msg.documentMessage) return { texto: msg.documentMessage.caption || "", midia: midia("documento", msg.documentMessage) };
  if (msg.stickerMessage) return { texto: "", midia: midia("figurinha", msg.stickerMessage) };
  const texto =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    (msg.locationMessage && `📍 Localização: https://maps.google.com/?q=${msg.locationMessage.degreesLatitude},${msg.locationMessage.degreesLongitude}`) ||
    (msg.contactMessage && `👤 Contato: ${msg.contactMessage.displayName || ""}`) ||
    "";
  return { texto, midia: null };
}

/** Como a mídia vai para o WhatsApp: formatos que o celular reproduz; o resto vai como documento. */
export function tipoDeEnvio(mimetype) {
  if (/^image\/(jpeg|png|webp)$/.test(mimetype)) return "imagem";
  if (mimetype === "video/mp4") return "video";
  if (/^audio\/(ogg|mpeg|mp4|aac)$/.test(mimetype)) return "audio";
  return "documento";
}

export class WhatsApp extends EventEmitter {
  constructor(dir) {
    super();
    this.authDir = path.join(dir, "whatsapp-auth");
    // LID (contato com número oculto) → JID com o número. Vem dos contatos, das mensagens e do
    // mapa que o próprio WhatsApp manda; serve para não ter a mesma pessoa em duas conversas.
    this.lidParaPn = new Map();
    this.diag = this.#diagZerado();
    this.logger = this.#criarLogger(path.join(dir, "whatsapp.log"));
    this.sock = null;
    this.status = "desconectado"; // desconectado | conectando | aguardando_qr | conectado | reconectando
    this.qr = null;
    this.conta = null;
    this.erro = null;
    this.parado = true;
    this.tentativas = 0;
  }

  estado() {
    return { status: this.status, qr: this.qr, conta: this.conta, erro: this.erro, diagnostico: this.diag };
  }

  #diagZerado() {
    return { conectadoEm: "", lotesHistorico: 0, conversasRecebidas: 0, mensagensHistorico: 0, mensagensAoVivo: 0, semConteudo: 0, naoDescriptografadas: 0, ultimaMensagemEm: "", ultimoErro: "" };
  }

  /** Registro da biblioteca em data/whatsapp.log (avisos e erros); o último erro aparece na tela. */
  #criarLogger(arquivo) {
    try {
      if (existsSync(arquivo) && statSync(arquivo).size > 5 * 1024 * 1024) truncateSync(arquivo, 0);
    } catch {
      /* sem permissão: segue sem truncar */
    }
    const saida = createWriteStream(arquivo, { flags: "a" });
    saida.on("error", () => {});
    const destino = {
      write: (linha) => {
        saida.write(linha);
        try {
          const j = JSON.parse(linha);
          if (j.level >= 50) this.diag.ultimoErro = `${new Date(j.time).toLocaleString("pt-BR")}: ${String(j.msg || j.err?.message || "erro").slice(0, 200)}`;
        } catch {
          /* linha que não é JSON */
        }
      },
    };
    return pino({ level: process.env.WA_LOG_LEVEL || "warn" }, destino);
  }

  /** Aprende que um LID é o mesmo contato de um número; avisa para juntar as conversas. */
  #aprender(lid, pn) {
    if (!ehLid(lid) || !ehPn(pn)) return;
    const numero = jidNormalizedUser(pn);
    if (this.lidParaPn.get(lid) === numero) return;
    this.lidParaPn.set(lid, numero);
    this.emit("unificar", { lid, pn: numero });
  }

  /** JID da conversa: o do número quando ele é conhecido, senão o LID. */
  #canonico(jid) {
    return ehLid(jid) ? this.lidParaPn.get(jid) || jid : jid;
  }

  #mudar(campos) {
    Object.assign(this, campos);
    this.emit("estado", this.estado());
  }

  /** Reconecta sozinho se já existe sessão salva. */
  async iniciarSeHouverSessao() {
    const arquivo = path.join(this.authDir, "creds.json");
    if (!existsSync(arquivo)) return;
    // creds.json nasce já no primeiro QR; só há sessão de verdade depois da leitura (`me`).
    const creds = JSON.parse(await readFile(arquivo, "utf8").catch(() => "{}"));
    if (creds.me) await this.conectar();
  }

  /** Interrompe a conexão/reconexão sem apagar a sessão salva. */
  parar() {
    this.parado = true;
    const sock = this.sock;
    this.sock = null;
    sock?.end(undefined);
    this.#mudar({ status: "desconectado", qr: null, erro: null });
  }

  async conectar() {
    if (this.sock) return;
    this.parado = false;
    this.#mudar({ status: this.status === "reconectando" ? "reconectando" : "conectando", erro: null });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger,
      browser: Browsers.ubuntu("Controle de Leads 2026"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      if (u.qr) {
        const qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 300, color: { dark: "#0b3324", light: "#ffffff" } });
        this.#mudar({ status: "aguardando_qr", qr });
      }
      if (u.connection === "open") {
        this.tentativas = 0;
        this.diag.conectadoEm = new Date().toISOString();
        const id = sock.user?.id || "";
        this.#mudar({
          status: "conectado",
          qr: null,
          erro: null,
          conta: { numero: digitos(id.split(":")[0].split("@")[0]), nome: sock.user?.name || "" },
        });
      }
      if (u.connection === "close") {
        const codigo = u.lastDisconnect?.error?.output?.statusCode;
        const estavaNoQr = this.status === "aguardando_qr";
        this.sock = null;
        sock.ev.removeAllListeners();

        if (this.parado) return;
        if (codigo === DisconnectReason.loggedOut) {
          await rm(this.authDir, { recursive: true, force: true });
          this.parado = true;
          this.#mudar({ status: "desconectado", qr: null, conta: null, erro: "Sessão encerrada pelo celular. Gere um novo QR Code." });
          return;
        }
        if (codigo === DisconnectReason.restartRequired) {
          // Acontece logo após ler o QR: o WhatsApp pede para reabrir a conexão.
          this.conectar();
          return;
        }
        if (estavaNoQr && codigo === DisconnectReason.timedOut) {
          this.parado = true;
          this.#mudar({ status: "desconectado", qr: null, erro: "O QR Code expirou. Clique em “Gerar QR Code” para tentar de novo." });
          return;
        }
        this.tentativas += 1;
        const espera = Math.min(30000, 2000 * this.tentativas);
        this.diag.ultimoErro = `${new Date().toLocaleString("pt-BR")}: conexão caiu${codigo ? ` (código ${codigo})` : ""}; reconectando`;
        this.#mudar({
          status: "reconectando",
          qr: null,
          erro: `Sem conexão com o WhatsApp${codigo ? ` (código ${codigo})` : ""}. Nova tentativa em ${Math.round(espera / 1000)}s…`,
        });
        setTimeout(() => !this.parado && this.conectar(), espera);
      }
    });

    this.ligarEventos(sock);
  }

  /**
   * Traduz os eventos da biblioteca (histórico, contatos, conversas, mensagens, mapa LID↔número)
   * em "conversa", "mensagem" e "unificar". Separado de conectar() para poder ser testado com
   * eventos de mentira no mesmo formato.
   */
  ligarEventos(sock) {
    const emData = (ts) => new Date(Number(ts || Date.now() / 1000) * 1000).toISOString();
    const avisarMensagem = (m, tipo) => {
      const jidOriginal = m.key?.remoteJid || "";
      if (!ehConversaIndividual(jidOriginal)) return; // grupos, status e canais ficam de fora
      // O WhatsApp manda o outro endereço do mesmo contato em remoteJidAlt (ou senderPn).
      const alternativo = m.key.remoteJidAlt || m.key.senderPn || "";
      if (ehLid(jidOriginal)) this.#aprender(jidOriginal, alternativo);
      else if (ehLid(alternativo)) this.#aprender(alternativo, jidOriginal);
      if (ehLid(jidOriginal) && !this.lidParaPn.has(jidOriginal)) this.#descobrirNumero(jidOriginal);

      if (m.messageStubType === STUB_CIPHERTEXT) {
        this.diag.naoDescriptografadas += 1;
        this.logger.warn({ jid: jidOriginal, motivo: m.messageStubParameters?.[0] }, "mensagem não descriptografada");
        return;
      }
      const { texto, midia } = conteudoDaMensagem(m);
      if (!texto && !midia) {
        this.diag.semConteudo += 1; // reações, edições, avisos do sistema…
        return;
      }
      const jid = this.#canonico(jidOriginal);
      if (tipo === "historico") this.diag.mensagensHistorico += 1;
      else this.diag.mensagensAoVivo += 1;
      this.diag.ultimaMensagemEm = new Date().toISOString();
      this.emit("mensagem", {
        jid,
        jidWhatsapp: jidOriginal, // o endereço que o WhatsApp usa nesta conversa (para pedir histórico)
        id: m.key.id || "",
        fromMe: !!m.key.fromMe,
        telefone: telefoneDoJid(jid),
        nome: m.key.fromMe ? "" : m.pushName || "",
        texto,
        // Guarda a mensagem original (com as chaves da mídia) para baixar o arquivo quando abrirem.
        midia: midia ? { ...midia, wa: JSON.parse(JSON.stringify({ key: m.key, message: m.message }, BufferJSON.replacer)) } : null,
        em: emData(m.messageTimestamp),
        nova: tipo === "notify", // chegou agora (conta como não lida)
        historico: tipo === "historico", // sincronização: só preenche a caixa de entrada
      });
    };
    const avisarContato = (c) => {
      // v7: id (LID ou número), lid, phoneNumber. v6: id, lid, jid.
      const pn = [c.phoneNumber, c.jid, c.id].find(ehPn);
      const lid = [c.lid, c.id].find(ehLid);
      if (pn && lid) this.#aprender(lid, pn);
      const jid = pn ? jidNormalizedUser(pn) : lid;
      if (!jid) return;
      this.emit("conversa", { jid, nome: c.notify || c.verifiedName || "", nomeContato: c.name || "", telefone: telefoneDoJid(jid) });
    };
    const avisarChat = (c) => {
      if (!ehConversaIndividual(c.id)) return;
      if (ehLid(c.id) && c.pnJid) this.#aprender(c.id, c.pnJid);
      this.diag.conversasRecebidas += 1;
      const jid = this.#canonico(c.id);
      this.emit("conversa", {
        jid,
        jidWhatsapp: c.id,
        nome: c.name || "",
        naoLidas: typeof c.unreadCount === "number" ? c.unreadCount : undefined,
        ultimaEm: c.conversationTimestamp ? emData(c.conversationTimestamp) : "",
      });
    };

    // Ao conectar, o WhatsApp manda o histórico recente: conversas, contatos e mensagens.
    // Contatos primeiro: eles ensinam quais LIDs são quais números.
    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      this.diag.lotesHistorico += 1;
      (contacts || []).forEach(avisarContato);
      (chats || []).forEach(avisarChat);
      (messages || []).forEach((m) => avisarMensagem(m, "historico"));
    });
    sock.ev.on("contacts.upsert", (cs) => cs.forEach(avisarContato));
    sock.ev.on("contacts.update", (cs) => cs.forEach((c) => c.id && avisarContato(c)));
    sock.ev.on("chats.upsert", (cs) => cs.forEach(avisarChat));
    sock.ev.on("lid-mapping.update", (mapa) => [].concat(mapa || []).forEach((x) => this.#aprender(x?.lid, x?.pn)));

    // notify = chegou agora; append = enviada por outro aparelho / pelo próprio CRM / histórico.
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const m of messages) avisarMensagem(m, type === "notify" ? "notify" : "append");
    });
  }

  async desconectar() {
    this.parado = true;
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        await sock.logout();
      } catch {
        sock.end(undefined);
      }
    }
    await rm(this.authDir, { recursive: true, force: true });
    this.#mudar({ status: "desconectado", qr: null, conta: null, erro: null });
  }

  /** Envia texto para um telefone (com ou sem DDI; `pais` ajuda a completar o DDI). */
  async enviar(telefone, texto, pais = "") {
    if (this.status !== "conectado" || !this.sock) throw new Error("WhatsApp não está conectado");
    let numero = digitos(telefone);
    if (pais === "Brasil" && (numero.length === 10 || numero.length === 11)) numero = "55" + numero;
    if (pais === "Portugal" && numero.length === 9) numero = "351" + numero;
    if (numero.length < 10) throw new Error("Telefone inválido para WhatsApp");
    const [resultado] = await this.sock.onWhatsApp(numero);
    if (!resultado?.exists) throw new Error("Este número não tem WhatsApp");
    return this.enviarParaJid(resultado.jid, texto);
  }

  /** Envia para um lead: pela conversa ligada a ele, se houver; senão pelo telefone. */
  enviarParaLead(lead, texto) {
    if (lead.whatsappJid) return this.enviarParaJid(lead.whatsappJid, texto);
    return this.enviar(lead.telefone, texto, lead.pais);
  }

  /** Pergunta ao WhatsApp o número de um LID desconhecido (sem travar o recebimento). */
  #descobrirNumero(lid) {
    const mapa = this.sock?.signalRepository?.lidMapping;
    if (!mapa?.getPNForLID) return;
    mapa.getPNForLID(lid).then((pn) => pn && this.#aprender(lid, pn)).catch(() => {});
  }

  /**
   * Pede ao celular mensagens mais antigas de uma conversa. Elas chegam depois, pelo mesmo
   * caminho do histórico (messaging-history.set). `chave` = a mensagem mais antiga que já temos.
   */
  async pedirAnteriores(jidWhatsapp, chave, emIso) {
    if (this.status !== "conectado" || !this.sock) throw new Error("WhatsApp não está conectado");
    const segundos = Math.floor(new Date(emIso).getTime() / 1000);
    await this.sock.fetchMessageHistory(50, { remoteJid: jidWhatsapp, id: chave.id, fromMe: chave.fromMe }, segundos);
  }

  /** Baixa a mídia de uma mensagem guardada; devolve um stream com o arquivo. */
  async baixarMidia(wa) {
    const msg = JSON.parse(JSON.stringify(wa), BufferJSON.reviver);
    const sock = this.sock;
    // Mídia antiga some do servidor do WhatsApp; com o celular conectado ele reenvia (reupload).
    const ctx = sock ? { reuploadRequest: sock.updateMediaMessage, logger: this.logger } : undefined;
    return downloadMediaMessage(msg, "stream", {}, ctx);
  }

  /** Envia um arquivo (foto, vídeo, áudio ou documento) para uma conversa. */
  async enviarMidiaParaJid(jid, { caminho, mimetype, nome, legenda }) {
    if (this.status !== "conectado" || !this.sock) throw new Error("WhatsApp não está conectado");
    if (!ehConversaIndividual(jid)) throw new Error("Conversa inválida");
    const tipo = tipoDeEnvio(mimetype);
    const arquivo = { url: caminho };
    const conteudo =
      tipo === "imagem" ? { image: arquivo, caption: legenda || undefined }
      : tipo === "video" ? { video: arquivo, caption: legenda || undefined, mimetype }
      : tipo === "audio" ? { audio: arquivo, mimetype }
      : { document: arquivo, mimetype: mimetype || "application/octet-stream", fileName: nome || "arquivo", caption: legenda || undefined };
    const enviada = await this.sock.sendMessage(jid, conteudo);
    return { jid, id: enviada?.key?.id || "", em: new Date().toISOString(), tipo };
  }

  /** Envia direto para uma conversa (serve também para contatos anônimos @lid). */
  async enviarParaJid(jid, texto) {
    if (this.status !== "conectado" || !this.sock) throw new Error("WhatsApp não está conectado");
    if (!ehConversaIndividual(jid)) throw new Error("Conversa inválida");
    const enviada = await this.sock.sendMessage(jid, { text: texto });
    return { jid, id: enviada?.key?.id || "", em: new Date().toISOString() };
  }
}
