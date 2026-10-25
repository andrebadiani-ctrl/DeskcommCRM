// Testa as contas do Painel de resultados com dados montados à mão (resultado conhecido).
// Rode com: npm test
import assert from "node:assert/strict";
import { resumoDoPainel } from "../painel.mjs";

const agora = new Date("2026-10-24T15:00:00Z");
const atras = (dias, horas = 0) => new Date(agora.getTime() - dias * 86400_000 - horas * 3600_000).toISOString();
const dia = (d) => d.slice(0, 10);

const leads = [
  // passou por todas as etapas e fechou em 4 dias
  { id: "a", criadoEm: atras(10), origem: "Instagram", etapa: "Ganho", etapaDesde: atras(6), etapas: [{ etapa: "Novo Lead" }, { etapa: "Atendimento Humano" }, { etapa: "Proposta Enviada" }, { etapa: "Ganho" }] },
  // chegou à proposta e foi perdido: conta até "Proposta Enviada" no funil
  { id: "b", criadoEm: atras(8), origem: "Instagram", etapa: "Perdido", etapaDesde: atras(2), etapas: [{ etapa: "Novo Lead" }, { etapa: "Reunião Agendada" }, { etapa: "Proposta Enviada" }, { etapa: "Perdido" }] },
  // lead antigo, sem histórico de etapas: vale a etapa atual
  { id: "c", criadoEm: atras(5), origem: "", etapa: "Atendimento Humano", etapaDesde: atras(5) },
  // fora do período de 30 dias
  { id: "d", criadoEm: atras(200), origem: "Google", etapa: "Ganho", etapaDesde: atras(190) },
];

const pedidos = [
  { status: "Entregue", moeda: "BRL", total: 1000, comissao: 50, vendedor: { nome: "Paula" }, criadoEm: atras(20), historico: [{ status: "Orçamento", em: atras(20) }, { status: "Confirmado", em: atras(3) }],
    itens: [{ descricao: "Kit", quantidade: 2, total: 1000 }],
    pagamentos: [{ numero: 1, valor: 500, vencimento: dia(atras(5)), pagaEm: atras(4) }, { numero: 2, valor: 500, vencimento: dia(atras(1)), pagaEm: "" }] },
  { status: "Confirmado", moeda: "BRL", total: 300, comissao: 0, vendedor: null, criadoEm: atras(2), historico: [{ status: "Confirmado", em: atras(2) }],
    itens: [{ descricao: "Curso", quantidade: 1, total: 300 }],
    pagamentos: [{ numero: 1, valor: 300, vencimento: dia(atras(-10)), pagaEm: "" }] },
  // orçamento e cancelado não são venda nem conta a receber
  { status: "Orçamento", moeda: "BRL", total: 999, criadoEm: atras(1), historico: [], itens: [], pagamentos: [{ numero: 1, valor: 999, vencimento: dia(atras(1)), pagaEm: "" }] },
  { status: "Cancelado", moeda: "BRL", total: 777, criadoEm: atras(1), historico: [{ status: "Confirmado", em: atras(1) }], itens: [], pagamentos: [{ numero: 1, valor: 777, vencimento: dia(atras(1)), pagaEm: "" }] },
  // euro não se soma com real
  { status: "Enviado", moeda: "EUR", total: 80, comissao: 0, criadoEm: atras(4), historico: [{ status: "Enviado", em: atras(4) }], itens: [{ descricao: "Kit", quantidade: 1, total: 80 }], pagamentos: [] },
];

const conversas = [
  { jid: "1", fila: { desde: atras(0, 2) }, esperas: [{ desde: atras(3, 1), baixaEm: atras(3) }], mensagens: [
    { direcao: "entrada", em: atras(1, 3) },
    { direcao: "entrada", em: atras(1, 2.9) }, // segunda mensagem seguida: o relógio continua contando da primeira
    { direcao: "saida", em: atras(1, 2.5) },   // 30 min depois da primeira
    { direcao: "entrada", em: atras(1, 1) },
    { direcao: "saida", em: atras(1, 0.95) },  // 3 min
  ] },
  { jid: "2", mensagens: [{ direcao: "entrada", em: atras(90) }, { direcao: "saida", em: atras(89) }] }, // fora do período
];

const r = resumoDoPainel({ leads, pedidos, conversas, dias: 30, agora });

assert.equal(r.leads.novos, 3);
assert.equal(r.leads.ganhos, 1);
assert.equal(r.leads.perdidos, 1);
assert.equal(r.leads.diasAteGanhar, 4);
assert.equal(Math.round(r.leads.conversao * 100), 33);
const funil = Object.fromEntries(r.leads.funil.map((f) => [f.etapa, f.alcancaram]));
assert.deepEqual(funil, { "Novo Lead": 3, "Em atendimento IA": 3, "Atendimento Humano": 3, "Reunião Agendada": 2, "Proposta Enviada": 2, Ganho: 1 });
assert.deepEqual(r.leads.porOrigem.map((o) => [o.origem, o.leads, o.ganhos]), [["Instagram", 2, 1], ["Sem origem", 1, 0]]);
console.log("1 ok: funil pelo histórico de etapas, conversão, origem e tempo até fechar");

const brl = r.vendas.BRL;
assert.equal(brl.pedidos, 2, "vendido há 3 dias (confirmação), mesmo criado há 20");
assert.equal(brl.total, 1300);
assert.equal(brl.ticketMedio, 650);
assert.equal(brl.comissao, 50);
assert.equal(brl.recebido, 500);
assert.equal(brl.aReceber, 800, "orçamento e cancelado ficam fora");
assert.equal(brl.atrasado, 500);
assert.equal(brl.vence30dias, 300);
assert.deepEqual(brl.porVendedor.map((v) => [v.nome, v.total]), [["Paula", 1000], ["Sem vendedor", 300]]);
assert.equal(brl.porMes.at(-1).total, 1300);
assert.equal(r.vendas.EUR.total, 80);
assert.deepEqual(Object.keys(r.vendas), ["BRL", "EUR"]);
console.log("2 ok: vendas pela data de confirmação, a receber, atraso, comissão e moedas separadas");

const a = r.atendimento;
assert.equal(a.naFila, 1);
assert.equal(a.maiorEsperaMin, 120);
assert.equal(a.esperaMedianaMin, 60);
assert.equal(a.respostaMedianaMin, 16.5); // mediana de 30 e 3
assert.equal(a.respondidasEm5min, 0.5);
assert.equal(a.recebidas, 3);
assert.equal(a.enviadas, 2);
assert.equal(a.conversasAtivas, 1);
assert.equal(a.porHora.reduce((s, n) => s + n, 0), 3);
console.log("3 ok: tempo de resposta, fila, espera e mensagens por hora");

const tudo = resumoDoPainel({ leads, pedidos, conversas, dias: 0, agora });
assert.equal(tudo.leads.novos, 4);
assert.equal(tudo.atendimento.conversasAtivas, 2);
const vazio = resumoDoPainel({ leads: [], pedidos: [], conversas: [], dias: 7, agora });
assert.equal(vazio.vendas.BRL.total, 0);
assert.equal(vazio.atendimento.respostaMedianaMin, null);
console.log("4 ok: período \"Tudo\" e instalação vazia");
console.log("Painel: todos os cenários passaram.");
