// Página do pedido para imprimir ou salvar em PDF (pelo próprio navegador: Imprimir › Salvar como PDF).
// Tudo vem escapado: nome de cliente ou observação nunca vira HTML.

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dataBr = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("pt-BR") : "");

export function paginaDoPedido(pedido, lead, empresa = {}) {
  const fmt = (v) => new Intl.NumberFormat(pedido.moeda === "EUR" ? "pt-PT" : "pt-BR", { style: "currency", currency: pedido.moeda || "BRL" }).format(Number(v) || 0);
  const qtd = (q) => String(q).replace(".", ",");
  const local = lead ? [lead.cidade, lead.uf || lead.distrito, lead.pais].filter(Boolean).join(" · ") : "";
  const linhasTotais = [
    ["Subtotal", fmt(pedido.subtotal)],
    pedido.ajuste ? [`${pedido.ajuste < 0 ? "Desconto" : "Acréscimo"} (${esc(pedido.condicao?.nome)})`, `${pedido.ajuste < 0 ? "− " : "+ "}${fmt(Math.abs(pedido.ajuste))}`] : null,
    pedido.desconto ? ["Desconto", `− ${fmt(pedido.desconto)}`] : null,
    pedido.frete ? ["Frete", `+ ${fmt(pedido.frete)}`] : null,
  ].filter(Boolean);
  const parcelas = pedido.pagamentos || [];

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pedido ${pedido.numero}${pedido.cliente ? ` — ${esc(pedido.cliente)}` : ""}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #10261d; margin: 0; background: #eef3f0; }
  .folha { max-width: 820px; margin: 24px auto; background: #fff; padding: 40px 44px; border-radius: 12px; box-shadow: 0 4px 24px rgba(6,35,26,.12); }
  .barra { max-width: 820px; margin: 16px auto 0; display: flex; justify-content: flex-end; gap: 8px; }
  .barra button { font: inherit; font-weight: 700; border: 0; border-radius: 999px; padding: 10px 18px; cursor: pointer; background: #4ade80; color: #06231a; }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 3px solid #14573e; padding-bottom: 16px; }
  .empresa strong { font-size: 1.25rem; color: #0b3324; }
  .empresa div, .numero div { font-size: .85rem; color: #4b6358; margin-top: 2px; }
  .numero { text-align: right; }
  .numero strong { font-size: 1.4rem; color: #0b3324; }
  .status { display: inline-block; margin-top: 6px; padding: 2px 10px; border-radius: 999px; background: #dcfce7; color: #14573e; font-weight: 700; font-size: .8rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: #4b6358; margin: 22px 0 8px; }
  .cliente { font-size: .95rem; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th { text-align: left; background: #0b3324; color: #fff; padding: 8px 10px; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
  td { padding: 8px 10px; border-bottom: 1px solid #dfe9e3; }
  .num { text-align: right; white-space: nowrap; }
  .totais { margin-left: auto; width: 320px; margin-top: 12px; font-size: .92rem; }
  .totais div { display: flex; justify-content: space-between; padding: 3px 0; }
  .totais .final { border-top: 2px solid #14573e; margin-top: 6px; padding-top: 8px; font-size: 1.15rem; font-weight: 800; color: #0b3324; }
  .obs { white-space: pre-wrap; font-size: .9rem; background: #f3f7f4; border-radius: 8px; padding: 10px 12px; }
  .assinatura { margin-top: 56px; display: flex; gap: 40px; }
  .assinatura div { flex: 1; border-top: 1px solid #10261d; padding-top: 6px; font-size: .8rem; text-align: center; color: #4b6358; }
  .pago { color: #15803d; font-weight: 700; }
  @media print { body { background: #fff; } .barra { display: none; } .folha { box-shadow: none; margin: 0; max-width: none; padding: 0; } @page { margin: 16mm; } }
</style></head>
<body>
  <div class="barra"><button onclick="window.print()">Imprimir / Salvar em PDF</button></div>
  <main class="folha">
    <header>
      <div class="empresa">
        <strong>${esc(empresa.nome || "Pedido de venda")}</strong>
        ${empresa.documento ? `<div>${esc(empresa.documento)}</div>` : ""}
        ${empresa.endereco ? `<div>${esc(empresa.endereco)}</div>` : ""}
        ${empresa.telefone || empresa.email ? `<div>${[empresa.telefone, empresa.email].filter(Boolean).map(esc).join(" · ")}</div>` : ""}
      </div>
      <div class="numero">
        <strong>Pedido nº ${pedido.numero}</strong>
        <div>Emitido em ${dataBr(pedido.criadoEm)}</div>
        ${pedido.vendedor ? `<div>Vendedor: ${esc(pedido.vendedor.nome)}</div>` : ""}
        <span class="status">${esc(pedido.status)}</span>
      </div>
    </header>

    <h2>Cliente</h2>
    <div class="cliente">
      <strong>${esc(pedido.cliente)}</strong>${lead?.empresa ? ` — ${esc(lead.empresa)}` : ""}<br />
      ${[lead?.telefone, lead?.email].filter(Boolean).map(esc).join(" · ")}${local ? `<br />${esc(local)}` : ""}
    </div>

    <h2>Itens</h2>
    <table>
      <thead><tr><th>Descrição</th><th class="num">Qtd.</th><th class="num">Preço unit.</th><th class="num">Total</th></tr></thead>
      <tbody>${pedido.itens.map((i) => `<tr><td>${esc(i.descricao)}${i.codigo ? ` <small>(${esc(i.codigo)})</small>` : ""}</td><td class="num">${qtd(i.quantidade)} ${esc(i.unidade)}</td><td class="num">${fmt(i.precoUnitario)}</td><td class="num">${fmt(i.total)}</td></tr>`).join("")}</tbody>
    </table>
    <div class="totais">
      ${linhasTotais.map(([r, v]) => `<div><span>${r}</span><span>${v}</span></div>`).join("")}
      <div class="final"><span>Total</span><span>${fmt(pedido.total)}</span></div>
    </div>

    <h2>Pagamento${pedido.condicao ? ` — ${esc(pedido.condicao.nome)}` : ""}</h2>
    ${parcelas.length ? `<table>
      <thead><tr><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th></tr></thead>
      <tbody>${parcelas.map((p) => `<tr><td>${p.numero}/${parcelas.length}</td><td>${dataBr(p.vencimento)}</td><td class="num">${fmt(p.valor)}</td><td>${p.pagaEm ? `<span class="pago">Pago em ${dataBr(p.pagaEm)}</span>` : "A pagar"}</td></tr>`).join("")}</tbody>
    </table>` : ""}

    ${pedido.observacoes ? `<h2>Observações</h2><div class="obs">${esc(pedido.observacoes)}</div>` : ""}

    <div class="assinatura"><div>${esc(empresa.nome || "Empresa")}</div><div>${esc(pedido.cliente)}</div></div>
  </main>
</body></html>`;
}
