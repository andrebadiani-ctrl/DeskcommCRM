// Painel de resultados: números calculados na hora a partir de leads, pedidos e conversas.
// Nada é guardado à parte, então o painel nunca diverge do que está nas outras abas.
import { ETAPAS } from "./store.mjs";
import { STATUS_VENDA } from "./pedidos.mjs";

const FUSO = process.env.TZ || "America/Sao_Paulo";
// O caminho "pra frente" do funil; Perdido e Sem interesse são saídas dele.
const CAMINHO = ETAPAS.slice(0, ETAPAS.indexOf("Ganho") + 1);
const SAIDAS = ["Perdido", "Sem interesse"];
const DIA = 86400_000;

const centavos = (v) => Math.round(v * 100) / 100;
const mesDe = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit" });
const horaDe = new Intl.DateTimeFormat("en-GB", { timeZone: FUSO, hour: "2-digit", hourCycle: "h23" });
const chaveMes = (d) => mesDe.format(d).slice(0, 7); // "2026-10"
const mediana = (xs) => {
  if (!xs.length) return null;
  const o = [...xs].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
};

/** Até onde o lead chegou no caminho do funil (índice em CAMINHO), olhando o histórico de etapas. */
function alcance(lead) {
  const passou = [...(lead.etapas || []).map((h) => h.etapa), lead.etapa];
  return Math.max(0, ...passou.map((e) => CAMINHO.indexOf(e)));
}

/** Quando o pedido virou venda: a primeira vez que entrou num status de venda (ou a criação). */
function vendidoEm(p) {
  const h = (p.historico || []).find((x) => STATUS_VENDA.includes(x.status));
  return h?.em || p.criadoEm;
}

export function resumoDoPainel({ leads, pedidos, conversas, dias, agora = new Date() }) {
  const desde = dias ? new Date(agora.getTime() - dias * DIA) : null;
  const noPeriodo = (iso) => !!iso && (!desde || new Date(iso) >= desde);

  // ---- leads ----
  const coorte = leads.filter((l) => noPeriodo(l.criadoEm));
  const ganhosNoPeriodo = leads.filter((l) => l.etapa === "Ganho" && noPeriodo(l.etapaDesde));
  const perdidosNoPeriodo = leads.filter((l) => SAIDAS.includes(l.etapa) && noPeriodo(l.etapaDesde));
  const ganhosDaCoorte = coorte.filter((l) => l.etapa === "Ganho").length;
  const alcances = coorte.map(alcance);
  const funil = CAMINHO.map((etapa, i) => ({ etapa, alcancaram: alcances.filter((a) => a >= i).length }));

  const origens = new Map();
  for (const l of coorte) {
    const nome = l.origem || "Sem origem";
    const o = origens.get(nome) || { origem: nome, leads: 0, ganhos: 0 };
    o.leads++;
    if (l.etapa === "Ganho") o.ganhos++;
    origens.set(nome, o);
  }
  const porOrigem = [...origens.values()]
    .map((o) => ({ ...o, conversao: o.leads ? o.ganhos / o.leads : 0 }))
    .sort((a, b) => b.leads - a.leads);

  const diasAteGanhar = ganhosNoPeriodo
    .map((l) => (new Date(l.etapaDesde) - new Date(l.criadoEm)) / DIA)
    .filter((d) => d >= 0);

  // ---- vendas (por moeda: real e euro não se somam) ----
  const meses = [];
  for (let i = 11; i >= 0; i--) meses.push(chaveMes(new Date(agora.getFullYear(), agora.getMonth() - i, 15)));
  const hoje = agora.toISOString().slice(0, 10);
  const daqui30 = new Date(agora.getTime() + 30 * DIA).toISOString().slice(0, 10);
  const moedas = {};
  const daMoeda = (m) =>
    (moedas[m] ||= {
      pedidos: 0, total: 0, ticketMedio: 0, comissao: 0,
      recebido: 0, aReceber: 0, atrasado: 0, vence30dias: 0,
      porMes: meses.map((mes) => ({ mes, pedidos: 0, total: 0 })),
      vendedores: new Map(), produtos: new Map(),
    });

  for (const p of pedidos) {
    const m = daMoeda(p.moeda || "BRL");
    // Dinheiro que entrou no período e o que falta receber valem para qualquer pedido não cancelado.
    if (p.status !== "Cancelado") {
      for (const x of p.pagamentos || []) {
        if (x.pagaEm && noPeriodo(x.pagaEm)) m.recebido += x.valor;
        if (!x.pagaEm && STATUS_VENDA.includes(p.status)) {
          m.aReceber += x.valor;
          if (x.vencimento < hoje) m.atrasado += x.valor;
          else if (x.vencimento <= daqui30) m.vence30dias += x.valor;
        }
      }
    }
    if (!STATUS_VENDA.includes(p.status)) continue;
    const quando = vendidoEm(p);
    const mes = m.porMes.find((x) => x.mes === chaveMes(new Date(quando)));
    if (mes) {
      mes.pedidos++;
      mes.total += p.total;
    }
    if (!noPeriodo(quando)) continue;
    m.pedidos++;
    m.total += p.total;
    m.comissao += p.comissao || 0;
    const nomeVendedor = p.vendedor?.nome || "Sem vendedor";
    const v = m.vendedores.get(nomeVendedor) || { nome: nomeVendedor, pedidos: 0, total: 0, comissao: 0 };
    v.pedidos++;
    v.total += p.total;
    v.comissao += p.comissao || 0;
    m.vendedores.set(nomeVendedor, v);
    for (const i of p.itens || []) {
      const pr = m.produtos.get(i.descricao) || { descricao: i.descricao, quantidade: 0, total: 0 };
      pr.quantidade += Number(i.quantidade) || 0;
      pr.total += i.total || 0;
      m.produtos.set(i.descricao, pr);
    }
  }
  for (const m of Object.values(moedas)) {
    m.ticketMedio = m.pedidos ? m.total / m.pedidos : 0;
    for (const k of ["total", "ticketMedio", "comissao", "recebido", "aReceber", "atrasado", "vence30dias"]) m[k] = centavos(m[k]);
    for (const x of m.porMes) x.total = centavos(x.total);
    m.porVendedor = [...m.vendedores.values()].map((v) => ({ ...v, total: centavos(v.total), comissao: centavos(v.comissao) })).sort((a, b) => b.total - a.total);
    m.topProdutos = [...m.produtos.values()].map((p) => ({ ...p, total: centavos(p.total) })).sort((a, b) => b.total - a.total).slice(0, 5);
    delete m.vendedores;
    delete m.produtos;
  }
  // Moeda com movimento vem primeiro; sem nenhum pedido, mostra real zerado.
  if (!Object.keys(moedas).length) daMoeda("BRL");

  // ---- atendimento ----
  const respostas = []; // minutos entre a primeira mensagem sem resposta e a resposta
  const porHora = Array(24).fill(0);
  const esperas = [];
  let recebidas = 0;
  let enviadas = 0;
  let conversasAtivas = 0;
  let naFila = 0;
  let maiorEsperaMin = 0;
  for (const c of conversas) {
    if (c.fila) {
      naFila++;
      maiorEsperaMin = Math.max(maiorEsperaMin, (agora - new Date(c.fila.desde)) / 60_000);
    }
    for (const e of c.esperas || []) if (noPeriodo(e.baixaEm)) esperas.push((new Date(e.baixaEm) - new Date(e.desde)) / 60_000);
    let pendenteDesde = null;
    let ativa = false;
    for (const msg of c.mensagens || []) {
      if (msg.direcao === "entrada") {
        if (!pendenteDesde) pendenteDesde = msg.em;
        if (noPeriodo(msg.em)) {
          recebidas++;
          ativa = true;
          porHora[Number(horaDe.format(new Date(msg.em)))]++;
        }
      } else {
        if (noPeriodo(msg.em)) {
          enviadas++;
          ativa = true;
        }
        if (pendenteDesde && noPeriodo(msg.em)) respostas.push((new Date(msg.em) - new Date(pendenteDesde)) / 60_000);
        pendenteDesde = null;
      }
    }
    if (ativa) conversasAtivas++;
  }

  const r = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    periodo: { dias: dias || null, desde: desde?.toISOString() || null, geradoEm: agora.toISOString(), fuso: FUSO },
    leads: {
      novos: coorte.length,
      ganhos: ganhosNoPeriodo.length,
      perdidos: perdidosNoPeriodo.length,
      emAberto: leads.filter((l) => l.etapa !== "Ganho" && !SAIDAS.includes(l.etapa)).length,
      conversao: coorte.length ? ganhosDaCoorte / coorte.length : 0,
      diasAteGanhar: r(mediana(diasAteGanhar)),
      funil,
      porEtapa: ETAPAS.map((etapa) => ({ etapa, quantidade: leads.filter((l) => l.etapa === etapa).length })),
      porOrigem,
    },
    vendas: Object.fromEntries(Object.entries(moedas).sort(([, a], [, b]) => b.total - a.total || b.aReceber - a.aReceber)),
    atendimento: {
      naFila,
      maiorEsperaMin: r(maiorEsperaMin),
      esperaMedianaMin: r(mediana(esperas)),
      atendidosDaFila: esperas.length,
      respostaMedianaMin: r(mediana(respostas)),
      respondidasEm5min: respostas.length ? respostas.filter((x) => x <= 5).length / respostas.length : null,
      conversasAtivas,
      recebidas,
      enviadas,
      porHora,
    },
  };
}

