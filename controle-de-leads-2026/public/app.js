/* Controle de Leads 2026 — frontend (JavaScript puro, sem build). */
(() => {
  "use strict";

  const { etapas: ETAPAS, ufs: UFS, distritos: DISTRITOS } = window.CRM_LISTAS;
  const CLASSE_ETAPA = {
    "Novo Lead": "e-novo",
    "Em atendimento IA": "e-ia",
    "Atendimento Humano": "e-humano",
    "Reunião Agendada": "e-reuniao",
    "Proposta Enviada": "e-proposta",
    Ganho: "e-ganho",
    Perdido: "e-perdido",
    "Sem interesse": "e-sem",
  };
  const EM_ANDAMENTO = ["Em atendimento IA", "Atendimento Humano", "Reunião Agendada", "Proposta Enviada"];

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

  const estado = {
    leads: [],
    aba: lerPreferencia("aba", "tabela"),
    busca: "",
    etapa: "",
    origem: "",
    etiqueta: "",
    pais: "",
    regiao: "",
    cidade: "",
    ordem: "criadoEm:desc",
    whatsapp: { status: "desconectado", qr: null, conta: null, erro: null },
    config: { autoCriarLeads: false },
    leadAberto: null,
    conversas: [],
    conversaAberta: null,
    conversaDados: null,
    cvFiltro: lerPreferencia("cvFiltro", "todas"),
    cvBusca: "",
    novoLeadJid: null,
    renderPendente: false,
  };

  // ---------- utilidades ----------
  function lerPreferencia(chave, padrao) {
    try { return localStorage.getItem("cl2026:" + chave) || padrao; } catch { return padrao; }
  }
  function gravarPreferencia(chave, valor) {
    try { localStorage.setItem("cl2026:" + chave, valor); } catch { /* sem armazenamento: segue */ }
  }
  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const normalizar = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function moeda(valor, pais) {
    const eur = pais === "Portugal";
    return new Intl.NumberFormat(eur ? "pt-PT" : "pt-BR", {
      style: "currency",
      currency: eur ? "EUR" : "BRL",
      maximumFractionDigits: 0,
    }).format(Number(valor) || 0);
  }
  const moedaCompacta = (v) =>
    new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(Number(v) || 0);

  function parseDinheiro(texto) {
    let t = String(texto || "").replace(/[^\d,.-]/g, "");
    if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  }
  const dataCurta = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR") : "");
  const paraInputData = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  // Mantém a hora original ao trocar só o dia (meio-dia local quando não havia hora).
  function deInputData(valor, isoAtual) {
    if (!valor) return isoAtual;
    const [a, m, d] = valor.split("-").map(Number);
    const base = isoAtual ? new Date(isoAtual) : new Date();
    const nova = new Date(base);
    nova.setFullYear(a, m - 1, d);
    if (!isoAtual) nova.setHours(12, 0, 0, 0);
    return nova.toISOString();
  }
  // 5511987654321 → +55 11 98765-4321 · 351912345678 → +351 912 345 678
  function formatarTelefone(numero) {
    const d = String(numero || "").replace(/\D/g, "");
    let m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
    if (m) return `+55 ${m[1]} ${m[2]}-${m[3]}`;
    m = d.match(/^351(\d{3})(\d{3})(\d{3})$/);
    if (m) return `+351 ${m[1]} ${m[2]} ${m[3]}`;
    return d ? "+" + d : "";
  }
  // ---------- mídia nas mensagens (foto, vídeo, áudio, documento, figurinha) ----------
  function tamanhoLegivel(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
  }
  const duracao = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
  const ICONE_DOC = `<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>`;

  function htmlMidia(m) {
    const md = m.midia;
    const url = `/api/midia/${encodeURIComponent(m.id || "")}`;
    if (!m.id) return `<div class="midia-erro">Anexo indisponível</div>`;
    if (md.tipo === "imagem") return `<a class="midia-img" href="${url}" target="_blank" rel="noopener" title="Abrir a foto"><img src="${url}" alt="Foto" loading="lazy" data-midia /></a>`;
    if (md.tipo === "figurinha") return `<img class="midia-figurinha" src="${url}" alt="Figurinha" loading="lazy" data-midia />`;
    if (md.tipo === "video") return `<video class="midia-video" controls preload="none" playsinline src="${url}" data-midia></video>`;
    if (md.tipo === "audio") {
      return `<div class="midia-audio"><span class="midia-audio-icone" title="${md.ptt ? "Mensagem de voz" : "Áudio"}">${md.ptt ? "🎤" : "🎵"}</span><audio controls preload="none" src="${url}" data-midia></audio>${md.segundos ? `<small>${duracao(md.segundos)}</small>` : ""}</div>`;
    }
    const nome = md.nome || "Documento";
    const ext = (nome.includes(".") ? nome.split(".").pop() : (md.mimetype || "").split("/").pop() || "arq").slice(0, 4).toUpperCase();
    return `<div class="midia-doc">
      <span class="doc-icone">${ICONE_DOC}<b>${esc(ext)}</b></span>
      <span class="doc-info"><strong title="${esc(nome)}">${esc(nome)}</strong><small>${[tamanhoLegivel(md.tamanho), md.mimetype].filter(Boolean).map(esc).join(" · ")}</small></span>
      <span class="doc-acoes"><a href="${url}" target="_blank" rel="noopener">Abrir</a><a href="${url}?baixar=1" download>Baixar</a></span>
    </div>`;
  }

  /**
   * Mensagem respondida, mostrada acima do balão. `lista` = as mensagens da conversa (para saber
   * quem escreveu a original e poder pular até ela); `nomeOutro` = nome do contato.
   */
  function htmlCitacao(c, lista, nomeOutro) {
    const original = (lista || []).find((x) => x.id && x.id === c.id);
    const deMim = original?.direcao === "saida";
    const autor = original ? (deMim ? "Você" : nomeOutro || "Contato") : "";
    return `<button type="button" class="msg-citacao${deMim ? " de-mim" : ""}" data-ir-msg="${esc(c.id)}"${original ? "" : ` title="A mensagem original não está carregada"`}>${autor ? `<b>${esc(autor)}</b>` : ""}<span>${esc(c.texto || "Mensagem")}</span></button>`;
  }

  /** Conteúdo de um balão: citação (se respondeu a algo) + mídia + texto/legenda. */
  const conteudoDaMensagem = (m, lista, nomeOutro) =>
    (m.citacao?.id ? htmlCitacao(m.citacao, lista, nomeOutro) : "") +
    (m.midia ? htmlMidia(m) : "") +
    (m.texto ? `<span class="msg-texto">${esc(m.texto)}</span>` : "");

  // Mídia que não carregou (WhatsApp desconectado, arquivo expirado…): explica e deixa tentar de novo.
  document.addEventListener("error", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.matches?.("[data-midia]")) return;
    const url = el.getAttribute("src");
    const caixa = document.createElement("div");
    caixa.className = "midia-erro";
    caixa.innerHTML = `Não foi possível abrir este arquivo. ${estado.whatsapp.status === "conectado" ? "" : "Conecte o WhatsApp e "}<button type="button" class="link">tentar de novo</button>`;
    caixa.querySelector("button").addEventListener("click", () => {
      const novo = el.cloneNode(true);
      novo.setAttribute("src", url.split("?")[0] + "?t=" + Date.now());
      caixa.replaceWith(novo);
      if (novo.tagName === "AUDIO" || novo.tagName === "VIDEO") novo.play().catch(() => {});
    });
    (el.closest(".midia-img") || el.closest(".midia-audio") || el).replaceWith(caixa);
  }, true);

  const regiaoDe = (l) => (l.pais === "Brasil" ? l.uf : l.pais === "Portugal" ? l.distrito : "");

  function toast(mensagem, erro = false) {
    const el = document.createElement("div");
    el.className = "toast" + (erro ? " erro" : "");
    el.textContent = mensagem;
    $("#toasts").append(el);
    setTimeout(() => el.remove(), erro ? 5000 : 2800);
  }

  async function api(metodo, url, corpo) {
    const res = await fetch(url, {
      method: metodo,
      headers: corpo ? { "Content-Type": "application/json" } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Erro ${res.status}`);
    return json.data;
  }

  function opcoesRegiao(pais, selecionado, vazio = "—") {
    const lista = pais === "Brasil" ? UFS.map(([s, n]) => [s, `${s} — ${n}`]) : pais === "Portugal" ? DISTRITOS.map((d) => [d, d]) : [];
    return `<option value="">${vazio}</option>` +
      lista.map(([v, r]) => `<option value="${esc(v)}"${v === selecionado ? " selected" : ""}>${esc(r)}</option>`).join("");
  }
  const opcoesEtapa = (sel) => ETAPAS.map((e) => `<option${e === sel ? " selected" : ""}>${esc(e)}</option>`).join("");

  // ---------- filtros e ordenação ----------
  function leadsFiltrados() {
    const termo = normalizar(estado.busca.trim());
    const cidade = normalizar(estado.cidade.trim());
    const [campo, sentido] = estado.ordem.split(":");
    const fator = sentido === "asc" ? 1 : -1;
    return estado.leads
      .filter((l) => {
        if (estado.etapa && l.etapa !== estado.etapa) return false;
        if (estado.pais && l.pais !== estado.pais) return false;
        if (estado.regiao) {
          const [tipo, valor] = estado.regiao.split(":");
          if (tipo === "uf" && l.uf !== valor) return false;
          if (tipo === "d" && l.distrito !== valor) return false;
        }
        if (cidade && !normalizar(l.cidade).includes(cidade)) return false;
        if (estado.origem && (l.origem || "") !== estado.origem) return false;
        if (estado.etiqueta && !(l.etiquetas || []).some((e) => e.toLowerCase() === estado.etiqueta.toLowerCase())) return false;
        if (termo) {
          const alvo = normalizar([l.nome, l.empresa, l.cidade, l.email, l.telefone, l.cargo, l.uf, l.distrito, l.etapa, l.origem, ...(l.etiquetas || [])].join(" "));
          const soDigitos = termo.replace(/\D/g, "");
          if (!alvo.includes(termo) && !(soDigitos.length >= 4 && String(l.telefone).replace(/\D/g, "").includes(soDigitos))) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const va = campo === "criadoEm" ? new Date(a.criadoEm).getTime() : Number(a[campo]) || 0;
        const vb = campo === "criadoEm" ? new Date(b.criadoEm).getTime() : Number(b[campo]) || 0;
        return (va - vb) * fator;
      });
  }

  function preencherFiltroRegiao() {
    const sel = $("#f-regiao");
    const ufs = `<optgroup label="Brasil — UF">${UFS.map(([s, n]) => `<option value="uf:${s}">${s} — ${esc(n)}</option>`).join("")}</optgroup>`;
    const ds = `<optgroup label="Portugal — Distrito">${DISTRITOS.map((d) => `<option value="d:${esc(d)}">${esc(d)}</option>`).join("")}</optgroup>`;
    sel.innerHTML = `<option value="">Todas</option>` + (estado.pais === "Portugal" ? ds : estado.pais === "Brasil" ? ufs : ufs + ds);
    if ($$("option", sel).some((o) => o.value === estado.regiao)) sel.value = estado.regiao;
    else estado.regiao = "";
  }

  // ---------- render ----------
  function render() {
    const editando = document.activeElement?.closest?.("#tabela-corpo");
    if (editando) {
      estado.renderPendente = true; // não atropela o campo que a pessoa está editando
      renderKpis();
      return;
    }
    estado.renderPendente = false;
    atualizarOpcoesDeOrigemEEtiqueta();
    renderKpis();
    renderAbas();
    if (estado.aba === "tabela") renderTabela();
    if (estado.aba === "kanban") renderKanban();
    if (estado.aba === "whatsapp") renderWhatsApp();
    if (estado.aba === "conversas") renderConversas();
    if (estado.aba === "pedidos") renderPedidos();
    if (estado.aba === "resultados") carregarPainel();
    renderPilula();
  }

  // Filtros e sugestões de origem/etiqueta saem do que já existe nos leads.
  const ORIGENS_SUGERIDAS = ["WhatsApp", "Instagram", "Facebook", "Google", "Site", "Indicação", "Evento", "Planilha"];
  function atualizarOpcoesDeOrigemEEtiqueta() {
    const origens = [...new Set([...estado.leads.map((l) => l.origem).filter(Boolean)])].sort((a, b) => a.localeCompare(b, "pt-BR"));
    const etiquetas = [...new Map(estado.leads.flatMap((l) => l.etiquetas || []).map((e) => [e.toLowerCase(), e])).values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
    const preencher = (sel, lista, atual) => {
      const valor = atual;
      sel.innerHTML = `<option value="">Todas</option>` + lista.map((v) => `<option${v === valor ? " selected" : ""}>${esc(v)}</option>`).join("");
      if (valor && !lista.includes(valor)) sel.value = "";
    };
    preencher($("#f-origem"), origens, estado.origem);
    preencher($("#f-etiqueta"), etiquetas, estado.etiqueta);
    $("#lista-origens").innerHTML = [...new Set([...ORIGENS_SUGERIDAS, ...origens])].map((o) => `<option value="${esc(o)}"></option>`).join("");
  }

  function renderAbas() {
    $$(".aba").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === estado.aba));
    $("#painel-tabela").hidden = estado.aba !== "tabela";
    $("#painel-kanban").hidden = estado.aba !== "kanban";
    $("#painel-whatsapp").hidden = estado.aba !== "whatsapp";
    $("#painel-conversas").hidden = estado.aba !== "conversas";
    $("#painel-pedidos").hidden = estado.aba !== "pedidos";
    $("#painel-resultados").hidden = estado.aba !== "resultados";
    const semFiltros = ["whatsapp", "conversas", "pedidos", "resultados"].includes(estado.aba);
    // Pedidos e Painel têm os próprios totais
    $("#kpis").hidden = ["conversas", "pedidos", "resultados"].includes(estado.aba);
    $("#filtros").hidden = semFiltros;
    $("#btn-filtros").hidden = semFiltros;

  }

  function renderKpis() {
    const ls = estado.leads;
    const conta = (f) => ls.filter(f).length;
    const ganhos = conta((l) => l.etapa === "Ganho");
    const perdidos = conta((l) => l.etapa === "Perdido");
    const semInteresse = conta((l) => l.etapa === "Sem interesse");
    const fechados = ganhos + perdidos + semInteresse;
    const taxa = fechados ? Math.round((ganhos / fechados) * 100) : 0;
    const itens = [
      ["Total de leads", ls.length, "no funil", "var(--verde-700)"],
      ["Novos", conta((l) => l.etapa === "Novo Lead"), "aguardando contato", "#0ea5e9"],
      ["Em andamento", conta((l) => EM_ANDAMENTO.includes(l.etapa)), "IA, humano, reunião, proposta", "#f59e0b"],
      ["Ganhos", ganhos, `${moedaCompacta(ls.filter((l) => l.etapa === "Ganho").reduce((s, l) => s + (Number(l.faturamentoMensal) || 0), 0))} em faturamento/mês`, "#16a34a"],
      ["Perdidos", perdidos, `+ ${semInteresse} sem interesse`, "#dc2626"],
      ["Conversão", `${taxa}%`, "ganhos ÷ encerrados", "var(--verde-400)"],
    ];
    $("#kpis").innerHTML = itens
      .map(([t, v, s, c]) => `<div class="kpi" style="--cor:${c}"><span>${t}</span><strong>${v}</strong><small>${esc(s)}</small></div>`)
      .join("");
  }

  function linhaTabela(l) {
    const classe = CLASSE_ETAPA[l.etapa] || "";
    return `<tr data-id="${l.id}">
      <td><input type="date" data-campo="criadoEm" value="${paraInputData(l.criadoEm)}" aria-label="Data de criação" /></td>
      <td class="col-nome"><input data-campo="nome" value="${esc(l.nome)}" aria-label="Nome" /></td>
      <td><input type="email" data-campo="email" value="${esc(l.email)}" placeholder="—" aria-label="E-mail" /></td>
      <td><input type="tel" data-campo="telefone" value="${esc(l.telefone)}" placeholder="—" aria-label="Telefone" /></td>
      <td><input data-campo="cargo" value="${esc(l.cargo)}" placeholder="—" aria-label="Cargo" /></td>
      <td><input data-campo="empresa" value="${esc(l.empresa)}" placeholder="—" aria-label="Empresa" /></td>
      <td><input class="dinheiro" data-campo="faturamentoMensal" inputmode="decimal" value="${esc(moeda(l.faturamentoMensal, l.pais))}" data-bruto="${Number(l.faturamentoMensal) || 0}" aria-label="Faturamento mensal" /></td>
      <td><select data-campo="pais" aria-label="País"><option value="">—</option><option${l.pais === "Brasil" ? " selected" : ""}>Brasil</option><option${l.pais === "Portugal" ? " selected" : ""}>Portugal</option></select></td>
      <td><select data-campo="${l.pais === "Portugal" ? "distrito" : "uf"}" ${l.pais ? "" : "disabled"} aria-label="UF ou distrito">${opcoesRegiao(l.pais, regiaoDe(l), l.pais ? "Selecione" : "Escolha o país")}</select></td>
      <td><input data-campo="cidade" value="${esc(l.cidade)}" placeholder="—" aria-label="Cidade" /></td>
      <td class="${classe}"><select class="etapa" data-campo="etapa" aria-label="Etapa do funil">${opcoesEtapa(l.etapa)}</select></td>
      <td><input data-campo="origem" value="${esc(l.origem || "")}" list="lista-origens" placeholder="—" aria-label="Origem" /></td>
      <td><input class="etiquetas-celula" data-campo="etiquetas" value="${esc((l.etiquetas || []).join(", "))}" placeholder="—" title="Separe por vírgula" aria-label="Etiquetas" /></td>
      <td><input class="obs" data-campo="observacoes" value="${esc((l.observacoes || "").split("\n").pop())}" title="${esc(l.observacoes)}" placeholder="Adicionar nota…" aria-label="Observações" /></td>
      <td class="col-acoes">
        <button class="icone-btn" data-acao="abrir" title="Abrir / editar"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg></button>
        <button class="icone-btn wa" data-acao="whatsapp" title="WhatsApp"><svg viewBox="0 0 24 24"><path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z" /></svg></button>
        <button class="icone-btn del" data-acao="excluir" title="Excluir"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg></button>
      </td>
    </tr>`;
  }

  function renderTabela() {
    const lista = leadsFiltrados();
    $("#tabela-corpo").innerHTML = lista.map(linhaTabela).join("");
    $("#tabela-vazia").hidden = lista.length > 0;
    const [campo, sentido] = estado.ordem.split(":");
    $$("#tabela th.ordenavel").forEach((th) => {
      th.classList.toggle("asc", th.dataset.ordem === campo && sentido === "asc");
      th.classList.toggle("desc", th.dataset.ordem === campo && sentido === "desc");
    });
  }

  function cartaoKanban(l) {
    const local = [l.cidade, regiaoDe(l)].filter(Boolean).join(" · ");
    return `<article class="cartao ${CLASSE_ETAPA[l.etapa] || ""}" data-id="${l.id}" tabindex="0">
      <div class="cartao-topo">
        <h4>${esc(l.nome)}</h4>
        <span class="alca" title="Arrastar"><svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></svg></span>
      </div>
      ${l.empresa ? `<p><svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4" /></svg>${esc(l.empresa)}${l.cargo ? ` · ${esc(l.cargo)}` : ""}</p>` : ""}
      ${local ? `<p><svg viewBox="0 0 24 24"><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>${esc(local)}</p>` : ""}
      ${(l.etiquetas || []).length ? `<div class="etiquetas">${l.etiquetas.map((e) => `<span class="etiqueta">${esc(e)}</span>`).join("")}</div>` : ""}
      ${badgeTarefa(l)}
      ${badgeFollowup(l)}
      <div class="cartao-rodape">
        <span class="valor">${moeda(l.faturamentoMensal, l.pais)}<small style="font-weight:500;color:var(--texto-suave)">/mês</small></span>
        <span class="data">${dataCurta(l.criadoEm)}</span>
      </div>
      <select class="mover" aria-label="Mover para etapa">${opcoesEtapa(l.etapa)}</select>
    </article>`;
  }

  function botaoRegrasDaEtapa(etapa) {
    const daEtapa = (estado.config.regrasFollowup || []).filter((r) => r.etapa === etapa);
    const ativas = daEtapa.filter((r) => r.ativo).length;
    const titulo = daEtapa.length ? `${ativas} de ${daEtapa.length} follow-up(s) automático(s) ativo(s) nesta etapa` : "Criar follow-up automático para esta etapa";
    return `<button type="button" class="regras-etapa${ativas ? " ativas" : ""}" data-regras-etapa="${esc(etapa)}" title="${titulo}"><svg viewBox="0 0 24 24"><path d="M13 3L5 13h6l-1 8 8-10h-6z" /></svg>${ativas || (daEtapa.length ? "0" : "+")}</button>`;
  }

  function renderKanban() {
    const lista = leadsFiltrados();
    $("#kanban").innerHTML = ETAPAS.map((etapa) => {
      const doEstagio = lista.filter((l) => l.etapa === etapa);
      const soma = doEstagio.reduce((s, l) => s + (Number(l.faturamentoMensal) || 0), 0);
      return `<section class="coluna ${CLASSE_ETAPA[etapa]}" data-etapa="${esc(etapa)}">
        <header class="coluna-topo"><span class="ponto"></span><h3>${esc(etapa)}</h3>${botaoRegrasDaEtapa(etapa)}<span class="contagem">${doEstagio.length}</span></header>
        <div class="coluna-soma">${moedaCompacta(soma)} em faturamento/mês</div>
        <div class="coluna-cartoes">${doEstagio.map(cartaoKanban).join("") || `<div class="coluna-vazia">Arraste leads para cá</div>`}</div>
      </section>`;
    }).join("");
  }

  const ROTULO_WA = {
    desconectado: "Desconectado",
    conectando: "Conectando…",
    aguardando_qr: "Aguardando leitura do QR",
    conectado: "Conectado",
    reconectando: "Reconectando…",
  };

  const PILULA_WA = {
    desconectado: "WhatsApp desconectado",
    conectando: "Conectando WhatsApp…",
    aguardando_qr: "Leia o QR Code",
    conectado: "WhatsApp conectado",
    reconectando: "Reconectando WhatsApp…",
  };

  function renderPilula() {
    const s = estado.whatsapp.status;
    const p = $("#wa-pilula");
    const completo = PILULA_WA[s] + (estado.whatsapp.simulado ? " (demonstração)" : "");
    // No celular só cabe "WhatsApp"; a cor da bolinha continua mostrando o status.
    p.innerHTML = `<span class="pilula-longa">${esc(completo)}</span><span class="pilula-curta">WhatsApp</span>`;
    p.title = completo;
    p.className = "wa-pilula" + (s === "conectado" ? " on" : s === "desconectado" ? "" : " espera");
  }

  function renderWhatsApp() {
    const { status, qr, conta, erro } = estado.whatsapp;
    const selo = $("#wa-status");
    selo.textContent = ROTULO_WA[status];
    selo.className = "selo" + (status === "conectado" ? " on" : status === "desconectado" ? "" : " espera");

    let caixa;
    if (status === "conectado") {
      caixa = `<div class="wa-qr-conectado"><div class="circulo"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10" /></svg></div>
        <strong>WhatsApp conectado</strong><span>${conta?.nome ? esc(conta.nome) + "<br />" : ""}${conta?.numero ? esc(formatarTelefone(conta.numero)) : ""}</span></div>`;
    } else if (status === "aguardando_qr" && qr) {
      caixa = `<img src="${qr}" alt="QR Code para conectar o WhatsApp" />`;
    } else if (status === "conectando" || status === "reconectando") {
      caixa = `<div class="wa-qr-vazio"><div class="carregando"></div><span>${ROTULO_WA[status]}</span></div>`;
    } else {
      caixa = `<div class="wa-qr-vazio"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3M21 14v7h-7" /></svg><span>O QR Code aparece aqui</span></div>`;
    }
    $("#wa-qr").innerHTML = caixa;
    $("#wa-descricao").innerHTML = erro
      ? `<span class="erro-wa">${esc(erro)}</span>`
      : status === "conectado"
        ? "Tudo pronto: envie mensagens pelos leads e receba as respostas no histórico."
        : "Conecte o seu WhatsApp lendo o QR Code com o celular.";
    $("#wa-instrucoes").hidden = status === "conectado";
    $("#btn-wa-conectar").hidden = status !== "desconectado";
    $("#btn-wa-desconectar").hidden = status === "desconectado";
    $("#btn-wa-desconectar").textContent = status === "conectado" ? "Desconectar" : "Cancelar";
    $("#cfg-auto").checked = !!estado.config.autoCriarLeads;
    renderDiagnostico();
    renderAutomacao();
  }

  // ---------- diagnóstico da sincronização (aba WhatsApp) ----------
  function renderDiagnostico() {
    const d = estado.whatsapp.diagnostico;
    const caixa = $("#wa-diagnostico");
    caixa.hidden = !d || estado.whatsapp.status !== "conectado";
    if (caixa.hidden) return;
    const quando = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
    const minutosConectado = d.conectadoEm ? (Date.now() - new Date(d.conectadoEm).getTime()) / 60000 : 0;
    const linhas = [
      ["Conectado desde", quando(d.conectadoEm)],
      ["Lotes de histórico recebidos do celular", d.lotesHistorico],
      ["Conversas recebidas", d.conversasRecebidas],
      ["Mensagens do histórico", d.mensagensHistorico],
      ["Mensagens recebidas ao vivo", d.mensagensAoVivo],
      ["Mensagens que não puderam ser lidas (criptografia)", d.naoDescriptografadas],
      ["Recuperadas depois de pedir reenvio", d.recuperadas ?? 0],
      ["Última mensagem recebida", quando(d.ultimaMensagemEm)],
      ["Último erro", d.ultimoErro || "nenhum"],
    ];
    const avisos = [];
    if (!d.lotesHistorico && minutosConectado > 2) {
      avisos.push("O celular não mandou o histórico de conversas. Ele só faz isso quando o aparelho é <strong>conectado pela primeira vez</strong>: para receber as conversas antigas, clique em <strong>Desconectar</strong> e leia o QR Code de novo.");
    }
    if (d.naoDescriptografadas) {
      avisos.push(d.sessaoNova
        ? "Algumas mensagens chegaram mas ainda não puderam ser lidas. Logo depois de conectar isso é normal: o sistema pede ao remetente que reenvie e elas aparecem em seguida (contam como “recuperadas”). Se o número só aumentar por mais de 10 minutos, desconecte e leia o QR Code de novo."
        : "Mensagens estão chegando ilegíveis. Clique em <strong>Desconectar</strong>, depois em <strong>Gerar QR Code</strong>, e leia com o celular para criar uma conexão nova.");
    }
    $("#wa-diag-conteudo").innerHTML =
      `<dl>${linhas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join("")}</dl>` +
      avisos.map((a) => `<p class="diag-aviso">${a}</p>`).join("") +
      `<p class="dica">O registro detalhado fica no arquivo <code>data/whatsapp.log</code>.</p>`;
  }
  // Os números mudam sem aviso (a cada mensagem): atualiza enquanto a aba WhatsApp está aberta.
  setInterval(async () => {
    if (estado.aba !== "whatsapp" || estado.whatsapp.status !== "conectado" || document.hidden) return;
    try {
      estado.whatsapp = await api("GET", "/api/whatsapp");
      renderDiagnostico();
    } catch {
      /* tenta de novo no próximo ciclo */
    }
  }, 5000);

  // ---------- dados ----------
  async function carregarLeads() {
    estado.leads = await api("GET", "/api/leads");
    render();
    if (estado.leadAberto) {
      const atual = estado.leads.find((l) => l.id === estado.leadAberto);
      if (atual) {
        renderMensagens(atual);
        renderFollowupsLead(atual);
      }
    }
  }

  function substituir(lead) {
    const i = estado.leads.findIndex((l) => l.id === lead.id);
    if (i >= 0) estado.leads[i] = lead;
    else estado.leads.unshift(lead);
  }

  async function salvarCampo(id, campos) {
    const lead = await api("PATCH", `/api/leads/${id}`, campos);
    substituir(lead);
    return lead;
  }

  async function excluir(id) {
    const lead = estado.leads.find((l) => l.id === id);
    if (!lead || !confirm(`Excluir o lead “${lead.nome}”? Essa ação não pode ser desfeita.`)) return false;
    await api("DELETE", `/api/leads/${id}`);
    estado.leads = estado.leads.filter((l) => l.id !== id);
    render();
    toast("Lead excluído");
    return true;
  }

  async function moverEtapa(id, etapa) {
    const lead = estado.leads.find((l) => l.id === id);
    if (!lead || lead.etapa === etapa) return;
    const anterior = lead.etapa;
    lead.etapa = etapa; // otimista
    render();
    try {
      await salvarCampo(id, { etapa });
      toast(`“${lead.nome}” movido para ${etapa}`);
    } catch (e) {
      lead.etapa = anterior;
      render();
      toast(e.message, true);
    }
  }

  // ---------- tabela: edição inline ----------
  $("#tabela-corpo").addEventListener("focusin", (e) => {
    const el = e.target;
    if (el.dataset.campo === "faturamentoMensal") el.value = el.dataset.bruto === "0" ? "" : el.dataset.bruto;
  });

  $("#tabela-corpo").addEventListener("focusout", (e) => {
    const el = e.target;
    if (el.dataset.campo === "faturamentoMensal" && !el.dataset.salvando) {
      const linha = estado.leads.find((l) => l.id === el.closest("tr").dataset.id);
      if (linha) el.value = moeda(linha.faturamentoMensal, linha.pais);
    }
    setTimeout(() => {
      if (estado.renderPendente && !document.activeElement?.closest?.("#tabela-corpo")) render();
    }, 0);
  });

  $("#tabela-corpo").addEventListener("change", async (e) => {
    const el = e.target;
    const campo = el.dataset.campo;
    if (!campo) return;
    const tr = el.closest("tr");
    const id = tr.dataset.id;
    const lead = estado.leads.find((l) => l.id === id);
    let valor = el.value;
    const campos = {};

    if (campo === "faturamentoMensal") {
      valor = parseDinheiro(valor);
      if (Number.isNaN(valor)) { el.classList.add("invalido"); toast("Faturamento inválido", true); return; }
    }
    if (campo === "criadoEm") valor = deInputData(valor, lead.criadoEm);
    if (campo === "nome" && !valor.trim()) { el.value = lead.nome; toast("O nome não pode ficar vazio", true); return; }
    if (campo === "observacoes") {
      // A célula mostra a última linha; editar troca só ela e preserva o histórico.
      const linhas = (lead.observacoes || "").split("\n");
      linhas[linhas.length - 1] = valor;
      valor = linhas.join("\n").trim();
    }
    campos[campo] = valor;
    if (campo === "pais") { campos.uf = ""; campos.distrito = ""; }

    el.classList.remove("invalido");
    el.dataset.salvando = "1";
    try {
      const novo = await salvarCampo(id, campos);
      if (["pais", "etapa", "faturamentoMensal", "etiquetas"].includes(campo)) {
        const foco = document.activeElement === el;
        tr.outerHTML = linhaTabela(novo);
        const novaLinha = $(`#tabela-corpo tr[data-id="${id}"]`);
        if (foco) $(`[data-campo="${campo}"]`, novaLinha)?.focus();
        novaLinha?.classList.add("salvo");
      } else {
        el.closest("td").classList.add("salvo");
        setTimeout(() => el.closest("td")?.classList.remove("salvo"), 900);
      }
      renderKpis();
    } catch (err) {
      el.classList.add("invalido");
      toast(err.message, true);
    } finally {
      delete el.dataset.salvando;
    }
  });

  $("#tabela-corpo").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input")) e.target.blur();
  });

  $("#tabela-corpo").addEventListener("click", (e) => {
    const botao = e.target.closest("[data-acao]");
    if (!botao) return;
    const id = botao.closest("tr").dataset.id;
    if (botao.dataset.acao === "abrir") abrirModal(id);
    if (botao.dataset.acao === "whatsapp") abrirModal(id, { focoWhatsApp: true });
    if (botao.dataset.acao === "excluir") excluir(id).catch((err) => toast(err.message, true));
  });

  $$("#tabela th.ordenavel").forEach((th) =>
    th.addEventListener("click", () => {
      const [campo, sentido] = estado.ordem.split(":");
      estado.ordem = `${th.dataset.ordem}:${campo === th.dataset.ordem && sentido === "desc" ? "asc" : "desc"}`;
      $("#f-ordem").value = estado.ordem;
      render();
    }),
  );

  // ---------- kanban: arrastar e soltar (mouse e toque) ----------
  let arrasto = null;
  let acabouDeArrastar = false;
  const kanban = $("#kanban");

  kanban.addEventListener("pointerdown", (e) => {
    const cartao = e.target.closest(".cartao");
    if (!cartao || e.button !== 0 || e.target.closest("select,button")) return;
    // No toque, o cartão inteiro rola a tela; arrasta-se pela alça.
    if (e.pointerType !== "mouse" && !e.target.closest(".alca")) return;
    const r = cartao.getBoundingClientRect();
    arrasto = { cartao, id: cartao.dataset.id, x0: e.clientX, y0: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, largura: r.width, ativo: false, coluna: null };
    if (e.pointerType !== "mouse") e.preventDefault();
  });

  document.addEventListener("pointermove", (e) => {
    if (!arrasto) return;
    if (!arrasto.ativo) {
      if (Math.hypot(e.clientX - arrasto.x0, e.clientY - arrasto.y0) < 6) return;
      arrasto.ativo = true;
      const fantasma = arrasto.cartao.cloneNode(true);
      fantasma.classList.add("cartao-fantasma");
      fantasma.style.width = arrasto.largura + "px";
      document.body.append(fantasma);
      arrasto.fantasma = fantasma;
      arrasto.cartao.classList.add("arrastando");
      document.body.style.userSelect = "none";
    }
    e.preventDefault();
    arrasto.fantasma.style.left = e.clientX - arrasto.dx + "px";
    arrasto.fantasma.style.top = e.clientY - arrasto.dy + "px";
    const coluna = document.elementFromPoint(e.clientX, e.clientY)?.closest(".coluna");
    if (coluna !== arrasto.coluna) {
      arrasto.coluna?.classList.remove("alvo");
      coluna?.classList.add("alvo");
      arrasto.coluna = coluna;
    }
    // rolagem automática perto das bordas do quadro
    const caixa = kanban.getBoundingClientRect();
    if (e.clientX > caixa.right - 60) kanban.scrollLeft += 14;
    else if (e.clientX < caixa.left + 60) kanban.scrollLeft -= 14;
  }, { passive: false });

  function terminarArrasto(e, cancelado) {
    if (!arrasto) return;
    const a = arrasto;
    arrasto = null;
    if (!a.ativo) return;
    acabouDeArrastar = true;
    setTimeout(() => (acabouDeArrastar = false), 50);
    a.fantasma.remove();
    a.cartao.classList.remove("arrastando");
    a.coluna?.classList.remove("alvo");
    document.body.style.userSelect = "";
    if (!cancelado && a.coluna) moverEtapa(a.id, a.coluna.dataset.etapa);
  }
  document.addEventListener("pointerup", (e) => terminarArrasto(e, false));
  document.addEventListener("pointercancel", (e) => terminarArrasto(e, true));
  document.addEventListener("keydown", (e) => e.key === "Escape" && terminarArrasto(e, true));

  kanban.addEventListener("click", (e) => {
    const botaoRegras = e.target.closest("[data-regras-etapa]");
    if (botaoRegras) return abrirRegrasDaEtapa(botaoRegras.dataset.regrasEtapa);
    const cartao = e.target.closest(".cartao");
    if (!cartao || acabouDeArrastar || e.target.closest("select,.alca")) return;
    abrirModal(cartao.dataset.id);
  });
  kanban.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches(".cartao")) abrirModal(e.target.dataset.id);
  });
  kanban.addEventListener("change", (e) => {
    if (e.target.matches(".mover")) moverEtapa(e.target.closest(".cartao").dataset.id, e.target.value);
  });

  // ---------- modal ----------
  const modal = $("#modal");
  const form = $("#form-lead");

  function atualizarCamposRegiao(pais, uf = "", distrito = "") {
    $("#campo-uf").hidden = pais !== "Brasil";
    $("#campo-distrito").hidden = pais !== "Portugal";
    form.uf.innerHTML = opcoesRegiao("Brasil", uf, "Selecione a UF");
    form.distrito.innerHTML = opcoesRegiao("Portugal", distrito, "Selecione o distrito");
  }

  /**
   * Desenha os balões só acrescentando as mensagens novas: redesenhar tudo destruiria o áudio ou
   * vídeo que está tocando sempre que chegasse qualquer mensagem.
   */
  function renderBaloes(caixa, chave, mensagens, montar, vazio) {
    const ids = mensagens.map((m) => m.id || m.em);
    const antes = caixa._ids || [];
    const soAcrescentou = caixa._chave === chave && antes.length > 0 && antes.length <= ids.length && antes.every((id, i) => id === ids[i]);
    if (soAcrescentou && antes.length === ids.length) return;
    if (soAcrescentou) caixa.insertAdjacentHTML("beforeend", montar(mensagens.slice(antes.length), mensagens[antes.length - 1]));
    else caixa.innerHTML = mensagens.length ? montar(mensagens, null) : vazio;
    caixa._ids = ids;
    caixa._chave = chave;
  }
  const classeBalao = (m) => `msg ${m.direcao === "saida" ? "saida" : "entrada"}${m.midia ? " com-midia" : ""}`;

  function renderMensagens(lead) {
    const caixa = $("#mensagens");
    const pertoDoFim = caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight < 80;
    const mudouDeLead = caixa._chave !== lead.id;
    renderBaloes(caixa, lead.id, lead.mensagens || [], (lista) =>
      lista.map((m) => `<div class="${classeBalao(m)}" data-msg="${esc(m.id || "")}">${conteudoDaMensagem(m, lead.mensagens, lead.nome)}<time>${new Date(m.em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time></div>`).join(""),
      `<div class="sem-msg">Nenhuma mensagem trocada com este lead ainda.</div>`);
    if (mudouDeLead || pertoDoFim) caixa.scrollTop = caixa.scrollHeight;
    atualizarAvisoWhatsApp(lead);
  }

  function atualizarAvisoWhatsApp(lead) {
    const conectado = estado.whatsapp.status === "conectado";
    const semTelefone = !lead?.telefone;
    $("#btn-wa-enviar").disabled = !conectado || semTelefone;
    $("#wa-aviso-modal").innerHTML = semTelefone
      ? "Cadastre um telefone para conversar pelo WhatsApp."
      : conectado
        ? ""
        : `WhatsApp desconectado. <a href="#" data-ir-whatsapp>Conecte pelo QR Code</a> para enviar mensagens.`;
  }

  function abrirModal(id = null, { focoWhatsApp = false, preencher = null } = {}) {
    const lead = id ? estado.leads.find((l) => l.id === id) : null;
    estado.leadAberto = lead?.id || null;
    estado.novoLeadJid = (!lead && preencher?.whatsappJid) || null;
    form.reset();
    $$(".invalido", form).forEach((el) => el.classList.remove("invalido"));
    form.etapa.innerHTML = opcoesEtapa(lead?.etapa || preencher?.etapa || "Novo Lead");
    $("#modal-titulo").textContent = lead ? lead.nome : estado.novoLeadJid ? "Novo lead do WhatsApp" : "Novo lead";
    $("#btn-excluir").hidden = !lead;
    $("#bloco-nota").hidden = !lead;
    $("#bloco-wa").hidden = !lead;
    $("#bloco-followups").hidden = !lead;
    $("#bloco-pedidos").hidden = !lead;
    $("#bloco-tarefas").hidden = !lead;
    $("#btn-salvar").textContent = lead ? "Salvar alterações" : "Criar lead";

    const v = lead || { pais: "", criadoEm: new Date().toISOString(), ...(preencher || {}) };
    for (const campo of ["nome", "email", "telefone", "cargo", "empresa", "cidade", "observacoes", "origem"]) form[campo].value = v[campo] || "";
    form.etiquetas.value = (v.etiquetas || []).join(", ");
    form.faturamentoMensal.value = lead ? v.faturamentoMensal || "" : "";
    form.criadoEm.value = paraInputData(v.criadoEm);
    form.pais.value = v.pais || "";
    atualizarCamposRegiao(v.pais, v.uf, v.distrito);
    if (lead) {
      renderMensagens(lead);
      compositorLead.renderAtalhos();
      atualizarLinkConversa(lead);
      renderPedidosLead(lead);
      renderTarefasLead(lead);
      prepararNovaTarefa($("[data-nova-tarefa=lead]"));
      renderFollowupsLead(lead);
      prepararAgendamento();
    }
    $("#wa-texto").value = "";

    modal.showModal();
    if (focoWhatsApp && lead) {
      $("#bloco-wa").scrollIntoView({ block: "end" });
      $("#wa-texto").focus();
    } else if (!lead) form.nome.focus();
  }

  function fecharModal() {
    estado.leadAberto = null;
    modal.close();
  }

  form.pais.addEventListener("change", () => atualizarCamposRegiao(form.pais.value));
  $$("[data-fechar]", modal).forEach((b) => b.addEventListener("click", fecharModal));
  modal.addEventListener("close", () => (estado.leadAberto = null));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) fecharModal(); // clique no fundo escuro
    if (e.target.matches("[data-ir-whatsapp]")) {
      e.preventDefault();
      fecharModal();
      trocarAba("whatsapp");
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    $$(".invalido", form).forEach((el) => el.classList.remove("invalido"));
    const nome = form.nome.value.trim();
    const email = form.email.value.trim();
    if (!nome) { form.nome.classList.add("invalido"); form.nome.focus(); toast("Informe o nome do lead", true); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { form.email.classList.add("invalido"); form.email.focus(); toast("E-mail inválido", true); return; }
    const fat = form.faturamentoMensal.value === "" ? 0 : Number(form.faturamentoMensal.value);
    if (!Number.isFinite(fat) || fat < 0) { form.faturamentoMensal.classList.add("invalido"); toast("Faturamento inválido", true); return; }

    const atual = estado.leads.find((l) => l.id === estado.leadAberto);
    const pais = form.pais.value;
    const dados = {
      nome, email,
      telefone: form.telefone.value.trim(),
      cargo: form.cargo.value.trim(),
      empresa: form.empresa.value.trim(),
      cidade: form.cidade.value.trim(),
      observacoes: form.observacoes.value.trim(),
      faturamentoMensal: fat,
      criadoEm: deInputData(form.criadoEm.value, atual?.criadoEm),
      pais,
      uf: pais === "Brasil" ? form.uf.value : "",
      distrito: pais === "Portugal" ? form.distrito.value : "",
      etapa: form.etapa.value,
      origem: form.origem.value.trim(),
      etiquetas: form.etiquetas.value,
    };
    if (!atual && estado.novoLeadJid) dados.whatsappJid = estado.novoLeadJid; // veio da aba Conversas
    const botao = $("#btn-salvar");
    botao.disabled = true;
    try {
      const lead = atual ? await api("PATCH", `/api/leads/${atual.id}`, dados) : await api("POST", "/api/leads", dados);
      substituir(lead);
      fecharModal();
      render();
      toast(atual ? "Lead atualizado" : dados.whatsappJid ? "Lead criado a partir da conversa" : "Lead criado");
      if (dados.whatsappJid) {
        await carregarConversas();
        if (estado.conversaAberta === dados.whatsappJid) await abrirConversa(dados.whatsappJid, { rolar: false });
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      botao.disabled = false;
    }
  });

  $("#btn-excluir").addEventListener("click", async () => {
    try {
      if (await excluir(estado.leadAberto)) fecharModal();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function adicionarNota() {
    const campo = $("#nota-texto");
    const texto = campo.value.trim();
    if (!texto || !estado.leadAberto) return;
    try {
      const lead = await api("POST", `/api/leads/${estado.leadAberto}/notas`, { texto });
      substituir(lead);
      form.observacoes.value = lead.observacoes;
      campo.value = "";
      render();
      toast("Nota adicionada");
    } catch (err) {
      toast(err.message, true);
    }
  }
  $("#btn-nota").addEventListener("click", adicionarNota);
  $("#nota-texto").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); adicionarNota(); }
  });

  async function enviarWhatsApp() {
    const campo = $("#wa-texto");
    const texto = campo.value.trim();
    if (!texto || !estado.leadAberto) return;
    const botao = $("#btn-wa-enviar");
    botao.disabled = true;
    try {
      const lead = await api("POST", `/api/leads/${estado.leadAberto}/whatsapp`, { texto });
      substituir(lead);
      renderMensagens(lead);
      campo.value = "";
      toast("Mensagem enviada pelo WhatsApp");
    } catch (err) {
      toast(err.message, true);
    } finally {
      atualizarAvisoWhatsApp(estado.leads.find((l) => l.id === estado.leadAberto));
    }
  }
  $("#btn-wa-enviar").addEventListener("click", enviarWhatsApp);

  // ---------- respostas rápidas e follow-ups ----------
  const ICONE_RELOGIO = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>`;
  const ICONE_RAIO = `<svg viewBox="0 0 24 24"><path d="M13 3L5 13h6l-1 8 8-10h-6z" /></svg>`;
  const respostas = () => estado.config.respostasRapidas || [];
  const regras = () => estado.config.regrasFollowup || [];

  // Mesma regra do servidor (store.mjs → preencherVariaveis).
  function preencherVariaveis(texto, lead) {
    const nome = (lead?.nome || "").trim();
    const valores = { nome, primeiro_nome: nome.split(/\s+/)[0] || "", empresa: lead?.empresa || "", cargo: lead?.cargo || "", cidade: lead?.cidade || "", etapa: lead?.etapa || "" };
    return String(texto || "").replace(/\{(\w+)\}/g, (todo, chave) => (chave in valores ? valores[chave] : todo));
  }

  function descreverEspera(min) {
    if (!min) return "na hora";
    if (min % 1440 === 0) return `${min / 1440} dia${min === 1440 ? "" : "s"}`;
    if (min % 60 === 0) return `${min / 60} h`;
    return `${min} min`;
  }

  function relativo(iso) {
    const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (min <= 0) return "agora";
    if (min < 60) return `em ${min} min`;
    if (min < 1440) return `em ${Math.round(min / 60)} h`;
    const d = Math.round(min / 1440);
    return `em ${d} dia${d === 1 ? "" : "s"}`;
  }
  const dataHora = (iso) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  const proximoFollowup = (l) =>
    (l.followups || []).filter((f) => f.status === "pendente").sort((a, b) => new Date(a.agendadoPara) - new Date(b.agendadoPara))[0];

  function badgeFollowup(l) {
    if (l.optOut) return `<p class="selo-fu bloqueado" title="O lead pediu para não receber mensagens automáticas">Não contatar</p>`;
    const f = proximoFollowup(l);
    if (!f) return "";
    const pendentes = (l.followups || []).filter((x) => x.status === "pendente").length;
    return `<p class="selo-fu" title="Próximo follow-up: ${esc(dataHora(f.agendadoPara))}">${ICONE_RELOGIO}Follow-up ${relativo(f.agendadoPara)}${pendentes > 1 ? ` · +${pendentes - 1}` : ""}</p>`;
  }

  function textoDoFollowup(f, lead) {
    if (f.status === "enviado" && f.texto) return f.texto;
    const regra = f.regraId ? regras().find((r) => r.id === f.regraId) : null;
    return preencherVariaveis(regra ? regra.texto : f.texto, lead);
  }
  function origemDoFollowup(f) {
    if (f.origem !== "regra") return "Manual";
    const regra = regras().find((r) => r.id === f.regraId);
    return regra ? `Regra “${regra.nome || regra.etapa}”` : "Regra excluída";
  }

  // ---- aba WhatsApp: listas ----
  function renderRespostas() {
    const lista = respostas();
    $("#lista-respostas").innerHTML = lista.length
      ? lista.map((r) => `<div class="item" data-resposta="${r.id}">
          <div class="item-corpo"><strong><code>/${esc(r.atalho)}</code> ${esc(r.titulo || "")}</strong><span>${esc(r.texto)}</span></div>
          <button class="icone-btn" data-editar-resposta="${r.id}" title="Editar"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg></button>
        </div>`).join("")
      : `<p class="sem-msg">Nenhuma resposta rápida ainda.</p>`;
  }

  function itemRegra(r) {
    return `<div class="item regra ${r.ativo ? "" : "pausada"}">
      <label class="interruptor mini" title="${r.ativo ? "Pausar" : "Ativar"}"><input type="checkbox" data-ativar-regra="${r.id}" ${r.ativo ? "checked" : ""} /><span class="trilho"></span></label>
      <div class="item-corpo">
        <strong>${esc(r.nome || "Follow-up")} <span class="tag">${r.ativo ? "ativa" : "pausada"}</span></strong>
        <span class="fluxo">Após <b>${descreverEspera(r.aposMinutos)}</b> na etapa → envia mensagem${r.moverPara ? ` → move para <b>${esc(r.moverPara)}</b>` : ""}${r.cancelarSeResponder ? " · para se o lead responder" : ""}</span>
        <span>${esc(r.texto)}</span>
      </div>
      <button class="icone-btn" data-editar-regra="${r.id}" title="Editar"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg></button>
    </div>`;
  }

  function listaRegras(etapa) {
    const ordenadas = (lista) => [...lista].sort((a, b) => a.aposMinutos - b.aposMinutos);
    if (etapa) {
      const daEtapa = ordenadas(regras().filter((r) => r.etapa === etapa));
      return daEtapa.length ? daEtapa.map(itemRegra).join("") : `<p class="sem-msg">Nenhuma regra nesta etapa ainda.</p>`;
    }
    const grupos = ETAPAS.map((e) => [e, ordenadas(regras().filter((r) => r.etapa === e))]).filter(([, rs]) => rs.length);
    return grupos.length
      ? grupos.map(([e, rs]) => `<div class="grupo-etapa ${CLASSE_ETAPA[e]}"><h4><span class="ponto"></span>${esc(e)}</h4>${rs.map(itemRegra).join("")}</div>`).join("")
      : `<p class="sem-msg">Nenhuma regra criada. Clique em “Nova regra”.</p>`;
  }

  function renderProximos() {
    const pendentes = estado.leads
      .flatMap((l) => (l.followups || []).filter((f) => f.status === "pendente").map((f) => ({ l, f })))
      .sort((a, b) => new Date(a.f.agendadoPara) - new Date(b.f.agendadoPara));
    const wa = estado.whatsapp.status === "conectado";
    $("#proximos-resumo").textContent = !pendentes.length
      ? "Nenhum follow-up agendado."
      : `${pendentes.length} agendado${pendentes.length === 1 ? "" : "s"}${wa ? "" : " · aguardando o WhatsApp conectar para enviar"}`;
    $("#lista-proximos").innerHTML = pendentes.slice(0, 50).map(({ l, f }) => `<div class="item">
        <div class="item-corpo">
          <strong><a href="#" data-abrir-lead="${l.id}">${esc(l.nome)}</a> <span class="tag">${relativo(f.agendadoPara)}</span></strong>
          <span class="fluxo">${esc(dataHora(f.agendadoPara))} · ${esc(origemDoFollowup(f))}${f.motivo ? ` · <em>${esc(f.motivo)}</em>` : ""}</span>
          <span>${esc(textoDoFollowup(f, l))}</span>
        </div>
        <div class="item-acoes">
          <button class="btn btn-secundario mini" data-fu-enviar="${f.id}" data-lead="${l.id}" ${wa ? "" : "disabled"}>Enviar agora</button>
          <button class="btn btn-fantasma mini" data-fu-cancelar="${f.id}" data-lead="${l.id}">Cancelar</button>
        </div>
      </div>`).join("") || `<p class="sem-msg">Quando uma regra ou um agendamento manual criar um follow-up, ele aparece aqui.</p>`;
  }

  function renderAutomacao() {
    renderRespostas();
    renderProximos();
    $("#lista-regras").innerHTML = listaRegras();
    const { inicio, fim } = estado.config.janela || { inicio: 8, fim: 21 };
    const horas = (sel) => Array.from({ length: 25 }, (_, h) => `<option value="${h}"${h === sel ? " selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("");
    $("#janela-inicio").innerHTML = horas(inicio);
    $("#janela-fim").innerHTML = horas(fim);
  }

  async function recarregarConfig() {
    estado.config = await api("GET", "/api/config");
    render();
    if (modalEtapa.open) $("#etapa-regras").innerHTML = listaRegras(etapaDoModal);
    if (estado.leadAberto) renderFollowupsLead(estado.leads.find((l) => l.id === estado.leadAberto));
  }

  async function janelaMudou() {
    try {
      estado.config = await api("PATCH", "/api/config", { janela: { inicio: Number($("#janela-inicio").value), fim: Number($("#janela-fim").value) } });
      toast("Janela de envio atualizada");
    } catch (err) {
      toast(err.message, true);
      renderAutomacao();
    }
  }
  $("#janela-inicio").addEventListener("change", janelaMudou);
  $("#janela-fim").addEventListener("change", janelaMudou);

  // ações em listas (aba WhatsApp, modal da etapa e modal do lead)
  async function acaoFollowup(botao) {
    const leadId = botao.dataset.lead;
    const enviar = "fuEnviar" in botao.dataset;
    const fid = enviar ? botao.dataset.fuEnviar : botao.dataset.fuCancelar;
    if (!enviar && !confirm("Cancelar este follow-up?")) return;
    botao.disabled = true;
    try {
      const lead = enviar ? await api("POST", `/api/leads/${leadId}/followups/${fid}/enviar`) : await api("DELETE", `/api/leads/${leadId}/followups/${fid}`);
      substituir(lead);
      render();
      if (estado.leadAberto === leadId) { renderFollowupsLead(lead); renderMensagens(lead); }
      toast(enviar ? "Follow-up enviado" : "Follow-up cancelado");
    } catch (err) {
      toast(err.message, true);
      botao.disabled = false;
    }
  }

  document.addEventListener("click", (e) => {
    const alvo = e.target.closest("[data-editar-resposta],[data-editar-regra],[data-fu-enviar],[data-fu-cancelar],[data-abrir-lead]");
    if (!alvo) return;
    if (alvo.dataset.editarResposta) abrirResposta(alvo.dataset.editarResposta);
    else if (alvo.dataset.editarRegra) abrirRegra(alvo.dataset.editarRegra);
    else if (alvo.dataset.abrirLead) { e.preventDefault(); abrirModal(alvo.dataset.abrirLead); }
    else acaoFollowup(alvo);
  });
  document.addEventListener("change", async (e) => {
    const id = e.target.dataset?.ativarRegra;
    if (!id) return;
    try {
      await api("PATCH", `/api/regras/${id}`, { ativo: e.target.checked });
      toast(e.target.checked ? "Regra ativada — vale para leads que entrarem na etapa" : "Regra pausada e envios pendentes dela cancelados");
      await recarregarConfig();
      await carregarLeads();
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, true);
    }
  });

  // ---- editor de resposta rápida ----
  const modalResposta = $("#modal-resposta");
  const formResposta = $("#form-resposta");
  let respostaEditada = null;

  function abrirResposta(id = null) {
    const r = id ? respostas().find((x) => x.id === id) : null;
    respostaEditada = r?.id || null;
    formResposta.reset();
    $("#resposta-titulo").textContent = r ? "Editar resposta rápida" : "Nova resposta rápida";
    $("#btn-excluir-resposta").hidden = !r;
    formResposta.atalho.value = r?.atalho || "";
    formResposta.titulo.value = r?.titulo || "";
    formResposta.texto.value = r?.texto || "";
    modalResposta.showModal();
    formResposta.atalho.focus();
  }
  $("#btn-nova-resposta").addEventListener("click", () => abrirResposta());
  formResposta.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dados = { atalho: formResposta.atalho.value, titulo: formResposta.titulo.value, texto: formResposta.texto.value };
    try {
      await (respostaEditada ? api("PATCH", `/api/respostas/${respostaEditada}`, dados) : api("POST", "/api/respostas", dados));
      modalResposta.close();
      toast("Resposta rápida salva");
      await recarregarConfig();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btn-excluir-resposta").addEventListener("click", async () => {
    if (!confirm("Excluir esta resposta rápida?")) return;
    try {
      await api("DELETE", `/api/respostas/${respostaEditada}`);
      modalResposta.close();
      toast("Resposta excluída");
      await recarregarConfig();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---- editor de regra de follow-up ----
  const modalRegra = $("#modal-regra");
  const formRegra = $("#form-regra");
  let regraEditada = null;

  function abrirRegra(id = null, etapa = "") {
    const r = id ? regras().find((x) => x.id === id) : null;
    regraEditada = r?.id || null;
    formRegra.reset();
    $("#regra-titulo").textContent = r ? "Editar regra de follow-up" : "Nova regra de follow-up";
    $("#btn-excluir-regra").hidden = !r;
    formRegra.etapa.innerHTML = opcoesEtapa(r?.etapa || etapa || "Novo Lead");
    formRegra.moverPara.innerHTML = `<option value="">Não mover (continua na etapa)</option>` + ETAPAS.map((e) => `<option${e === r?.moverPara ? " selected" : ""}>${esc(e)}</option>`).join("");
    formRegra.nome.value = r?.nome || "";
    formRegra.texto.value = r?.texto || "";
    const min = r ? r.aposMinutos : 60;
    const unidade = min && min % 1440 === 0 ? 1440 : min && min % 60 === 0 ? 60 : min ? 1 : 60;
    formRegra.unidade.value = String(unidade);
    formRegra.quantidade.value = String(min / unidade);
    formRegra.cancelarSeResponder.checked = r ? r.cancelarSeResponder : true;
    formRegra.ativo.checked = r ? r.ativo : true;
    modalRegra.showModal();
    formRegra.nome.focus();
  }
  $("#btn-nova-regra").addEventListener("click", () => abrirRegra());
  formRegra.addEventListener("submit", async (e) => {
    e.preventDefault();
    const quantidade = Number(formRegra.quantidade.value);
    if (!Number.isFinite(quantidade) || quantidade < 0) { toast("Tempo de espera inválido", true); return; }
    const dados = {
      etapa: formRegra.etapa.value,
      nome: formRegra.nome.value,
      aposMinutos: Math.round(quantidade * Number(formRegra.unidade.value)),
      texto: formRegra.texto.value,
      moverPara: formRegra.moverPara.value,
      cancelarSeResponder: formRegra.cancelarSeResponder.checked,
      ativo: formRegra.ativo.checked,
    };
    try {
      await (regraEditada ? api("PATCH", `/api/regras/${regraEditada}`, dados) : api("POST", "/api/regras", dados));
      modalRegra.close();
      toast(regraEditada ? "Regra atualizada" : "Regra criada — vale para leads que entrarem na etapa");
      await recarregarConfig();
      await carregarLeads();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btn-excluir-regra").addEventListener("click", async () => {
    if (!confirm("Excluir esta regra? Os envios pendentes dela serão cancelados.")) return;
    try {
      await api("DELETE", `/api/regras/${regraEditada}`);
      modalRegra.close();
      toast("Regra excluída");
      await recarregarConfig();
      await carregarLeads();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---- regras de uma etapa, aberto pelo cabeçalho da coluna do Kanban ----
  const modalEtapa = $("#modal-etapa");
  let etapaDoModal = "";
  function abrirRegrasDaEtapa(etapa) {
    etapaDoModal = etapa;
    $("#etapa-titulo").textContent = `Follow-ups: ${etapa}`;
    $("#etapa-regras").innerHTML = listaRegras(etapa);
    modalEtapa.showModal();
  }
  $("#btn-etapa-nova-regra").addEventListener("click", () => abrirRegra(null, etapaDoModal));

  // fechar e variáveis nos três diálogos novos
  for (const dlg of [modalResposta, modalRegra, modalEtapa]) {
    $$("[data-fechar]", dlg).forEach((b) => b.addEventListener("click", () => dlg.close()));
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
      const codigo = e.target.closest(".variaveis code");
      if (codigo) {
        const area = $("textarea[name=texto]", dlg);
        const ini = area.selectionStart ?? area.value.length;
        area.setRangeText(codigo.textContent, ini, area.selectionEnd ?? ini, "end");
        area.focus();
      }
    });
  }

  // ---- caixa de mensagem com respostas rápidas ("/" ou atalhos): no lead e na aba Conversas ----
  function ligarCompositor({ campo, caixa, atalhos, alvo, enviar }) {
    let ativa = 0;
    const fechar = () => {
      caixa.hidden = true;
      caixa.innerHTML = "";
    };
    const inserir = (id) => {
      const r = respostas().find((x) => x.id === id);
      if (!r) return;
      campo.value = preencherVariaveis(r.texto, alvo());
      fechar();
      campo.focus();
      campo.setSelectionRange(campo.value.length, campo.value.length);
    };
    campo.addEventListener("input", () => {
      const m = campo.value.match(/^\/(\S*)$/);
      if (!m) return fechar();
      const termo = normalizar(m[1]);
      const achadas = respostas().filter((r) => normalizar(r.atalho + " " + r.titulo).includes(termo)).slice(0, 8);
      if (!achadas.length) return fechar();
      ativa = 0;
      caixa.innerHTML = achadas
        .map((r, i) => `<div class="sugestao${i === 0 ? " ativa" : ""}" role="option" data-usar-resposta="${r.id}"><strong>/${esc(r.atalho)}</strong> ${esc(r.titulo || "")}<span>${esc(r.texto)}</span></div>`)
        .join("");
      caixa.hidden = false;
    });
    caixa.addEventListener("mousedown", (e) => {
      const s = e.target.closest("[data-usar-resposta]");
      if (!s) return;
      e.preventDefault();
      inserir(s.dataset.usarResposta);
    });
    campo.addEventListener("blur", () => setTimeout(fechar, 100));
    campo.addEventListener("keydown", (e) => {
      const itens = caixa.hidden ? [] : $$(".sugestao", caixa);
      if (itens.length && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "Escape") return fechar();
        if (e.key === "Enter" || e.key === "Tab") return inserir(itens[ativa].dataset.usarResposta);
        ativa = (ativa + (e.key === "ArrowDown" ? 1 : -1) + itens.length) % itens.length;
        itens.forEach((s, i) => s.classList.toggle("ativa", i === ativa));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        enviar();
      }
    });
    atalhos.addEventListener("click", (e) => {
      const b = e.target.closest("[data-usar-resposta]");
      if (b) inserir(b.dataset.usarResposta);
    });
    return {
      renderAtalhos() {
        atalhos.innerHTML = respostas()
          .map((r) => `<button type="button" class="chip" data-usar-resposta="${r.id}" title="${esc(r.texto)}">${ICONE_RAIO}/${esc(r.atalho)}</button>`)
          .join("");
      },
    };
  }

  const compositorLead = ligarCompositor({
    campo: $("#wa-texto"),
    caixa: $("#sugestoes"),
    atalhos: $("#atalhos-respostas"),
    alvo: () => estado.leads.find((l) => l.id === estado.leadAberto),
    enviar: enviarWhatsApp,
  });

  // ---- no modal do lead: follow-ups ----
  function renderFollowupsLead(lead) {
    if (!lead) return;
    const lista = [...(lead.followups || [])].sort((a, b) => {
      if ((a.status === "pendente") !== (b.status === "pendente")) return a.status === "pendente" ? -1 : 1;
      return a.status === "pendente" ? new Date(a.agendadoPara) - new Date(b.agendadoPara) : new Date(b.encerradoEm || 0) - new Date(a.encerradoEm || 0);
    }).slice(0, 12);
    const ROTULO = { pendente: "agendado", enviado: "enviado", cancelado: "cancelado", falhou: "falhou" };
    $("#followups-lead").innerHTML = lista.length
      ? lista.map((f) => `<div class="item fu-${f.status}">
          <div class="item-corpo">
            <strong><span class="tag">${ROTULO[f.status]}</span> ${f.status === "pendente" ? `${esc(dataHora(f.agendadoPara))} (${relativo(f.agendadoPara)})` : esc(dataHora(f.encerradoEm || f.agendadoPara))}</strong>
            <span class="fluxo">${esc(origemDoFollowup(f))}${f.motivo ? ` · ${esc(f.motivo)}` : ""}</span>
            <span>${esc(textoDoFollowup(f, lead))}</span>
          </div>
          ${f.status === "pendente" ? `<div class="item-acoes">
            <button type="button" class="btn btn-secundario mini" data-fu-enviar="${f.id}" data-lead="${lead.id}" ${estado.whatsapp.status === "conectado" ? "" : "disabled"}>Enviar agora</button>
            <button type="button" class="btn btn-fantasma mini" data-fu-cancelar="${f.id}" data-lead="${lead.id}">Cancelar</button>
          </div>` : ""}
        </div>`).join("")
      : `<p class="sem-msg">Nenhum follow-up para este lead. Agende um abaixo ou crie regras para a etapa <b>${esc(lead.etapa)}</b>.</p>`;
    $("#fu-optout").checked = !!lead.optOut;
  }

  function prepararAgendamento() {
    $("#fu-modelo").innerHTML = `<option value="">Usar resposta rápida…</option>` + respostas().map((r) => `<option value="${r.id}">/${esc(r.atalho)} ${esc(r.titulo || "")}</option>`).join("");
    const amanha = new Date(Date.now() + 86400000);
    amanha.setHours(9, 0, 0, 0);
    $("#fu-quando").value = new Date(amanha.getTime() - amanha.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $("#fu-texto").value = "";
    $("#fu-cancelar").checked = true;
  }
  $("#fu-modelo").addEventListener("change", (e) => {
    const r = respostas().find((x) => x.id === e.target.value);
    if (r) $("#fu-texto").value = r.texto;
    e.target.value = "";
  });
  $("#btn-fu-agendar").addEventListener("click", async () => {
    const texto = $("#fu-texto").value.trim();
    const quando = $("#fu-quando").value;
    if (!texto) { $("#fu-texto").focus(); toast("Escreva a mensagem do follow-up", true); return; }
    if (!quando) { toast("Escolha data e hora", true); return; }
    try {
      const lead = await api("POST", `/api/leads/${estado.leadAberto}/followups`, { texto, agendadoPara: new Date(quando).toISOString(), cancelarSeResponder: $("#fu-cancelar").checked });
      substituir(lead);
      renderFollowupsLead(lead);
      prepararAgendamento();
      render();
      toast("Follow-up agendado");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#fu-optout").addEventListener("change", async (e) => {
    try {
      const lead = await salvarCampo(estado.leadAberto, { optOut: e.target.checked });
      renderFollowupsLead(lead);
      render();
      toast(e.target.checked ? "Este lead não receberá follow-ups automáticos" : "Follow-ups automáticos liberados para este lead");
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, true);
    }
  });

  // ---------- aba Conversas (caixa de entrada do WhatsApp) ----------
  const ICONE_VOLTAR = `<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>`;
  const jidUrl = (jid) => encodeURIComponent(jid);

  function nomeConversa(c) {
    return c.nomeContato || c.nome || (c.telefone ? formatarTelefone(c.telefone) : "Contato do WhatsApp");
  }
  function iniciais(nome) {
    const partes = String(nome).replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).filter(Boolean);
    return ((partes[0]?.[0] || "?") + (partes.length > 1 ? partes.at(-1)[0] : "")).toUpperCase();
  }
  function horaCurta(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const hoje = new Date();
    const ontem = new Date(Date.now() - 86400000);
    if (d.toDateString() === hoje.toDateString()) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === ontem.toDateString()) return "ontem";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }

  async function carregarConversas() {
    estado.conversas = await api("GET", "/api/conversas");
    renderBolhaConversas();
    if (estado.aba === "conversas") renderListaConversas();
  }

  function renderBolhaConversas() {
    const total = estado.conversas.reduce((s, c) => s + (c.naoLidas || 0), 0);
    const bolha = $("#cv-bolha");
    bolha.hidden = !total;
    bolha.textContent = total > 99 ? "99+" : String(total);
    document.title = total ? `(${total}) Controle de Leads 2026` : "Controle de Leads 2026";
  }

  // Fila de atendimento: quem chegou primeiro aparece primeiro.
  const naFila = () => estado.conversas.filter((c) => c.fila).sort((a, b) => a.fila.desde.localeCompare(b.fila.desde));
  function tempoDesde(iso) {
    const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (min < 1) return "agora";
    if (min < 60) return `há ${min} min`;
    if (min < 1440) return `há ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
    const d = Math.floor(min / 1440);
    return `há ${d} dia${d > 1 ? "s" : ""}`;
  }
  const ICONE_PIN = `<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3H7l3-3z" /><path d="M12 13v7" /></svg>`;

  function conversasFiltradas() {
    const termo = normalizar(estado.cvBusca.trim());
    const base = estado.cvFiltro === "fila" ? naFila() : estado.conversas;
    return base.filter((c) => {
      if (estado.cvFiltro === "nao-lidas" && !c.naoLidas) return false;
      if (estado.cvFiltro === "sem-lead" && c.lead) return false;
      if (estado.cvFiltro === "leads" && !c.lead) return false;
      if (!termo) return true;
      const alvo = normalizar([nomeConversa(c), c.nome, c.telefone, c.ultimaMensagem, c.lead?.nome].join(" "));
      return alvo.includes(termo) || (termo.replace(/\D/g, "").length >= 4 && String(c.telefone).includes(termo.replace(/\D/g, "")));
    });
  }

  function renderListaConversas() {
    $$("[data-cv-filtro]").forEach((b) => b.classList.toggle("ativo", b.dataset.cvFiltro === estado.cvFiltro));
    const lista = conversasFiltradas();
    const wa = estado.whatsapp.status;
    let vazio = "";
    if (!estado.conversas.length) {
      vazio = wa === "conectado"
        ? `<div class="cv-lista-vazia"><div class="carregando"></div><span>Carregando conversas do WhatsApp…</span><small>As conversas aparecem aqui conforme o celular sincroniza.</small></div>`
        : `<div class="cv-lista-vazia"><strong>WhatsApp desconectado</strong><span>Conecte o seu WhatsApp para ver as conversas aqui.</span><button class="btn btn-primario" data-ir-aba="whatsapp">Conectar WhatsApp</button></div>`;
    } else if (!lista.length) {
      vazio = `<div class="cv-lista-vazia"><span>Nenhuma conversa encontrada.</span></div>`;
    }
    const fila = estado.cvFiltro === "fila";
    if (fila && !lista.length && estado.conversas.length) vazio = `<div class="cv-lista-vazia"><strong>Fila vazia 🎉</strong><span>Todo mundo foi atendido. Quem mandar mensagem nova entra aqui, por ordem de chegada.</span></div>`;
    $("#cv-lista").innerHTML = vazio || lista.map((c, i) => {
      const nome = nomeConversa(c);
      return `<div role="button" tabindex="0" class="cv-item${c.jid === estado.conversaAberta ? " ativa" : ""}${c.naoLidas ? " nao-lida" : ""}${fila ? " na-fila" : ""}" data-jid="${esc(c.jid)}">
        ${fila ? `<span class="posicao" title="Posição na fila">${i + 1}º</span>` : ""}
        <span class="avatar${c.lead ? " " + (CLASSE_ETAPA[c.lead.etapa] || "") : ""}">${esc(iniciais(nome))}</span>
        <span class="cv-meio">
          <strong>${c.fixada ? `<span class="pin" title="Fixada">${ICONE_PIN}</span>` : ""}${esc(nome)}</strong>
          <span class="previa">${esc(c.ultimaMensagem || "")}</span>
          ${fila ? `<span class="espera">⏱ chegou ${tempoDesde(c.fila.desde)}</span>` : ""}
        </span>
        <span class="cv-lado">
          <time>${esc(horaCurta(c.ultimaEm))}</time>
          ${c.naoLidas ? `<span class="bolha">${c.naoLidas}</span>` : ""}
          ${fila ? `<button type="button" class="btn btn-secundario mini" data-baixa="${esc(c.jid)}" title="Atendimento concluído: tira da fila">✓ Dar baixa</button>`
            : c.lead ? `<span class="cv-etapa ${CLASSE_ETAPA[c.lead.etapa] || ""}"><span class="ponto"></span>${esc(c.lead.etapa)}</span>` : `<span class="cv-sem-lead">sem lead</span>`}
        </span>
      </div>`;
    }).join("");
    const nFila = estado.conversas.filter((c) => c.fila).length;
    $("#cv-fila-contagem").textContent = nFila ? String(nFila) : "";
    if (!estado.conversaAberta) $("#inbox").classList.remove("com-chat");
  }

  function renderCabecalhoConversa() {
    const c = estado.conversaDados;
    const lead = c.lead && estado.leads.find((l) => l.id === c.lead.id);
    const nome = nomeConversa(c);
    const numero = c.telefone ? formatarTelefone(c.telefone) : "número oculto pelo WhatsApp";
    const acoes = lead
      ? `<div class="cv-lead ${CLASSE_ETAPA[lead.etapa] || ""}">
          <span class="cv-lead-rotulo">Lead</span>
          <select class="etapa" id="cv-mover" aria-label="Etapa do funil">${opcoesEtapa(lead.etapa)}</select>
          <button type="button" class="btn btn-secundario mini" data-cv-abrir-lead="${lead.id}">Abrir lead</button>
          <button type="button" class="btn btn-secundario mini" data-novo-pedido="${lead.id}">+ Pedido</button>
        </div>`
      : `<div class="cv-acoes">
          <button type="button" class="btn btn-primario" id="cv-adicionar">+ Adicionar como lead</button>
          <select id="cv-vincular" aria-label="Vincular a um lead existente">
            <option value="">Vincular a lead existente…</option>
            ${[...estado.leads].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")).map((l) => `<option value="${l.id}">${esc(l.nome)}${l.empresa ? " — " + esc(l.empresa) : ""}</option>`).join("")}
          </select>
        </div>`;
    const atendimento = c.fila
      ? `<div class="cv-fila"><span>⏱ Na fila: chegou ${tempoDesde(c.fila.desde)}</span><button type="button" class="btn btn-primario mini" id="cv-baixa">✓ Dar baixa</button></div>`
      : `<button type="button" class="btn btn-fantasma mini" id="cv-por-na-fila" title="Volta para a fila de atendimento">Pôr na fila</button>`;
    $("#cv-cabecalho").innerHTML = `
      <button type="button" class="icone-btn cv-voltar" id="cv-voltar" aria-label="Voltar para a lista">${ICONE_VOLTAR}</button>
      <span class="avatar${lead ? " " + (CLASSE_ETAPA[lead.etapa] || "") : ""}">${esc(iniciais(nome))}</span>
      <div class="cv-quem"><strong>${esc(nome)}</strong><span>${esc(numero)}${lead && lead.nome !== nome ? ` · lead: ${esc(lead.nome)}` : ""}</span></div>
      <button type="button" class="icone-btn cv-fixar${c.fixada ? " ativo" : ""}" id="cv-fixar" aria-pressed="${!!c.fixada}" title="${c.fixada ? "Desafixar" : "Fixar no topo da lista"}">${ICONE_PIN}</button>
      ${atendimento}
      ${acoes}`;
  }

  function renderMensagensConversa({ rolar = false } = {}) {
    const caixa = $("#cv-mensagens");
    const pertoDoFim = caixa.scrollHeight - caixa.scrollTop - caixa.clientHeight < 80;
    const rotuloDoDia = (m) => new Date(m.em).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
    renderBaloes(caixa, estado.conversaAberta, estado.conversaDados.mensagens || [], (lista, anterior) => {
      let dia = anterior ? rotuloDoDia(anterior) : "";
      return lista.map((m) => {
        const rotulo = rotuloDoDia(m);
        const separador = rotulo !== dia ? `<div class="cv-dia"><span>${esc((dia = rotulo))}</span></div>` : "";
        const responder = m.id ? `<button type="button" class="msg-responder" data-responder="${esc(m.id)}" title="Responder" aria-label="Responder esta mensagem"><svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5" /><path d="M4 12h10a6 6 0 0 1 6 6v1" /></svg></button>` : "";
        return `${separador}<div class="${classeBalao(m)}" data-msg="${esc(m.id || "")}">${responder}${conteudoDaMensagem(m, estado.conversaDados.mensagens, nomeConversa(estado.conversaDados))}<time>${new Date(m.em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time></div>`;
      }).join("");
    }, `<div class="sem-msg">Sem mensagens nesta conversa ainda.</div>`);
    if (rolar || pertoDoFim) caixa.scrollTop = caixa.scrollHeight;
  }

  function renderAvisoConversa() {
    const conectado = estado.whatsapp.status === "conectado";
    $("#cv-anteriores").hidden = !conectado || !(estado.conversaDados?.mensagens || []).some((m) => m.id);
    $("#cv-enviar").disabled = !conectado;
    $("#cv-aviso").innerHTML = conectado ? "" : `WhatsApp desconectado. <a href="#" data-ir-aba="whatsapp">Conecte pelo QR Code</a> para responder.`;
  }

  function renderConversas() {
    renderListaConversas();
    const aberta = !!estado.conversaDados;
    $("#cv-vazio").hidden = aberta;
    $("#cv-conteudo").hidden = !aberta;
    $("#inbox").classList.toggle("com-chat", aberta);
    if (aberta) {
      renderCabecalhoConversa();
      renderMensagensConversa();
      renderAvisoConversa();
    }
  }

  // ---- mensagens anteriores: o celular manda em lotes, pelo mesmo caminho do histórico ----
  $("#cv-anteriores").addEventListener("click", async (e) => {
    const botao = e.currentTarget;
    const jid = estado.conversaAberta;
    botao.disabled = true;
    botao.textContent = "Pedindo ao celular…";
    try {
      await api("POST", `/api/conversas/${jidUrl(jid)}/anteriores`);
      toast("Pedido enviado ao celular — as mensagens antigas aparecem em instantes");
      botao.textContent = "Aguardando o celular…";
    } catch (err) {
      toast(err.message, true);
    } finally {
      // O celular pode demorar ou não ter mais nada: libera o botão depois de um tempo.
      setTimeout(() => {
        botao.disabled = false;
        botao.textContent = "↑ Carregar mensagens anteriores";
      }, 8000);
    }
  });

  async function abrirConversa(jid, { rolar = true } = {}) {
    try {
      estado.conversaDados = await api("GET", `/api/conversas/${jidUrl(jid)}`);
    } catch (err) {
      toast(err.message, true);
      return;
    }
    const mudou = estado.conversaAberta !== jid;
    estado.conversaAberta = jid;
    if (mudou) {
      $("#cv-texto").value = "";
      limparAnexo();
      pararDeResponder();
      cancelarGravacao();
      compositorConversa.renderAtalhos();
    }
    renderConversas();
    renderMensagensConversa({ rolar: rolar || mudou });
    if (estado.conversaDados.naoLidas) {
      estado.conversaDados.naoLidas = 0;
      const resumo = estado.conversas.find((c) => c.jid === jid);
      if (resumo) resumo.naoLidas = 0;
      renderBolhaConversas();
      renderListaConversas();
      api("POST", `/api/conversas/${jidUrl(jid)}/lida`).catch(() => {});
    }
    if (mudou && window.matchMedia("(min-width: 761px)").matches) $("#cv-texto").focus();
  }

  function fecharConversa() {
    estado.conversaAberta = null;
    estado.conversaDados = null;
    renderConversas();
  }

  // ---- anexos: escolhido pelo 📎 ou arrastado para o chat; a legenda é o texto digitado ----
  const LIMITE_ANEXO = 64 * 1024 * 1024;
  let anexoPendente = null;

  function escolherAnexo(arquivo) {
    if (!arquivo) return;
    if (arquivo.size > LIMITE_ANEXO) return toast("Arquivo grande demais (máximo 64 MB)", true);
    if (!arquivo.size) return toast("Arquivo vazio", true);
    anexoPendente = arquivo;
    renderAnexoPendente();
    $("#cv-texto").placeholder = "Legenda (opcional)…";
    $("#cv-texto").focus();
  }
  function limparAnexo() {
    anexoPendente = null;
    $("#cv-arquivo").value = "";
    $("#cv-texto").placeholder = "Escreva uma mensagem… (digite / para respostas rápidas)";
    renderAnexoPendente();
  }
  function renderAnexoPendente() {
    const caixa = $("#cv-anexo");
    caixa.hidden = !anexoPendente;
    if (!anexoPendente) return (caixa.innerHTML = "");
    const icone = anexoPendente.type.startsWith("image/") ? "📷" : anexoPendente.type.startsWith("video/") ? "🎥" : anexoPendente.type.startsWith("audio/") ? "🎤" : "📄";
    caixa.innerHTML = `<span>${icone}</span><strong>${esc(anexoPendente.name)}</strong><small>${tamanhoLegivel(anexoPendente.size)}</small>
      <button type="button" class="icone-btn" id="cv-anexo-remover" aria-label="Remover anexo"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>`;
  }
  $("#cv-arquivo").addEventListener("change", (e) => escolherAnexo(e.target.files[0]));
  $("#cv-anexo").addEventListener("click", (e) => e.target.closest("#cv-anexo-remover") && limparAnexo());
  const areaChat = $(".inbox-chat");
  areaChat.addEventListener("dragover", (e) => {
    if (!estado.conversaAberta || !e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    areaChat.classList.add("soltar");
  });
  areaChat.addEventListener("dragleave", (e) => !areaChat.contains(e.relatedTarget) && areaChat.classList.remove("soltar"));
  areaChat.addEventListener("drop", (e) => {
    areaChat.classList.remove("soltar");
    if (!estado.conversaAberta || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    escolherAnexo(e.dataTransfer.files[0]);
  });

  // ---- responder citando: ↩ no balão; a próxima mensagem (texto, anexo ou áudio) vai como resposta ----
  let respondendo = null; // { id, autor, texto }
  function responderA(id) {
    const m = (estado.conversaDados?.mensagens || []).find((x) => x.id === id);
    if (!m) return;
    const resumo = m.texto || (m.midia ? { imagem: "📷 Foto", video: "🎥 Vídeo", audio: "🎤 Áudio", documento: `📄 ${m.midia.nome || "Documento"}`, figurinha: "Figurinha" }[m.midia.tipo] : "") || "Mensagem";
    respondendo = { id, autor: m.direcao === "saida" ? "Você" : nomeConversa(estado.conversaDados), texto: resumo };
    renderCitando();
    $("#cv-texto").focus();
  }
  function pararDeResponder() {
    respondendo = null;
    renderCitando();
  }
  function renderCitando() {
    const caixa = $("#cv-citando");
    caixa.hidden = !respondendo;
    caixa.innerHTML = respondendo
      ? `<div><b>Respondendo a ${esc(respondendo.autor)}</b><span>${esc(respondendo.texto)}</span></div>
        <button type="button" class="icone-btn" id="cv-citando-cancelar" aria-label="Não responder a esta mensagem"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button>`
      : "";
  }
  $("#cv-citando").addEventListener("click", (e) => e.target.closest("#cv-citando-cancelar") && pararDeResponder());

  /** Pula até a mensagem citada e a destaca por um instante. */
  function irParaMensagem(caixa, id) {
    const alvo = [...caixa.querySelectorAll("[data-msg]")].find((el) => el.dataset.msg === id);
    if (!alvo) return toast("A mensagem original é mais antiga e não está carregada aqui", true);
    alvo.scrollIntoView({ behavior: "smooth", block: "center" });
    alvo.classList.remove("destacada");
    void alvo.offsetWidth; // reinicia a animação
    alvo.classList.add("destacada");
  }
  $("#cv-mensagens").addEventListener("click", (e) => {
    const r = e.target.closest("[data-responder]");
    if (r) return responderA(r.dataset.responder);
    const c = e.target.closest("[data-ir-msg]");
    if (c) irParaMensagem($("#cv-mensagens"), c.dataset.irMsg);
  });
  $("#mensagens").addEventListener("click", (e) => {
    const c = e.target.closest("[data-ir-msg]");
    if (c) irParaMensagem($("#mensagens"), c.dataset.irMsg);
  });

  async function enviarAnexo(arquivo, legenda, extras = {}) {
    const res = await fetch(`/api/conversas/${jidUrl(estado.conversaAberta)}/anexos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Tipo-Arquivo": encodeURIComponent(arquivo.type || "application/octet-stream"),
        "X-Nome-Arquivo": encodeURIComponent(arquivo.name || "arquivo"),
        "X-Legenda": encodeURIComponent(legenda),
        ...(respondendo ? { "X-Citar": encodeURIComponent(respondendo.id) } : {}),
        ...extras,
      },
      body: arquivo,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || (res.status === 413 ? "Arquivo grande demais" : `Erro ${res.status}`));
    return json.data;
  }

  async function enviarNaConversa() {
    const campo = $("#cv-texto");
    const texto = campo.value.trim();
    if ((!texto && !anexoPendente) || !estado.conversaAberta) return;
    const botao = $("#cv-enviar");
    botao.disabled = true;
    const textoOriginal = botao.textContent;
    if (anexoPendente) botao.textContent = "Enviando…";
    try {
      if (anexoPendente) {
        estado.conversaDados = await enviarAnexo(anexoPendente, texto);
        limparAnexo();
      } else {
        estado.conversaDados = await api("POST", `/api/conversas/${jidUrl(estado.conversaAberta)}/mensagens`, { texto, ...(respondendo ? { citarId: respondendo.id } : {}) });
      }
      campo.value = "";
      pararDeResponder();
      renderMensagensConversa({ rolar: true });
    } catch (err) {
      toast(err.message, true);
    } finally {
      botao.textContent = textoOriginal;
      renderAvisoConversa();
    }
  }

  const compositorConversa = ligarCompositor({
    campo: $("#cv-texto"),
    caixa: $("#cv-sugestoes"),
    atalhos: $("#cv-atalhos"),
    alvo: () => {
      const c = estado.conversaDados;
      return (c?.lead && estado.leads.find((l) => l.id === c.lead.id)) || { nome: c ? nomeConversa(c) : "" };
    },
    enviar: enviarNaConversa,
  });
  $("#cv-enviar").addEventListener("click", enviarNaConversa);

  // ---- gravar mensagem de voz (chega no celular como áudio de voz, com a forma de onda) ----
  const LIMITE_GRAVACAO_S = 5 * 60;
  const gravacao = { recorder: null, stream: null, partes: [], inicio: 0, timer: null, ctx: null, medir: () => 0, niveis: [] };
  const tempoGravado = () => (gravacao.inicio ? (Date.now() - gravacao.inicio) / 1000 : 0);

  async function iniciarGravacao() {
    if (!estado.conversaAberta || gravacao.recorder) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return toast(window.isSecureContext
        ? "Este navegador não consegue gravar áudio. Use o Chrome, o Edge ou o Firefox."
        : "O navegador só libera o microfone em conexão segura: abra pelo endereço https (veja \"Acesso de fora da rede\" no README) ou, neste computador, por http://localhost.", true);
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      return toast(e.name === "NotAllowedError" ? "Permita o uso do microfone no navegador para gravar." : "Nenhum microfone encontrado.", true);
    }
    // Ogg (Firefox) já é o formato do WhatsApp; WebM (Chrome/Edge) o servidor converte sem perda.
    const tipo = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo, audioBitsPerSecond: 32000 } : undefined);
    Object.assign(gravacao, { recorder: rec, stream, partes: [], inicio: Date.now(), niveis: [] });
    rec.ondataavailable = (e) => e.data.size && gravacao.partes.push(e.data);
    rec.start(250);
    try {
      const ctx = new AudioContext();
      const analisador = ctx.createAnalyser();
      analisador.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analisador);
      const amostras = new Uint8Array(analisador.fftSize);
      gravacao.ctx = ctx;
      gravacao.medir = () => {
        analisador.getByteTimeDomainData(amostras);
        let soma = 0;
        for (const v of amostras) soma += ((v - 128) / 128) ** 2;
        return Math.sqrt(soma / amostras.length);
      };
    } catch {
      gravacao.medir = () => 0;
    }
    $("#cv-enviar-linha").hidden = true;
    $("#cv-gravando").hidden = false;
    $("#cv-gravar-onda").innerHTML = "";
    gravacao.timer = setInterval(tickGravacao, 100);
    tickGravacao();
  }

  function tickGravacao() {
    const s = tempoGravado();
    const nivel = Math.min(1, gravacao.medir() * 4);
    gravacao.niveis.push(nivel);
    $("#cv-gravar-tempo").textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const onda = $("#cv-gravar-onda");
    onda.insertAdjacentHTML("beforeend", `<i style="height:${Math.max(8, nivel * 100)}%"></i>`);
    while (onda.childElementCount > 60) onda.firstElementChild.remove();
    if (s >= LIMITE_GRAVACAO_S) enviarGravacao(); // limite: envia o que gravou
  }

  function liberarGravacao() {
    clearInterval(gravacao.timer);
    gravacao.stream?.getTracks().forEach((t) => t.stop());
    gravacao.ctx?.close().catch(() => {});
    Object.assign(gravacao, { recorder: null, stream: null, timer: null, ctx: null, inicio: 0, medir: () => 0 });
    $("#cv-gravando").hidden = true;
    $("#cv-enviar-linha").hidden = false;
  }

  function cancelarGravacao() {
    const rec = gravacao.recorder;
    if (!rec) return;
    rec.ondataavailable = null;
    if (rec.state !== "inactive") rec.stop();
    liberarGravacao();
  }

  /** 64 valores de 0 a 100: o desenho do áudio que o WhatsApp mostra no balão. */
  function formaDeOnda(niveis) {
    const n = niveis.length || 1;
    const blocos = Array.from({ length: 64 }, (_, i) => {
      const fatia = niveis.slice(Math.floor((i * n) / 64), Math.max(Math.floor(((i + 1) * n) / 64), Math.floor((i * n) / 64) + 1));
      return fatia.reduce((a, b) => a + b, 0) / (fatia.length || 1);
    });
    const maior = Math.max(...blocos, 0.01);
    return btoa(String.fromCharCode(...blocos.map((v) => Math.round((v / maior) * 100))));
  }

  async function enviarGravacao() {
    const rec = gravacao.recorder;
    if (!rec) return;
    const segundos = tempoGravado();
    const niveis = gravacao.niveis;
    const blob = await new Promise((resolver) => {
      rec.onstop = () => resolver(new Blob(gravacao.partes, { type: rec.mimeType || "audio/webm" }));
      if (rec.state !== "inactive") rec.stop();
      else rec.onstop();
    });
    liberarGravacao();
    if (segundos < 1 || !blob.size) return toast("Gravação curta demais: segure por pelo menos 1 segundo.", true);
    const tipo = (blob.type || "audio/webm").split(";")[0];
    // Safari grava em MP4: vai como arquivo de áudio comum (o WhatsApp toca, mas não como "voz").
    const voz = tipo === "audio/webm" || tipo === "audio/ogg";
    const extensao = { "audio/ogg": "ogg", "audio/webm": "webm", "audio/mp4": "m4a" }[tipo] || "audio";
    const arquivo = new File([blob], `audio-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.${extensao}`, { type: tipo });
    const botao = $("#cv-enviar");
    botao.disabled = true;
    botao.textContent = "Enviando áudio…";
    try {
      estado.conversaDados = await enviarAnexo(arquivo, "", voz ? { "X-Voz": "1", "X-Onda": encodeURIComponent(formaDeOnda(niveis)) } : {});
      pararDeResponder();
      renderMensagensConversa({ rolar: true });
    } catch (err) {
      toast(err.message, true);
    } finally {
      botao.textContent = "Enviar";
      renderAvisoConversa();
    }
  }

  $("#cv-gravar").addEventListener("click", iniciarGravacao);
  $("#cv-gravar-cancelar").addEventListener("click", cancelarGravacao);
  $("#cv-gravar-enviar").addEventListener("click", enviarGravacao);

  // ---- emojis (nas duas caixas de mensagem) ----
  const EMOJIS = {
    "Mais usados": "😀 😊 🙂 😉 😍 🥰 😘 😅 😂 🤣 😇 🤩 😎 🤔 🤗 🙏 👍 👏 🙌 💪 👌 ✌️ 🤝 👋 ❤️ 💚 🔥 ✨ 🎉 ✅ 😃 😁",
    Rostos: "😆 😋 😜 🤪 😏 😌 😴 😬 🙄 😮 😲 😳 🥺 😢 😭 😤 😡 🤯 😱 🤒 🤧 🥳 🤠 🤓 🧐 😐 🙃 🤭 🤫 😶 😑 😕 🫡",
    Gestos: "👎 ✊ 🤞 🤙 👉 👈 👆 👇 ☝️ ✋ 🖐️ 🫶 🙋 🙋‍♀️ 🙋‍♂️ 🤷 🤷‍♀️ 🤦 💁 🙆 🙅 👀 💃 🕺",
    Negócios: "💼 📈 📊 💰 💵 💳 🧾 🛒 🛍️ 📦 🚚 🏷️ 📅 ⏰ ⏳ 📞 📱 💻 📧 📝 📄 📎 🔗 📍 🏠 🏢 🏥 🎯 🏆 💡 🔔 🤑",
    Símbolos: "✔️ ❌ ⚠️ ❗ ❓ ⭐ 🌟 💯 🆕 🔴 🟢 🟡 ➡️ ⬅️ ⬆️ ⬇️ 💬 💭 ☀️ 🌙 ☕ 🍕 🎂 🎁 🌹 🍀 ⚽ 🇧🇷 🇵🇹 🙌🏻 👍🏻 🤝🏻",
  };
  const painelEmoji = $("#emoji-painel");
  let botaoEmoji = null;
  function abrirEmojis(botao) {
    botaoEmoji = botao;
    const recentes = lerPreferencia("emojisRecentes", "").split(" ").filter(Boolean);
    const grupos = recentes.length ? { Recentes: recentes.join(" "), ...EMOJIS } : EMOJIS;
    painelEmoji.innerHTML = Object.entries(grupos)
      .map(([grupo, lista]) => `<h4>${grupo}</h4><div class="emoji-grade">${lista.split(" ").map((e) => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`).join("")}</div>`)
      .join("");
    // Dentro do modal do lead o painel precisa estar no próprio modal (senão fica por baixo dele).
    (botao.closest("dialog") || document.body).append(painelEmoji);
    painelEmoji.hidden = false;
    botao.setAttribute("aria-expanded", "true");
    const r = botao.getBoundingClientRect();
    const larg = painelEmoji.offsetWidth;
    const alt = painelEmoji.offsetHeight;
    const x = Math.min(Math.max(8, r.right - larg), window.innerWidth - larg - 8);
    const y = r.top - alt - 8 >= 8 ? r.top - alt - 8 : Math.min(r.bottom + 8, window.innerHeight - alt - 8);
    painelEmoji.style.left = `${x}px`;
    painelEmoji.style.top = `${y}px`;
    // Se algum ancestral desloca o "fixed" (modal com transformação), corrige pela diferença medida.
    const real = painelEmoji.getBoundingClientRect();
    painelEmoji.style.left = `${x - (real.left - x)}px`;
    painelEmoji.style.top = `${y - (real.top - y)}px`;
  }
  function fecharEmojis() {
    if (painelEmoji.hidden) return;
    painelEmoji.hidden = true;
    botaoEmoji?.setAttribute("aria-expanded", "false");
    botaoEmoji = null;
  }
  painelEmoji.addEventListener("mousedown", (e) => e.preventDefault()); // o cursor continua no texto
  painelEmoji.addEventListener("click", (e) => {
    const b = e.target.closest("[data-emoji]");
    if (!b || !botaoEmoji) return;
    const campo = $("#" + botaoEmoji.dataset.emojiPara);
    const emoji = b.dataset.emoji;
    campo.setRangeText(emoji, campo.selectionStart ?? campo.value.length, campo.selectionEnd ?? campo.value.length, "end");
    campo.dispatchEvent(new Event("input", { bubbles: true }));
    campo.focus();
    const recentes = [emoji, ...lerPreferencia("emojisRecentes", "").split(" ").filter((x) => x && x !== emoji)].slice(0, 16);
    gravarPreferencia("emojisRecentes", recentes.join(" "));
  });
  document.addEventListener("click", (e) => {
    const botao = e.target.closest("[data-emoji-para]");
    if (botao) return botao === botaoEmoji ? fecharEmojis() : abrirEmojis(botao);
    if (!painelEmoji.contains(e.target)) fecharEmojis();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || painelEmoji.hidden) return;
    e.preventDefault(); // fecha só o painel, não o modal
    e.stopPropagation();
    fecharEmojis();
    $("#" + (botaoEmoji?.dataset.emojiPara || "cv-texto"))?.focus();
  }, true);

  $("#cv-lista").addEventListener("click", (e) => {
    const baixa = e.target.closest("[data-baixa]");
    if (baixa) return darBaixa(baixa.dataset.baixa); // não abre a conversa
    const item = e.target.closest("[data-jid]");
    if (item) abrirConversa(item.dataset.jid);
  });
  $("#cv-lista").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".cv-item")) {
      e.preventDefault();
      abrirConversa(e.target.dataset.jid);
    }
  });
  $$("[data-cv-filtro]").forEach((b) => b.addEventListener("click", () => {
    estado.cvFiltro = b.dataset.cvFiltro;
    gravarPreferencia("cvFiltro", estado.cvFiltro);
    renderListaConversas();
  }));
  $("#cv-busca").addEventListener("input", (e) => {
    estado.cvBusca = e.target.value;
    renderListaConversas();
  });

  // Ações do cabeçalho da conversa: adicionar, vincular, mudar etapa, abrir lead, voltar.
  async function acaoConversa(jid, acao, corpo) {
    try {
      await api("POST", `/api/conversas/${jidUrl(jid)}/${acao}`, corpo);
      await carregarConversas();
      if (estado.conversaAberta === jid) await abrirConversa(jid, { rolar: false });
    } catch (err) {
      toast(err.message, true);
    }
  }
  const darBaixa = (jid) => acaoConversa(jid, "baixa").then(() => toast("Atendimento concluído — saiu da fila"));

  $("#cv-cabecalho").addEventListener("click", (e) => {
    const c = estado.conversaDados;
    if (e.target.closest("#cv-voltar")) return fecharConversa();
    if (e.target.closest("#cv-baixa")) return darBaixa(c.jid);
    if (e.target.closest("#cv-por-na-fila")) return acaoConversa(c.jid, "fila").then(() => toast("Conversa colocada na fila"));
    if (e.target.closest("#cv-fixar")) return acaoConversa(c.jid, "fixar", { fixada: !c.fixada }).then(() => toast(c.fixada ? "Conversa desafixada" : "Conversa fixada no topo"));
    const pedido = e.target.closest("[data-novo-pedido]");
    if (pedido) return abrirPedido(null, { leadId: pedido.dataset.novoPedido });
    if (e.target.closest("#cv-adicionar")) return adicionarLeadDaConversa();
    const abrir = e.target.closest("[data-cv-abrir-lead]");
    if (abrir) abrirModal(abrir.dataset.cvAbrirLead);
  });
  $("#cv-cabecalho").addEventListener("change", async (e) => {
    const c = estado.conversaDados;
    if (e.target.id === "cv-mover" && c?.lead) {
      await moverEtapa(c.lead.id, e.target.value);
      await abrirConversa(c.jid, { rolar: false });
      carregarConversas().catch(() => {});
    }
    if (e.target.id === "cv-vincular" && e.target.value) {
      const lead = estado.leads.find((l) => l.id === e.target.value);
      if (!confirm(`Ligar esta conversa ao lead “${lead?.nome}”? O histórico da conversa vai para o lead.`)) {
        e.target.value = "";
        return;
      }
      try {
        substituir(await api("POST", `/api/conversas/${jidUrl(c.jid)}/vincular`, { leadId: e.target.value }));
        toast("Conversa ligada ao lead");
        await abrirConversa(c.jid, { rolar: false });
        carregarConversas().catch(() => {});
      } catch (err) {
        toast(err.message, true);
      }
    }
  });

  function adicionarLeadDaConversa() {
    const c = estado.conversaDados;
    if (!c) return;
    const pais = c.telefone.startsWith("55") ? "Brasil" : c.telefone.startsWith("351") ? "Portugal" : "";
    abrirModal(null, {
      preencher: {
        nome: c.nomeContato || c.nome || "",
        telefone: c.telefone ? formatarTelefone(c.telefone) : "",
        pais,
        etapa: "Novo Lead",
        origem: "WhatsApp",
        whatsappJid: c.jid,
      },
    });
  }

  // Do modal do lead para a conversa dele.
  $("#lead-ver-conversa").addEventListener("click", (e) => {
    e.preventDefault();
    const jid = e.currentTarget.dataset.jid;
    fecharModal();
    trocarAba("conversas");
    abrirConversa(jid);
  });
  function atualizarLinkConversa(lead) {
    const conversa = lead && estado.conversas.find((c) => c.lead?.id === lead.id);
    const link = $("#lead-ver-conversa");
    link.hidden = !conversa;
    if (conversa) link.dataset.jid = conversa.jid;
  }

  document.addEventListener("click", (e) => {
    const ir = e.target.closest("[data-ir-aba]");
    if (!ir) return;
    e.preventDefault();
    trocarAba(ir.dataset.irAba);
  });

  // ---------- Pedidos, produtos e condições de pagamento ----------
  const pd = { pedidos: [], produtos: [], condicoes: [], vendedores: [], config: { empresa: {} }, status: [], aba: "pedidos", filtroStatus: "", filtroPagamento: "", busca: "" };
  const STATUS_VENDA = ["Confirmado", "Em separação", "Enviado", "Entregue"];
  const CLASSE_PAGAMENTO = { Pago: "pg-pago", Parcial: "pg-parcial", Atrasado: "pg-atrasado", Pendente: "pg-pendente", Cancelado: "pg-cancelado" };
  /** Soma separando real e euro (um lead de Portugal gera pedido em €). */
  function somaPorMoeda(lista, campo) {
    const brl = lista.filter((p) => p.moeda !== "EUR").reduce((s, p) => s + (Number(p[campo]) || 0), 0);
    const eur = lista.filter((p) => p.moeda === "EUR").reduce((s, p) => s + (Number(p[campo]) || 0), 0);
    return [brl || !eur ? dinheiro(brl) : "", eur ? dinheiro(eur, "EUR") : ""].filter(Boolean).join(" · ");
  }
  const CLASSE_STATUS = {
    "Orçamento": "st-orcamento", Confirmado: "st-confirmado", "Em separação": "st-separacao",
    Enviado: "st-enviado", Entregue: "st-entregue", Cancelado: "st-cancelado",
  };
  const dinheiro = (v, moeda = "BRL") =>
    new Intl.NumberFormat(moeda === "EUR" ? "pt-PT" : "pt-BR", { style: "currency", currency: moeda }).format(Number(v) || 0);
  const centavos = (n) => Math.round(n * 100) / 100;
  const ICONE_EDITAR = `<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>`;
  const ICONE_LIXO = `<svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>`;
  const ICONE_WA = `<svg viewBox="0 0 24 24"><path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z" /></svg>`;

  async function carregarPedidos() {
    Object.assign(pd, await api("GET", "/api/pedidos"));
    if (estado.aba === "pedidos") renderPedidos();
    if (estado.leadAberto) renderPedidosLead(estado.leads.find((l) => l.id === estado.leadAberto));
  }

  function renderPedidos() {
    $$("[data-pd-aba]").forEach((b) => b.classList.toggle("ativo", b.dataset.pdAba === pd.aba));
    $("#pd-lista-pedidos").hidden = pd.aba !== "pedidos";
    $("#pd-lista-produtos").hidden = pd.aba !== "produtos";
    $("#pd-lista-condicoes").hidden = pd.aba !== "condicoes";
    $("#pd-lista-vendedores").hidden = pd.aba !== "vendedores";
    $("#pd-filtro-pagamento").hidden = pd.aba !== "pedidos";
    $("#pd-novo").textContent = { pedidos: "+ Novo pedido", produtos: "+ Novo produto", condicoes: "+ Nova condição", vendedores: "+ Novo vendedor" }[pd.aba];
    $("#pd-busca").placeholder = { pedidos: "Buscar pedido, cliente, produto ou vendedor", produtos: "Buscar produto ou código", condicoes: "Buscar condição", vendedores: "Buscar vendedor" }[pd.aba];
    if (pd.aba === "vendedores") renderListaVendedores();
    if (pd.aba === "pedidos") renderListaPedidos();
    if (pd.aba === "produtos") renderListaProdutos();
    if (pd.aba === "condicoes") renderListaCondicoes();
  }

  function pedidosFiltrados() {
    const termo = normalizar(pd.busca.trim());
    return pd.pedidos.filter((p) => {
      if (pd.filtroStatus && p.status !== pd.filtroStatus) return false;
      if (pd.filtroPagamento && p.situacaoPagamento !== pd.filtroPagamento) return false;
      if (!termo) return true;
      return normalizar([`#${p.numero}`, p.numero, p.cliente, p.condicao?.nome, p.vendedor?.nome, ...p.itens.map((i) => i.descricao)].join(" ")).includes(termo);
    });
  }

  function renderListaPedidos() {
    // Totais por status (sem contar os cancelados no "em aberto").
    const porStatus = (st) => pd.pedidos.filter((p) => p.status === st);
    const chip = (valor, rotulo, lista) => {
      const soma = lista.reduce((s, p) => s + (p.moeda === "EUR" ? 0 : p.total), 0);
      return `<button type="button" class="pd-chip ${CLASSE_STATUS[valor] || ""}${pd.filtroStatus === valor ? " ativo" : ""}" data-pd-status="${esc(valor)}">
        <span>${esc(rotulo)}</span><strong>${lista.length}</strong>${soma ? `<small>${dinheiro(soma)}</small>` : ""}</button>`;
    };
    $("#pd-status").innerHTML = chip("", "Todos", pd.pedidos) + pd.status.map((st) => chip(st, st, porStatus(st))).join("");
    const lista = pedidosFiltrados();
    $("#pd-corpo").innerHTML = lista.map((p) => {
      const resumoItens = p.itens.map((i) => `${String(i.quantidade).replace(".", ",")} × ${i.descricao}`).join("\n");
      const pagamento = `<span class="pg-chip ${CLASSE_PAGAMENTO[p.situacaoPagamento] || ""}">${esc(p.situacaoPagamento || "")}</span>
        <small>${p.condicao ? `${esc(p.condicao.nome)}${p.parcelas > 1 ? ` · ${p.parcelas}x` : ""}` : "sem condição"}${p.aReceber > 0 && p.situacaoPagamento !== "Pendente" ? ` · falta ${dinheiro(p.aReceber, p.moeda)}` : ""}</small>`;
      return `<tr data-pedido="${p.id}">
        <td><strong>#${p.numero}</strong></td>
        <td>${dataCurta(p.criadoEm)}</td>
        <td>${p.leadId ? `<a href="#" data-abrir-lead="${p.leadId}">${esc(p.cliente)}</a>` : esc(p.cliente)}${p.vendedor ? `<small>vendedor: ${esc(p.vendedor.nome)}</small>` : ""}</td>
        <td title="${esc(resumoItens)}">${p.itens.length} ${p.itens.length === 1 ? "item" : "itens"}<small>${esc(p.itens[0]?.descricao || "")}${p.itens.length > 1 ? "…" : ""}</small></td>
        <td>${pagamento}</td>
        <td class="num"><strong>${dinheiro(p.total, p.moeda)}</strong></td>
        <td class="${CLASSE_STATUS[p.status] || ""}"><select class="pd-status-sel" data-mudar-status="${p.id}" aria-label="Status do pedido">${pd.status.map((st) => `<option${st === p.status ? " selected" : ""}>${esc(st)}</option>`).join("")}</select></td>
        <td class="col-acoes">
          <button class="icone-btn" data-abrir-pedido="${p.id}" title="Abrir / editar">${ICONE_EDITAR}</button>
          ${p.leadId ? `<button class="icone-btn wa" data-pedido-wa="${p.id}" title="Enviar resumo no WhatsApp">${ICONE_WA}</button>` : ""}
          <button class="icone-btn del" data-excluir-pedido="${p.id}" title="Excluir">${ICONE_LIXO}</button>
        </td>
      </tr>`;
    }).join("");
    $("#pd-vazio").hidden = lista.length > 0;
  }

  function renderListaProdutos() {
    const termo = normalizar(pd.busca.trim());
    const lista = pd.produtos.filter((p) => !termo || normalizar(`${p.nome} ${p.codigo} ${p.descricao}`).includes(termo));
    $("#pr-corpo").innerHTML = lista.map((p) => `<tr class="${p.ativo ? "" : "inativo"}">
      <td>${esc(p.codigo || "—")}</td>
      <td><strong>${esc(p.nome)}</strong>${p.descricao ? `<small>${esc(p.descricao)}</small>` : ""}</td>
      <td>${esc(p.unidade)}</td>
      <td class="num"><strong>${dinheiro(p.preco)}</strong></td>
      <td class="num">${p.controlarEstoque ? `<span class="estoque${p.estoque <= 0 ? " zerado" : p.estoque <= (p.estoqueMinimo || 0) ? " baixo" : ""}">${String(p.estoque).replace(".", ",")} ${esc(p.unidade)}</span>` : `<span class="suave">—</span>`}</td>
      <td><label class="interruptor mini"><input type="checkbox" data-ativar-produto="${p.id}" ${p.ativo ? "checked" : ""} /><span class="trilho"></span></label></td>
      <td class="col-acoes">
        <button class="icone-btn" data-editar-produto="${p.id}" title="Editar">${ICONE_EDITAR}</button>
        <button class="icone-btn del" data-excluir-produto="${p.id}" title="Excluir">${ICONE_LIXO}</button>
      </td></tr>`).join("");
    $("#pr-vazio").hidden = lista.length > 0;
  }

  function descreverPrazo(c) {
    const primeiro = c.primeiroVencimentoDias ?? (c.parcelas > 1 ? 30 : 0);
    const inicio = primeiro ? `1ª em ${primeiro} dias` : "1ª no dia do pedido";
    return c.parcelas > 1 ? `${inicio}, depois a cada ${c.intervaloDias || 30} dias` : primeiro ? `em ${primeiro} dias` : "à vista";
  }

  function renderListaVendedores() {
    const termo = normalizar(pd.busca.trim());
    const lista = pd.vendedores.filter((v) => !termo || normalizar(v.nome).includes(termo));
    $("#vd-corpo").innerHTML = lista.map((v) => {
      const vendas = pd.pedidos.filter((p) => p.vendedor?.id === v.id && STATUS_VENDA.includes(p.status));
      return `<tr class="${v.ativo ? "" : "inativo"}">
        <td><strong>${esc(v.nome)}</strong></td>
        <td class="num">${String(v.comissaoPercentual).replace(".", ",")}%</td>
        <td class="num">${vendas.length} · ${somaPorMoeda(vendas, "total")}</td>
        <td class="num"><strong>${somaPorMoeda(vendas, "comissao")}</strong></td>
        <td><label class="interruptor mini"><input type="checkbox" data-ativar-vendedor="${v.id}" ${v.ativo ? "checked" : ""} /><span class="trilho"></span></label></td>
        <td class="col-acoes">
          <button class="icone-btn" data-editar-vendedor="${v.id}" title="Editar">${ICONE_EDITAR}</button>
          <button class="icone-btn del" data-excluir-vendedor="${v.id}" title="Excluir">${ICONE_LIXO}</button>
        </td></tr>`;
    }).join("");
    $("#vd-vazio").hidden = lista.length > 0;
  }

  const descreverAjuste = (a) => (!a ? "—" : a < 0 ? `${String(-a).replace(".", ",")}% de desconto` : `${String(a).replace(".", ",")}% de acréscimo`);

  function renderListaCondicoes() {
    const termo = normalizar(pd.busca.trim());
    const lista = pd.condicoes.filter((c) => !termo || normalizar(`${c.nome} ${c.descricao}`).includes(termo));
    $("#cp-corpo").innerHTML = lista.map((c) => `<tr class="${c.ativo ? "" : "inativo"}">
      <td><strong>${esc(c.nome)}</strong></td>
      <td>${c.parcelas}x</td>
      <td>${descreverPrazo(c)}</td>
      <td class="${c.ajustePercentual < 0 ? "ajuste-desc" : c.ajustePercentual > 0 ? "ajuste-acr" : ""}">${descreverAjuste(c.ajustePercentual)}</td>
      <td>${esc(c.descricao || "")}</td>
      <td><label class="interruptor mini"><input type="checkbox" data-ativar-condicao="${c.id}" ${c.ativo ? "checked" : ""} /><span class="trilho"></span></label></td>
      <td class="col-acoes">
        <button class="icone-btn" data-editar-condicao="${c.id}" title="Editar">${ICONE_EDITAR}</button>
        <button class="icone-btn del" data-excluir-condicao="${c.id}" title="Excluir">${ICONE_LIXO}</button>
      </td></tr>`).join("");
    $("#cp-vazio").hidden = lista.length > 0;
  }

  $$("[data-pd-aba]").forEach((b) => b.addEventListener("click", () => {
    pd.aba = b.dataset.pdAba;
    pd.busca = "";
    $("#pd-busca").value = "";
    renderPedidos();
  }));
  $("#pd-busca").addEventListener("input", (e) => {
    pd.busca = e.target.value;
    renderPedidos();
  });
  $("#pd-novo").addEventListener("click", () => ({ pedidos: abrirPedido, produtos: abrirProduto, condicoes: abrirCondicao, vendedores: abrirVendedor })[pd.aba]());
  $("#pd-filtro-pagamento").addEventListener("change", (e) => {
    pd.filtroPagamento = e.target.value;
    renderListaPedidos();
  });
  $("#pd-status").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pd-status]");
    if (!b) return;
    pd.filtroStatus = pd.filtroStatus === b.dataset.pdStatus ? "" : b.dataset.pdStatus;
    renderListaPedidos();
  });

  // Venda fechada move o lead para "Ganho" (no servidor); avisa para a pessoa não estranhar o Kanban.
  function avisoLeadGanho(pedido, statusNovo) {
    const lead = pedido?.leadId && estado.leads.find((l) => l.id === pedido.leadId);
    return pd.config.moverLeadParaGanho && STATUS_VENDA.includes(statusNovo) && lead && lead.etapa !== "Ganho" ? ` — ${lead.nome} foi para “Ganho”` : "";
  }

  async function mudarStatusPedido(id, status) {
    try {
      const aviso = avisoLeadGanho(pd.pedidos.find((x) => x.id === id), status);
      await api("POST", `/api/pedidos/${id}/status`, { status });
      toast(`Pedido agora está “${status}”${aviso}`);
      await carregarPedidos();
    } catch (err) {
      toast(err.message, true);
      renderPedidos();
    }
  }
  async function enviarPedidoWhatsApp(id) {
    const p = pd.pedidos.find((x) => x.id === id);
    if (!confirm(`Enviar o resumo do pedido #${p?.numero} para ${p?.cliente} pelo WhatsApp?`)) return;
    try {
      await api("POST", `/api/pedidos/${id}/whatsapp`);
      toast("Resumo do pedido enviado pelo WhatsApp");
    } catch (err) {
      toast(err.message, true);
    }
  }
  async function excluirRegistro(url, pergunta, ok) {
    if (!confirm(pergunta)) return false;
    try {
      await api("DELETE", url);
      toast(ok);
      await carregarPedidos();
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  }

  // Ações das três listas (delegadas para sobreviver ao redesenho).
  $("#painel-pedidos").addEventListener("click", (e) => {
    const t = (sel) => e.target.closest(sel);
    let b;
    if ((b = t("[data-abrir-pedido]"))) return abrirPedido(b.dataset.abrirPedido);
    if ((b = t("[data-pedido-wa]"))) return enviarPedidoWhatsApp(b.dataset.pedidoWa);
    if ((b = t("[data-excluir-pedido]"))) {
      const p = pd.pedidos.find((x) => x.id === b.dataset.excluirPedido);
      return excluirRegistro(`/api/pedidos/${p.id}`, `Excluir o pedido #${p.numero} de ${p.cliente}?`, "Pedido excluído");
    }
    if ((b = t("[data-editar-produto]"))) return abrirProduto(b.dataset.editarProduto);
    if ((b = t("[data-excluir-produto]"))) {
      const p = pd.produtos.find((x) => x.id === b.dataset.excluirProduto);
      return excluirRegistro(`/api/produtos/${p.id}`, `Excluir o produto “${p.nome}”? Os pedidos já feitos não mudam.`, "Produto excluído");
    }
    if ((b = t("[data-editar-condicao]"))) return abrirCondicao(b.dataset.editarCondicao);
    if ((b = t("[data-editar-vendedor]"))) return abrirVendedor(b.dataset.editarVendedor);
    if ((b = t("[data-excluir-vendedor]"))) {
      const v = pd.vendedores.find((x) => x.id === b.dataset.excluirVendedor);
      return excluirRegistro(`/api/vendedores/${v.id}`, `Excluir o vendedor “${v.nome}”? Os pedidos já feitos continuam com o nome dele.`, "Vendedor excluído");
    }
    if ((b = t("[data-excluir-condicao]"))) {
      const c = pd.condicoes.find((x) => x.id === b.dataset.excluirCondicao);
      return excluirRegistro(`/api/condicoes/${c.id}`, `Excluir a condição “${c.nome}”? Os pedidos já feitos não mudam.`, "Condição excluída");
    }
  });
  $("#painel-pedidos").addEventListener("change", async (e) => {
    const d = e.target.dataset;
    if (d.mudarStatus) return mudarStatusPedido(d.mudarStatus, e.target.value);
    const [rota, id] = d.ativarProduto ? ["produtos", d.ativarProduto] : d.ativarCondicao ? ["condicoes", d.ativarCondicao] : d.ativarVendedor ? ["vendedores", d.ativarVendedor] : [];
    if (!rota) return;
    try {
      await api("PATCH", `/api/${rota}/${id}`, { ativo: e.target.checked });
      await carregarPedidos();
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, true);
    }
  });

  // ---- formulário do pedido ----
  const modalPedido = $("#modal-pedido");
  const formPedido = $("#form-pedido");
  let pedidoEditado = null;
  let itensPedido = [];

  const condicaoEscolhida = () => pd.condicoes.find((c) => c.id === formPedido.condicaoId.value) || (pedidoEditado?.condicao?.id === formPedido.condicaoId.value ? pedidoEditado.condicao : null);
  const moedaDoPedido = () => {
    const lead = estado.leads.find((l) => l.id === formPedido.leadId.value);
    return lead ? (lead.pais === "Portugal" ? "EUR" : "BRL") : pedidoEditado?.moeda || "BRL";
  };

  function opcoesProduto(selecionado) {
    const ativos = pd.produtos.filter((p) => p.ativo || p.id === selecionado);
    return `<option value="">✎ Item avulso (digitar)</option>` + ativos.map((p) => `<option value="${p.id}"${p.id === selecionado ? " selected" : ""}>${esc(p.nome)}${p.codigo ? ` (${esc(p.codigo)})` : ""} — ${dinheiro(p.preco)}${p.controlarEstoque ? ` · estoque ${String(p.estoque).replace(".", ",")}` : ""}</option>`).join("");
  }

  function renderItensPedido() {
    const moeda = moedaDoPedido();
    $("#pedido-itens").innerHTML = itensPedido.map((i, n) => `<div class="item-pedido" data-n="${n}">
        <div class="item-produto">
          <select data-campo-item="produtoId" aria-label="Produto">${opcoesProduto(i.produtoId)}</select>
          <input data-campo-item="descricao" value="${esc(i.descricao)}" placeholder="Descrição do item" maxlength="200" ${i.produtoId ? "hidden" : ""} />
        </div>
        <input data-campo-item="quantidade" type="number" min="0" step="any" inputmode="decimal" value="${i.quantidade}" aria-label="Quantidade" />
        <input data-campo-item="precoUnitario" type="number" min="0" step="0.01" inputmode="decimal" value="${i.precoUnitario}" aria-label="Preço unitário" />
        <span class="item-total">${dinheiro((Number(i.quantidade) || 0) * (Number(i.precoUnitario) || 0), moeda)}</span>
        <button type="button" class="icone-btn del" data-remover-item="${n}" title="Remover item" ${itensPedido.length === 1 ? "disabled" : ""}>${ICONE_LIXO}</button>
      </div>`).join("");
    renderTotaisPedido();
  }

  // Prévia dos totais (o servidor recalcula ao salvar, com a mesma regra).
  function renderTotaisPedido() {
    const moeda = moedaDoPedido();
    $$("#pedido-itens .item-pedido").forEach((linha, n) => {
      const i = itensPedido[n];
      linha.querySelector(".item-total").textContent = dinheiro((Number(i.quantidade) || 0) * (Number(i.precoUnitario) || 0), moeda);
    });
    const subtotal = centavos(itensPedido.reduce((s, i) => s + centavos((Number(i.quantidade) || 0) * (Number(i.precoUnitario) || 0)), 0));
    const c = condicaoEscolhida();
    const ajuste = centavos(subtotal * ((c?.ajustePercentual || 0) / 100));
    const desconto = Number(formPedido.desconto.value) || 0;
    const frete = Number(formPedido.frete.value) || 0;
    const total = centavos(Math.max(0, subtotal + ajuste - desconto + frete));
    const parcelas = c?.parcelas || 1;
    const linha = (rotulo, valor, classe = "") => `<div class="${classe}"><span>${rotulo}</span><strong>${valor}</strong></div>`;
    $("#pedido-totais").innerHTML =
      linha("Subtotal", dinheiro(subtotal, moeda)) +
      (ajuste ? linha(`${ajuste < 0 ? "Desconto" : "Acréscimo"} — ${esc(c.nome)}`, `${ajuste < 0 ? "−" : "+"} ${dinheiro(Math.abs(ajuste), moeda)}`, ajuste < 0 ? "ajuste-desc" : "ajuste-acr") : "") +
      (desconto ? linha("Desconto", `− ${dinheiro(desconto, moeda)}`, "ajuste-desc") : "") +
      (frete ? linha("Frete", `+ ${dinheiro(frete, moeda)}`) : "") +
      linha("Total", `${dinheiro(total, moeda)}${parcelas > 1 ? `<small>${parcelas}x de ${dinheiro(centavos(total / parcelas), moeda)}</small>` : ""}`, "total-final") +
      (vendedorEscolhido() ? linha(`Comissão de ${esc(vendedorEscolhido().nome)} (${String(vendedorEscolhido().comissaoPercentual).replace(".", ",")}%)`, dinheiro(centavos((total * vendedorEscolhido().comissaoPercentual) / 100), moeda), "linha-comissao") : "");
    renderParcelasPedido(total, c, moeda);
  }

  const vendedorEscolhido = () => pd.vendedores.find((v) => v.id === formPedido.vendedorId.value) || (pedidoEditado?.vendedor?.id === formPedido.vendedorId.value ? pedidoEditado.vendedor : null);

  // Mesma regra do servidor (pedidos.mjs → #parcelas): última parcela leva os centavos que sobram.
  function previaParcelas(total, condicao) {
    const n = condicao?.parcelas || 1;
    const valores = Array.from({ length: n }, (_, i) => (i < n - 1 ? Math.floor((total / n) * 100) / 100 : 0));
    valores[n - 1] = centavos(total - valores.slice(0, -1).reduce((s, v) => s + v, 0));
    const primeiro = condicao?.primeiroVencimentoDias ?? (n > 1 ? 30 : 0);
    const intervalo = condicao?.intervaloDias || 30;
    const base = new Date(pedidoEditado?.criadoEm || Date.now());
    return valores.map((valor, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + primeiro + i * intervalo);
      return { numero: i + 1, valor, vencimento: d.toISOString().slice(0, 10), pagaEm: "" };
    });
  }

  function renderParcelasPedido(total, condicao, moeda) {
    const previa = previaParcelas(total, condicao);
    const salvas = pedidoEditado?.pagamentos || [];
    const mesmas = salvas.length === previa.length && salvas.every((p, i) => p.valor === previa[i].valor);
    const temPaga = salvas.some((p) => p.pagaEm);
    const hoje = new Date().toISOString().slice(0, 10);
    const lista = mesmas ? salvas : previa;
    const interativa = mesmas && pedidoEditado;
    const dataBr = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("pt-BR");
    $("#pedido-parcelas").innerHTML = `<h4>Pagamento ${interativa ? "" : "<small>(as datas são confirmadas ao salvar)</small>"}</h4>
      ${!mesmas && temPaga ? `<p class="diag-aviso">Este pedido já tem parcela paga. Para mudar valores ou a condição, desmarque o pagamento primeiro.</p>` : ""}
      <div class="parcelas">${lista.map((p) => `<div class="parcela${p.pagaEm ? " paga" : !p.pagaEm && p.vencimento < hoje ? " vencida" : ""}">
        <span class="parcela-num">${p.numero}/${lista.length}</span>
        ${interativa ? `<input type="date" value="${p.vencimento}" data-parcela-venc="${p.numero}" aria-label="Vencimento da parcela ${p.numero}" ${p.pagaEm ? "disabled" : ""} />` : `<span>${dataBr(p.vencimento)}</span>`}
        <strong>${dinheiro(p.valor, moeda)}</strong>
        ${interativa ? `<label class="check"><input type="checkbox" data-parcela-paga="${p.numero}" ${p.pagaEm ? "checked" : ""} /> ${p.pagaEm ? `paga em ${new Date(p.pagaEm).toLocaleDateString("pt-BR")}` : "paga"}</label>` : ""}
      </div>`).join("")}</div>`;
  }

  // Marcar parcela como paga ou mudar o vencimento: salva na hora (não espera o "Salvar pedido").
  $("#pedido-parcelas").addEventListener("change", async (e) => {
    const numeroPaga = e.target.dataset.parcelaPaga;
    const numeroVenc = e.target.dataset.parcelaVenc;
    if (!pedidoEditado || (!numeroPaga && !numeroVenc)) return;
    const corpo = numeroPaga ? { paga: e.target.checked } : { vencimento: e.target.value };
    try {
      const atualizado = await api("PATCH", `/api/pedidos/${pedidoEditado.id}/pagamentos/${numeroPaga || numeroVenc}`, corpo);
      pedidoEditado = atualizado;
      const i = pd.pedidos.findIndex((x) => x.id === atualizado.id);
      if (i >= 0) pd.pedidos[i] = atualizado;
      renderTotaisPedido();
      if (numeroPaga) toast(e.target.checked ? `Parcela ${numeroPaga} paga — situação: ${atualizado.situacaoPagamento}` : `Parcela ${numeroPaga} desmarcada`);
    } catch (err) {
      toast(err.message, true);
      renderTotaisPedido();
    }
  });

  function abrirPedido(id = null, { leadId = "" } = {}) {
    const p = id ? pd.pedidos.find((x) => x.id === id) : null;
    pedidoEditado = p;
    formPedido.reset();
    $("#pedido-titulo").textContent = p ? `Pedido #${p.numero}` : "Novo pedido";
    $("#pedido-excluir").hidden = !p;
    $("#pedido-whatsapp").hidden = !(p && p.leadId);
    $("#pedido-imprimir").hidden = !p;
    if (p) $("#pedido-imprimir").href = `/pedidos/${p.id}/imprimir`;
    const leadEscolhido = p ? p.leadId : leadId;
    const leads = [...estado.leads].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    formPedido.leadId.innerHTML = `<option value="">Selecione o cliente…</option>` +
      leads.map((l) => `<option value="${l.id}"${l.id === leadEscolhido ? " selected" : ""}>${esc(l.nome)}${l.empresa ? " — " + esc(l.empresa) : ""}</option>`).join("") +
      `<option value="__avulso"${p && !p.leadId ? " selected" : ""}>— Cliente sem cadastro —</option>`;
    formPedido.clienteNome.value = p && !p.leadId ? p.cliente : "";
    $("#campo-cliente-avulso").hidden = formPedido.leadId.value !== "__avulso";
    const conds = pd.condicoes.filter((c) => c.ativo || c.id === p?.condicao?.id);
    const condAntiga = p?.condicao && !pd.condicoes.some((c) => c.id === p.condicao.id) ? p.condicao : null;
    formPedido.condicaoId.innerHTML = `<option value="">Sem condição definida</option>` +
      [...conds, ...(condAntiga ? [condAntiga] : [])].map((c) => `<option value="${c.id}"${c.id === p?.condicao?.id ? " selected" : ""}>${esc(c.nome)}${c.parcelas > 1 ? ` · ${c.parcelas}x` : ""}${c.ajustePercentual ? ` · ${c.ajustePercentual > 0 ? "+" : ""}${String(c.ajustePercentual).replace(".", ",")}%` : ""}</option>`).join("");
    formPedido.status.innerHTML = pd.status.map((st) => `<option${st === (p?.status || "Orçamento") ? " selected" : ""}>${esc(st)}</option>`).join("");
    const vends = pd.vendedores.filter((v) => v.ativo || v.id === p?.vendedor?.id);
    const vendAntigo = p?.vendedor && !pd.vendedores.some((v) => v.id === p.vendedor.id) ? p.vendedor : null;
    formPedido.vendedorId.innerHTML = `<option value="">Sem vendedor</option>` + [...vends, ...(vendAntigo ? [vendAntigo] : [])].map((v) => `<option value="${v.id}"${v.id === p?.vendedor?.id ? " selected" : ""}>${esc(v.nome)} (${String(v.comissaoPercentual).replace(".", ",")}%)</option>`).join("");
    formPedido.desconto.value = p?.desconto || "";
    formPedido.frete.value = p?.frete || "";
    formPedido.observacoes.value = p?.observacoes || "";
    itensPedido = p ? p.itens.map((i) => ({ produtoId: pd.produtos.some((x) => x.id === i.produtoId) ? i.produtoId : "", descricao: i.descricao, quantidade: i.quantidade, precoUnitario: i.precoUnitario })) : [{ produtoId: "", descricao: "", quantidade: 1, precoUnitario: 0 }];
    renderItensPedido();
    $("#pedido-historico").innerHTML = p?.historico?.length
      ? `<h4>Histórico do status</h4>` + [...p.historico].reverse().map((h) => `<div><span class="pd-chip-mini ${CLASSE_STATUS[h.status] || ""}">${esc(h.status)}</span><time>${new Date(h.em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time></div>`).join("")
      : "";
    modalPedido.showModal();
    if (!p && !leadEscolhido) formPedido.leadId.focus();
  }

  formPedido.leadId.addEventListener("change", () => {
    $("#campo-cliente-avulso").hidden = formPedido.leadId.value !== "__avulso";
    renderItensPedido(); // a moeda acompanha o país do cliente
  });
  formPedido.condicaoId.addEventListener("change", renderTotaisPedido);
  formPedido.vendedorId.addEventListener("change", renderTotaisPedido);
  formPedido.desconto.addEventListener("input", renderTotaisPedido);
  formPedido.frete.addEventListener("input", renderTotaisPedido);
  $("#pedido-add-item").addEventListener("click", () => {
    itensPedido.push({ produtoId: "", descricao: "", quantidade: 1, precoUnitario: 0 });
    renderItensPedido();
    $$("#pedido-itens .item-pedido select").at(-1)?.focus();
  });
  $("#pedido-itens").addEventListener("click", (e) => {
    const b = e.target.closest("[data-remover-item]");
    if (!b) return;
    itensPedido.splice(Number(b.dataset.removerItem), 1);
    renderItensPedido();
  });
  $("#pedido-itens").addEventListener("input", (e) => {
    const campo = e.target.dataset.campoItem;
    if (!campo || campo === "produtoId") return;
    itensPedido[Number(e.target.closest(".item-pedido").dataset.n)][campo] = e.target.value;
    renderTotaisPedido();
  });
  $("#pedido-itens").addEventListener("change", (e) => {
    if (e.target.dataset.campoItem !== "produtoId") return;
    const item = itensPedido[Number(e.target.closest(".item-pedido").dataset.n)];
    const produto = pd.produtos.find((p) => p.id === e.target.value);
    item.produtoId = produto?.id || "";
    if (produto) {
      item.descricao = produto.nome;
      item.precoUnitario = produto.preco;
    }
    renderItensPedido();
  });

  formPedido.addEventListener("submit", async (e) => {
    e.preventDefault();
    const avulso = formPedido.leadId.value === "__avulso";
    if (!formPedido.leadId.value) return toast("Escolha o cliente do pedido", true);
    if (avulso && !formPedido.clienteNome.value.trim()) return toast("Digite o nome do cliente", true);
    const corpo = {
      leadId: avulso ? "" : formPedido.leadId.value,
      clienteNome: avulso ? formPedido.clienteNome.value.trim() : "",
      itens: itensPedido.map((i) => ({ produtoId: i.produtoId, descricao: i.descricao, quantidade: Number(i.quantidade), precoUnitario: Number(i.precoUnitario) })),
      condicaoId: formPedido.condicaoId.value,
      vendedorId: formPedido.vendedorId.value,
      status: formPedido.status.value,
      desconto: Number(formPedido.desconto.value) || 0,
      frete: Number(formPedido.frete.value) || 0,
      observacoes: formPedido.observacoes.value,
    };
    const botao = $("#pedido-salvar");
    botao.disabled = true;
    try {
      const salvo = pedidoEditado ? await api("PATCH", `/api/pedidos/${pedidoEditado.id}`, corpo) : await api("POST", "/api/pedidos", corpo);
      modalPedido.close();
      const aviso = avisoLeadGanho({ leadId: corpo.leadId }, corpo.status);
      toast((pedidoEditado ? `Pedido #${salvo.numero} atualizado` : `Pedido #${salvo.numero} criado — ${dinheiro(salvo.total, salvo.moeda)}`) + aviso);
      await carregarPedidos();
    } catch (err) {
      toast(err.message, true);
    } finally {
      botao.disabled = false;
    }
  });
  $("#pedido-excluir").addEventListener("click", async () => {
    const p = pedidoEditado;
    if (await excluirRegistro(`/api/pedidos/${p.id}`, `Excluir o pedido #${p.numero} de ${p.cliente}?`, "Pedido excluído")) modalPedido.close();
  });
  $("#pedido-whatsapp").addEventListener("click", () => enviarPedidoWhatsApp(pedidoEditado.id));

  // ---- produto e condição de pagamento ----
  function ligarCadastro({ modal, form, titulo, excluir, rota, nomeItem, colecao, preencher, ler, genero = "o" }) {
    let editado = null;
    const abrir = (id = null) => {
      editado = id ? pd[colecao].find((x) => x.id === id) : null;
      form.reset();
      $(titulo).textContent = editado ? `Editar ${nomeItem}` : `Nov${genero} ${nomeItem}`;
      $(excluir).hidden = !editado;
      preencher(editado);
      modal.showModal();
      form.nome.focus();
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await (editado ? api("PATCH", `/api/${rota}/${editado.id}`, ler()) : api("POST", `/api/${rota}`, ler()));
        modal.close();
        toast(`${nomeItem[0].toUpperCase() + nomeItem.slice(1)} salv${genero}`);
        await carregarPedidos();
      } catch (err) {
        toast(err.message, true);
      }
    });
    $(excluir).addEventListener("click", async () => {
      if (await excluirRegistro(`/api/${rota}/${editado.id}`, `Excluir “${editado.nome}”? Os pedidos já feitos não mudam.`, "Excluído")) modal.close();
    });
    return abrir;
  }
  const formProduto = $("#form-produto");
  const abrirProduto = ligarCadastro({
    modal: $("#modal-produto"), form: formProduto, titulo: "#produto-titulo", excluir: "#produto-excluir", rota: "produtos", nomeItem: "produto", colecao: "produtos",
    preencher: (p) => {
      formProduto.nome.value = p?.nome || "";
      formProduto.codigo.value = p?.codigo || "";
      formProduto.unidade.value = p?.unidade || "un";
      formProduto.preco.value = p ? p.preco : "";
      formProduto.descricao.value = p?.descricao || "";
      formProduto.ativo.checked = p ? p.ativo : true;
      formProduto.controlarEstoque.checked = !!p?.controlarEstoque;
      formProduto.estoque.value = p?.estoque ?? 0;
      formProduto.estoqueMinimo.value = p?.estoqueMinimo ?? 0;
      $$(".campo-estoque", formProduto).forEach((c) => (c.hidden = !formProduto.controlarEstoque.checked));
    },
    ler: () => ({
      nome: formProduto.nome.value, codigo: formProduto.codigo.value, unidade: formProduto.unidade.value,
      preco: formProduto.preco.value === "" ? 0 : Number(formProduto.preco.value), descricao: formProduto.descricao.value, ativo: formProduto.ativo.checked,
      controlarEstoque: formProduto.controlarEstoque.checked, estoque: Number(formProduto.estoque.value) || 0, estoqueMinimo: Number(formProduto.estoqueMinimo.value) || 0,
    }),
  });
  const formCondicao = $("#form-condicao");
  const abrirCondicao = ligarCadastro({
    modal: $("#modal-condicao"), form: formCondicao, titulo: "#condicao-titulo", excluir: "#condicao-excluir", rota: "condicoes", nomeItem: "condição de pagamento", colecao: "condicoes", genero: "a",
    preencher: (c) => {
      formCondicao.nome.value = c?.nome || "";
      formCondicao.parcelas.value = c?.parcelas || 1;
      formCondicao.ajustePercentual.value = c?.ajustePercentual || 0;
      formCondicao.descricao.value = c?.descricao || "";
      formCondicao.ativo.checked = c ? c.ativo : true;
      formCondicao.primeiroVencimentoDias.value = c?.primeiroVencimentoDias ?? (c && c.parcelas > 1 ? 30 : 0);
      formCondicao.intervaloDias.value = c?.intervaloDias || 30;
    },
    ler: () => ({
      nome: formCondicao.nome.value, parcelas: Number(formCondicao.parcelas.value), ajustePercentual: Number(formCondicao.ajustePercentual.value) || 0,
      descricao: formCondicao.descricao.value, ativo: formCondicao.ativo.checked,
      primeiroVencimentoDias: Number(formCondicao.primeiroVencimentoDias.value) || 0, intervaloDias: Number(formCondicao.intervaloDias.value) || 30,
    }),
  });
  formProduto.controlarEstoque.addEventListener("change", (e) => $$(".campo-estoque", formProduto).forEach((c) => (c.hidden = !e.target.checked)));

  const formVendedor = $("#form-vendedor");
  const abrirVendedor = ligarCadastro({
    modal: $("#modal-vendedor"), form: formVendedor, titulo: "#vendedor-titulo", excluir: "#vendedor-excluir", rota: "vendedores", nomeItem: "vendedor", colecao: "vendedores",
    preencher: (v) => {
      formVendedor.nome.value = v?.nome || "";
      formVendedor.comissaoPercentual.value = v?.comissaoPercentual ?? 0;
      formVendedor.ativo.checked = v ? v.ativo : true;
    },
    ler: () => ({ nome: formVendedor.nome.value, comissaoPercentual: Number(formVendedor.comissaoPercentual.value) || 0, ativo: formVendedor.ativo.checked }),
  });

  // ---- dados da empresa (pedido impresso) e regra do lead "Ganho" ----
  const modalPdConfig = $("#modal-pd-config");
  const formPdConfig = $("#form-pd-config");
  $("#pd-config").addEventListener("click", () => {
    const emp = pd.config.empresa || {};
    for (const k of ["nome", "documento", "telefone", "email", "endereco"]) formPdConfig[k].value = emp[k] || "";
    formPdConfig.moverLeadParaGanho.checked = pd.config.moverLeadParaGanho !== false;
    modalPdConfig.showModal();
  });
  formPdConfig.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const empresa = Object.fromEntries(["nome", "documento", "telefone", "email", "endereco"].map((k) => [k, formPdConfig[k].value]));
      pd.config = await api("PATCH", "/api/pedidos-config", { empresa, moverLeadParaGanho: formPdConfig.moverLeadParaGanho.checked });
      modalPdConfig.close();
      toast("Dados da empresa salvos");
    } catch (err) {
      toast(err.message, true);
    }
  });

  for (const dlg of [modalPedido, $("#modal-produto"), $("#modal-condicao"), $("#modal-vendedor"), modalPdConfig]) {
    $$("[data-fechar]", dlg).forEach((b) => b.addEventListener("click", () => dlg.close()));
    dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());
  }

  // ---- no modal do lead: pedidos dele ----
  function renderPedidosLead(lead) {
    if (!lead) return;
    const lista = pd.pedidos.filter((p) => p.leadId === lead.id);
    $("#pedidos-lead").innerHTML = lista.length
      ? lista.map((p) => `<div class="item pedido-do-lead" data-abrir-pedido="${p.id}" role="button" tabindex="0">
          <div class="item-corpo"><strong>Pedido #${p.numero} <span class="pd-chip-mini ${CLASSE_STATUS[p.status] || ""}">${esc(p.status)}</span></strong>
          <span class="fluxo">${dataCurta(p.criadoEm)} · ${p.itens.length} ${p.itens.length === 1 ? "item" : "itens"}${p.condicao ? ` · ${esc(p.condicao.nome)}` : ""}</span></div>
          <strong class="valor">${dinheiro(p.total, p.moeda)}</strong>
        </div>`).join("")
      : `<p class="sem-msg">Nenhum pedido ainda.</p>`;
  }
  $("#pedidos-lead").addEventListener("click", (e) => {
    const b = e.target.closest("[data-abrir-pedido]");
    if (b) abrirPedido(b.dataset.abrirPedido);
  });
  $("#lead-novo-pedido").addEventListener("click", () => abrirPedido(null, { leadId: estado.leadAberto }));

  // ---------- importação de planilha (CSV) ----------
  const CAMPOS_IMPORTACAO = [
    ["nome", "Nome", ["nome", "name", "cliente", "contato", "nome completo", "lead"]],
    ["telefone", "Telefone", ["telefone", "fone", "celular", "whatsapp", "phone", "tel", "telefone celular"]],
    ["email", "E-mail", ["email", "e-mail", "mail", "correio eletronico"]],
    ["empresa", "Empresa", ["empresa", "company", "companhia", "razao social", "negocio"]],
    ["cargo", "Cargo", ["cargo", "funcao", "job", "titulo"]],
    ["cidade", "Cidade", ["cidade", "city", "municipio"]],
    ["uf", "UF / Estado", ["uf", "estado", "state"]],
    ["pais", "País", ["pais", "country"]],
    ["distrito", "Distrito (Portugal)", ["distrito"]],
    ["faturamentoMensal", "Faturamento mensal", ["faturamento", "faturamento mensal", "receita", "valor", "faturamento (r$)"]],
    ["etapa", "Etapa do funil", ["etapa", "etapa do funil", "status", "fase", "estagio"]],
    ["origem", "Origem", ["origem", "fonte", "canal", "source"]],
    ["etiquetas", "Etiquetas", ["etiquetas", "etiqueta", "tags", "tag"]],
    ["observacoes", "Observações", ["observacoes", "observacao", "obs", "notas", "comentarios", "anotacoes"]],
    ["criadoEm", "Data de criação", ["data", "data de criacao", "criado em", "data cadastro", "data de cadastro"]],
  ];
  const imp = { cabecalho: [], linhas: [], mapa: [] };
  const modalImportar = $("#modal-importar");

  /** Lê CSV com aspas, separador ; , ou TAB (detectado na primeira linha). */
  function lerCsv(texto) {
    texto = texto.replace(/^﻿/, "");
    const primeira = texto.split(/\r?\n/, 1)[0];
    const contar = (c) => primeira.split(c).length - 1;
    const sep = [";", ",", "\t"].sort((a, b) => contar(b) - contar(a))[0];
    const linhas = [];
    let campo = "", linha = [], aspas = false;
    for (let i = 0; i < texto.length; i++) {
      const ch = texto[i];
      if (aspas) {
        if (ch === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
        else if (ch === '"') aspas = false;
        else campo += ch;
      } else if (ch === '"') aspas = true;
      else if (ch === sep) { linha.push(campo); campo = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && texto[i + 1] === "\n") i++;
        linha.push(campo); campo = "";
        if (linha.some((c) => c.trim())) linhas.push(linha);
        linha = [];
      } else campo += ch;
    }
    linha.push(campo);
    if (linha.some((c) => c.trim())) linhas.push(linha);
    return linhas;
  }

  // Excel em português costuma salvar CSV em Windows-1252; o resto em UTF-8.
  async function textoDoArquivo(arquivo) {
    const bytes = await arquivo.arrayBuffer();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("windows-1252").decode(bytes);
    }
  }

  function adivinharCampo(cabecalho, usados) {
    const n = normalizar(cabecalho).replace(/[_*]/g, " ").replace(/\s+/g, " ").trim();
    for (const [campo, , sinonimos] of CAMPOS_IMPORTACAO) {
      if (usados.has(campo)) continue;
      if (sinonimos.includes(n)) return campo;
    }
    for (const [campo, , sinonimos] of CAMPOS_IMPORTACAO) {
      if (!usados.has(campo) && sinonimos.some((s) => s.length > 3 && n.includes(s))) return campo;
    }
    return "";
  }

  function abrirImportacao() {
    $("#imp-passo-arquivo").hidden = false;
    $("#imp-passo-mapa").hidden = true;
    $("#imp-passo-resultado").hidden = true;
    $("#imp-confirmar").hidden = true;
    $("#imp-voltar").hidden = true;
    $("#imp-arquivo").value = "";
    $("#imp-etapa").innerHTML = opcoesEtapa("Novo Lead");
    modalImportar.showModal();
  }

  async function carregarPlanilha(arquivo) {
    if (!arquivo) return;
    if (/\.xlsx?$/i.test(arquivo.name)) return toast("Esse é um arquivo do Excel. Salve como CSV (Arquivo › Salvar como › CSV) e escolha de novo.", true);
    const linhas = lerCsv(await textoDoArquivo(arquivo));
    if (linhas.length < 2) return toast("A planilha precisa ter a linha de títulos e pelo menos uma linha de dados", true);
    imp.cabecalho = linhas[0].map((c) => c.trim());
    imp.linhas = linhas.slice(1);
    const usados = new Set();
    imp.mapa = imp.cabecalho.map((c) => {
      const campo = adivinharCampo(c, usados);
      if (campo) usados.add(campo);
      return campo;
    });
    renderMapaImportacao();
    $("#imp-passo-arquivo").hidden = true;
    $("#imp-passo-mapa").hidden = false;
    $("#imp-voltar").hidden = false;
    $("#imp-confirmar").hidden = false;
  }

  function linhasMapeadas() {
    return imp.linhas.map((valores, i) => {
      const campos = {};
      imp.mapa.forEach((campo, col) => {
        if (!campo) return;
        const v = (valores[col] || "").trim();
        // Duas colunas no mesmo campo (ex.: "Obs 1" e "Obs 2"): junta.
        campos[campo] = campos[campo] ? `${campos[campo]}${campo === "etiquetas" ? "," : " "}${v}` : v;
      });
      return { linha: i + 2, campos };
    });
  }

  function renderMapaImportacao() {
    $("#imp-resumo").innerHTML = `<strong>${imp.linhas.length}</strong> ${imp.linhas.length === 1 ? "linha encontrada" : "linhas encontradas"} e ${imp.cabecalho.length} colunas.`;
    const opcoes = (sel) => `<option value="">— não importar —</option>` + CAMPOS_IMPORTACAO.map(([c, r]) => `<option value="${c}"${c === sel ? " selected" : ""}>${r}</option>`).join("");
    $("#imp-mapa").innerHTML = imp.cabecalho.map((c, col) => `<div class="imp-coluna${imp.mapa[col] ? " mapeada" : ""}">
        <span class="imp-cab">${esc(c || `Coluna ${col + 1}`)}</span>
        <small>${esc(imp.linhas.find((l) => (l[col] || "").trim())?.[col] || "(vazia)")}</small>
        <span class="imp-seta">→</span>
        <select data-imp-col="${col}" aria-label="Campo para a coluna ${esc(c)}">${opcoes(imp.mapa[col])}</select>
      </div>`).join("");
    renderPreviaImportacao();
  }

  function renderPreviaImportacao() {
    const usados = CAMPOS_IMPORTACAO.filter(([c]) => imp.mapa.includes(c));
    const temIdentificacao = ["nome", "empresa", "telefone", "email"].some((c) => imp.mapa.includes(c));
    $("#imp-confirmar").disabled = !temIdentificacao;
    $("#imp-confirmar").textContent = `Importar ${imp.linhas.length} ${imp.linhas.length === 1 ? "lead" : "leads"}`;
    if (!temIdentificacao) {
      $("#imp-previa").innerHTML = `<tbody><tr><td class="vazio">Escolha qual coluna é o <strong>Nome</strong> (ou Empresa, Telefone ou E-mail).</td></tr></tbody>`;
      return;
    }
    const linhas = linhasMapeadas().slice(0, 5);
    $("#imp-previa").innerHTML = `<thead><tr>${usados.map(([, r]) => `<th>${r}</th>`).join("")}</tr></thead>
      <tbody>${linhas.map((l) => `<tr>${usados.map(([c]) => `<td>${esc(l.campos[c] || "")}</td>`).join("")}</tr>`).join("")}</tbody>`;
  }

  async function confirmarImportacao() {
    const botao = $("#imp-confirmar");
    botao.disabled = true;
    botao.textContent = "Importando…";
    try {
      const r = await api("POST", "/api/leads/importar", {
        linhas: linhasMapeadas(),
        padroes: { etapa: $("#imp-etapa").value, origem: $("#imp-origem").value.trim() },
        pularDuplicados: $("#imp-duplicados").checked,
      });
      const lista = (itens) => itens.slice(0, 15).map((x) => `<li>Linha ${x.linha}${x.nome ? ` (${esc(x.nome)})` : ""}: ${esc(x.motivo)}</li>`).join("") + (itens.length > 15 ? `<li>… e mais ${itens.length - 15}</li>` : "");
      $("#imp-passo-resultado").innerHTML = `<div class="imp-final">
          <div class="imp-numero ok"><strong>${r.criados}</strong><span>importados</span></div>
          <div class="imp-numero"><strong>${r.pulados.length}</strong><span>já cadastrados (pulados)</span></div>
          <div class="imp-numero ${r.erros.length ? "erro" : ""}"><strong>${r.erros.length}</strong><span>com problema</span></div>
        </div>
        ${r.erros.length ? `<h4 class="imp-titulo">Linhas não importadas</h4><ul class="imp-lista">${lista(r.erros)}</ul>` : ""}
        ${r.pulados.length ? `<h4 class="imp-titulo">Puladas por já existirem</h4><ul class="imp-lista">${lista(r.pulados)}</ul>` : ""}`;
      $("#imp-passo-mapa").hidden = true;
      $("#imp-passo-resultado").hidden = false;
      botao.hidden = true;
      toast(`${r.criados} ${r.criados === 1 ? "lead importado" : "leads importados"}`);
      await carregarLeads();
    } catch (err) {
      toast(err.message, true);
      botao.disabled = false;
      botao.textContent = `Importar ${imp.linhas.length} leads`;
    }
  }

  $("#btn-importar").addEventListener("click", abrirImportacao);
  $("#imp-arquivo").addEventListener("change", (e) => carregarPlanilha(e.target.files[0]).catch((err) => toast(err.message, true)));
  $("#imp-soltar").addEventListener("dragover", (e) => { e.preventDefault(); e.currentTarget.classList.add("ativo"); });
  $("#imp-soltar").addEventListener("dragleave", (e) => e.currentTarget.classList.remove("ativo"));
  $("#imp-soltar").addEventListener("drop", (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove("ativo");
    carregarPlanilha(e.dataTransfer.files[0]).catch((err) => toast(err.message, true));
  });
  $("#imp-mapa").addEventListener("change", (e) => {
    const col = Number(e.target.dataset.impCol);
    if (Number.isNaN(col)) return;
    imp.mapa[col] = e.target.value;
    e.target.closest(".imp-coluna").classList.toggle("mapeada", !!e.target.value);
    renderPreviaImportacao();
  });
  $("#imp-confirmar").addEventListener("click", confirmarImportacao);
  $("#imp-voltar").addEventListener("click", abrirImportacao);
  $$("[data-fechar]", modalImportar).forEach((b) => b.addEventListener("click", () => modalImportar.close()));

  // ---------- avisos: som e notificação do navegador (preferência deste aparelho) ----------
  const avisos = { som: lerPreferencia("som", "1") === "1", navegador: lerPreferencia("notif", "0") === "1" };
  let audioCtx = null;
  // O navegador só libera áudio depois de um clique na página.
  document.addEventListener("pointerdown", () => {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch {
      /* sem áudio neste navegador */
    }
  });
  function tocarSom(tipo = "mensagem") {
    if (!avisos.som || !audioCtx) return;
    const notas = tipo === "lembrete" ? [880, 660, 880] : [740, 988];
    notas.forEach((freq, i) => {
      const t0 = audioCtx.currentTime + i * 0.16;
      const osc = audioCtx.createOscillator();
      const vol = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      vol.gain.setValueAtTime(0.0001, t0);
      vol.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      vol.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
      osc.connect(vol).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.16);
    });
  }
  const notificacoesPossiveis = () => "Notification" in window && window.isSecureContext;
  function notificar(titulo, corpo, tag, aoClicar) {
    if (!avisos.navegador || !notificacoesPossiveis() || Notification.permission !== "granted") return;
    try {
      const n = new Notification(titulo, { body: corpo, tag, icon: $("link[rel=icon]")?.href });
      n.onclick = () => {
        window.focus();
        aoClicar?.();
        n.close();
      };
    } catch {
      /* alguns celulares só notificam via service worker */
    }
  }
  function renderConfigAvisos() {
    $("#cfg-som").checked = avisos.som;
    const estadoNotif = $("#notif-estado");
    const botao = $("#btn-notif");
    botao.hidden = false;
    if (!("Notification" in window)) {
      estadoNotif.textContent = "Este navegador não mostra notificações.";
      botao.hidden = true;
    } else if (!window.isSecureContext) {
      estadoNotif.innerHTML = "Notificações do navegador só funcionam em endereço seguro (<strong>https</strong>) ou em <strong>http://localhost</strong>. Pelo endereço da rede local fica só o som.";
      botao.hidden = true;
    } else if (Notification.permission === "denied") {
      estadoNotif.textContent = "Notificações bloqueadas neste navegador. Libere no cadeado ao lado do endereço do site.";
      botao.hidden = true;
    } else if (Notification.permission === "granted" && avisos.navegador) {
      estadoNotif.textContent = "Notificações do navegador ativadas ✓";
      botao.textContent = "Desativar";
    } else {
      estadoNotif.textContent = "Receba um aviso mesmo com o sistema minimizado.";
      botao.textContent = "Ativar notificações";
    }
  }
  $("#cfg-som").addEventListener("change", (e) => {
    avisos.som = e.target.checked;
    gravarPreferencia("som", avisos.som ? "1" : "0");
    if (avisos.som) tocarSom();
  });
  $("#btn-notif").addEventListener("click", async () => {
    if (Notification.permission === "granted" && avisos.navegador) {
      avisos.navegador = false;
    } else {
      avisos.navegador = (await Notification.requestPermission()) === "granted";
      if (avisos.navegador) notificar("Notificações ativadas", "Você vai ser avisado de mensagens e lembretes.", "teste");
    }
    gravarPreferencia("notif", avisos.navegador ? "1" : "0");
    renderConfigAvisos();
  });

  // ---------- tarefas e lembretes ----------
  let listaTarefas = [];
  const ICONE_TAREFA = `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="17" rx="2" /><path d="M8 2v4M16 2v4M4 9h16M8.5 14.5l2 2 4-4" /></svg>`;
  const paraInputLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const mesmoDia = (a, b) => a.toDateString() === b.toDateString();

  function atalhosDeHora() {
    const agora = new Date();
    const em = (dias, h, m = 0) => {
      const d = new Date(agora);
      d.setDate(d.getDate() + dias);
      d.setHours(h, m, 0, 0);
      return d;
    };
    const daquiUmaHora = new Date(Math.ceil((agora.getTime() + 3600_000) / 300_000) * 300_000);
    const lista = [["Daqui 1h", daquiUmaHora]];
    if (agora.getHours() < 16) lista.push(["Hoje 17h", em(0, 17)]);
    lista.push(["Amanhã 9h", em(1, 9)], ["Amanhã 14h", em(1, 14)], ["Em 1 semana", em(7, 9)]);
    return lista;
  }

  function quandoLegivel(iso) {
    const d = new Date(iso);
    const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const hoje = new Date();
    if (mesmoDia(d, hoje)) return `hoje ${hora}`;
    if (mesmoDia(d, new Date(Date.now() + 86400_000))) return `amanhã ${hora}`;
    if (mesmoDia(d, new Date(Date.now() - 86400_000))) return `ontem ${hora}`;
    return `${d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })} ${hora}`;
  }
  function situacaoTarefa(t) {
    if (t.feita) return "feita";
    const d = new Date(t.quando);
    if (d.getTime() < Date.now()) return "atrasada";
    return mesmoDia(d, new Date()) ? "hoje" : "proxima";
  }
  const porData = (a, b) => a.quando.localeCompare(b.quando);

  async function carregarTarefas() {
    listaTarefas = await api("GET", "/api/tarefas");
    renderBolhaTarefas();
    if ($("#modal-tarefas").open) renderTarefas();
    if (estado.leadAberto) renderTarefasLead(estado.leads.find((l) => l.id === estado.leadAberto));
    if (estado.aba === "kanban") render();
  }

  function renderBolhaTarefas() {
    const pend = listaTarefas.filter((t) => ["atrasada", "hoje"].includes(situacaoTarefa(t)));
    const atrasadas = pend.filter((t) => situacaoTarefa(t) === "atrasada").length;
    const bolha = $("#tarefas-bolha");
    bolha.hidden = !pend.length;
    bolha.textContent = String(pend.length);
    bolha.classList.toggle("urgente", atrasadas > 0);
    $("#btn-tarefas").title = pend.length ? `${pend.length} tarefa(s) para hoje${atrasadas ? `, ${atrasadas} atrasada(s)` : ""}` : "Tarefas e lembretes";
  }

  function itemTarefa(t, { mostrarLead = true } = {}) {
    const sit = situacaoTarefa(t);
    return `<div class="tarefa tarefa-${sit}">
      <label class="tarefa-check" title="${t.feita ? "Reabrir" : "Concluir"}"><input type="checkbox" data-tarefa-feita="${t.id}" ${t.feita ? "checked" : ""} /></label>
      <div class="tarefa-corpo">
        <span class="tarefa-titulo">${esc(t.titulo)}</span>
        <span class="tarefa-info"><span class="tarefa-quando">${sit === "atrasada" ? "⚠ " : ""}${quandoLegivel(t.quando)}</span>${mostrarLead && (t.leadId || t.leadNome) ? ` · ${t.leadId ? `<a href="#" data-abrir-lead="${t.leadId}">${esc(t.leadNome)}</a>` : esc(t.leadNome)}` : ""}</span>
      </div>
      <button type="button" class="icone-btn del" data-tarefa-excluir="${t.id}" title="Excluir"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg></button>
    </div>`;
  }

  function renderTarefas() {
    const grupos = [
      ["Atrasadas", listaTarefas.filter((t) => situacaoTarefa(t) === "atrasada").sort(porData)],
      ["Hoje", listaTarefas.filter((t) => situacaoTarefa(t) === "hoje").sort(porData)],
      ["Próximas", listaTarefas.filter((t) => situacaoTarefa(t) === "proxima").sort(porData)],
      ["Concluídas", listaTarefas.filter((t) => t.feita).sort((a, b) => (b.feitaEm || "").localeCompare(a.feitaEm || "")).slice(0, 10)],
    ].filter(([, l]) => l.length);
    $("#tarefas-lista").innerHTML = grupos.length
      ? grupos.map(([titulo, l]) => `<h4 class="tarefas-grupo">${titulo} <span>${l.length}</span></h4>${l.map((t) => itemTarefa(t)).join("")}`).join("")
      : `<p class="sem-msg">Nenhuma tarefa. Crie a primeira acima — ex.: “ligar para o João amanhã às 9h”.</p>`;
  }

  function renderTarefasLead(lead) {
    if (!lead) return;
    const doLead = listaTarefas.filter((t) => t.leadId === lead.id);
    const lista = [...doLead.filter((t) => !t.feita).sort(porData), ...doLead.filter((t) => t.feita).slice(-3)];
    $("#tarefas-lead").innerHTML = lista.length ? lista.map((t) => itemTarefa(t, { mostrarLead: false })).join("") : `<p class="sem-msg">Nenhuma tarefa para este lead.</p>`;
  }

  function prepararNovaTarefa(caixa) {
    $("[data-tarefa-titulo]", caixa).value = "";
    $("[data-tarefa-quando]", caixa).value = paraInputLocal(atalhosDeHora().find(([r]) => r === "Amanhã 9h")[1]);
    $("[data-atalhos-hora]", caixa).innerHTML = atalhosDeHora().map(([r, d]) => `<button type="button" class="chip" data-hora="${paraInputLocal(d)}">${r}</button>`).join("");
    const sel = $("[data-tarefa-lead]", caixa);
    if (sel) {
      sel.innerHTML = `<option value="">Sem lead</option>` + [...estado.leads].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")).map((l) => `<option value="${l.id}">${esc(l.nome)}</option>`).join("");
    }
  }

  async function adicionarTarefa(caixa) {
    const titulo = $("[data-tarefa-titulo]", caixa).value.trim();
    const quando = $("[data-tarefa-quando]", caixa).value;
    if (!titulo) return $("[data-tarefa-titulo]", caixa).focus(), toast("Escreva o que precisa ser feito", true);
    if (!quando) return toast("Escolha o dia e a hora", true);
    const leadId = caixa.dataset.novaTarefa === "lead" ? estado.leadAberto : $("[data-tarefa-lead]", caixa)?.value || "";
    try {
      const t = await api("POST", "/api/tarefas", { titulo, quando: new Date(quando).toISOString(), leadId });
      toast(`Tarefa marcada para ${quandoLegivel(t.quando)}`);
      prepararNovaTarefa(caixa);
      await carregarTarefas();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Tudo delegado: as mesmas peças aparecem na janela de tarefas e dentro do lead.
  document.addEventListener("click", async (e) => {
    const caixa = e.target.closest("[data-nova-tarefa]");
    if (caixa && e.target.closest("[data-tarefa-adicionar]")) return adicionarTarefa(caixa);
    const hora = e.target.closest("[data-hora]");
    if (caixa && hora) {
      $("[data-tarefa-quando]", caixa).value = hora.dataset.hora;
      $$("[data-hora]", caixa).forEach((b) => b.classList.toggle("ativo", b === hora));
      return;
    }
    const excluir = e.target.closest("[data-tarefa-excluir]");
    if (excluir) {
      if (!confirm("Excluir esta tarefa?")) return;
      try {
        await api("DELETE", `/api/tarefas/${excluir.dataset.tarefaExcluir}`);
        await carregarTarefas();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-tarefa-titulo]")) {
      e.preventDefault();
      adicionarTarefa(e.target.closest("[data-nova-tarefa]"));
    }
  });
  document.addEventListener("change", async (e) => {
    const id = e.target.dataset?.tarefaFeita;
    if (!id) return;
    try {
      await api("PATCH", `/api/tarefas/${id}`, { feita: e.target.checked });
      if (e.target.checked) toast("Tarefa concluída ✓");
      await carregarTarefas();
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, true);
    }
  });

  const modalTarefas = $("#modal-tarefas");
  $("#btn-tarefas").addEventListener("click", () => {
    prepararNovaTarefa($("[data-nova-tarefa=geral]"));
    renderTarefas();
    renderConfigAvisos();
    modalTarefas.showModal();
  });
  $$("[data-fechar]", modalTarefas).forEach((b) => b.addEventListener("click", () => modalTarefas.close()));
  modalTarefas.addEventListener("click", (e) => e.target === modalTarefas && modalTarefas.close());

  // "Hoje" vira "atrasada" com o passar do tempo: recalcula o contador a cada minuto.
  setInterval(() => renderBolhaTarefas(), 60_000);

  /** Cartão do Kanban: tarefa atrasada ou de hoje do lead. */
  function badgeTarefa(l) {
    const t = listaTarefas.filter((x) => x.leadId === l.id && ["atrasada", "hoje"].includes(situacaoTarefa(x))).sort(porData)[0];
    if (!t) return "";
    const atrasada = situacaoTarefa(t) === "atrasada";
    return `<p class="selo-tarefa${atrasada ? " atrasada" : ""}" title="${esc(t.titulo)}">${ICONE_TAREFA}${atrasada ? "Atrasada" : quandoLegivel(t.quando)}: ${esc(t.titulo)}</p>`;
  }

  // Aviso na hora da tarefa: fica na tela até a pessoa decidir.
  function mostrarLembrete(t) {
    tocarSom("lembrete");
    notificar("⏰ Lembrete", `${t.titulo}${t.leadNome ? ` — ${t.leadNome}` : ""}`, `tarefa-${t.id}`, () => t.leadId && abrirModal(t.leadId));
    const el = document.createElement("div");
    el.className = "lembrete";
    el.innerHTML = `<div class="lembrete-topo">${ICONE_TAREFA}<strong>Lembrete</strong><button type="button" class="icone-btn" data-fechar-lembrete aria-label="Fechar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>
      <p>${esc(t.titulo)}</p>${t.leadNome ? `<small>${esc(t.leadNome)} · ${quandoLegivel(t.quando)}</small>` : `<small>${quandoLegivel(t.quando)}</small>`}
      <div class="lembrete-acoes">
        <button type="button" class="btn btn-primario mini" data-lembrete="concluir">✓ Concluir</button>
        <button type="button" class="btn btn-secundario mini" data-lembrete="adiar">Adiar 1h</button>
        ${t.leadId ? `<button type="button" class="btn btn-fantasma mini" data-lembrete="abrir">Abrir lead</button>` : ""}
      </div>`;
    el.addEventListener("click", async (e) => {
      const acao = e.target.closest("[data-lembrete]")?.dataset.lembrete;
      if (e.target.closest("[data-fechar-lembrete]")) return el.remove();
      if (!acao) return;
      try {
        if (acao === "concluir") await api("PATCH", `/api/tarefas/${t.id}`, { feita: true });
        if (acao === "adiar") await api("PATCH", `/api/tarefas/${t.id}`, { quando: new Date(Date.now() + 3600_000).toISOString() });
        if (acao === "abrir") abrirModal(t.leadId);
        el.remove();
        if (acao !== "abrir") toast(acao === "concluir" ? "Tarefa concluída ✓" : "Lembrete adiado para daqui 1 hora");
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#lembretes").append(el);
  }

  // ---------- topo, abas e filtros ----------
  // ---------- aba Painel (resultados) ----------
  const rs = { dias: lerPreferencia("painelDias", "30"), moeda: "", dados: null, carregando: false, espera: null };
  const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const nomeMes = (chave) => `${MESES_CURTOS[Number(chave.slice(5, 7)) - 1]}/${chave.slice(2, 4)}`;
  const compacto = (v, m) =>
    new Intl.NumberFormat(m === "EUR" ? "pt-PT" : "pt-BR", { style: "currency", currency: m, notation: "compact", maximumFractionDigits: 1 }).format(Number(v) || 0);
  function tempo(min) {
    if (min == null) return "—";
    if (min < 1) return "menos de 1 min";
    if (min < 60) return `${Math.round(min)} min`;
    if (min < 48 * 60) {
      const h = Math.floor(min / 60);
      const m = Math.round(min % 60);
      return m ? `${h}h ${m}min` : `${h}h`;
    }
    return `${String(Math.round((min / 1440) * 10) / 10).replace(".", ",")} dias`;
  }
  const vazioRs = (texto) => `<p class="rs-vazio">${esc(texto)}</p>`;

  // Chamado a cada render da aba: junta pedidos seguidos (vários eventos chegam juntos).
  function carregarPainel() {
    clearTimeout(rs.espera);
    rs.espera = setTimeout(buscarPainel, rs.dados ? 400 : 0);
    if (!rs.dados) renderPainel();
  }
  async function buscarPainel() {
    if (rs.carregando) return carregarPainel();
    rs.carregando = true;
    try {
      rs.dados = await api("GET", `/api/painel?dias=${encodeURIComponent(rs.dias)}`);
      renderPainel();
    } catch (e) {
      toast(e.message, "erro");
    } finally {
      rs.carregando = false;
    }
  }

  function renderPainel() {
    $$("[data-dias]").forEach((b) => b.classList.toggle("ativo", b.dataset.dias === rs.dias));
    const d = rs.dados;
    if (!d) {
      $("#rs-cartoes").innerHTML = vazioRs("Carregando…");
      return;
    }
    const moedas = Object.keys(d.vendas);
    if (!moedas.includes(rs.moeda)) rs.moeda = moedas[0];
    const sel = $("#rs-moeda");
    sel.hidden = moedas.length < 2;
    sel.innerHTML = moedas.map((m) => `<option value="${m}"${m === rs.moeda ? " selected" : ""}>${m === "EUR" ? "Euro (€)" : "Real (R$)"}</option>`).join("");
    $("#rs-atualizado").textContent = `Atualizado às ${new Date(d.periodo.geradoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    const v = d.vendas[rs.moeda];
    const m = rs.moeda;
    const nomePeriodo = d.periodo.dias ? (d.periodo.dias === 365 ? "nos últimos 12 meses" : `nos últimos ${d.periodo.dias} dias`) : "desde o começo";

    const cartoes = [
      ["Leads novos", d.leads.novos, nomePeriodo],
      ["Conversão", pct(d.leads.conversao), d.leads.novos ? "dos leads novos já viraram Ganho" : "sem leads novos no período"],
      ["Ganhos", d.leads.ganhos, d.leads.diasAteGanhar != null ? `levaram ${tempo(d.leads.diasAteGanhar * 1440)} para fechar (mediana)` : "leads que fecharam no período"],
      ["Vendas", dinheiro(v.total, m), `${v.pedidos} ${v.pedidos === 1 ? "pedido" : "pedidos"}`],
      ["Ticket médio", dinheiro(v.ticketMedio, m), "por pedido"],
      ["Recebido", dinheiro(v.recebido, m), "parcelas pagas no período"],
    ];
    $("#rs-cartoes").innerHTML = cartoes
      .map(([t, val, sub]) => `<div class="kpi"><span>${t}</span><strong>${esc(val)}</strong><small>${esc(sub)}</small></div>`)
      .join("");

    // Funil: cada barra é proporcional a quem entrou; ao lado, quanto passou da etapa anterior.
    const base = d.leads.funil[0]?.alcancaram || 0;
    $("#rs-funil").innerHTML = base
      ? `<ol class="rs-funil">${d.leads.funil
          .map((f, i) => {
            const ant = i ? d.leads.funil[i - 1].alcancaram : 0;
            const passagem = i && ant ? f.alcancaram / ant : null;
            const dica = `${f.etapa}: ${f.alcancaram} de ${base} leads (${pct(f.alcancaram / base)})${passagem != null ? ` · ${pct(passagem)} dos que estavam em ${d.leads.funil[i - 1].etapa}` : ""}`;
            return `<li tabindex="0" data-dica="${esc(dica)}" aria-label="${esc(dica)}">
              <span class="rs-rotulo">${esc(f.etapa)}</span>
              <span class="rs-trilho"><span class="rs-barra" style="width:${Math.max((f.alcancaram / base) * 100, f.alcancaram ? 1.5 : 0)}%"></span></span>
              <strong>${f.alcancaram}</strong>
              <small>${passagem != null ? `${pct(passagem)} passaram` : ""}</small>
            </li>`;
          })
          .join("")}</ol>
        <p class="rs-nota">${d.leads.perdidos} perdidos ou sem interesse no período · ${d.leads.emAberto} leads em aberto no funil hoje</p>`
      : vazioRs("Nenhum lead entrou neste período.");

    // Vendas por mês: uma série só, então sem legenda; valor escrito só no maior mês e no atual.
    const maxMes = Math.max(...v.porMes.map((x) => x.total), 0);
    const maiorIdx = v.porMes.findIndex((x) => x.total === maxMes);
    $("#rs-meses").innerHTML = maxMes
      ? `<div class="rs-colunas" role="list">${v.porMes
          .map((x, i) => {
            const dica = `${nomeMes(x.mes)}: ${dinheiro(x.total, m)} em ${x.pedidos} ${x.pedidos === 1 ? "pedido" : "pedidos"}`;
            const rotulo = x.total && (i === maiorIdx || i === v.porMes.length - 1) ? `<em>${compacto(x.total, m)}</em>` : "";
            return `<div class="rs-coluna" role="listitem" tabindex="0" data-dica="${esc(dica)}" aria-label="${esc(dica)}">
              <div class="rs-coluna-area"><span style="height:${(x.total / maxMes) * 100}%">${rotulo}</span></div>
              <small>${nomeMes(x.mes).slice(0, 3)}</small>
            </div>`;
          })
          .join("")}</div>`
      : vazioRs("Ainda não há pedidos confirmados nos últimos 12 meses.");

    const maxOrigem = Math.max(...d.leads.porOrigem.map((o) => o.leads), 0);
    $("#rs-origens").innerHTML = d.leads.porOrigem.length
      ? `<table class="rs-tabela"><thead><tr><th>Origem</th><th class="rs-col-barra"></th><th class="num">Leads</th><th class="num">Ganhos</th><th class="num">Conversão</th></tr></thead><tbody>${d.leads.porOrigem
          .map((o) => `<tr tabindex="0" data-dica="${esc(`${o.origem}: ${o.leads} leads, ${o.ganhos} ganhos (${pct(o.conversao)})`)}"><td>${esc(o.origem)}</td><td class="rs-col-barra"><span class="rs-barra" style="width:${(o.leads / maxOrigem) * 100}%"></span></td><td class="num">${o.leads}</td><td class="num">${o.ganhos}</td><td class="num">${pct(o.conversao)}</td></tr>`)
          .join("")}</tbody></table>`
      : vazioRs("Nenhum lead entrou neste período.");

    const depois = Math.max(0, v.aReceber - v.atrasado - v.vence30dias);
    $("#rs-receber").innerHTML = v.aReceber
      ? `<div class="rs-receber-total"><span>Total em aberto</span><strong>${dinheiro(v.aReceber, m)}</strong></div>
        <div class="rs-pilha" aria-hidden="true">${[["rs-atrasado", v.atrasado], ["rs-proximo", v.vence30dias], ["rs-depois", depois]]
          .filter(([, x]) => x > 0)
          .map(([c, x]) => `<span class="${c}" style="flex-grow:${x}"></span>`)
          .join("")}</div>
        <ul class="rs-legenda">
          <li class="${v.atrasado ? "rs-alerta" : ""}"><i class="rs-atrasado"></i>${v.atrasado ? "⚠ " : ""}Atrasado<strong>${dinheiro(v.atrasado, m)}</strong></li>
          <li><i class="rs-proximo"></i>Vence em até 30 dias<strong>${dinheiro(v.vence30dias, m)}</strong></li>
          <li><i class="rs-depois"></i>Vence depois<strong>${dinheiro(depois, m)}</strong></li>
        </ul>
        ${v.atrasado ? `<button type="button" class="btn btn-secundario rs-ver-atrasados">Ver pedidos atrasados</button>` : ""}`
      : vazioRs("Nenhuma parcela em aberto. Tudo recebido!");

    $("#rs-vendedores").innerHTML = v.porVendedor.length
      ? `<table class="rs-tabela"><thead><tr><th>Vendedor</th><th class="num">Pedidos</th><th class="num">Vendas</th><th class="num">Comissão</th></tr></thead><tbody>${v.porVendedor
          .map((x) => `<tr><td>${esc(x.nome)}</td><td class="num">${x.pedidos}</td><td class="num">${dinheiro(x.total, m)}</td><td class="num">${dinheiro(x.comissao, m)}</td></tr>`)
          .join("")}</tbody>${v.porVendedor.length > 1 ? `<tfoot><tr><td>Total</td><td class="num">${v.pedidos}</td><td class="num">${dinheiro(v.total, m)}</td><td class="num">${dinheiro(v.comissao, m)}</td></tr></tfoot>` : ""}</table>`
      : vazioRs("Nenhuma venda no período.");

    $("#rs-produtos").innerHTML = v.topProdutos.length
      ? `<table class="rs-tabela"><thead><tr><th>Produto</th><th class="num">Qtd.</th><th class="num">Vendas</th></tr></thead><tbody>${v.topProdutos
          .map((x) => `<tr><td>${esc(x.descricao)}</td><td class="num">${String(Math.round(x.quantidade * 100) / 100).replace(".", ",")}</td><td class="num">${dinheiro(x.total, m)}</td></tr>`)
          .join("")}</tbody></table>`
      : vazioRs("Nenhuma venda no período.");

    const a = d.atendimento;
    const maxHora = Math.max(...a.porHora, 0);
    const pico = a.porHora.indexOf(maxHora);
    const fuso = d.periodo.fuso.split("/").pop().replace(/_/g, " ");
    $("#rs-atendimento").innerHTML = `<div class="rs-numeros">
        <div><span>Tempo de resposta</span><strong>${tempo(a.respostaMedianaMin)}</strong><small>mediana entre a mensagem do cliente e a sua resposta</small></div>
        <div><span>Respondidas em até 5 min</span><strong>${pct(a.respondidasEm5min)}</strong><small>das vezes em que o cliente escreveu</small></div>
        <div class="${a.naFila ? "rs-alerta" : ""}"><span>Na fila agora</span><strong>${a.naFila}</strong><small>${a.naFila ? `esperando há até ${tempo(a.maiorEsperaMin)}` : "ninguém esperando"}</small></div>
        <div><span>Espera na fila</span><strong>${tempo(a.esperaMedianaMin)}</strong><small>${a.atendidosDaFila} atendidos (mediana até a baixa)</small></div>
        <div><span>Conversas</span><strong>${a.conversasAtivas}</strong><small>${a.recebidas} recebidas · ${a.enviadas} enviadas</small></div>
      </div>
      ${maxHora
        ? `<h4 class="rs-subtitulo">Mensagens recebidas por hora do dia <small>(horário de ${esc(fuso)})${` · pico às ${pico}h`}</small></h4>
          <div class="rs-colunas rs-horas" role="list">${a.porHora
            .map((n, h) => {
              const dica = `${h}h–${h + 1}h: ${n} ${n === 1 ? "mensagem" : "mensagens"}`;
              return `<div class="rs-coluna" role="listitem" tabindex="0" data-dica="${esc(dica)}" aria-label="${esc(dica)}">
                <div class="rs-coluna-area"><span style="height:${(n / maxHora) * 100}%"></span></div>
                <small>${h % 3 === 0 ? `${h}h` : ""}</small>
              </div>`;
            })
            .join("")}</div>`
        : vazioRs("Nenhuma mensagem recebida no período.")}`;
  }

  $$("[data-dias]").forEach((b) =>
    b.addEventListener("click", () => {
      rs.dias = b.dataset.dias;
      gravarPreferencia("painelDias", rs.dias);
      renderPainel();
      buscarPainel();
    }),
  );
  $("#rs-moeda").addEventListener("change", (e) => {
    rs.moeda = e.target.value;
    renderPainel();
  });
  $("#painel-resultados").addEventListener("click", (e) => {
    if (!e.target.closest(".rs-ver-atrasados")) return;
    pd.aba = "pedidos";
    pd.filtroPagamento = "Atrasado";
    $("#pd-filtro-pagamento").value = "Atrasado";
    trocarAba("pedidos");
  });
  // Dica ao passar o mouse (ou focar pelo teclado) sobre barras e linhas.
  (() => {
    const dica = $("#rs-dica");
    const area = $("#painel-resultados");
    const mostrar = (alvo, x, y) => {
      dica.textContent = alvo.dataset.dica;
      dica.hidden = false;
      const r = dica.getBoundingClientRect();
      dica.style.left = `${Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8)}px`;
      dica.style.top = `${y - r.height - 12 < 8 ? y + 18 : y - r.height - 12}px`;
    };
    area.addEventListener("pointermove", (e) => {
      const alvo = e.target.closest("[data-dica]");
      if (alvo) mostrar(alvo, e.clientX, e.clientY);
      else dica.hidden = true;
    });
    area.addEventListener("pointerleave", () => (dica.hidden = true));
    area.addEventListener("focusin", (e) => {
      const alvo = e.target.closest("[data-dica]");
      if (!alvo) return;
      const r = alvo.getBoundingClientRect();
      mostrar(alvo, r.left + r.width / 2, r.top);
    });
    area.addEventListener("focusout", () => (dica.hidden = true));
  })();

  function trocarAba(aba) {
    estado.aba = aba;
    gravarPreferencia("aba", aba);
    render();
  }
  $$(".aba").forEach((b) => b.addEventListener("click", () => trocarAba(b.dataset.aba)));
  $("#wa-pilula").addEventListener("click", () => trocarAba("whatsapp"));
  $("#btn-novo").addEventListener("click", () => abrirModal());
  $("#btn-filtros").addEventListener("click", (e) => {
    const aberto = $("#filtros").classList.toggle("aberto");
    e.currentTarget.setAttribute("aria-expanded", String(aberto));
  });

  let esperaBusca;
  $("#busca").addEventListener("input", (e) => {
    clearTimeout(esperaBusca);
    esperaBusca = setTimeout(() => {
      estado.busca = e.target.value;
      if (estado.aba === "whatsapp") estado.aba = "tabela";
      render();
    }, 120);
  });
  $("#f-etapa").innerHTML += ETAPAS.map((e) => `<option>${esc(e)}</option>`).join("");
  $("#f-etapa").addEventListener("change", (e) => { estado.etapa = e.target.value; render(); });
  $("#f-pais").addEventListener("change", (e) => { estado.pais = e.target.value; preencherFiltroRegiao(); render(); });
  $("#f-regiao").addEventListener("change", (e) => { estado.regiao = e.target.value; render(); });
  $("#f-cidade").addEventListener("input", (e) => { estado.cidade = e.target.value; render(); });
  $("#f-ordem").addEventListener("change", (e) => { estado.ordem = e.target.value; render(); });
  $("#f-origem").addEventListener("change", (e) => { estado.origem = e.target.value; render(); });
  $("#f-etiqueta").addEventListener("change", (e) => { estado.etiqueta = e.target.value; render(); });
  $("#btn-limpar").addEventListener("click", () => {
    Object.assign(estado, { busca: "", etapa: "", pais: "", regiao: "", cidade: "", origem: "", etiqueta: "", ordem: "criadoEm:desc" });
    $("#busca").value = "";
    $("#f-etapa").value = "";
    $("#f-pais").value = "";
    $("#f-cidade").value = "";
    $("#f-ordem").value = estado.ordem;
    preencherFiltroRegiao();
    render();
  });

  // ---------- exportação CSV ----------
  $("#btn-csv").addEventListener("click", () => {
    const lista = leadsFiltrados();
    const colunas = [
      ["Data de Criação", (l) => dataCurta(l.criadoEm)],
      ["Nome", (l) => l.nome],
      ["E-mail", (l) => l.email],
      ["Telefone", (l) => l.telefone],
      ["Cargo", (l) => l.cargo],
      ["Empresa", (l) => l.empresa],
      ["Observações", (l) => l.observacoes],
      ["Faturamento Mensal", (l) => String(Number(l.faturamentoMensal) || 0).replace(".", ",")],
      ["Moeda", (l) => (l.pais === "Portugal" ? "EUR" : "BRL")],
      ["Cidade", (l) => l.cidade],
      ["País", (l) => l.pais],
      ["UF", (l) => l.uf],
      ["Distrito", (l) => l.distrito],
      ["Etapa do Funil", (l) => l.etapa],
      ["Origem", (l) => l.origem || ""],
      ["Etiquetas", (l) => (l.etiquetas || []).join(", ")],
    ];
    // Prefixa fórmulas para o Excel não executá-las (injeção de CSV).
    const celula = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t) && !/^[+-]?\d/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const linhas = [colunas.map(([t]) => celula(t)).join(";"), ...lista.map((l) => colunas.map(([, f]) => celula(f(l))).join(";"))];
    const blob = new Blob(["﻿" + linhas.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `leads-${paraInputData(new Date().toISOString())}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`${lista.length} lead(s) exportado(s)`);
  });

  // ---------- WhatsApp ----------
  $("#btn-wa-conectar").addEventListener("click", async () => {
    estado.whatsapp = { ...estado.whatsapp, status: "conectando", erro: null };
    render();
    try {
      estado.whatsapp = await api("POST", "/api/whatsapp/conectar");
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btn-wa-desconectar").addEventListener("click", async () => {
    const status = estado.whatsapp.status;
    if (status === "conectado" && !confirm("Desconectar o WhatsApp deste CRM? Será preciso ler o QR Code de novo.")) return;
    try {
      // Cancelar uma reconexão só para de tentar; não descarta a sessão já pareada.
      estado.whatsapp = await api("POST", "/api/whatsapp/desconectar", { apenasParar: status === "reconectando" });
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#cfg-auto").addEventListener("change", async (e) => {
    try {
      estado.config = await api("PATCH", "/api/config", { autoCriarLeads: e.target.checked });
      toast(estado.config.autoCriarLeads ? "Leads novos serão criados pelo WhatsApp" : "Criação automática desligada");
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, true);
    }
  });

  // ---------- tema (automático / claro / escuro) ----------
  const TEMAS = {
    auto: { proximo: "escuro", nome: "automático (segue o sistema)", icone: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></svg>` },
    escuro: { proximo: "claro", nome: "escuro", icone: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>` },
    claro: { proximo: "auto", nome: "claro", icone: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>` },
  };
  function aplicarTema(tema) {
    if (tema === "auto") delete document.documentElement.dataset.tema;
    else document.documentElement.dataset.tema = tema;
    const t = TEMAS[tema];
    const botao = $("#btn-tema");
    botao.innerHTML = t.icone;
    botao.title = `Tema: ${t.nome}. Clique para mudar para ${TEMAS[t.proximo].nome.split(" (")[0]}.`;
    botao.setAttribute("aria-label", botao.title);
  }
  let tema = TEMAS[lerPreferencia("tema", "auto")] ? lerPreferencia("tema", "auto") : "auto";
  aplicarTema(tema);
  $("#btn-tema").addEventListener("click", () => {
    tema = TEMAS[tema].proximo;
    gravarPreferencia("tema", tema);
    aplicarTema(tema);
    toast(`Tema ${TEMAS[tema].nome}`);
  });

  // ---------- app instalável (PWA) ----------
  // O navegador só oferece instalar em endereço seguro (https ou localhost). O service worker guarda
  // a "casca" da tela para abrir mesmo sem rede; os dados vêm sempre do servidor.
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  let pedidoDeInstalacao = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // mostra o nosso botão em vez do aviso automático
    pedidoDeInstalacao = e;
    $("#btn-instalar").hidden = false;
  });
  $("#btn-instalar").addEventListener("click", async () => {
    if (!pedidoDeInstalacao) return;
    pedidoDeInstalacao.prompt();
    const { outcome } = await pedidoDeInstalacao.userChoice.catch(() => ({}));
    pedidoDeInstalacao = null;
    $("#btn-instalar").hidden = true;
    if (outcome === "accepted") toast("App instalado! Ele aparece junto com os outros programas.");
  });
  window.addEventListener("appinstalled", () => ($("#btn-instalar").hidden = true));

  // ---------- versão do sistema (canto superior direito) ----------
  async function mostrarVersao() {
    const { versao, data } = await api("GET", "/api/versao");
    const dataBr = data ? new Date(`${data}T12:00:00`).toLocaleDateString("pt-BR") : "";
    const el = $("#versao");
    el.innerHTML = `v${esc(versao)}${dataBr ? `<span class="versao-data"> · ${esc(dataBr)}</span>` : ""}`; // a data some no celular estreito
    el.title = `Controle de Leads 2026 — versão ${versao}${dataBr ? `, criada em ${dataBr}` : ""}`;
    el.hidden = false;
  }

  // ---------- tempo real ----------
  let esperaConversas;
  function agendarConversas() {
    clearTimeout(esperaConversas);
    esperaConversas = setTimeout(async () => {
      try {
        await carregarConversas();
        // Conversa aberta e visível: atualiza as mensagens (e marca como lida).
        if (estado.conversaAberta && estado.aba === "conversas") await abrirConversa(estado.conversaAberta, { rolar: false });
      } catch {
        /* tenta de novo no próximo aviso */
      }
    }, 300);
  }
  let esperaRecarga;
  function conectarEventos() {
    const fonte = new EventSource("/api/eventos");
    fonte.addEventListener("whatsapp", (e) => {
      const anterior = estado.whatsapp.status;
      estado.whatsapp = JSON.parse(e.data);
      if (anterior !== "conectado" && estado.whatsapp.status === "conectado" && anterior !== "desconectado") toast("WhatsApp conectado!");
      render();
      if (estado.leadAberto) atualizarAvisoWhatsApp(estado.leads.find((l) => l.id === estado.leadAberto));
    });
    fonte.addEventListener("config", () => recarregarConfig().catch(() => {}));
    fonte.addEventListener("leads", () => {
      clearTimeout(esperaRecarga);
      esperaRecarga = setTimeout(() => carregarLeads().catch(() => {}), 150);
      agendarConversas(); // etapa e nome do lead aparecem na lista de conversas
    });
    fonte.addEventListener("conversas", agendarConversas);
    fonte.addEventListener("pedidos", () => carregarPedidos().catch(() => {}));
    fonte.addEventListener("tarefas", () => carregarTarefas().catch(() => {}));
    // O Painel soma tudo: qualquer mudança em leads, pedidos ou conversas o atualiza.
    for (const tipo of ["leads", "pedidos", "conversas"]) fonte.addEventListener(tipo, () => estado.aba === "resultados" && carregarPainel());
    fonte.addEventListener("lembrete", (e) => mostrarLembrete(JSON.parse(e.data)));
    // Mensagem nova no WhatsApp: som e notificação, a não ser que a pessoa já esteja nela.
    fonte.addEventListener("mensagem-nova", (e) => {
      const d = JSON.parse(e.data);
      const vendoEla = !document.hidden && estado.aba === "conversas" && estado.conversaAberta === d.jid;
      if (vendoEla) return;
      tocarSom("mensagem");
      notificar(`Mensagem de ${d.nome}`, d.previa, `msg-${d.jid}`, () => {
        trocarAba("conversas");
        abrirConversa(d.jid);
      });
    });
  }

  // A caixa de entrada ocupa a altura que sobra abaixo do topo (que muda de altura no celular).
  function medirTopo() {
    document.documentElement.style.setProperty("--altura-topo", $(".topo").offsetHeight + "px");
  }
  window.addEventListener("resize", medirTopo);

  // ---------- início ----------
  (async () => {
    medirTopo();
    $("#f-ordem").value = estado.ordem;
    preencherFiltroRegiao();
    try {
      const [leads, config, wa] = await Promise.all([api("GET", "/api/leads"), api("GET", "/api/config"), api("GET", "/api/whatsapp")]);
      Object.assign(estado, { leads, config, whatsapp: wa });
      await Promise.all([carregarConversas(), carregarPedidos(), carregarTarefas(), mostrarVersao()]);
      const atrasadas = listaTarefas.filter((t) => situacaoTarefa(t) === "atrasada").length;
      if (atrasadas) toast(`Você tem ${atrasadas} ${atrasadas === 1 ? "tarefa atrasada" : "tarefas atrasadas"} — veja no botão de tarefas, no topo`);
    } catch (err) {
      toast("Não foi possível carregar os leads: " + err.message, true);
    }
    render();
    conectarEventos();
  })();
})();
