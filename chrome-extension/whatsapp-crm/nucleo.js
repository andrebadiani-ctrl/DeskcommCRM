/**
 * Regras puras da extensão — sem DOM, sem chrome.*, sem relógio implícito.
 * Carregado como content script ANTES de content.js (ver manifest.json) e
 * exposto em `globalThis.DeskcommNucleo`; os testes importam o mesmo arquivo.
 */
(function (raiz) {
  "use strict";

  // Piso de cadência de campanha da casa (CLAUDE.md › WAHA: 1 msg / 5 s).
  // A tela aceita valores maiores, nunca menores.
  const DELAY_MINIMO_MS = 5000;

  /**
   * Devolve só dígitos com DDI, ou null quando não parece telefone.
   * 10–11 dígitos = número nacional sem DDI → recebe o DDI padrão. No Brasil
   * o tamanho decide sozinho (com DDI são 12–13; "55…" de 11 dígitos é o DDD 55);
   * nos demais países, número que já começa pelo DDI fica como está.
   */
  function normalizarTelefone(bruto, ddiPadrao = "55") {
    const digitos = String(bruto ?? "").replace(/\D/g, "");
    if (digitos.length < 8 || digitos.length > 15) return null;
    const nacional = digitos.length === 10 || digitos.length === 11;
    if (ddiPadrao && nacional && (ddiPadrao === "55" || !digitos.startsWith(ddiPadrao)))
      return ddiPadrao + digitos;
    return digitos;
  }

  /**
   * Uma linha por contato: `telefone`, `telefone;nome` (aceita `,` ou tab).
   * Remove duplicados mantendo a primeira ocorrência.
   */
  function parseListaContatos(texto, ddiPadrao = "55") {
    const validos = [];
    const invalidos = [];
    const vistos = new Set();
    for (const linhaBruta of String(texto ?? "").split(/\r?\n/)) {
      const linha = linhaBruta.trim();
      if (!linha) continue;
      const [tel, ...resto] = linha.split(/[;,\t]/);
      const telefone = normalizarTelefone(tel, ddiPadrao);
      if (!telefone) {
        invalidos.push(linha);
        continue;
      }
      if (vistos.has(telefone)) continue;
      vistos.add(telefone);
      validos.push({ telefone, nome: resto.join(" ").trim() });
    }
    return { validos, invalidos };
  }

  /** `{Olá|Oi|E aí}` → uma das opções. Aninhamento resolvido de dentro para fora. */
  function aplicarSpintax(texto, aleatorio = Math.random) {
    const grupo = /\{([^{}]*\|[^{}]*)\}/;
    let saida = String(texto ?? "");
    for (let guarda = 0; guarda < 500 && grupo.test(saida); guarda++) {
      saida = saida.replace(grupo, (_, corpo) => {
        const opcoes = corpo.split("|");
        return opcoes[Math.floor(aleatorio() * opcoes.length)] ?? "";
      });
    }
    return saida;
  }

  /** `{{nome}}`, `{{primeiro_nome}}`, `{{telefone}}`. Variável sem valor vira vazio. */
  function aplicarVariaveis(texto, contato) {
    const nome = (contato?.nome ?? "").trim();
    const valores = {
      nome,
      primeiro_nome: nome.split(/\s+/)[0] ?? "",
      telefone: contato?.telefone ?? "",
    };
    return String(texto ?? "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, chave) =>
      Object.prototype.hasOwnProperty.call(valores, chave) ? valores[chave] : "",
    );
  }

  /** Variáveis primeiro: `{{nome}}` não pode ser lido como grupo de spintax. */
  function montarMensagem(modelo, contato, aleatorio = Math.random) {
    return aplicarSpintax(aplicarVariaveis(modelo, contato), aleatorio)
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function sortearDelay(minMs, maxMs, aleatorio = Math.random) {
    const min = Math.max(DELAY_MINIMO_MS, Number(minMs) || 0);
    const max = Math.max(min, Number(maxMs) || 0);
    return Math.floor(aleatorio() * (max - min + 1)) + min;
  }

  /** Janela [inicio, fim) em horas locais. inicio === fim = sem janela. */
  function dentroDaJanela(data, horaInicio, horaFim) {
    if (horaInicio === horaFim) return true;
    const h = data.getHours();
    return horaInicio < horaFim ? h >= horaInicio && h < horaFim : h >= horaInicio || h < horaFim;
  }

  function chaveDoDia(data) {
    const p = (n) => String(n).padStart(2, "0");
    return `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}`;
  }

  /**
   * `data-id` de mensagem do WhatsApp Web: `<fromMe>_<chatJid>_<msgId>[_<autor>]`.
   * Só o SEGUNDO segmento é o chat; em grupo o último é o autor, e lê-lo
   * atribuiria a conversa do grupo ao telefone de um participante.
   */
  function telefoneDoDataId(dataId) {
    const partes = String(dataId ?? "").split("_");
    if (partes.length < 3 || (partes[0] !== "true" && partes[0] !== "false")) return null;
    const m = /^(\d{8,15})@c\.us$/.exec(partes[1]);
    return m ? m[1] : null;
  }

  /** Conversa sem nome salvo mostra o número formatado no cabeçalho. */
  function telefoneDoTitulo(titulo) {
    const t = String(titulo ?? "").trim();
    if (!/^\+?[\d\s().-]+$/.test(t)) return null;
    const d = t.replace(/\D/g, "");
    return d.length >= 8 && d.length <= 15 ? d : null;
  }

  raiz.DeskcommNucleo = Object.freeze({
    DELAY_MINIMO_MS,
    normalizarTelefone,
    parseListaContatos,
    aplicarSpintax,
    aplicarVariaveis,
    montarMensagem,
    sortearDelay,
    dentroDaJanela,
    chaveDoDia,
    telefoneDoDataId,
    telefoneDoTitulo,
  });
})(globalThis);
