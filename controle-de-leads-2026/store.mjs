// Persistência simples em arquivo JSON (data/leads.json), com escrita atômica.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const ETAPAS = [
  "Novo Lead",
  "Em atendimento IA",
  "Atendimento Humano",
  "Reunião Agendada",
  "Proposta Enviada",
  "Ganho",
  "Perdido",
  "Sem interesse",
];

export const PAISES = ["Brasil", "Portugal"];

export const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

export const DISTRITOS = [
  "Aveiro", "Beja", "Braga", "Bragança", "Castelo Branco", "Coimbra", "Évora", "Faro",
  "Guarda", "Leiria", "Lisboa", "Portalegre", "Porto", "Santarém", "Setúbal",
  "Viana do Castelo", "Vila Real", "Viseu", "Região Autónoma dos Açores",
  "Região Autónoma da Madeira",
];

const TEXTOS = ["nome", "email", "telefone", "cargo", "empresa", "observacoes", "cidade"];
const LIMITE_TEXTO = 5000;
const LIMITE_MENSAGENS = 200;

export class ErroValidacao extends Error {}

/** Valida e normaliza os campos editáveis de um lead. `parcial` = PATCH. */
export function validarLead(entrada, { parcial = false, atual = {} } = {}) {
  if (!entrada || typeof entrada !== "object") throw new ErroValidacao("Corpo inválido");
  const saida = {};

  for (const campo of TEXTOS) {
    if (campo in entrada) {
      const v = entrada[campo] ?? "";
      if (typeof v !== "string") throw new ErroValidacao(`Campo ${campo} deve ser texto`);
      saida[campo] = v.trim().slice(0, LIMITE_TEXTO);
    }
  }
  if ("email" in saida && saida.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(saida.email)) {
    throw new ErroValidacao("E-mail inválido");
  }
  if ("faturamentoMensal" in entrada) {
    const bruto = entrada.faturamentoMensal;
    const n = bruto === "" || bruto === null ? 0 : Number(bruto);
    if (!Number.isFinite(n) || n < 0) throw new ErroValidacao("Faturamento mensal inválido");
    saida.faturamentoMensal = Math.round(n * 100) / 100;
  }
  if ("criadoEm" in entrada) {
    const d = new Date(entrada.criadoEm);
    if (Number.isNaN(d.getTime())) throw new ErroValidacao("Data de criação inválida");
    saida.criadoEm = d.toISOString();
  }
  if ("etapa" in entrada) {
    if (!ETAPAS.includes(entrada.etapa)) throw new ErroValidacao("Etapa do funil inválida");
    saida.etapa = entrada.etapa;
  }
  if ("pais" in entrada) {
    if (entrada.pais && !PAISES.includes(entrada.pais)) throw new ErroValidacao("País inválido");
    saida.pais = entrada.pais || "";
  }

  // UF só vale para Brasil; Distrito só para Portugal.
  const pais = saida.pais ?? atual.pais ?? "";
  if ("uf" in entrada || "pais" in saida) {
    const uf = "uf" in entrada ? entrada.uf || "" : atual.uf || "";
    saida.uf = pais === "Brasil" && UFS.includes(uf) ? uf : "";
    if ("uf" in entrada && uf && pais !== "Brasil") throw new ErroValidacao("UF só se aplica ao Brasil");
    if ("uf" in entrada && uf && !UFS.includes(uf)) throw new ErroValidacao("UF inválida");
  }
  if ("distrito" in entrada || "pais" in saida) {
    const d = "distrito" in entrada ? entrada.distrito || "" : atual.distrito || "";
    saida.distrito = pais === "Portugal" && DISTRITOS.includes(d) ? d : "";
    if ("distrito" in entrada && d && pais !== "Portugal") throw new ErroValidacao("Distrito só se aplica a Portugal");
    if ("distrito" in entrada && d && !DISTRITOS.includes(d)) throw new ErroValidacao("Distrito inválido");
  }

  if (!parcial && !saida.nome) throw new ErroValidacao("Nome é obrigatório");
  if (parcial && "nome" in saida && !saida.nome) throw new ErroValidacao("Nome é obrigatório");
  return saida;
}

/** Só dígitos. */
export const digitos = (t) => String(t || "").replace(/\D/g, "");

/** Forma comparável de um telefone: com DDI, e sem o 9º dígito brasileiro. */
export function chaveTelefone(t) {
  let d = digitos(t);
  if (d.length === 10 || d.length === 11) d = "55" + d; // número BR sem DDI
  if (d.length === 9 && d.startsWith("9")) d = "351" + d; // celular PT sem DDI
  if (d.startsWith("55") && d.length === 13) d = d.slice(0, 4) + d.slice(5);
  return d;
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.arquivo = path.join(dir, "leads.json");
    this.leads = [];
    this.config = { autoCriarLeads: true };
    this.fila = Promise.resolve();
  }

  async carregar() {
    await mkdir(this.dir, { recursive: true });
    try {
      const json = JSON.parse(await readFile(this.arquivo, "utf8"));
      this.leads = Array.isArray(json.leads) ? json.leads : [];
      this.config = { ...this.config, ...(json.config || {}) };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.leads = exemplos();
      await this.salvar();
    }
  }

  salvar() {
    // Serializa as escritas para nunca intercalar dois writes no mesmo arquivo.
    this.fila = this.fila.then(async () => {
      const tmp = this.arquivo + ".tmp";
      await writeFile(tmp, JSON.stringify({ leads: this.leads, config: this.config }, null, 2));
      await rename(tmp, this.arquivo);
    });
    return this.fila;
  }

  listar() {
    return this.leads;
  }

  obter(id) {
    return this.leads.find((l) => l.id === id);
  }

  porTelefone(telefone) {
    const chave = chaveTelefone(telefone);
    if (!chave) return undefined;
    return this.leads.find((l) => l.telefone && chaveTelefone(l.telefone) === chave);
  }

  async criar(entrada) {
    const dados = validarLead(entrada);
    const lead = {
      id: randomUUID(),
      criadoEm: new Date().toISOString(),
      nome: "", email: "", telefone: "", cargo: "", empresa: "", observacoes: "",
      faturamentoMensal: 0, cidade: "", pais: "", uf: "", distrito: "",
      etapa: "Novo Lead",
      mensagens: [],
      ...dados,
      atualizadoEm: new Date().toISOString(),
    };
    this.leads.unshift(lead);
    await this.salvar();
    return lead;
  }

  async atualizar(id, entrada) {
    const lead = this.obter(id);
    if (!lead) return undefined;
    Object.assign(lead, validarLead(entrada, { parcial: true, atual: lead }), {
      atualizadoEm: new Date().toISOString(),
    });
    await this.salvar();
    return lead;
  }

  async adicionarNota(id, texto) {
    const lead = this.obter(id);
    if (!lead) return undefined;
    const t = String(texto || "").trim().slice(0, 1000);
    if (!t) throw new ErroValidacao("Nota vazia");
    const quando = new Date().toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: process.env.TZ || "America/Sao_Paulo",
    });
    const linha = `[${quando}] ${t}`;
    lead.observacoes = lead.observacoes ? `${lead.observacoes}\n${linha}` : linha;
    lead.atualizadoEm = new Date().toISOString();
    await this.salvar();
    return lead;
  }

  async registrarMensagem(id, msg) {
    const lead = this.obter(id);
    if (!lead) return undefined;
    lead.mensagens = [...(lead.mensagens || []), msg].slice(-LIMITE_MENSAGENS);
    lead.atualizadoEm = new Date().toISOString();
    await this.salvar();
    return lead;
  }

  async excluir(id) {
    const antes = this.leads.length;
    this.leads = this.leads.filter((l) => l.id !== id);
    if (this.leads.length === antes) return false;
    await this.salvar();
    return true;
  }

  async atualizarConfig(entrada) {
    if (typeof entrada?.autoCriarLeads === "boolean") this.config.autoCriarLeads = entrada.autoCriarLeads;
    await this.salvar();
    return this.config;
  }
}

function exemplos() {
  const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const base = { email: "", cargo: "", observacoes: "", uf: "", distrito: "", mensagens: [] };
  const lista = [
    { nome: "Mariana Costa", empresa: "Verde Vivo Cosméticos", cargo: "Diretora Comercial", email: "mariana@verdevivo.com.br", telefone: "+55 11 98765-4321", cidade: "São Paulo", pais: "Brasil", uf: "SP", faturamentoMensal: 85000, etapa: "Novo Lead", criadoEm: dias(1) },
    { nome: "João Ferreira", empresa: "Lusitânia Imóveis", cargo: "Sócio", email: "joao@lusitania.pt", telefone: "+351 912 345 678", cidade: "Porto", pais: "Portugal", distrito: "Porto", faturamentoMensal: 42000, etapa: "Em atendimento IA", criadoEm: dias(3) },
    { nome: "Ana Ribeiro", empresa: "Clínica Bem Estar", cargo: "Gestora", email: "ana@bemestar.com.br", telefone: "+55 31 99876-1234", cidade: "Belo Horizonte", pais: "Brasil", uf: "MG", faturamentoMensal: 120000, etapa: "Reunião Agendada", criadoEm: dias(6) },
    { nome: "Carlos Mendes", empresa: "TechSul Software", cargo: "CEO", email: "carlos@techsul.com.br", telefone: "+55 51 98111-2233", cidade: "Porto Alegre", pais: "Brasil", uf: "RS", faturamentoMensal: 230000, etapa: "Proposta Enviada", criadoEm: dias(9), observacoes: "Pediu proposta com plano anual." },
    { nome: "Rita Almeida", empresa: "Atlântico Turismo", cargo: "Marketing", email: "rita@atlantico.pt", telefone: "+351 934 567 890", cidade: "Lisboa", pais: "Portugal", distrito: "Lisboa", faturamentoMensal: 60000, etapa: "Ganho", criadoEm: dias(14) },
    { nome: "Pedro Santos", empresa: "Loja do Pedro", cargo: "Proprietário", telefone: "+55 21 97777-8888", cidade: "Rio de Janeiro", pais: "Brasil", uf: "RJ", faturamentoMensal: 18000, etapa: "Perdido", criadoEm: dias(20) },
    { nome: "Beatriz Lima", empresa: "Nordeste Alimentos", cargo: "Compras", email: "beatriz@nordeste.com.br", telefone: "+55 81 98888-7777", cidade: "Recife", pais: "Brasil", uf: "PE", faturamentoMensal: 95000, etapa: "Atendimento Humano", criadoEm: dias(2) },
    { nome: "Miguel Sousa", empresa: "Café Coimbra", cargo: "Gerente", telefone: "+351 961 222 333", cidade: "Coimbra", pais: "Portugal", distrito: "Coimbra", faturamentoMensal: 9000, etapa: "Sem interesse", criadoEm: dias(25) },
  ];
  return lista.map((l) => ({ ...base, ...l, id: randomUUID(), atualizadoEm: l.criadoEm }));
}
