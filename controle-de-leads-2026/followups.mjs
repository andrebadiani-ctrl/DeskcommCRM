// Follow-ups: mensagens agendadas por lead, nascidas das regras de cada etapa do Kanban
// (automáticas) ou criadas à mão no lead (manuais). Um laço verifica os vencidos e envia pelo WhatsApp.
import { randomUUID } from "node:crypto";
import { ErroValidacao, preencherVariaveis } from "./store.mjs";

const INTERVALO_MS = 30_000; // de quanto em quanto tempo procura follow-ups vencidos
const POR_RODADA = 10; // teto de envios por rodada
const ESPACO_MS = [4000, 7000]; // pausa entre dois envios (anti-bloqueio)
const NOVA_TENTATIVA_MS = 10 * 60_000;
const MAX_TENTATIVAS = 3;
const MANTER_HISTORICO = 30; // follow-ups encerrados guardados por lead

// Pedidos de descadastro: mensagem inteira igual a uma destas palavras.
const PALAVRAS_DE_SAIDA = ["parar", "pare", "sair", "stop", "cancelar", "descadastrar", "nao quero mais", "não quero mais"];
const normalizar = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
export const ehPedidoDeSaida = (texto) => PALAVRAS_DE_SAIDA.map(normalizar).includes(normalizar(texto).replace(/[.!]+$/, ""));

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const FUSO = process.env.TZ || "America/Sao_Paulo";

function horaLocal(data = new Date()) {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: FUSO, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(data);
  const h = Number(partes.find((p) => p.type === "hour").value);
  const m = Number(partes.find((p) => p.type === "minute").value);
  return h + m / 60;
}

export class Followups {
  constructor(store, whatsapp, avisar) {
    this.store = store;
    this.whatsapp = whatsapp;
    this.avisar = avisar; // (idDoLead) => void — avisa as telas abertas
    this.rodando = false;

    store.on("etapa", (lead, anterior) => this.aoMudarEtapa(lead, anterior));
    store.on("config", (colecao, regra) => colecao === "regras" && this.aoMudarRegra(regra));
  }

  iniciar() {
    this.timer = setInterval(() => this.rodada().catch((e) => console.error("Follow-ups:", e)), INTERVALO_MS);
    this.timer.unref?.();
  }

  dentroDaJanela() {
    const { inicio, fim } = this.store.config.janela || { inicio: 0, fim: 24 };
    const h = horaLocal();
    return h >= inicio && h < fim;
  }

  #encerrar(f, status, motivo) {
    f.status = status;
    f.motivo = motivo || "";
    f.encerradoEm = new Date().toISOString();
  }

  #podar(lead) {
    const pendentes = lead.followups.filter((f) => f.status === "pendente");
    const encerrados = lead.followups.filter((f) => f.status !== "pendente").slice(-MANTER_HISTORICO);
    lead.followups = [...encerrados, ...pendentes];
  }

  /** Lead entrou numa etapa: cancela os automáticos da etapa antiga e agenda os da nova. (síncrono) */
  aoMudarEtapa(lead, anterior) {
    lead.followups ||= [];
    const agora = Date.now();
    for (const f of lead.followups) {
      if (f.status === "pendente" && f.origem === "regra" && f.etapa !== lead.etapa) {
        this.#encerrar(f, "cancelado", `Lead saiu da etapa ${f.etapa}${anterior ? ` para ${lead.etapa}` : ""}`);
      }
    }
    for (const regra of this.store.config.regrasFollowup) {
      if (!regra.ativo || regra.etapa !== lead.etapa) continue;
      lead.followups.push({
        id: randomUUID(),
        origem: "regra",
        regraId: regra.id,
        etapa: lead.etapa,
        agendadoPara: new Date(agora + regra.aposMinutos * 60_000).toISOString(),
        status: "pendente",
        tentativas: 0,
        criadoEm: new Date(agora).toISOString(),
      });
    }
    this.#podar(lead);
  }

  /** Regra pausada, editada ou excluída: ajusta os follow-ups pendentes que vieram dela. */
  aoMudarRegra(regra) {
    const encerrar = regra.excluido || !regra.ativo;
    let mexeu = false;
    for (const lead of this.store.listar()) {
      for (const f of lead.followups || []) {
        if (f.status !== "pendente" || f.regraId !== regra.id) continue;
        if (encerrar) {
          this.#encerrar(f, "cancelado", regra.excluido ? "Regra excluída" : "Regra pausada");
        } else {
          // Tempo de espera mudou: reagenda a partir de quando o follow-up foi criado.
          f.agendadoPara = new Date(new Date(f.criadoEm).getTime() + regra.aposMinutos * 60_000).toISOString();
        }
        mexeu = true;
      }
    }
    if (mexeu) this.avisar(null);
  }

  /** Mensagem recebida do lead: cancela o que deve parar quando ele responde. (síncrono) */
  aoReceberMensagem(lead, msg) {
    lead.followups ||= [];
    if (ehPedidoDeSaida(msg.texto)) {
      lead.optOut = true;
      for (const f of lead.followups) if (f.status === "pendente") this.#encerrar(f, "cancelado", "Lead pediu para não receber mensagens");
      return;
    }
    const recebidaEm = new Date(msg.em).getTime();
    for (const f of lead.followups) {
      if (f.status !== "pendente" || recebidaEm <= new Date(f.criadoEm).getTime()) continue;
      const regra = f.regraId ? this.store.config.regrasFollowup.find((r) => r.id === f.regraId) : null;
      const cancela = f.origem === "regra" ? regra?.cancelarSeResponder !== false : f.cancelarSeResponder;
      if (cancela) this.#encerrar(f, "cancelado", "Lead respondeu");
    }
  }

  // ---- follow-up manual ----
  async agendar(leadId, { texto, agendadoPara, cancelarSeResponder = true }) {
    const lead = this.store.obter(leadId);
    if (!lead) return undefined;
    const t = String(texto || "").trim();
    if (!t) throw new ErroValidacao("Escreva a mensagem do follow-up");
    const quando = new Date(agendadoPara);
    if (Number.isNaN(quando.getTime())) throw new ErroValidacao("Data e hora do follow-up inválidas");
    if (quando.getTime() < Date.now() - 60_000) throw new ErroValidacao("Escolha uma data e hora no futuro");
    if (!lead.telefone && !lead.whatsappJid) throw new ErroValidacao("Lead sem telefone");
    lead.followups ||= [];
    lead.followups.push({
      id: randomUUID(),
      origem: "manual",
      texto: t.slice(0, 4000),
      etapa: lead.etapa,
      agendadoPara: quando.toISOString(),
      cancelarSeResponder: cancelarSeResponder !== false,
      status: "pendente",
      tentativas: 0,
      criadoEm: new Date().toISOString(),
    });
    await this.store.salvar();
    return lead;
  }

  async cancelar(leadId, followupId) {
    const lead = this.store.obter(leadId);
    const f = lead?.followups?.find((x) => x.id === followupId && x.status === "pendente");
    if (!f) return undefined;
    this.#encerrar(f, "cancelado", "Cancelado manualmente");
    await this.store.salvar();
    return lead;
  }

  async enviarAgora(leadId, followupId) {
    const lead = this.store.obter(leadId);
    const f = lead?.followups?.find((x) => x.id === followupId && x.status === "pendente");
    if (!f) return undefined;
    await this.#enviar(lead, f, { manual: true });
    if (f.status !== "enviado") throw new Error(f.motivo || "Não foi possível enviar");
    return lead;
  }

  // ---- envio ----
  async #enviar(lead, f, { manual = false } = {}) {
    const regra = f.regraId ? this.store.config.regrasFollowup.find((r) => r.id === f.regraId) : null;
    if (f.origem === "regra") {
      if (!regra || !regra.ativo) return this.#encerrar(f, "cancelado", regra ? "Regra pausada" : "Regra excluída");
      if (lead.etapa !== f.etapa) return this.#encerrar(f, "cancelado", `Lead saiu da etapa ${f.etapa}`);
    }
    if (lead.optOut && !manual) return this.#encerrar(f, "cancelado", "Lead pediu para não receber mensagens");
    if (!lead.telefone && !lead.whatsappJid) return this.#encerrar(f, "falhou", "Lead sem telefone");

    const texto = preencherVariaveis(regra ? regra.texto : f.texto, lead);
    let enviada;
    try {
      enviada = await this.whatsapp.enviarParaLead(lead, texto);
    } catch (e) {
      f.motivo = e.message;
      if (/não tem WhatsApp|Telefone inválido/.test(e.message)) {
        this.#encerrar(f, "falhou", e.message); // não adianta tentar de novo
      } else if (!manual) {
        f.tentativas = (f.tentativas || 0) + 1;
        if (f.tentativas >= MAX_TENTATIVAS) this.#encerrar(f, "falhou", e.message);
        else f.agendadoPara = new Date(Date.now() + NOVA_TENTATIVA_MS).toISOString();
      }
      await this.store.salvar();
      this.avisar(lead.id);
      return;
    }

    f.texto = texto; // guarda o texto que de fato saiu
    this.#encerrar(f, "enviado", "");
    await this.store.registrarMensagem(lead.id, { id: enviada?.id || "", direcao: "saida", texto, em: new Date().toISOString(), origem: "followup" });
    // Integração com o Kanban: a regra pode mover o lead de etapa depois do envio.
    if (regra?.moverPara && lead.etapa === f.etapa) await this.store.atualizar(lead.id, { etapa: regra.moverPara });
    this.avisar(lead.id);
  }

  async rodada() {
    if (this.rodando || this.whatsapp.status !== "conectado" || !this.dentroDaJanela()) return;
    this.rodando = true;
    try {
      const agora = Date.now();
      const vencidos = this.store
        .listar()
        .flatMap((lead) => (lead.followups || []).filter((f) => f.status === "pendente" && new Date(f.agendadoPara).getTime() <= agora).map((f) => ({ lead, f })))
        .sort((a, b) => new Date(a.f.agendadoPara) - new Date(b.f.agendadoPara))
        .slice(0, POR_RODADA);
      for (const [i, { lead, f }] of vencidos.entries()) {
        if (this.whatsapp.status !== "conectado") break;
        if (!this.store.obter(lead.id) || f.status !== "pendente") continue;
        await this.#enviar(lead, f);
        if (i < vencidos.length - 1) await espera(ESPACO_MS[0] + Math.random() * (ESPACO_MS[1] - ESPACO_MS[0]));
      }
    } finally {
      this.rodando = false;
    }
  }
}
