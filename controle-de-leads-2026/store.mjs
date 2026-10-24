// Persistência simples em arquivo JSON (data/leads.json), com escrita atômica.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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

  if ("whatsappJid" in entrada) {
    const jid = String(entrada.whatsappJid || "");
    if (jid && !/^[\w.:-]+@(s\.whatsapp\.net|lid)$/.test(jid)) throw new ErroValidacao("Conversa do WhatsApp inválida");
    saida.whatsappJid = jid;
  }
  if ("optOut" in entrada) {
    if (typeof entrada.optOut !== "boolean") throw new ErroValidacao("optOut deve ser verdadeiro ou falso");
    saida.optOut = entrada.optOut;
  }

  if (!parcial && !saida.nome) throw new ErroValidacao("Nome é obrigatório");
  if (parcial && "nome" in saida && !saida.nome) throw new ErroValidacao("Nome é obrigatório");
  return saida;
}

const MINUTOS_MAX = 60 * 24 * 365;

/** Resposta rápida: atalho (usado com "/" no chat), título e texto. */
export function validarResposta(entrada, { parcial = false } = {}) {
  if (!entrada || typeof entrada !== "object") throw new ErroValidacao("Corpo inválido");
  const saida = {};
  if ("atalho" in entrada || !parcial) {
    const atalho = String(entrada.atalho || "").trim().toLowerCase().replace(/^\//, "");
    if (!/^[a-z0-9_-]{1,30}$/.test(atalho)) throw new ErroValidacao("Atalho: use até 30 letras sem acento, números, - ou _");
    saida.atalho = atalho;
  }
  if ("titulo" in entrada) saida.titulo = String(entrada.titulo || "").trim().slice(0, 80);
  if ("texto" in entrada || !parcial) {
    const texto = String(entrada.texto || "").trim();
    if (!texto) throw new ErroValidacao("A resposta precisa de um texto");
    saida.texto = texto.slice(0, 4000);
  }
  return saida;
}

/** Regra de follow-up: "lead na etapa X há N minutos → envia mensagem (e pode mover de etapa)". */
export function validarRegra(entrada, { parcial = false } = {}) {
  if (!entrada || typeof entrada !== "object") throw new ErroValidacao("Corpo inválido");
  const saida = {};
  if ("etapa" in entrada || !parcial) {
    if (!ETAPAS.includes(entrada.etapa)) throw new ErroValidacao("Etapa do funil inválida");
    saida.etapa = entrada.etapa;
  }
  if ("nome" in entrada) saida.nome = String(entrada.nome || "").trim().slice(0, 80);
  if ("aposMinutos" in entrada || !parcial) {
    const n = Number(entrada.aposMinutos);
    if (!Number.isInteger(n) || n < 0 || n > MINUTOS_MAX) throw new ErroValidacao("Tempo de espera inválido");
    saida.aposMinutos = n;
  }
  if ("texto" in entrada || !parcial) {
    const texto = String(entrada.texto || "").trim();
    if (!texto) throw new ErroValidacao("O follow-up precisa de uma mensagem");
    saida.texto = texto.slice(0, 4000);
  }
  if ("moverPara" in entrada) {
    if (entrada.moverPara && !ETAPAS.includes(entrada.moverPara)) throw new ErroValidacao("Etapa de destino inválida");
    saida.moverPara = entrada.moverPara || "";
  }
  for (const campo of ["cancelarSeResponder", "ativo"]) {
    if (campo in entrada) {
      if (typeof entrada[campo] !== "boolean") throw new ErroValidacao(`${campo} deve ser verdadeiro ou falso`);
      saida[campo] = entrada[campo];
    }
  }
  if (saida.moverPara && saida.etapa && saida.moverPara === saida.etapa) {
    throw new ErroValidacao("A etapa de destino deve ser diferente da etapa da regra");
  }
  return saida;
}

/** Troca {nome}, {primeiro_nome}, {empresa}… pelos dados do lead. */
export function preencherVariaveis(texto, lead) {
  const nome = (lead.nome || "").trim();
  const valores = {
    nome,
    primeiro_nome: nome.split(/\s+/)[0] || "",
    empresa: lead.empresa || "",
    cargo: lead.cargo || "",
    cidade: lead.cidade || "",
    etapa: lead.etapa || "",
  };
  return String(texto || "").replace(/\{(\w+)\}/g, (todo, chave) => (chave in valores ? valores[chave] : todo));
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

export class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.arquivo = path.join(dir, "leads.json");
    this.leads = [];
    this.config = {
      // Desligado: quem vira lead é escolhido na aba Conversas. Ligado, todo número novo vira lead.
      autoCriarLeads: false,
      janela: { inicio: 8, fim: 21 },
      respostasRapidas: respostasDeExemplo(),
      regrasFollowup: regrasDeExemplo(),
    };
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
      followups: [],
      optOut: false,
      ...dados,
      atualizadoEm: new Date().toISOString(),
    };
    lead.etapaDesde = new Date().toISOString();
    this.leads.unshift(lead);
    // Ouvintes síncronos (agenda de follow-ups) mexem no lead antes de salvar.
    this.emit("etapa", lead, null);
    await this.salvar();
    return lead;
  }

  async atualizar(id, entrada) {
    const lead = this.obter(id);
    if (!lead) return undefined;
    const anterior = lead.etapa;
    Object.assign(lead, validarLead(entrada, { parcial: true, atual: lead }), {
      atualizadoEm: new Date().toISOString(),
    });
    if (lead.etapa !== anterior) {
      lead.etapaDesde = new Date().toISOString();
      this.emit("etapa", lead, anterior);
    }
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
    // A mesma mensagem pode chegar duas vezes (o envio e o eco do WhatsApp): o id desduplica.
    const existente = msg.id && (lead.mensagens || []).find((m) => m.id === msg.id);
    if (existente) {
      if (msg.origem && !existente.origem) {
        existente.origem = msg.origem;
        await this.salvar();
      }
      return lead;
    }
    lead.mensagens = [...(lead.mensagens || []), msg].slice(-LIMITE_MENSAGENS);
    lead.atualizadoEm = new Date().toISOString();
    await this.salvar();
    return lead;
  }

  /** Traz o histórico de uma conversa do WhatsApp para o lead (sem duplicar). */
  async importarMensagens(id, mensagens) {
    const lead = this.obter(id);
    if (!lead) return undefined;
    const ids = new Set((lead.mensagens || []).map((m) => m.id).filter(Boolean));
    const novas = mensagens.filter((m) => !m.id || !ids.has(m.id)).map(({ id: mid, direcao, texto, em }) => ({ id: mid, direcao, texto, em }));
    lead.mensagens = [...(lead.mensagens || []), ...novas].sort((a, b) => a.em.localeCompare(b.em)).slice(-LIMITE_MENSAGENS);
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
    if (entrada?.janela) {
      const inicio = Number(entrada.janela.inicio);
      const fim = Number(entrada.janela.fim);
      const hora = (h) => Number.isInteger(h) && h >= 0 && h <= 24;
      if (!hora(inicio) || !hora(fim) || inicio >= fim) throw new ErroValidacao("Janela de envio inválida");
      this.config.janela = { inicio, fim };
    }
    await this.salvar();
    return this.config;
  }

  // ---- respostas rápidas e regras de follow-up (CRUD genérico em config) ----
  #colecao(nome) {
    return nome === "respostas" ? this.config.respostasRapidas : this.config.regrasFollowup;
  }

  async criarItem(nome, entrada) {
    const dados = nome === "respostas" ? validarResposta(entrada) : validarRegra(entrada);
    const lista = this.#colecao(nome);
    if (nome === "respostas" && lista.some((r) => r.atalho === dados.atalho)) {
      throw new ErroValidacao(`Já existe uma resposta com o atalho /${dados.atalho}`);
    }
    const base = nome === "respostas" ? { titulo: "" } : { nome: "", moverPara: "", cancelarSeResponder: true, ativo: true };
    const item = { id: randomUUID(), ...base, ...dados, criadoEm: new Date().toISOString() };
    lista.push(item);
    this.emit("config", nome, item);
    await this.salvar();
    return item;
  }

  async atualizarItem(nome, id, entrada) {
    const item = this.#colecao(nome).find((i) => i.id === id);
    if (!item) return undefined;
    const dados = nome === "respostas" ? validarResposta(entrada, { parcial: true }) : validarRegra({ etapa: item.etapa, ...entrada }, { parcial: true });
    if (nome === "respostas" && dados.atalho && this.#colecao(nome).some((r) => r.id !== id && r.atalho === dados.atalho)) {
      throw new ErroValidacao(`Já existe uma resposta com o atalho /${dados.atalho}`);
    }
    Object.assign(item, dados);
    this.emit("config", nome, item);
    await this.salvar();
    return item;
  }

  async excluirItem(nome, id) {
    const lista = this.#colecao(nome);
    const i = lista.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [item] = lista.splice(i, 1);
    this.emit("config", nome, { ...item, excluido: true });
    await this.salvar();
    return true;
  }
}

function respostasDeExemplo() {
  const agora = new Date().toISOString();
  return [
    { id: randomUUID(), atalho: "ola", titulo: "Boas-vindas", texto: "Olá, {primeiro_nome}! Tudo bem? Obrigado pelo contato. Como posso te ajudar?", criadoEm: agora },
    { id: randomUUID(), atalho: "reuniao", titulo: "Agendar reunião", texto: "{primeiro_nome}, que tal marcarmos uma conversa rápida de 20 minutos para eu entender melhor a {empresa}? Qual o melhor dia e horário para você?", criadoEm: agora },
    { id: randomUUID(), atalho: "proposta", titulo: "Proposta enviada", texto: "{primeiro_nome}, acabei de te enviar a proposta. Qualquer dúvida, estou à disposição por aqui!", criadoEm: agora },
    { id: randomUUID(), atalho: "obrigado", titulo: "Agradecimento", texto: "Muito obrigado, {primeiro_nome}! Foi um prazer falar com você.", criadoEm: agora },
  ];
}

// Regras de exemplo nascem PAUSADAS: nada é enviado sem a pessoa ligar a regra.
function regrasDeExemplo() {
  const agora = new Date().toISOString();
  const base = { cancelarSeResponder: true, ativo: false, criadoEm: agora };
  return [
    { id: randomUUID(), ...base, etapa: "Novo Lead", nome: "Primeiro contato", aposMinutos: 60, moverPara: "Atendimento Humano", texto: "Olá, {primeiro_nome}! Aqui é da equipe comercial. Vi o seu interesse e queria entender como podemos ajudar a {empresa}. Podemos conversar?" },
    { id: randomUUID(), ...base, etapa: "Proposta Enviada", nome: "Lembrete da proposta", aposMinutos: 2 * 24 * 60, moverPara: "", texto: "Oi, {primeiro_nome}! Conseguiu dar uma olhada na proposta? Fico à disposição para tirar qualquer dúvida." },
    { id: randomUUID(), ...base, etapa: "Proposta Enviada", nome: "Última tentativa", aposMinutos: 7 * 24 * 60, moverPara: "Sem interesse", texto: "{primeiro_nome}, como não tive retorno, vou encerrar a proposta por aqui. Se quiser retomar, é só me chamar!" },
  ];
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
