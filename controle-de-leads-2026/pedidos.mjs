// Pedidos: catálogo de produtos, condições de pagamento e pedidos (com itens, totais e status),
// guardados em data/pedidos.json. Os totais são sempre calculados aqui, nunca confiados à tela.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ErroValidacao } from "./store.mjs";

export const STATUS_PEDIDO = ["Orçamento", "Confirmado", "Em separação", "Enviado", "Entregue", "Cancelado"];
/** Status de venda fechada: tiram do estoque, contam comissão e podem mover o lead para "Ganho". */
export const STATUS_VENDA = ["Confirmado", "Em separação", "Enviado", "Entregue"];
const MAX_ITENS = 100;

const texto = (v, max) => String(v ?? "").trim().slice(0, max);
const centavos = (n) => Math.round(n * 100) / 100;

function numero(v, { campo, min = 0, max = 1e9, inteiro = false }) {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (inteiro && !Number.isInteger(n))) throw new ErroValidacao(`${campo} inválido`);
  return inteiro ? n : centavos(n);
}

function booleano(v, campo) {
  if (typeof v !== "boolean") throw new ErroValidacao(`${campo} deve ser verdadeiro ou falso`);
  return v;
}

export class Pedidos {
  constructor(dir) {
    this.dir = dir;
    this.arquivo = path.join(dir, "pedidos.json");
    this.dados = { produtos: [], condicoes: [], vendedores: [], pedidos: [], proximoNumero: 1, config: {} };
    this.fila = Promise.resolve();
  }

  async carregar() {
    await mkdir(this.dir, { recursive: true });
    let novo = false;
    try {
      this.dados = { ...this.dados, ...JSON.parse(await readFile(this.arquivo, "utf8")) };
      this.dados.vendedores ||= [];
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.dados.produtos = produtosDeExemplo();
      this.dados.condicoes = condicoesDeExemplo();
      novo = true;
    }
    // Configuração (dados da empresa para o pedido impresso e regras automáticas).
    const config = this.dados.config || {};
    this.dados.config = {
      moverLeadParaGanho: config.moverLeadParaGanho ?? true,
      empresa: { nome: "", documento: "", telefone: "", email: "", endereco: "", ...(config.empresa || {}) },
    };
    if (novo) await this.salvar();
  }

  salvar() {
    this.fila = this.fila.then(async () => {
      const tmp = this.arquivo + ".tmp";
      await writeFile(tmp, JSON.stringify(this.dados, null, 2));
      await rename(tmp, this.arquivo);
    });
    return this.fila;
  }

  // ---------- produtos ----------
  #validarProduto(e, { parcial = false, id = null } = {}) {
    if (!e || typeof e !== "object") throw new ErroValidacao("Corpo inválido");
    const s = {};
    if ("nome" in e || !parcial) {
      s.nome = texto(e.nome, 200);
      if (!s.nome) throw new ErroValidacao("O produto precisa de um nome");
    }
    if ("codigo" in e) {
      s.codigo = texto(e.codigo, 50);
      if (s.codigo && this.dados.produtos.some((p) => p.id !== id && p.codigo.toLowerCase() === s.codigo.toLowerCase())) {
        throw new ErroValidacao(`Já existe um produto com o código ${s.codigo}`);
      }
    }
    if ("preco" in e || !parcial) s.preco = numero(e.preco ?? 0, { campo: "Preço" });
    if ("unidade" in e) s.unidade = texto(e.unidade, 12) || "un";
    if ("descricao" in e) s.descricao = texto(e.descricao, 1000);
    if ("ativo" in e) s.ativo = booleano(e.ativo, "ativo");
    if ("controlarEstoque" in e) s.controlarEstoque = booleano(e.controlarEstoque, "controlarEstoque");
    // Estoque pode ficar negativo (venda antes de repor); o mínimo só serve de alerta.
    if ("estoque" in e) s.estoque = Math.round(numero(e.estoque ?? 0, { campo: "Estoque", min: -1e7, max: 1e7 }) * 1000) / 1000;
    if ("estoqueMinimo" in e) s.estoqueMinimo = numero(e.estoqueMinimo ?? 0, { campo: "Estoque mínimo", max: 1e7 });
    return s;
  }

  async criarProduto(e) {
    const p = { id: randomUUID(), codigo: "", unidade: "un", descricao: "", ativo: true, controlarEstoque: false, estoque: 0, estoqueMinimo: 0, ...this.#validarProduto(e), criadoEm: new Date().toISOString() };
    this.dados.produtos.push(p);
    await this.salvar();
    return p;
  }

  async atualizarProduto(id, e) {
    const p = this.dados.produtos.find((x) => x.id === id);
    if (!p) return undefined;
    Object.assign(p, this.#validarProduto(e, { parcial: true, id }));
    await this.salvar();
    return p;
  }

  // Pedidos antigos guardam nome e preço do item; excluir o produto não muda nenhum pedido.
  async excluirProduto(id) {
    const antes = this.dados.produtos.length;
    this.dados.produtos = this.dados.produtos.filter((p) => p.id !== id);
    if (this.dados.produtos.length === antes) return false;
    await this.salvar();
    return true;
  }

  // ---------- condições de pagamento ----------
  #validarCondicao(e, { parcial = false, id = null } = {}) {
    if (!e || typeof e !== "object") throw new ErroValidacao("Corpo inválido");
    const s = {};
    if ("nome" in e || !parcial) {
      s.nome = texto(e.nome, 100);
      if (!s.nome) throw new ErroValidacao("A condição de pagamento precisa de um nome");
      if (this.dados.condicoes.some((c) => c.id !== id && c.nome.toLowerCase() === s.nome.toLowerCase())) {
        throw new ErroValidacao(`Já existe a condição “${s.nome}”`);
      }
    }
    if ("parcelas" in e || !parcial) s.parcelas = numero(e.parcelas ?? 1, { campo: "Número de parcelas", min: 1, max: 48, inteiro: true });
    // Negativo = desconto (ex.: -5 no PIX); positivo = acréscimo (ex.: juros do cartão).
    if ("ajustePercentual" in e) s.ajustePercentual = numero(e.ajustePercentual ?? 0, { campo: "Desconto/acréscimo", min: -100, max: 100 });
    if ("descricao" in e) s.descricao = texto(e.descricao, 300);
    if ("ativo" in e) s.ativo = booleano(e.ativo, "ativo");
    // Prazos: em quantos dias vence a 1ª parcela e de quantos em quantos dias vêm as outras.
    if ("primeiroVencimentoDias" in e) s.primeiroVencimentoDias = numero(e.primeiroVencimentoDias ?? 0, { campo: "Dias até a 1ª parcela", max: 365, inteiro: true });
    if ("intervaloDias" in e) s.intervaloDias = numero(e.intervaloDias ?? 30, { campo: "Intervalo entre parcelas", min: 1, max: 365, inteiro: true });
    return s;
  }

  async criarCondicao(e) {
    const dados = this.#validarCondicao(e);
    const c = { id: randomUUID(), ajustePercentual: 0, descricao: "", ativo: true, primeiroVencimentoDias: dados.parcelas > 1 ? 30 : 0, intervaloDias: 30, ...dados, criadoEm: new Date().toISOString() };
    this.dados.condicoes.push(c);
    await this.salvar();
    return c;
  }

  async atualizarCondicao(id, e) {
    const c = this.dados.condicoes.find((x) => x.id === id);
    if (!c) return undefined;
    Object.assign(c, this.#validarCondicao(e, { parcial: true, id }));
    await this.salvar();
    return c;
  }

  async excluirCondicao(id) {
    const antes = this.dados.condicoes.length;
    this.dados.condicoes = this.dados.condicoes.filter((c) => c.id !== id);
    if (this.dados.condicoes.length === antes) return false;
    await this.salvar();
    return true;
  }

  // ---------- vendedores (comissão) ----------
  #validarVendedor(e, { parcial = false, id = null } = {}) {
    if (!e || typeof e !== "object") throw new ErroValidacao("Corpo inválido");
    const s = {};
    if ("nome" in e || !parcial) {
      s.nome = texto(e.nome, 100);
      if (!s.nome) throw new ErroValidacao("O vendedor precisa de um nome");
      if (this.dados.vendedores.some((v) => v.id !== id && v.nome.toLowerCase() === s.nome.toLowerCase())) throw new ErroValidacao(`Já existe o vendedor “${s.nome}”`);
    }
    if ("comissaoPercentual" in e || !parcial) s.comissaoPercentual = numero(e.comissaoPercentual ?? 0, { campo: "Comissão", max: 100 });
    if ("ativo" in e) s.ativo = booleano(e.ativo, "ativo");
    return s;
  }

  async criarVendedor(e) {
    const v = { id: randomUUID(), ativo: true, ...this.#validarVendedor(e), criadoEm: new Date().toISOString() };
    this.dados.vendedores.push(v);
    await this.salvar();
    return v;
  }

  async atualizarVendedor(id, e) {
    const v = this.dados.vendedores.find((x) => x.id === id);
    if (!v) return undefined;
    Object.assign(v, this.#validarVendedor(e, { parcial: true, id }));
    await this.salvar();
    return v;
  }

  async excluirVendedor(id) {
    const antes = this.dados.vendedores.length;
    this.dados.vendedores = this.dados.vendedores.filter((v) => v.id !== id);
    if (this.dados.vendedores.length === antes) return false;
    await this.salvar();
    return true;
  }

  async atualizarConfig(e) {
    if (!e || typeof e !== "object") throw new ErroValidacao("Corpo inválido");
    if ("moverLeadParaGanho" in e) this.dados.config.moverLeadParaGanho = booleano(e.moverLeadParaGanho, "moverLeadParaGanho");
    if (e.empresa && typeof e.empresa === "object") {
      const campos = { nome: 120, documento: 40, telefone: 40, email: 120, endereco: 300 };
      for (const [k, max] of Object.entries(campos)) if (k in e.empresa) this.dados.config.empresa[k] = texto(e.empresa[k], max);
    }
    await this.salvar();
    return this.dados.config;
  }

  // ---------- estoque ----------
  /** Quanto de cada produto um pedido consome (só quando é venda fechada). */
  #consumo(pedido) {
    const m = new Map();
    if (!pedido || !STATUS_VENDA.includes(pedido.status)) return m;
    for (const i of pedido.itens) if (i.produtoId) m.set(i.produtoId, (m.get(i.produtoId) || 0) + i.quantidade);
    return m;
  }

  /** Acerta o estoque pela diferença entre o pedido antes e depois (confirmar, editar, cancelar, excluir). */
  #ajustarEstoque(antes, depois) {
    const a = this.#consumo(antes);
    const d = this.#consumo(depois);
    for (const id of new Set([...a.keys(), ...d.keys()])) {
      const produto = this.dados.produtos.find((p) => p.id === id);
      if (!produto?.controlarEstoque) continue;
      const delta = (d.get(id) || 0) - (a.get(id) || 0);
      if (delta) produto.estoque = Math.round(((produto.estoque || 0) - delta) * 1000) / 1000;
    }
  }

  // ---------- pedidos ----------
  /** Valida itens e condição e calcula os totais. `lead` = cliente (ou null com clienteNome). */
  #montar(e, lead, atual = null) {
    if (!e || typeof e !== "object") throw new ErroValidacao("Corpo inválido");
    const itensBrutos = e.itens ?? atual?.itens;
    if (!Array.isArray(itensBrutos) || !itensBrutos.length) throw new ErroValidacao("Adicione pelo menos um item ao pedido");
    if (itensBrutos.length > MAX_ITENS) throw new ErroValidacao(`No máximo ${MAX_ITENS} itens por pedido`);
    const itens = itensBrutos.map((i, n) => {
      const produto = i.produtoId ? this.dados.produtos.find((p) => p.id === i.produtoId) : null;
      const descricao = texto(i.descricao, 200) || produto?.nome || "";
      if (!descricao) throw new ErroValidacao(`Item ${n + 1}: escolha um produto ou escreva a descrição`);
      const quantidade = numero(i.quantidade, { campo: `Quantidade do item ${n + 1}`, min: 0.001, max: 1e6 });
      const precoUnitario = numero(i.precoUnitario ?? produto?.preco ?? 0, { campo: `Preço do item ${n + 1}` });
      return { produtoId: produto?.id || "", codigo: produto?.codigo || "", descricao, unidade: produto?.unidade || texto(i.unidade, 12) || "un", quantidade, precoUnitario, total: centavos(quantidade * precoUnitario) };
    });

    const condicaoId = "condicaoId" in e ? e.condicaoId || "" : atual?.condicao?.id || "";
    let condicao = null;
    if (condicaoId) {
      const c = this.dados.condicoes.find((x) => x.id === condicaoId);
      // Guarda uma cópia: mudar a condição depois não altera pedidos já feitos.
      condicao = c ? { id: c.id, nome: c.nome, parcelas: c.parcelas, ajustePercentual: c.ajustePercentual } : atual?.condicao?.id === condicaoId ? atual.condicao : null;
      if (!condicao) throw new ErroValidacao("Condição de pagamento não encontrada");
    }

    const desconto = "desconto" in e ? numero(e.desconto ?? 0, { campo: "Desconto" }) : atual?.desconto || 0;
    const frete = "frete" in e ? numero(e.frete ?? 0, { campo: "Frete" }) : atual?.frete || 0;
    const subtotal = centavos(itens.reduce((s, i) => s + i.total, 0));
    const ajuste = centavos(subtotal * ((condicao?.ajustePercentual || 0) / 100));
    const total = centavos(Math.max(0, subtotal + ajuste - desconto + frete));
    const parcelas = condicao?.parcelas || 1;

    const status = "status" in e ? e.status : atual?.status || "Orçamento";
    if (!STATUS_PEDIDO.includes(status)) throw new ErroValidacao("Status do pedido inválido");

    const vendedorId = "vendedorId" in e ? e.vendedorId || "" : atual?.vendedor?.id || "";
    let vendedor = null;
    if (vendedorId) {
      const v = this.dados.vendedores.find((x) => x.id === vendedorId);
      vendedor = v ? { id: v.id, nome: v.nome, comissaoPercentual: v.comissaoPercentual } : atual?.vendedor?.id === vendedorId ? atual.vendedor : null;
      if (!vendedor) throw new ErroValidacao("Vendedor não encontrado");
    }

    const pagamentos = this.#parcelas({ total, parcelas, condicao, base: atual?.criadoEm || new Date().toISOString(), atual });

    return {
      leadId: lead?.id || "",
      cliente: lead ? lead.nome : texto(e.clienteNome ?? atual?.cliente, 200),
      moeda: lead ? (lead.pais === "Portugal" ? "EUR" : "BRL") : atual?.moeda || "BRL",
      itens,
      condicao,
      subtotal,
      ajuste,
      desconto,
      frete,
      total,
      parcelas,
      valorParcela: centavos(total / parcelas),
      pagamentos,
      vendedor,
      comissao: vendedor ? centavos((total * vendedor.comissaoPercentual) / 100) : 0,
      observacoes: "observacoes" in e ? texto(e.observacoes, 2000) : atual?.observacoes || "",
      status,
    };
  }

  /**
   * Parcelas com vencimento. Se já há parcela paga, o pedido não pode mudar de valor ou de número
   * de parcelas sem antes desmarcar o pagamento (senão o dinheiro recebido fica sem dono).
   */
  #parcelas({ total, parcelas, condicao, base, atual }) {
    const valores = Array.from({ length: parcelas }, (_, i) => (i < parcelas - 1 ? Math.floor((total / parcelas) * 100) / 100 : 0));
    valores[parcelas - 1] = centavos(total - valores.slice(0, -1).reduce((s, v) => s + v, 0));
    const anteriores = atual?.pagamentos || [];
    const iguais = anteriores.length === parcelas && anteriores.every((p, i) => p.valor === valores[i]);
    if (iguais) return anteriores; // mantém pagamentos marcados e vencimentos ajustados à mão
    if (anteriores.some((p) => p.pagaEm)) throw new ErroValidacao("Este pedido já tem parcela paga: desmarque o pagamento antes de mudar valores, itens ou a condição de pagamento.");
    const primeiro = condicao?.primeiroVencimentoDias ?? (parcelas > 1 ? 30 : 0);
    const intervalo = condicao?.intervaloDias || 30;
    const inicio = new Date(base);
    return valores.map((valor, i) => {
      const venc = new Date(inicio);
      venc.setDate(venc.getDate() + primeiro + i * intervalo);
      return { numero: i + 1, valor, vencimento: venc.toISOString().slice(0, 10), pagaEm: "" };
    });
  }

  /** Marca/desmarca uma parcela como paga ou muda o vencimento dela. */
  async atualizarParcela(id, numeroParcela, e) {
    const pedido = this.obter(id);
    const parcela = pedido?.pagamentos?.find((p) => p.numero === Number(numeroParcela));
    if (!parcela) return undefined;
    if ("paga" in e) parcela.pagaEm = booleano(e.paga, "paga") ? (e.pagaEm && !Number.isNaN(new Date(e.pagaEm).getTime()) ? new Date(e.pagaEm).toISOString() : new Date().toISOString()) : "";
    if ("vencimento" in e) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.vencimento)) || Number.isNaN(new Date(e.vencimento).getTime())) throw new ErroValidacao("Data de vencimento inválida");
      parcela.vencimento = e.vencimento;
    }
    pedido.atualizadoEm = new Date().toISOString();
    await this.salvar();
    return pedido;
  }

  listar() {
    return this.dados.pedidos.map((p) => ({ ...p, ...resumoPagamento(p) }));
  }

  obter(id) {
    return this.dados.pedidos.find((p) => p.id === id);
  }

  async criar(e, lead) {
    if (!lead && !texto(e?.clienteNome, 200)) throw new ErroValidacao("Escolha o cliente do pedido");
    const agora = new Date().toISOString();
    const montado = this.#montar(e, lead);
    const pedido = { id: randomUUID(), numero: this.dados.proximoNumero++, criadoEm: agora, ...montado, historico: [{ status: montado.status, em: agora }], atualizadoEm: agora };
    this.#ajustarEstoque(null, pedido);
    this.dados.pedidos.unshift(pedido);
    await this.salvar();
    return pedido;
  }

  async atualizar(id, e, lead) {
    const pedido = this.obter(id);
    if (!pedido) return undefined;
    const montado = this.#montar(e, lead ?? null, pedido);
    if (!lead && !montado.cliente) throw new ErroValidacao("Escolha o cliente do pedido");
    const agora = new Date().toISOString();
    if (montado.status !== pedido.status) pedido.historico = [...(pedido.historico || []), { status: montado.status, em: agora }];
    const antes = { status: pedido.status, itens: pedido.itens };
    Object.assign(pedido, montado, { atualizadoEm: agora });
    this.#ajustarEstoque(antes, pedido);
    await this.salvar();
    return pedido;
  }

  /** Só troca o status (usado direto na lista de pedidos), registrando no histórico. */
  async mudarStatus(id, status) {
    const pedido = this.obter(id);
    if (!pedido) return undefined;
    if (!STATUS_PEDIDO.includes(status)) throw new ErroValidacao("Status do pedido inválido");
    if (pedido.status !== status) {
      const agora = new Date().toISOString();
      const antes = { status: pedido.status, itens: pedido.itens };
      pedido.status = status;
      this.#ajustarEstoque(antes, pedido);
      pedido.historico = [...(pedido.historico || []), { status, em: agora }];
      pedido.atualizadoEm = agora;
      await this.salvar();
    }
    return pedido;
  }

  async excluir(id) {
    const pedido = this.obter(id);
    if (!pedido) return false;
    this.#ajustarEstoque(pedido, null); // devolve ao estoque o que a venda tinha tirado
    this.dados.pedidos = this.dados.pedidos.filter((p) => p.id !== id);
    await this.salvar();
    return true;
  }

  /** Lead excluído: os pedidos dele ficam, com o nome do cliente guardado. */
  desligarLead(leadId) {
    let mexeu = false;
    for (const p of this.dados.pedidos) {
      if (p.leadId === leadId) {
        p.leadId = "";
        mexeu = true;
      }
    }
    if (mexeu) this.salvar();
  }

  /** Resumo do pedido para mandar pelo WhatsApp. */
  resumoParaWhatsApp(pedido) {
    const fmt = (v) => new Intl.NumberFormat(pedido.moeda === "EUR" ? "pt-PT" : "pt-BR", { style: "currency", currency: pedido.moeda || "BRL" }).format(v);
    const qtd = (q) => String(q).replace(".", ",");
    const primeiroNome = (pedido.cliente || "").split(/\s+/)[0];
    const linhas = [
      `Olá${primeiroNome ? `, ${primeiroNome}` : ""}! Segue o resumo do seu pedido nº ${pedido.numero}:`,
      "",
      ...pedido.itens.map((i) => `• ${qtd(i.quantidade)} ${i.unidade} × ${i.descricao} — ${fmt(i.total)}`),
      "",
      `Subtotal: ${fmt(pedido.subtotal)}`,
    ];
    if (pedido.ajuste) linhas.push(`${pedido.ajuste < 0 ? "Desconto" : "Acréscimo"} (${pedido.condicao?.nome}): ${fmt(Math.abs(pedido.ajuste))}`);
    if (pedido.desconto) linhas.push(`Desconto: ${fmt(pedido.desconto)}`);
    if (pedido.frete) linhas.push(`Frete: ${fmt(pedido.frete)}`);
    linhas.push(`*Total: ${fmt(pedido.total)}*${pedido.parcelas > 1 ? ` (${pedido.parcelas}x de ${fmt(pedido.valorParcela)})` : ""}`);
    if (pedido.condicao) linhas.push(`Pagamento: ${pedido.condicao.nome}`);
    linhas.push(`Status: ${pedido.status}`);
    if (pedido.observacoes) linhas.push("", pedido.observacoes);
    return linhas.join("\n");
  }
}

/** Situação do pagamento de um pedido (calculada, não guardada). */
export function resumoPagamento(p, hoje = new Date().toISOString().slice(0, 10)) {
  const parcelas = p.pagamentos || [];
  const pago = centavos(parcelas.filter((x) => x.pagaEm).reduce((s, x) => s + x.valor, 0));
  const aReceber = centavos(p.total - pago);
  let situacaoPagamento = "Pendente";
  if (p.status === "Cancelado") situacaoPagamento = "Cancelado";
  else if (parcelas.length && parcelas.every((x) => x.pagaEm)) situacaoPagamento = "Pago";
  else if (parcelas.some((x) => !x.pagaEm && x.vencimento < hoje)) situacaoPagamento = "Atrasado";
  else if (pago > 0) situacaoPagamento = "Parcial";
  return { pago, aReceber: p.status === "Cancelado" ? 0 : aReceber, situacaoPagamento };
}

function produtosDeExemplo() {
  const agora = new Date().toISOString();
  return [
    { id: randomUUID(), codigo: "PLAN-BAS", nome: "Plano Básico (mensal)", preco: 199.9, unidade: "mês", descricao: "Exemplo — edite ou exclua", ativo: true, criadoEm: agora },
    { id: randomUUID(), codigo: "PLAN-PRO", nome: "Plano Profissional (mensal)", preco: 499.9, unidade: "mês", descricao: "Exemplo — edite ou exclua", ativo: true, criadoEm: agora },
    { id: randomUUID(), codigo: "IMPL", nome: "Implantação e treinamento", preco: 1500, unidade: "un", descricao: "Exemplo — edite ou exclua", ativo: true, criadoEm: agora },
  ];
}

function condicoesDeExemplo() {
  const agora = new Date().toISOString();
  return [
    { id: randomUUID(), nome: "PIX à vista", parcelas: 1, ajustePercentual: -5, primeiroVencimentoDias: 0, intervaloDias: 30, descricao: "5% de desconto", ativo: true, criadoEm: agora },
    { id: randomUUID(), nome: "Cartão de crédito em 3x", parcelas: 3, ajustePercentual: 0, primeiroVencimentoDias: 30, intervaloDias: 30, descricao: "Sem juros", ativo: true, criadoEm: agora },
    { id: randomUUID(), nome: "Boleto 30/60/90", parcelas: 3, ajustePercentual: 3, primeiroVencimentoDias: 30, intervaloDias: 30, descricao: "3% de acréscimo", ativo: true, criadoEm: agora },
  ];
}
