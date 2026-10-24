// Integração com o WhatsApp (WhatsApp Web multi-device via Baileys), login por QR Code.
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { digitos } from "./store.mjs";

const logger = pino({ level: process.env.WA_LOG_LEVEL || "silent" });

function textoDaMensagem(m) {
  const msg = m.message || {};
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.fileName ||
    (msg.audioMessage && "[áudio]") ||
    (msg.imageMessage && "[imagem]") ||
    (msg.videoMessage && "[vídeo]") ||
    (msg.stickerMessage && "[figurinha]") ||
    (msg.locationMessage && "[localização]") ||
    (msg.contactMessage && "[contato]") ||
    null
  );
}

export class WhatsApp extends EventEmitter {
  constructor(dir) {
    super();
    this.authDir = path.join(dir, "whatsapp-auth");
    this.sock = null;
    this.status = "desconectado"; // desconectado | conectando | aguardando_qr | conectado | reconectando
    this.qr = null;
    this.conta = null;
    this.erro = null;
    this.parado = true;
    this.tentativas = 0;
  }

  estado() {
    return { status: this.status, qr: this.qr, conta: this.conta, erro: this.erro };
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
      logger,
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
        this.#mudar({
          status: "reconectando",
          qr: null,
          erro: `Sem conexão com o WhatsApp${codigo ? ` (código ${codigo})` : ""}. Nova tentativa em ${Math.round(espera / 1000)}s…`,
        });
        setTimeout(() => !this.parado && this.conectar(), espera);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        const jid = m.key?.remoteJid || "";
        if (!jid || m.key.fromMe) continue;
        if (jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
        // Endereçamento por LID esconde o número; o Baileys expõe o número real em senderPn.
        const jidNumero = jid.endsWith("@lid") ? m.key.senderPn || "" : jid;
        const telefone = digitos(jidNumero.split("@")[0].split(":")[0]);
        const texto = textoDaMensagem(m);
        if (!telefone || !texto) continue;
        this.emit("mensagem", {
          telefone,
          nome: m.pushName || "",
          texto,
          em: new Date(Number(m.messageTimestamp || Date.now() / 1000) * 1000).toISOString(),
        });
      }
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
    await this.sock.sendMessage(resultado.jid, { text: texto });
    return numero;
  }
}
