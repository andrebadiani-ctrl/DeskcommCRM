import { describe, expect, it } from "vitest";
import "./nucleo.js";

const N = globalThis.DeskcommNucleo;
const sempre = (v) => () => v;

describe("normalizarTelefone", () => {
  it("põe o DDI em número nacional e mantém o que já tem DDI", () => {
    expect(N.normalizarTelefone("(31) 99999-9999")).toBe("5531999999999");
    expect(N.normalizarTelefone("3133334444")).toBe("553133334444");
    expect(N.normalizarTelefone("+55 31 99999-9999")).toBe("5531999999999");
    expect(N.normalizarTelefone("1 415 555 0100", "1")).toBe("14155550100");
    expect(N.normalizarTelefone("415 555 0100", "1")).toBe("14155550100");
    expect(N.normalizarTelefone("55 99999-8888")).toBe("5555999998888");
  });
  it("recusa o que não é telefone", () => {
    expect(N.normalizarTelefone("abc")).toBeNull();
    expect(N.normalizarTelefone("1234")).toBeNull();
    expect(N.normalizarTelefone("1".repeat(16))).toBeNull();
  });
});

describe("parseListaContatos", () => {
  it("lê telefone;nome, deduplica e separa inválidos", () => {
    const r = N.parseListaContatos(
      "31999999999;Maria Souza\n\n5531999999999;Outra\nxx;Nada\n31888888888,João\t",
    );
    expect(r.validos).toEqual([
      { telefone: "5531999999999", nome: "Maria Souza" },
      { telefone: "5531888888888", nome: "João" },
    ]);
    expect(r.invalidos).toEqual(["xx;Nada"]);
  });
});

describe("montarMensagem", () => {
  it("resolve variáveis antes do spintax, sem confundir {{nome}} com grupo", () => {
    const c = { nome: "Maria Souza", telefone: "5531999999999" };
    expect(N.montarMensagem("{Olá|Oi} {{primeiro_nome}}!", c, sempre(0))).toBe("Olá Maria!");
    expect(N.montarMensagem("{Olá|Oi} {{nome}}", c, sempre(0.99))).toBe("Oi Maria Souza");
  });
  it("resolve spintax aninhado e deixa vazia variável desconhecida", () => {
    expect(N.montarMensagem("{a|{b|c}}", {}, sempre(0.99))).toBe("c");
    expect(N.montarMensagem("Oi {{xyz}} {{nome}}, tudo bem?", {}, sempre(0))).toBe(
      "Oi , tudo bem?",
    );
  });
  it("não mexe em chaves sem barra", () => {
    expect(N.aplicarSpintax("preço {promo}", sempre(0))).toBe("preço {promo}");
  });
});

describe("sortearDelay", () => {
  it("nunca fica abaixo do piso de 5 s nem acima do máximo", () => {
    expect(N.sortearDelay(1000, 2000, sempre(0))).toBe(N.DELAY_MINIMO_MS);
    expect(N.sortearDelay(10_000, 20_000, sempre(1 - Number.EPSILON))).toBe(20_000);
    expect(N.sortearDelay(30_000, 10_000, sempre(0.5))).toBe(30_000);
  });
});

describe("dentroDaJanela", () => {
  const as = (h) => new Date(2026, 9, 10, h, 30);
  it("janela comum é [início, fim)", () => {
    expect(N.dentroDaJanela(as(8), 8, 20)).toBe(true);
    expect(N.dentroDaJanela(as(19), 8, 20)).toBe(true);
    expect(N.dentroDaJanela(as(20), 8, 20)).toBe(false);
    expect(N.dentroDaJanela(as(7), 8, 20)).toBe(false);
  });
  it("janela que cruza a meia-noite e janela vazia", () => {
    expect(N.dentroDaJanela(as(23), 22, 2)).toBe(true);
    expect(N.dentroDaJanela(as(3), 22, 2)).toBe(false);
    expect(N.dentroDaJanela(as(3), 0, 0)).toBe(true);
  });
});

describe("telefone da conversa", () => {
  it("lê o chat do data-id, nunca o autor de mensagem de grupo", () => {
    expect(N.telefoneDoDataId("false_5531999999999@c.us_3EB0ABC")).toBe("5531999999999");
    expect(N.telefoneDoDataId("true_5531999999999@c.us_3EB0ABC")).toBe("5531999999999");
    expect(
      N.telefoneDoDataId("false_120363012345678901@g.us_3EB0ABC_5531999999999@c.us"),
    ).toBeNull();
    expect(N.telefoneDoDataId("lixo")).toBeNull();
  });
  it("aceita título que é número formatado e recusa nome", () => {
    expect(N.telefoneDoTitulo("+55 31 99999-9999")).toBe("5531999999999");
    expect(N.telefoneDoTitulo("Maria Souza")).toBeNull();
  });
});
