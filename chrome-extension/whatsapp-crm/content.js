/**
 * DeskcommCRM — CRM e disparo cadenciado dentro do WhatsApp Web.
 *
 * Três partes:
 *   1. CRM local: estágio, notas e opt-out por contato, em chrome.storage.local
 *      (o localStorage da página é do WhatsApp e some no logout).
 *   2. Painel: shadow DOM, para o CSS do WhatsApp não vazar para cá nem o nosso para lá.
 *   3. Motor de campanha: fila PERSISTIDA. Abrir uma conversa por número
 *      (`/send?phone=`) recarrega a página e mata o script; por isso o estado
 *      de cada envio mora no storage e o motor retoma de onde parou.
 *
 * Regras puras (telefone, spintax, janela, delay) vivem em nucleo.js.
 */
(function () {
  "use strict";

  if (window.__deskcommCrm) return;
  window.__deskcommCrm = true;

  const N = globalThis.DeskcommNucleo;

  const CHAVE = {
    contatos: "dk_contatos",
    campanha: "dk_campanha",
    envios: "dk_envios_dia",
    prefs: "dk_prefs",
  };

  const ESTAGIOS = [
    ["novo", "Lead novo"],
    ["proposta", "Em proposta"],
    ["followup", "Follow-up"],
    ["fechado", "Cliente fechado"],
    ["perdido", "Perdido"],
  ];
  const ROTULO_ESTAGIO = Object.fromEntries(ESTAGIOS);

  const PREFS_PADRAO = {
    delayMinS: 15,
    delayMaxS: 40,
    limiteDiario: 150,
    horaInicio: 8,
    horaFim: 20,
    ddi: "55",
  };

  // O WhatsApp Web troca classes a cada deploy; só atributos estáveis aqui,
  // e mais de um candidato por alvo. Quebrou? É neste bloco que se conserta.
  const SELETOR = {
    app: ["#side", "#pane-side"],
    cabecalho: ["#main header"],
    caixaTexto: [
      '#main footer div[contenteditable="true"][role="textbox"]',
      '#main footer div[contenteditable="true"]',
      'div[contenteditable="true"][data-tab="10"]',
    ],
    botaoEnviar: [
      '#main footer button[aria-label="Enviar"]',
      '#main footer button[aria-label="Send"]',
      '#main footer span[data-icon="send"]',
      '#main footer span[data-icon="wds-ic-send-filled"]',
    ],
    dialogo: ['div[role="dialog"]', '[data-animate-modal-popup="true"]'],
  };

  const achar = (lista, raiz = document) => {
    for (const s of lista) {
      const el = raiz.querySelector(s);
      if (el) return el;
    }
    return null;
  };

  const log = (...args) => console.info("[DeskcommCRM]", ...args);
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- storage

  async function ler(chave, padrao) {
    const r = await chrome.storage.local.get(chave);
    return r[chave] ?? padrao;
  }

  function gravar(chave, valor) {
    return chrome.storage.local.set({ [chave]: valor });
  }

  async function prefs() {
    return { ...PREFS_PADRAO, ...(await ler(CHAVE.prefs, {})) };
  }

  /** Lê, aplica e grava: nunca grava uma cópia velha da campanha por cima de um "Pausar". */
  async function atualizarCampanha(fn) {
    const c = await ler(CHAVE.campanha, null);
    if (!c) return null;
    fn(c);
    await gravar(CHAVE.campanha, c);
    return c;
  }

  async function enviosHoje() {
    const e = await ler(CHAVE.envios, null);
    return e && e.dia === N.chaveDoDia(new Date()) ? e.total : 0;
  }

  async function contarEnvio() {
    const dia = N.chaveDoDia(new Date());
    const total = (await enviosHoje()) + 1;
    await gravar(CHAVE.envios, { dia, total });
  }

  // -------------------------------------------------------------- CRM local

  /** Conversa aberta agora. A chave é o telefone quando dá para saber; senão o nome. */
  function conversaAtiva() {
    const cab = achar(SELETOR.cabecalho);
    if (!cab) return null;
    const tituloEl =
      cab.querySelector('span[dir="auto"][title]') || cab.querySelector('span[dir="auto"]');
    const nome = (tituloEl?.getAttribute("title") || tituloEl?.textContent || "").trim();
    if (!nome) return null;

    let telefone = null;
    for (const el of document.querySelectorAll("#main [data-id]")) {
      telefone = N.telefoneDoDataId(el.getAttribute("data-id"));
      if (telefone) break;
    }
    telefone = telefone || N.telefoneDoTitulo(nome);
    return { chave: telefone || `nome:${nome}`, nome, telefone };
  }

  async function salvarContato(conversa, campos) {
    const contatos = await ler(CHAVE.contatos, {});
    const anterior = contatos[conversa.chave] || {};
    contatos[conversa.chave] = {
      ...anterior,
      nome: conversa.nome,
      telefone: conversa.telefone ?? anterior.telefone ?? null,
      ...campos,
      atualizadoEm: new Date().toISOString(),
    };
    await gravar(CHAVE.contatos, contatos);
    log(`contato ${conversa.chave} → ${campos.estagio ?? "(sem estágio)"}`);
  }

  // ------------------------------------------------------- motor de campanha

  let navegouNestaPagina = false;
  let motorRodando = false;
  let statusCampanha = null; // espelho do storage, para interromper esperas longas

  /** Espera interrompível: devolve false se a campanha deixou de estar "rodando". */
  async function esperar(ms) {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      if (statusCampanha !== "rodando") return false;
      await dormir(Math.min(500, fim - Date.now()));
    }
    return statusCampanha === "rodando";
  }

  async function esperarPor(fn, timeoutMs, passoMs = 400) {
    const fim = Date.now() + timeoutMs;
    while (Date.now() < fim) {
      const v = fn();
      if (v) return v;
      await dormir(passoMs);
    }
    return null;
  }

  function abrirConversaPorNumero(telefone, texto) {
    navegouNestaPagina = true;
    const url = new URL("https://web.whatsapp.com/send");
    url.searchParams.set("phone", telefone);
    url.searchParams.set("text", texto);
    location.href = url.toString();
  }

  async function pausar(motivo) {
    await atualizarCampanha((c) => {
      c.status = "pausada";
      c.motivo = motivo;
      for (const it of c.itens) if (it.status === "em_andamento") it.status = "pendente";
    });
    log(`campanha pausada: ${motivo}`);
  }

  async function motor() {
    if (motorRodando) return;
    motorRodando = true;
    try {
      for (;;) {
        const c = await ler(CHAVE.campanha, null);
        statusCampanha = c?.status ?? null;
        if (!c || c.status !== "rodando") return;

        const emCurso = c.itens.find((i) => i.status === "em_andamento");
        if (emCurso) {
          // Só envia na página que NASCEU da navegação para este contato. Uma
          // página mais velha mostra a conversa ANTERIOR (ou a que o usuário
          // abriu): enviar ali entregaria a mensagem à pessoa errada.
          const paginaDaNavegacao = performance.timeOrigin >= emCurso.iniciadoEm;
          const recente = performance.timeOrigin - emCurso.iniciadoEm < 120_000;
          if (paginaDaNavegacao && recente) {
            await concluirEnvio(emCurso);
          } else if (!paginaDaNavegacao && navegouNestaPagina) {
            // A navegação que esta página pediu ainda não descarregou.
            await dormir(90_000);
            navegouNestaPagina = false;
            await registrarResultado(emCurso.telefone, "falhou", "a página não abriu a conversa");
          } else {
            await devolverParaFila(emCurso.telefone);
          }
          continue;
        }

        const prox = c.itens.find((i) => i.status === "pendente");
        if (!prox) {
          await atualizarCampanha((x) => {
            x.status = "concluida";
            x.terminouEm = Date.now();
          });
          log("campanha concluída");
          return;
        }

        const contatos = await ler(CHAVE.contatos, {});
        if (contatos[prox.telefone]?.optOut) {
          await registrarResultado(prox.telefone, "pulado", "contato pediu para não receber");
          continue;
        }

        const cfg = c.config;
        if (!N.dentroDaJanela(new Date(), cfg.horaInicio, cfg.horaFim)) {
          await pausar(`fora da janela de envio (${cfg.horaInicio}h–${cfg.horaFim}h)`);
          return;
        }
        if ((await enviosHoje()) >= cfg.limiteDiario) {
          await pausar(`limite diário de ${cfg.limiteDiario} envios atingido`);
          return;
        }

        const falta = (c.proximoEm || 0) - Date.now();
        if (falta > 0 && !(await esperar(falta))) continue;

        const texto = N.montarMensagem(c.mensagem, prox);
        await atualizarCampanha((x) => {
          const it = x.itens.find((i) => i.telefone === prox.telefone);
          it.status = "em_andamento";
          it.texto = texto;
          it.iniciadoEm = Date.now();
        });
        abrirConversaPorNumero(prox.telefone, texto);
      }
    } catch (erro) {
      console.error("[DeskcommCRM] motor parou", erro);
      await pausar(`erro inesperado: ${erro?.message ?? erro}`);
    } finally {
      motorRodando = false;
    }
  }

  async function devolverParaFila(telefone) {
    await atualizarCampanha((c) => {
      const it = c.itens.find((i) => i.telefone === telefone);
      if (it?.status === "em_andamento") it.status = "pendente";
    });
  }

  async function registrarResultado(telefone, status, motivo) {
    await atualizarCampanha((c) => {
      const it = c.itens.find((i) => i.telefone === telefone);
      // Cancelado durante o envio: a decisão do usuário vence.
      if (!it || it.status === "cancelado") return;
      const proximoEm = Date.now() + N.sortearDelay(c.config.delayMinMs, c.config.delayMaxMs);
      it.status = status;
      it.motivo = motivo ?? null;
      it.terminouEm = Date.now();
      // Pulado não abriu conversa nenhuma: não há por que esperar a cadência.
      if (status !== "pulado") c.proximoEm = proximoEm;
    });
    if (status === "enviado") await contarEnvio();
  }

  /** Página recém-aberta por `/send?phone=`: espera a conversa, confere o texto, envia. */
  async function concluirEnvio(item) {
    const pronto = await esperarPor(
      () => achar(SELETOR.caixaTexto) || (achar(SELETOR.app) && achar(SELETOR.dialogo)),
      60_000,
    );
    if (!pronto)
      return registrarResultado(item.telefone, "falhou", "o WhatsApp não carregou a conversa");

    // Número sem WhatsApp: o app mostra um diálogo e não abre conversa.
    const caixa = await esperarPor(() => achar(SELETOR.caixaTexto), 4000);
    if (!caixa) {
      const dialogo = achar(SELETOR.dialogo);
      dialogo?.querySelector("button")?.click();
      return registrarResultado(item.telefone, "falhou", "número inválido ou sem WhatsApp");
    }

    await dormir(1000 + Math.random() * 1500); // como quem confere o texto antes de enviar

    if (!caixa.textContent.trim()) {
      caixa.focus();
      document.execCommand("insertText", false, item.texto);
      caixa.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await dormir(800);
    }

    const alvo = await esperarPor(() => achar(SELETOR.botaoEnviar), 5000);
    if (!alvo) return registrarResultado(item.telefone, "falhou", "botão de enviar não encontrado");
    (alvo.closest("button") || alvo).click();

    const esvaziou = await esperarPor(
      () => !achar(SELETOR.caixaTexto)?.textContent.trim(),
      6000,
      250,
    );
    if (!esvaziou)
      return registrarResultado(item.telefone, "falhou", "a mensagem não saiu da caixa de texto");

    const contatos = await ler(CHAVE.contatos, {});
    if (contatos[item.telefone]) {
      contatos[item.telefone].ultimoDisparoEm = new Date().toISOString();
      await gravar(CHAVE.contatos, contatos);
    }
    log(`enviado para ${item.telefone}`);
    return registrarResultado(item.telefone, "enviado");
  }

  async function iniciarCampanha(lista, mensagem, cfg) {
    await gravar(CHAVE.campanha, {
      status: "rodando",
      criadaEm: Date.now(),
      mensagem,
      config: cfg,
      proximoEm: 0,
      itens: lista.map(({ telefone, nome }) => ({ telefone, nome, status: "pendente" })),
    });
    motor();
  }

  // ------------------------------------------------------------------ painel

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", Helvetica, Arial, sans-serif; }
    .tema { --fundo:#ffffff; --fundo2:#f0f2f5; --borda:#d1d7db; --texto:#111b21; --sutil:#667781; --verde:#00a884; --alerta:#c47f00; --erro:#d42f2f; }
    .tema.escuro { --fundo:#111b21; --fundo2:#202c33; --borda:#2a3942; --texto:#e9edef; --sutil:#8696a0; --alerta:#e1b12c; --erro:#f15c6d; }
    .lancador { position:fixed; right:0; top:42%; z-index:2147483646; writing-mode:vertical-rl;
      background:var(--verde); color:#fff; border:0; border-radius:8px 0 0 8px; padding:12px 6px;
      font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,.25); }
    .painel { position:fixed; right:12px; top:64px; z-index:2147483647; width:360px; max-height:calc(100vh - 88px);
      display:none; flex-direction:column; background:var(--fundo); color:var(--texto);
      border:1px solid var(--borda); border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.3); font-size:13px; }
    .painel.aberto { display:flex; }
    header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid var(--borda); }
    header b { color:var(--verde); }
    .x { background:none; border:0; color:var(--sutil); font-size:18px; cursor:pointer; line-height:1; }
    nav { display:flex; border-bottom:1px solid var(--borda); }
    nav button { flex:1; background:none; border:0; border-bottom:2px solid transparent; color:var(--sutil); padding:8px 4px; cursor:pointer; font-size:12px; }
    nav button.ativa { color:var(--verde); border-bottom-color:var(--verde); font-weight:600; }
    section { display:none; padding:12px; overflow:auto; gap:8px; flex-direction:column; }
    section.ativa { display:flex; }
    label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--sutil); }
    label.linha { flex-direction:row; align-items:center; gap:6px; color:var(--texto); }
    input, select, textarea { background:var(--fundo2); color:var(--texto); border:1px solid var(--borda); border-radius:6px; padding:6px 8px; font-size:13px; width:100%; }
    input[type=checkbox] { width:auto; }
    textarea { resize:vertical; min-height:64px; }
    .grade { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .acoes { display:flex; gap:8px; flex-wrap:wrap; }
    .btn { background:var(--fundo2); color:var(--texto); border:1px solid var(--borda); border-radius:6px; padding:7px 12px; cursor:pointer; font-size:12px; }
    .btn.primario { background:var(--verde); border-color:var(--verde); color:#fff; font-weight:600; }
    .btn:disabled { opacity:.5; cursor:not-allowed; }
    .sutil { color:var(--sutil); font-size:12px; }
    .aviso { color:var(--alerta); font-size:12px; }
    .erro { color:var(--erro); font-size:12px; }
    .ok { color:var(--verde); font-size:12px; }
    ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
    li { display:flex; justify-content:space-between; gap:8px; padding:6px 8px; background:var(--fundo2); border-radius:6px; }
    li span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .barra { height:6px; background:var(--fundo2); border-radius:3px; overflow:hidden; }
    .barra > div { height:100%; background:var(--verde); width:0; transition:width .3s; }
  `;

  const opcoesEstagio = ESTAGIOS.map(([v, r]) => `<option value="${v}">${r}</option>`).join("");

  // Só marcação estática aqui. Tudo que vem do usuário ou do WhatsApp entra por textContent.
  const HTML = `
    <button class="lancador" data-ref="lancador" title="Abrir painel do CRM">CRM</button>
    <div class="painel" data-ref="painel">
      <header><b>DeskcommCRM</b><button class="x" data-ref="fechar" title="Fechar">×</button></header>
      <nav>
        <button data-aba="contato" class="ativa">Contato</button>
        <button data-aba="disparo">Disparo</button>
        <button data-aba="contatos">Contatos</button>
      </nav>

      <section data-sec="contato" class="ativa">
        <div data-ref="semConversa" class="sutil">Abra uma conversa no WhatsApp para classificar o contato.</div>
        <div data-ref="formContato" style="display:none; flex-direction:column; gap:8px">
          <div><b data-ref="nomeContato"></b><div class="sutil" data-ref="telContato"></div></div>
          <label>Estágio<select data-ref="estagio">${opcoesEstagio}</select></label>
          <label>Notas<textarea data-ref="notas" placeholder="O que foi combinado, próximo passo…"></textarea></label>
          <label class="linha"><input type="checkbox" data-ref="optOut"> Pediu para não receber mensagens</label>
          <div class="acoes"><button class="btn primario" data-ref="salvar">Salvar</button><span data-ref="msgContato"></span></div>
        </div>
      </section>

      <section data-sec="disparo">
        <label>Contatos — um por linha: <i>telefone;nome</i>
          <textarea data-ref="lista" rows="5" placeholder="31999999999;Maria Souza&#10;5531888888888;João"></textarea>
        </label>
        <div class="acoes">
          <select data-ref="estagioOrigem" style="flex:1">${opcoesEstagio}</select>
          <button class="btn" data-ref="carregarEstagio">Usar contatos do estágio</button>
        </div>
        <label>Mensagem
          <textarea data-ref="mensagem" rows="4" placeholder="{Olá|Oi} {{primeiro_nome}}, tudo bem? …"></textarea>
        </label>
        <div class="sutil">Variáveis: {{nome}}, {{primeiro_nome}}, {{telefone}}. Variações: {Olá|Oi|E aí} — cada envio sorteia uma.</div>
        <div class="grade">
          <label>Intervalo mín. (s)<input type="number" min="5" data-ref="delayMin"></label>
          <label>Intervalo máx. (s)<input type="number" min="5" data-ref="delayMax"></label>
          <label>Envia a partir de (h)<input type="number" min="0" max="23" data-ref="horaInicio"></label>
          <label>Até (h)<input type="number" min="0" max="23" data-ref="horaFim"></label>
          <label>Limite por dia<input type="number" min="1" data-ref="limiteDiario"></label>
          <label>DDI padrão<input type="text" maxlength="4" data-ref="ddi"></label>
        </div>
        <div class="acoes">
          <button class="btn primario" data-ref="iniciar">Iniciar disparo</button>
          <button class="btn" data-ref="pausar">Pausar</button>
          <button class="btn" data-ref="retomar">Retomar</button>
          <button class="btn" data-ref="cancelar">Cancelar</button>
        </div>
        <div data-ref="msgDisparo"></div>
        <div class="barra"><div data-ref="barra"></div></div>
        <div class="sutil" data-ref="resumo"></div>
        <ul data-ref="itens"></ul>
      </section>

      <section data-sec="contatos">
        <div class="acoes">
          <select data-ref="filtro" style="flex:1"><option value="">Todos os estágios</option>${opcoesEstagio}</select>
        </div>
        <div class="sutil" data-ref="contagem"></div>
        <ul data-ref="listaContatos"></ul>
        <div class="acoes">
          <button class="btn" data-ref="exportar">Exportar JSON</button>
          <button class="btn" data-ref="importar">Importar JSON</button>
          <input type="file" accept="application/json" data-ref="arquivo" style="display:none">
        </div>
      </section>
    </div>
  `;

  const hospedeiro = document.createElement("div");
  hospedeiro.id = "deskcomm-crm";
  const sombra = hospedeiro.attachShadow({ mode: "open" });
  sombra.innerHTML = `<style>${CSS}</style><div class="tema">${HTML}</div>`;
  const tema = sombra.querySelector(".tema");
  const ref = new Proxy({}, { get: (_, nome) => sombra.querySelector(`[data-ref="${nome}"]`) });

  const mensagem = (alvo, texto, tipo = "sutil") => {
    alvo.className = tipo;
    alvo.textContent = texto;
  };

  function sincronizarTema() {
    tema.classList.toggle("escuro", document.body.classList.contains("dark"));
  }

  function trocarAba(aba) {
    for (const b of sombra.querySelectorAll("nav button"))
      b.classList.toggle("ativa", b.dataset.aba === aba);
    for (const s of sombra.querySelectorAll("section"))
      s.classList.toggle("ativa", s.dataset.sec === aba);
    if (aba === "contatos") renderContatos();
    if (aba === "contato") renderContato(true);
  }

  // --- aba Contato

  let chaveExibida = null;

  async function renderContato(forcar = false) {
    const conversa = conversaAtiva();
    if (!forcar && (conversa?.chave ?? null) === chaveExibida) return;
    chaveExibida = conversa?.chave ?? null;
    ref.semConversa.style.display = conversa ? "none" : "";
    ref.formContato.style.display = conversa ? "flex" : "none";
    if (!conversa) return;

    const salvo = (await ler(CHAVE.contatos, {}))[conversa.chave] || {};
    ref.nomeContato.textContent = conversa.nome;
    ref.telContato.textContent = conversa.telefone
      ? `+${conversa.telefone}`
      : "Telefone não identificado (grupo ou conversa sem mensagens)";
    ref.estagio.value = salvo.estagio || "novo";
    ref.notas.value = salvo.notas || "";
    ref.optOut.checked = Boolean(salvo.optOut);
    mensagem(
      ref.msgContato,
      salvo.atualizadoEm ? `Salvo em ${new Date(salvo.atualizadoEm).toLocaleString()}` : "",
    );
  }

  ref.salvar.addEventListener("click", async () => {
    const conversa = conversaAtiva();
    if (!conversa) return mensagem(ref.msgContato, "Abra uma conversa primeiro.", "erro");
    await salvarContato(conversa, {
      estagio: ref.estagio.value,
      notas: ref.notas.value.trim(),
      optOut: ref.optOut.checked,
    });
    mensagem(ref.msgContato, "Salvo.", "ok");
  });

  // --- aba Disparo

  async function carregarPrefs() {
    const p = await prefs();
    ref.delayMin.value = p.delayMinS;
    ref.delayMax.value = p.delayMaxS;
    ref.horaInicio.value = p.horaInicio;
    ref.horaFim.value = p.horaFim;
    ref.limiteDiario.value = p.limiteDiario;
    ref.ddi.value = p.ddi;
  }

  function lerPrefsDaTela() {
    const num = (el, padrao) =>
      Number.isFinite(Number(el.value)) && el.value !== "" ? Number(el.value) : padrao;
    const minS = Math.max(N.DELAY_MINIMO_MS / 1000, num(ref.delayMin, PREFS_PADRAO.delayMinS));
    return {
      delayMinS: minS,
      delayMaxS: Math.max(minS, num(ref.delayMax, PREFS_PADRAO.delayMaxS)),
      horaInicio: Math.min(23, Math.max(0, num(ref.horaInicio, PREFS_PADRAO.horaInicio))),
      horaFim: Math.min(23, Math.max(0, num(ref.horaFim, PREFS_PADRAO.horaFim))),
      limiteDiario: Math.max(1, num(ref.limiteDiario, PREFS_PADRAO.limiteDiario)),
      ddi: ref.ddi.value.replace(/\D/g, "") || PREFS_PADRAO.ddi,
    };
  }

  ref.carregarEstagio.addEventListener("click", async () => {
    const contatos = Object.values(await ler(CHAVE.contatos, {}));
    const doEstagio = contatos.filter(
      (c) => c.estagio === ref.estagioOrigem.value && c.telefone && !c.optOut,
    );
    ref.lista.value = doEstagio.map((c) => `${c.telefone};${c.nome ?? ""}`).join("\n");
    mensagem(
      ref.msgDisparo,
      `${doEstagio.length} contato(s) com telefone em "${ROTULO_ESTAGIO[ref.estagioOrigem.value]}".`,
    );
  });

  ref.iniciar.addEventListener("click", async () => {
    const atual = await ler(CHAVE.campanha, null);
    if (atual && (atual.status === "rodando" || atual.status === "pausada")) {
      return mensagem(
        ref.msgDisparo,
        "Já existe uma campanha em andamento. Cancele-a antes de iniciar outra.",
        "erro",
      );
    }
    const p = lerPrefsDaTela();
    await gravar(CHAVE.prefs, p);
    const { validos, invalidos } = N.parseListaContatos(ref.lista.value, p.ddi);
    const texto = ref.mensagem.value.trim();
    if (!validos.length)
      return mensagem(ref.msgDisparo, "Nenhum telefone válido na lista.", "erro");
    if (!texto) return mensagem(ref.msgDisparo, "Escreva a mensagem.", "erro");

    const contatos = await ler(CHAVE.contatos, {});
    const bloqueados = validos.filter((v) => contatos[v.telefone]?.optOut).length;
    const confirmacao =
      `Enviar para ${validos.length} contato(s)` +
      (bloqueados ? ` (${bloqueados} com opt-out serão pulados)` : "") +
      (invalidos.length ? `, ignorando ${invalidos.length} linha(s) inválida(s)` : "") +
      `?\n\nA página vai recarregar a cada contato. Mantenha esta aba aberta.`;
    if (!window.confirm(confirmacao)) return;

    await iniciarCampanha(validos, texto, {
      delayMinMs: p.delayMinS * 1000,
      delayMaxMs: p.delayMaxS * 1000,
      horaInicio: p.horaInicio,
      horaFim: p.horaFim,
      limiteDiario: p.limiteDiario,
    });
  });

  ref.pausar.addEventListener("click", () => pausar("pausada por você"));
  ref.retomar.addEventListener("click", async () => {
    const c = await atualizarCampanha((x) => {
      if (x.status === "pausada") {
        x.status = "rodando";
        x.motivo = null;
      }
    });
    if (c?.status === "rodando") motor();
  });
  ref.cancelar.addEventListener("click", async () => {
    if (!window.confirm("Cancelar a campanha? Os envios já feitos não são desfeitos.")) return;
    await atualizarCampanha((x) => {
      x.status = "cancelada";
      for (const it of x.itens)
        if (it.status === "pendente" || it.status === "em_andamento") it.status = "cancelado";
    });
  });

  const ROTULO_STATUS = {
    pendente: "na fila",
    em_andamento: "enviando…",
    enviado: "enviado",
    falhou: "falhou",
    pulado: "pulado",
    cancelado: "cancelado",
  };

  async function renderCampanha() {
    const c = await ler(CHAVE.campanha, null);
    const rodando = c?.status === "rodando";
    ref.iniciar.disabled = rodando || c?.status === "pausada";
    ref.pausar.disabled = !rodando;
    ref.retomar.disabled = c?.status !== "pausada";
    ref.cancelar.disabled = !c || !(rodando || c.status === "pausada");
    ref.itens.replaceChildren();
    if (!c) {
      ref.resumo.textContent = "";
      ref.barra.style.width = "0";
      return;
    }

    const conta = (s) => c.itens.filter((i) => i.status === s).length;
    const feitos = c.itens.length - conta("pendente") - conta("em_andamento");
    ref.barra.style.width = `${Math.round((feitos / c.itens.length) * 100)}%`;
    const estado = {
      rodando: "Rodando",
      pausada: "Pausada",
      concluida: "Concluída",
      cancelada: "Cancelada",
    }[c.status];
    let resumo =
      `${estado} — ${conta("enviado")} enviado(s), ${conta("falhou")} falha(s), ` +
      `${conta("pulado")} pulado(s), ${conta("pendente")} na fila · hoje: ${await enviosHoje()}/${c.config.limiteDiario}`;
    if (c.motivo) resumo += ` · ${c.motivo}`;
    if (rodando && c.proximoEm > Date.now())
      resumo += ` · próximo em ${Math.ceil((c.proximoEm - Date.now()) / 1000)}s`;
    ref.resumo.textContent = resumo;

    for (const it of c.itens.slice(-60).reverse()) {
      const li = document.createElement("li");
      const a = document.createElement("span");
      a.textContent = it.nome ? `${it.nome} · ${it.telefone}` : it.telefone;
      const b = document.createElement("span");
      b.textContent = ROTULO_STATUS[it.status] ?? it.status;
      b.className = { enviado: "ok", falhou: "erro", pulado: "aviso" }[it.status] ?? "sutil";
      if (it.motivo) b.title = it.motivo;
      li.append(a, b);
      ref.itens.append(li);
    }
  }

  // --- aba Contatos

  async function renderContatos() {
    const filtro = ref.filtro.value;
    const todos = Object.entries(await ler(CHAVE.contatos, {}))
      .filter(([, c]) => !filtro || c.estagio === filtro)
      .sort(([, a], [, b]) => String(b.atualizadoEm).localeCompare(String(a.atualizadoEm)));
    ref.contagem.textContent = `${todos.length} contato(s)`;
    ref.listaContatos.replaceChildren(
      ...todos.map(([chave, c]) => {
        const li = document.createElement("li");
        const a = document.createElement("span");
        a.textContent = c.nome || chave;
        a.title = [c.telefone ? `+${c.telefone}` : null, c.notas].filter(Boolean).join("\n");
        const b = document.createElement("span");
        b.textContent = (c.optOut ? "🚫 " : "") + (ROTULO_ESTAGIO[c.estagio] ?? c.estagio ?? "—");
        b.className = "sutil";
        li.append(a, b);
        return li;
      }),
    );
  }

  ref.filtro.addEventListener("change", renderContatos);

  ref.exportar.addEventListener("click", async () => {
    const dados = {
      versao: 1,
      exportadoEm: new Date().toISOString(),
      contatos: await ler(CHAVE.contatos, {}),
    };
    const blob = new Blob([JSON.stringify(dados, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `deskcomm-contatos-${N.chaveDoDia(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  ref.importar.addEventListener("click", () => ref.arquivo.click());
  ref.arquivo.addEventListener("change", async () => {
    const arq = ref.arquivo.files?.[0];
    ref.arquivo.value = "";
    if (!arq) return;
    try {
      const dados = JSON.parse(await arq.text());
      const novos = dados?.contatos;
      if (!novos || typeof novos !== "object" || Array.isArray(novos))
        throw new Error("formato inesperado");
      const atuais = await ler(CHAVE.contatos, {});
      // Mescla: o registro mais recente de cada contato vence.
      for (const [chave, c] of Object.entries(novos)) {
        if (!atuais[chave] || String(c.atualizadoEm) > String(atuais[chave].atualizadoEm))
          atuais[chave] = c;
      }
      await gravar(CHAVE.contatos, atuais);
      renderContatos();
      ref.contagem.textContent += ` · importados ${Object.keys(novos).length}`;
    } catch (erro) {
      ref.contagem.textContent = `Não foi possível importar: ${erro.message}`;
    }
  });

  // --- montagem

  function abrirPainel(aberto) {
    ref.painel.classList.toggle("aberto", aberto);
    ref.lancador.style.display = aberto ? "none" : "";
    if (aberto) {
      renderContato(true);
      renderCampanha();
    }
  }

  ref.lancador.addEventListener("click", () => abrirPainel(true));
  ref.fechar.addEventListener("click", () => abrirPainel(false));
  for (const b of sombra.querySelectorAll("nav button"))
    b.addEventListener("click", () => trocarAba(b.dataset.aba));

  chrome.storage.onChanged.addListener((mudancas, area) => {
    if (area !== "local") return;
    if (mudancas[CHAVE.campanha]) {
      statusCampanha = mudancas[CHAVE.campanha].newValue?.status ?? null;
      renderCampanha();
    }
    if (mudancas[CHAVE.contatos] && ref.painel.classList.contains("aberto")) renderContatos();
  });

  async function montar() {
    await esperarPor(() => achar(SELETOR.app), 120_000, 1000);
    document.body.append(hospedeiro);
    sincronizarTema();
    new MutationObserver(sincronizarTema).observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    await carregarPrefs();

    // Troca de conversa não dispara evento próprio no WhatsApp: verificação barata por segundo.
    setInterval(() => {
      if (ref.painel.classList.contains("aberto")) {
        renderContato();
        renderCampanha();
      }
    }, 1000);

    const c = await ler(CHAVE.campanha, null);
    if (c?.status === "rodando") {
      abrirPainel(true);
      trocarAba("disparo");
      motor();
    }
  }

  montar();
})();
