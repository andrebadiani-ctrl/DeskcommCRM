// Modo demonstração (WA_SIMULADO=1): imita um WhatsApp conectado, com conversas de exemplo,
// para conhecer e testar o sistema sem ler QR Code nem usar um número de verdade.
// Tem a mesma interface de WhatsApp (whatsapp.mjs). Nada sai para a internet.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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

const RESPOSTAS = ["Perfeito, obrigado!", "Combinado 👍", "Vou ver aqui e te retorno.", "Pode me mandar mais detalhes?"];

export class WhatsAppSimulado extends EventEmitter {
  constructor() {
    super();
    this.status = "desconectado";
    this.conta = null;
  }

  estado() {
    return { status: this.status, qr: null, conta: this.conta, erro: null, simulado: true };
  }

  async iniciarSeHouverSessao() {
    await this.conectar();
  }

  async conectar() {
    if (this.status === "conectado") return;
    this.status = "conectado";
    this.conta = { numero: "5511900000000", nome: "Demonstração" };
    this.emit("estado", this.estado());
    // Igual ao WhatsApp real: depois de conectar chega o histórico recente.
    setTimeout(() => {
      for (const c of CONVERSAS) {
        this.emit("conversa", { jid: c.jid, nome: c.nome, telefone: c.jid.endsWith("@s.whatsapp.net") ? digitos(c.jid) : "" });
        for (const [min, deMim, texto] of c.msgs) {
          this.#mensagem(c.jid, { texto, fromMe: !!deMim, nome: deMim ? "" : c.nome, em: minutosAtras(min), historico: true });
        }
      }
      // A conversa mais recente chega "agora", como não lida.
      this.#mensagem(CONVERSAS[0].jid, { texto: "Oi? 😊", nome: CONVERSAS[0].nome, nova: true });
    }, 300);
  }

  #mensagem(jid, { texto, fromMe = false, nome = "", em = new Date().toISOString(), nova = false, historico = false, id = randomUUID() }) {
    this.emit("mensagem", { jid, id, fromMe, telefone: jid.endsWith("@s.whatsapp.net") ? digitos(jid.split("@")[0]) : "", nome, texto, em, nova, historico });
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
