// Importação de leads de planilha: transforma os valores "como vieram" (cada um escreve de um
// jeito) no formato que o cadastro aceita. As colunas já chegam mapeadas pela tela.
import { DISTRITOS, ETAPAS, UFS } from "./store.mjs";

export const LIMITE_IMPORTACAO = 5000;

const sem = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

const NOMES_UF = {
  acre: "AC", alagoas: "AL", amapa: "AP", amazonas: "AM", bahia: "BA", ceara: "CE", "distrito federal": "DF",
  "espirito santo": "ES", goias: "GO", maranhao: "MA", "mato grosso": "MT", "mato grosso do sul": "MS",
  "minas gerais": "MG", para: "PA", paraiba: "PB", parana: "PR", pernambuco: "PE", piaui: "PI",
  "rio de janeiro": "RJ", "rio grande do norte": "RN", "rio grande do sul": "RS", rondonia: "RO", roraima: "RR",
  "santa catarina": "SC", "sao paulo": "SP", sergipe: "SE", tocantins: "TO",
};
const DISTRITO_POR_NOME = Object.fromEntries(DISTRITOS.map((d) => [sem(d), d]));
DISTRITO_POR_NOME["acores"] = "Região Autónoma dos Açores";
DISTRITO_POR_NOME["madeira"] = "Região Autónoma da Madeira";
const ETAPA_POR_NOME = Object.fromEntries(ETAPAS.map((e) => [sem(e), e]));

function uf(valor) {
  const v = sem(valor);
  if (!v) return "";
  if (UFS.includes(v.toUpperCase())) return v.toUpperCase();
  return NOMES_UF[v] || "";
}

function pais(valor) {
  const v = sem(valor);
  if (["brasil", "brazil", "br", "bra"].includes(v)) return "Brasil";
  if (["portugal", "pt", "prt"].includes(v)) return "Portugal";
  return "";
}

/** "R$ 1.234,56" → 1234.56 · "1,234.56" → 1234.56 · "1.500" → 1500 · "" → 0 */
export function dinheiro(valor) {
  const bruto = String(valor ?? "").trim();
  if (!bruto) return 0;
  let t = bruto.replace(/[^\d,.-]/g, "");
  if (!/\d/.test(t)) return NaN; // texto sem número ("a combinar")
  const virgula = t.lastIndexOf(",");
  const ponto = t.lastIndexOf(".");
  if (virgula >= 0 && ponto >= 0) {
    t = virgula > ponto ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (virgula >= 0) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (ponto >= 0 && (t.split(".").length > 2 || /\.\d{3}$/.test(t))) {
    t = t.replace(/\./g, ""); // ponto como separador de milhar
  }
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** "25/10/2026", "25/10/2026 14:30", "2026-10-25" → ISO; inválida → "" */
function data(valor) {
  const v = String(valor ?? "").trim();
  if (!v) return "";
  const br = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (br) {
    const ano = Number(br[3].length === 2 ? `20${br[3]}` : br[3]);
    const d = new Date(ano, Number(br[2]) - 1, Number(br[1]), Number(br[4] || 12), Number(br[5] || 0));
    return Number.isNaN(d.getTime()) || d.getDate() !== Number(br[1]) ? "" : d.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * Uma linha da planilha → dados de lead. `padroes` = { etapa, origem } escolhidos na tela.
 * Problemas pequenos (e-mail torto, data estranha) não derrubam a linha: vão para Observações.
 */
export function normalizarLinha(campos, padroes = {}) {
  const c = Object.fromEntries(Object.entries(campos || {}).map(([k, v]) => [k, String(v ?? "").trim()]));
  const avisos = [];
  const lead = {
    nome: c.nome || "",
    telefone: c.telefone || "",
    cargo: c.cargo || "",
    empresa: c.empresa || "",
    cidade: c.cidade || "",
    observacoes: c.observacoes || "",
    origem: c.origem || padroes.origem || "",
    etiquetas: c.etiquetas || "",
  };
  if (!lead.nome) lead.nome = lead.empresa || lead.telefone || c.email || "";

  const email = (c.email || "").toLowerCase();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) lead.email = email;
  else if (email) avisos.push(`e-mail inválido na planilha: ${c.email}`);

  const fat = dinheiro(c.faturamentoMensal);
  if (Number.isNaN(fat)) avisos.push(`faturamento não reconhecido: ${c.faturamentoMensal}`);
  else lead.faturamentoMensal = fat;

  // País, UF e distrito: um ajuda a descobrir o outro.
  const siglaUf = uf(c.uf);
  const distrito = DISTRITO_POR_NOME[sem(c.distrito || (pais(c.pais) === "Portugal" ? c.uf : ""))] || "";
  // Sem país na planilha: deduz pelo DDI do telefone (+55 Brasil, +351 Portugal).
  const digitosTel = (c.telefone || "").replace(/\D/g, "");
  const paisDoTelefone = /^\+?\s*351/.test(c.telefone || "") || (digitosTel.startsWith("351") && digitosTel.length === 12) ? "Portugal"
    : /^\+?\s*55/.test(c.telefone || "") && digitosTel.length >= 12 ? "Brasil" : "";
  lead.pais = pais(c.pais) || (siglaUf ? "Brasil" : distrito ? "Portugal" : paisDoTelefone);
  if (lead.pais === "Brasil") lead.uf = siglaUf;
  // Em Portugal a cidade costuma ser também o distrito (Lisboa, Porto, Faro…).
  if (lead.pais === "Portugal") lead.distrito = distrito || DISTRITO_POR_NOME[sem(c.cidade)] || "";
  if (c.uf && lead.pais === "Brasil" && !siglaUf) avisos.push(`UF não reconhecida: ${c.uf}`);

  lead.etapa = ETAPA_POR_NOME[sem(c.etapa)] || (ETAPAS.includes(padroes.etapa) ? padroes.etapa : "Novo Lead");
  const criado = data(c.criadoEm);
  if (criado) lead.criadoEm = criado;
  else if (c.criadoEm) avisos.push(`data não reconhecida: ${c.criadoEm}`);

  if (avisos.length) lead.observacoes = [lead.observacoes, `Importação: ${avisos.join("; ")}`].filter(Boolean).join("\n");
  return lead;
}
