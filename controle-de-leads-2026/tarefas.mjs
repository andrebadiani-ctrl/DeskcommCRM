// Tarefas e lembretes ("ligar para a Ana amanhã às 10h"), ligados ou não a um lead,
// guardados em data/tarefas.json. Um relógio avisa as telas abertas quando chega a hora.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ErroValidacao } from "./store.mjs";

const INTERVALO_MS = 20_000;
const MANTER_FEITAS_DIAS = 90; // tarefas concluídas há mais tempo saem da lista

export class Tarefas {
  constructor(dir) {
    this.dir = dir;
    this.arquivo = path.join(dir, "tarefas.json");
    this.lista = [];
    this.fila = Promise.resolve();
  }

  async carregar() {
    await mkdir(this.dir, { recursive: true });
    try {
      this.lista = JSON.parse(await readFile(this.arquivo, "utf8")).tarefas || [];
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  salvar() {
    this.fila = this.fila.then(async () => {
      const tmp = this.arquivo + ".tmp";
      await writeFile(tmp, JSON.stringify({ tarefas: this.lista }, null, 2));
      await rename(tmp, this.arquivo);
    });
    return this.fila;
  }

  #validar(e, { parcial = false } = {}) {
    if (!e || typeof e !== "object") throw new ErroValidacao("Corpo inválido");
    const s = {};
    if ("titulo" in e || !parcial) {
      s.titulo = String(e.titulo ?? "").trim().slice(0, 200);
      if (!s.titulo) throw new ErroValidacao("Escreva o que precisa ser feito");
    }
    if ("quando" in e || !parcial) {
      const d = new Date(e.quando);
      if (Number.isNaN(d.getTime())) throw new ErroValidacao("Data e hora da tarefa inválidas");
      s.quando = d.toISOString();
    }
    if ("observacao" in e) s.observacao = String(e.observacao ?? "").trim().slice(0, 1000);
    if ("feita" in e) {
      if (typeof e.feita !== "boolean") throw new ErroValidacao("feita deve ser verdadeiro ou falso");
      s.feita = e.feita;
    }
    return s;
  }

  listar() {
    const limite = Date.now() - MANTER_FEITAS_DIAS * 86400_000;
    return this.lista.filter((t) => !t.feita || new Date(t.feitaEm || t.quando).getTime() > limite);
  }

  async criar(e, lead) {
    const agora = new Date().toISOString();
    const t = { id: randomUUID(), observacao: "", feita: false, ...this.#validar(e), leadId: lead?.id || "", leadNome: lead?.nome || "", criadoEm: agora, avisadoEm: "", feitaEm: "" };
    this.lista.push(t);
    await this.salvar();
    return t;
  }

  async atualizar(id, e) {
    const t = this.lista.find((x) => x.id === id);
    if (!t) return undefined;
    const dados = this.#validar(e, { parcial: true });
    // Mudou o horário: avisa de novo na hora nova.
    if (dados.quando && dados.quando !== t.quando) dados.avisadoEm = "";
    if ("feita" in dados) dados.feitaEm = dados.feita ? new Date().toISOString() : "";
    Object.assign(t, dados);
    await this.salvar();
    return t;
  }

  async excluir(id) {
    const antes = this.lista.length;
    this.lista = this.lista.filter((t) => t.id !== id);
    if (this.lista.length === antes) return false;
    await this.salvar();
    return true;
  }

  /** Lead renomeado ou excluído: a tarefa guarda o nome para continuar legível. */
  atualizarLead(lead, { excluido = false } = {}) {
    let mexeu = false;
    for (const t of this.lista) {
      if (t.leadId !== lead.id) continue;
      if (excluido) t.leadId = "";
      t.leadNome = lead.nome;
      mexeu = true;
    }
    if (mexeu) this.salvar();
  }

  /** Chama `avisar(tarefa)` uma vez quando cada tarefa pendente chega na hora. */
  iniciar(avisar) {
    const rodar = async () => {
      const agora = Date.now();
      const vencidas = this.lista.filter((t) => !t.feita && !t.avisadoEm && new Date(t.quando).getTime() <= agora);
      if (!vencidas.length) return;
      for (const t of vencidas) {
        t.avisadoEm = new Date().toISOString();
        avisar(t);
      }
      await this.salvar();
    };
    this.timer = setInterval(() => rodar().catch((e) => console.error("Tarefas:", e)), INTERVALO_MS);
    this.timer.unref?.();
    rodar().catch(() => {});
  }
}
