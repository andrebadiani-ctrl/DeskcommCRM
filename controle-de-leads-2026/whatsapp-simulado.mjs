// Modo demonstração (WA_SIMULADO=1): imita um WhatsApp conectado, com conversas de exemplo,
// para conhecer e testar o sistema sem ler QR Code nem usar um número de verdade.
// Tem a mesma interface de WhatsApp (whatsapp.mjs). Nada sai para a internet.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { crc32, deflateSync } from "node:zlib";
import { digitos } from "./store.mjs";

const minutosAtras = (n) => new Date(Date.now() - n * 60000).toISOString();

const CONVERSAS = [
  { jid: "5511991234567@s.whatsapp.net", nome: "Juliana Prado", msgs: [[180, 0, "Boa tarde! Vi o anúncio de vocês no Instagram."], [178, 0, "Vocês atendem empresas pequenas? Tenho uma loja de roupas em Campinas."], [20, 0, "Consegue me passar valores?"]] },
  { jid: "5521987650000@s.whatsapp.net", nome: "Roberto Alves", msgs: [[300, 0, "Olá, queria agendar uma demonstração"], [290, 1, "Oi Roberto! Claro, qual o melhor horário pra você?"], [45, 0, "Pode ser quinta às 14h?"]] },
  { jid: "351913334444@s.whatsapp.net", nome: "Inês Carvalho", msgs: [[1500, 0, "Bom dia, sou de Lisboa. Trabalham com empresas em Portugal?"], [1490, 1, "Bom dia, Inês! Sim, atendemos Portugal também."], [1480, 0, "Ótimo, envia-me a apresentação por favor."]] },
  { jid: "553198761234@s.whatsapp.net", nome: "Ana Ribeiro", msgs: [[60 * 30, 0, "Oi! Queria entender como funciona o sistema para clínicas."], [60 * 29, 1, "Olá, Ana! Tudo bem? Obrigado pelo contato."]] },
  { jid: "94827364519283@lid", nome: "Marcos (sem número visível)", msgs: [[95, 0, "Oi, peguei seu contato com o Pedro. Podemos falar sobre a proposta?"]] },
  { jid: "5511955554444@s.whatsapp.net", nome: "Fernanda Lima", msgs: [[2880, 1, "Fernanda, segue o link da proposta!"], [2860, 0, "Recebi, obrigada! Vou analisar com meu sócio."]] },
];

// ---- mídias de exemplo, geradas aqui mesmo (sem arquivos externos) ----
function pngDeExemplo(largura = 480, altura = 300) {
  const linhas = [];
  for (let y = 0; y < altura; y++) {
    const linha = Buffer.alloc(1 + largura * 3);
    for (let x = 0; x < largura; x++) {
      const listra = Math.floor((x + y) / 30) % 2;
      linha[1 + x * 3] = 20 + (listra ? 40 : 0);
      linha[2 + x * 3] = 90 + Math.round((y / altura) * 120);
      linha[3 + x * 3] = 60 + Math.round((x / largura) * 60);
    }
    linhas.push(linha);
  }
  const bloco = (tipo, dados) => {
    const t = Buffer.from(tipo);
    const tam = Buffer.alloc(4);
    tam.writeUInt32BE(dados.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, dados])) >>> 0);
    return Buffer.concat([tam, t, dados, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bloco("IHDR", ihdr), bloco("IDAT", deflateSync(Buffer.concat(linhas))), bloco("IEND", Buffer.alloc(0))]);
}

function wavDeExemplo(segundos = 3, taxa = 8000) {
  const n = segundos * taxa;
  const dados = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / taxa;
    const amp = Math.sin(Math.PI * (t % 0.5) / 0.5) * 9000; // "sílabas"
    dados.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * (220 + 60 * Math.sin(t * 3)) * t)), i * 2);
  }
  const cab = Buffer.alloc(44);
  cab.write("RIFF", 0); cab.writeUInt32LE(36 + dados.length, 4); cab.write("WAVE", 8); cab.write("fmt ", 12);
  cab.writeUInt32LE(16, 16); cab.writeUInt16LE(1, 20); cab.writeUInt16LE(1, 22); cab.writeUInt32LE(taxa, 24);
  cab.writeUInt32LE(taxa * 2, 28); cab.writeUInt16LE(2, 32); cab.writeUInt16LE(16, 34); cab.write("data", 36); cab.writeUInt32LE(dados.length, 40);
  return Buffer.concat([cab, dados]);
}

function pdfDeExemplo() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const texto = "BT /F1 24 Tf 72 760 Td (Apresentacao - Atlantico Turismo) Tj 0 -40 Td /F1 14 Tf (Documento de exemplo do modo demonstracao.) Tj ET";
  objs[3] = `<< /Length ${texto.length} >>\nstream\n${texto}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const posicoes = [];
  objs.forEach((o, i) => { posicoes.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + posicoes.map((p) => `${String(p).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const AMOSTRAS = {
  foto: () => pngDeExemplo(),
  audio: () => wavDeExemplo(),
  pdf: () => pdfDeExemplo(),
};

// Mensagens com mídia de exemplo (jid, minutos atrás, dados).
const MIDIAS = [
  ["5511991234567@s.whatsapp.net", 176, { texto: "Essa é a fachada da loja", midia: { tipo: "imagem", mimetype: "image/png", nome: "", amostra: "foto" } }],
  ["5521987650000@s.whatsapp.net", 44, { texto: "", midia: { tipo: "audio", mimetype: "audio/wav", nome: "", segundos: 3, ptt: true, amostra: "audio" } }],
  ["351913334444@s.whatsapp.net", 1485, { texto: "Segue a nossa apresentação", midia: { tipo: "documento", mimetype: "application/pdf", nome: "apresentacao-atlantico.pdf", amostra: "pdf" } }],
];

const RESPOSTAS = ["Perfeito, obrigado!", "Combinado 👍", "Vou ver aqui e te retorno.", "Pode me mandar mais detalhes?"];

export class WhatsAppSimulado extends EventEmitter {
  constructor() {
    super();
    this.status = "desconectado";
    this.conta = null;
  }

  estado() {
    return { status: this.status, qr: null, conta: this.conta, erro: null, simulado: true, diagnostico: this.diag || null };
  }

  async iniciarSeHouverSessao() {
    await this.conectar();
  }

  async conectar() {
    if (this.status === "conectado") return;
    this.status = "conectado";
    this.conta = { numero: "5511900000000", nome: "Demonstração" };
    this.diag = { conectadoEm: new Date().toISOString(), lotesHistorico: 1, conversasRecebidas: CONVERSAS.length, mensagensHistorico: 0, mensagensAoVivo: 0, semConteudo: 0, naoDescriptografadas: 0, ultimaMensagemEm: "", ultimoErro: "" };
    this.emit("estado", this.estado());
    // Igual ao WhatsApp real: depois de conectar chega o histórico recente.
    setTimeout(() => {
      for (const c of CONVERSAS) {
        this.emit("conversa", { jid: c.jid, nome: c.nome, telefone: c.jid.endsWith("@s.whatsapp.net") ? digitos(c.jid) : "" });
        for (const [min, deMim, texto] of c.msgs) {
          this.#mensagem(c.jid, { texto, fromMe: !!deMim, nome: deMim ? "" : c.nome, em: minutosAtras(min), historico: true });
        }
      }
      for (const [jid, min, { texto, midia }] of MIDIAS) {
        const { amostra, ...descricao } = midia;
        const tamanho = AMOSTRAS[amostra]().length;
        this.#mensagem(jid, { texto, midia: { ...descricao, tamanho, wa: { simulado: amostra } }, nome: CONVERSAS.find((c) => c.jid === jid)?.nome || "", em: minutosAtras(min), historico: true });
      }
      // Mensagens que chegam "agora" (não lidas): entram na fila de atendimento por ordem de chegada.
      const nome = (jid) => CONVERSAS.find((c) => c.jid === jid)?.nome || "";
      this.#mensagem("5521987650000@s.whatsapp.net", { texto: "Alguém pode confirmar quinta às 14h?", nome: nome("5521987650000@s.whatsapp.net"), em: minutosAtras(18), nova: true });
      this.#mensagem("351913334444@s.whatsapp.net", { texto: "Bom dia! Ainda aguardo a apresentação 🙂", nome: nome("351913334444@s.whatsapp.net"), em: minutosAtras(9), nova: true });
      this.#mensagem(CONVERSAS[0].jid, { texto: "Oi? 😊", nome: CONVERSAS[0].nome, nova: true });
    }, 300);
  }

  #mensagem(jid, { texto, midia = null, fromMe = false, nome = "", em = new Date().toISOString(), nova = false, historico = false, id = randomUUID() }) {
    if (this.diag) {
      if (historico) this.diag.mensagensHistorico += 1;
      else this.diag.mensagensAoVivo += 1;
      this.diag.ultimaMensagemEm = new Date().toISOString();
    }
    this.emit("mensagem", { jid, id, fromMe, telefone: jid.endsWith("@s.whatsapp.net") ? digitos(jid.split("@")[0]) : "", nome, texto, midia, em, nova, historico });
  }

  // Como o WhatsApp real: o pedido sai na hora e as mensagens antigas chegam um pouco depois.
  async pedirAnteriores(jidWhatsapp, _chave, emIso) {
    if (this.status !== "conectado") throw new Error("WhatsApp não está conectado");
    const nome = CONVERSAS.find((c) => c.jid === jidWhatsapp)?.nome || "";
    const base = new Date(emIso).getTime();
    setTimeout(() => {
      ["Bom dia! Tudo bem?", "Vi o site de vocês ontem", "Queria tirar umas dúvidas"].forEach((texto, i) =>
        this.#mensagem(jidWhatsapp, { texto, nome, em: new Date(base - (3 - i) * 3600_000 - 86400_000).toISOString(), historico: true }),
      );
    }, 800);
  }

  async baixarMidia(wa) {
    const gerar = AMOSTRAS[wa?.simulado];
    if (!gerar) throw new Error("mídia expirada");
    await new Promise((r) => setTimeout(r, 300)); // simula o download
    return gerar();
  }

  async enviarMidiaParaJid(jid, { mimetype, nome, legenda }) {
    if (this.status !== "conectado") throw new Error("WhatsApp não está conectado");
    const { tipoDeEnvio } = await import("./whatsapp.mjs");
    const tipo = tipoDeEnvio(mimetype);
    const id = randomUUID();
    const em = new Date().toISOString();
    // Eco, como o WhatsApp real: chega antes de o CRM registrar o envio (sem o arquivo local).
    this.#mensagem(jid, { texto: legenda || "", fromMe: true, em, id, midia: { tipo, mimetype, nome, tamanho: 0, wa: { simulado: "eco" } } });
    return { jid, id, em, tipo };
  }

  parar() {
    this.status = "desconectado";
    this.emit("estado", this.estado());
  }

  async desconectar() {
    this.conta = null;
    this.parar();
  }

  async enviar(telefone, texto) {
    const numero = digitos(telefone);
    if (numero.length < 10) throw new Error("Telefone inválido para WhatsApp");
    return this.enviarParaJid(`${numero}@s.whatsapp.net`, texto);
  }

  enviarParaLead(lead, texto) {
    return lead.whatsappJid ? this.enviarParaJid(lead.whatsappJid, texto) : this.enviar(lead.telefone, texto);
  }

  async enviarParaJid(jid, texto) {
    if (this.status !== "conectado") throw new Error("WhatsApp não está conectado");
    const id = randomUUID();
    const em = new Date().toISOString();
    // O WhatsApp real devolve o eco da mensagem enviada; o sistema desduplica pelo id.
    this.#mensagem(jid, { texto, fromMe: true, em, id });
    const nome = CONVERSAS.find((c) => c.jid === jid)?.nome || "";
    setTimeout(() => this.#mensagem(jid, { texto: RESPOSTAS[Math.floor(Math.random() * RESPOSTAS.length)], nome, nova: true }), 4000);
    return { jid, id, em };
  }
}
