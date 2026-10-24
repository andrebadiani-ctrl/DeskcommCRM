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
    pais: "",
    regiao: "",
    cidade: "",
    ordem: "criadoEm:desc",
    whatsapp: { status: "desconectado", qr: null, conta: null, erro: null },
    config: { autoCriarLeads: true },
    leadAberto: null,
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
        if (termo) {
          const alvo = normalizar([l.nome, l.empresa, l.cidade, l.email, l.telefone, l.cargo, l.uf, l.distrito, l.etapa].join(" "));
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
    renderKpis();
    renderAbas();
    if (estado.aba === "tabela") renderTabela();
    if (estado.aba === "kanban") renderKanban();
    if (estado.aba === "whatsapp") renderWhatsApp();
    renderPilula();
  }

  function renderAbas() {
    $$(".aba").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === estado.aba));
    $("#painel-tabela").hidden = estado.aba !== "tabela";
    $("#painel-kanban").hidden = estado.aba !== "kanban";
    $("#painel-whatsapp").hidden = estado.aba !== "whatsapp";
    $("#filtros").hidden = estado.aba === "whatsapp";
    $("#btn-filtros").hidden = estado.aba === "whatsapp";
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
    p.textContent = PILULA_WA[s];
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
    renderAutomacao();
  }

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
      if (["pais", "etapa", "faturamentoMensal"].includes(campo)) {
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

  function renderMensagens(lead) {
    const msgs = lead.mensagens || [];
    const caixa = $("#mensagens");
    caixa.innerHTML = msgs.length
      ? msgs.map((m) => `<div class="msg ${m.direcao === "saida" ? "saida" : "entrada"}">${esc(m.texto)}<time>${new Date(m.em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time></div>`).join("")
      : `<div class="sem-msg">Nenhuma mensagem trocada com este lead ainda.</div>`;
    caixa.scrollTop = caixa.scrollHeight;
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

  function abrirModal(id = null, { focoWhatsApp = false } = {}) {
    const lead = id ? estado.leads.find((l) => l.id === id) : null;
    estado.leadAberto = lead?.id || null;
    form.reset();
    $$(".invalido", form).forEach((el) => el.classList.remove("invalido"));
    form.etapa.innerHTML = opcoesEtapa(lead?.etapa || "Novo Lead");
    $("#modal-titulo").textContent = lead ? lead.nome : "Novo lead";
    $("#btn-excluir").hidden = !lead;
    $("#bloco-nota").hidden = !lead;
    $("#bloco-wa").hidden = !lead;
    $("#bloco-followups").hidden = !lead;
    $("#btn-salvar").textContent = lead ? "Salvar alterações" : "Criar lead";

    const v = lead || { pais: "", criadoEm: new Date().toISOString() };
    for (const campo of ["nome", "email", "telefone", "cargo", "empresa", "cidade", "observacoes"]) form[campo].value = v[campo] || "";
    form.faturamentoMensal.value = lead ? v.faturamentoMensal || "" : "";
    form.criadoEm.value = paraInputData(v.criadoEm);
    form.pais.value = v.pais || "";
    atualizarCamposRegiao(v.pais, v.uf, v.distrito);
    if (lead) {
      renderMensagens(lead);
      renderAtalhos();
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
    };
    const botao = $("#btn-salvar");
    botao.disabled = true;
    try {
      const lead = atual ? await api("PATCH", `/api/leads/${atual.id}`, dados) : await api("POST", "/api/leads", dados);
      substituir(lead);
      fecharModal();
      render();
      toast(atual ? "Lead atualizado" : "Lead criado");
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
  $("#wa-texto").addEventListener("keydown", (e) => {
    const sugestoes = caixaSugestoes.hidden ? [] : sugestoesVisiveis();
    if (sugestoes.length && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "Escape") return fecharSugestoes();
      if (e.key === "Enter" || e.key === "Tab") {
        return inserirNoChat(respostas().find((r) => r.id === sugestoes[sugestaoAtiva].dataset.usarResposta)?.texto || "");
      }
      sugestaoAtiva = (sugestaoAtiva + (e.key === "ArrowDown" ? 1 : -1) + sugestoes.length) % sugestoes.length;
      sugestoes.forEach((s, i) => s.classList.toggle("ativa", i === sugestaoAtiva));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarWhatsApp(); }
  });

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

  // ---- no modal do lead: respostas rápidas no chat ----
  function inserirNoChat(texto) {
    const lead = estado.leads.find((l) => l.id === estado.leadAberto);
    const campo = $("#wa-texto");
    campo.value = preencherVariaveis(texto, lead);
    fecharSugestoes();
    campo.focus();
    campo.setSelectionRange(campo.value.length, campo.value.length);
  }

  function renderAtalhos() {
    $("#atalhos-respostas").innerHTML = respostas()
      .map((r) => `<button type="button" class="chip" data-usar-resposta="${r.id}" title="${esc(r.texto)}">${ICONE_RAIO}/${esc(r.atalho)}</button>`)
      .join("");
  }
  $("#atalhos-respostas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-usar-resposta]");
    if (b) inserirNoChat(respostas().find((r) => r.id === b.dataset.usarResposta)?.texto || "");
  });

  let sugestaoAtiva = 0;
  const caixaSugestoes = $("#sugestoes");
  function fecharSugestoes() {
    caixaSugestoes.hidden = true;
    caixaSugestoes.innerHTML = "";
  }
  function sugestoesVisiveis() {
    return $$(".sugestao", caixaSugestoes);
  }
  $("#wa-texto").addEventListener("input", (e) => {
    const m = e.target.value.match(/^\/(\S*)$/);
    if (!m) return fecharSugestoes();
    const termo = normalizar(m[1]);
    const achadas = respostas().filter((r) => normalizar(r.atalho + " " + r.titulo).includes(termo)).slice(0, 8);
    if (!achadas.length) return fecharSugestoes();
    sugestaoAtiva = 0;
    caixaSugestoes.innerHTML = achadas
      .map((r, i) => `<div class="sugestao${i === 0 ? " ativa" : ""}" role="option" data-usar-resposta="${r.id}"><strong>/${esc(r.atalho)}</strong> ${esc(r.titulo || "")}<span>${esc(r.texto)}</span></div>`)
      .join("");
    caixaSugestoes.hidden = false;
  });
  caixaSugestoes.addEventListener("mousedown", (e) => {
    const s = e.target.closest("[data-usar-resposta]");
    if (!s) return;
    e.preventDefault();
    inserirNoChat(respostas().find((r) => r.id === s.dataset.usarResposta)?.texto || "");
  });
  $("#wa-texto").addEventListener("blur", () => setTimeout(fecharSugestoes, 100));

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

  // ---------- topo, abas e filtros ----------
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
  $("#btn-limpar").addEventListener("click", () => {
    Object.assign(estado, { busca: "", etapa: "", pais: "", regiao: "", cidade: "", ordem: "criadoEm:desc" });
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

  // ---------- tempo real ----------
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
    });
  }

  // ---------- início ----------
  (async () => {
    $("#f-ordem").value = estado.ordem;
    preencherFiltroRegiao();
    try {
      const [leads, config, wa] = await Promise.all([api("GET", "/api/leads"), api("GET", "/api/config"), api("GET", "/api/whatsapp")]);
      Object.assign(estado, { leads, config, whatsapp: wa });
    } catch (err) {
      toast("Não foi possível carregar os leads: " + err.message, true);
    }
    render();
    conectarEventos();
  })();
})();
