// Pedidos: catálogo de produtos, condições de pagamento e pedidos (com itens, totais e status),
// guardados em data/pedidos.json. Os totais são sempre calculados aqui, nunca confiados à tela.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ErroValidacao } from "./store.mjs";

export const STATUS_PEDIDO = ["Orçamento", "Confirmado", "Em separação", "Enviado", "Entregue", "Cancelado"];
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
    this.dados = { produtos: [], condicoes: [], pedidos: [], proximoNumero: 1 };
    this.fila = Promise.resolve();
  }

  async carregar() {
    await mkdir(this.dir, { recursive: true });
    try {
      this.dados = { ...this.dados, ...JSON.parse(await readFile(this.arquivo, "utf8")) };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.dados.produtos = produtosDeExemplo();
      this.dados.condicoes = condicoesDeExemplo();
      await this.salvar();
    }
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
    return s;
  }

  async criarProduto(e) {
    const p = { id: randomUUID(), codigo: "", unidade: "un", descricao: "", ativo: true, ...this.#validarProduto(e), criadoEm: new Date().toISOString() };
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
    return s;
  }

  async criarCondicao(e) {
    const c = { id: randomUUID(), ajustePercentual: 0, descricao: "", ativo: true, ...this.#validarCondicao(e), criadoEm: new Date().toISOString() };
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
      observacoes: "observacoes" in e ? texto(e.observacoes, 2000) : atual?.observacoes || "",
      status,
    };
  }

  listar() {
    return this.dados.pedidos;
  }

  obter(id) {
    return this.dados.pedidos.find((p) => p.id === id);
  }

  async criar(e, lead) {
    if (!lead && !texto(e?.clienteNome, 200)) throw new ErroValidacao("Escolha o cliente do pedido");
    const agora = new Date().toISOString();
    const montado = this.#montar(e, lead);
    const pedido = { id: randomUUID(), numero: this.dados.proximoNumero++, criadoEm: agora, ...montado, historico: [{ status: montado.status, em: agora }], atualizadoEm: agora };
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
    Object.assign(pedido, montado, { atualizadoEm: agora });
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
      pedido.status = status;
      pedido.historico = [...(pedido.historico || []), { status, em: agora }];
      pedido.atualizadoEm = agora;
      await this.salvar();
    }
    return pedido;
  }

  async excluir(id) {
    const antes = this.dados.pedidos.length;
    this.dados.pedidos = this.dados.pedidos.filter((p) => p.id !== id);
    if (this.dados.pedidos.length === antes) return false;
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
    { id: randomUUID(), nome: "PIX à vista", parcelas: 1, ajustePercentual: -5, descricao: "5% de desconto", ativo: true, criadoEm: agora },
    { id: randomUUID(), nome: "Cartão de crédito em 3x", parcelas: 3, ajustePercentual: 0, descricao: "Sem juros", ativo: true, criadoEm: agora },
    { id: randomUUID(), nome: "Boleto 30/60/90", parcelas: 3, ajustePercentual: 3, descricao: "3% de acréscimo", ativo: true, criadoEm: agora },
  ];
}
