# Extensão Chrome — CRM no WhatsApp Web

Painel lateral dentro do `web.whatsapp.com` para classificar contatos num funil e
fazer disparo em lote cadenciado. Roda **só no navegador**: não fala com o
servidor do DeskcommCRM nem com o WAHA, e não entra na imagem Docker.

## Instalar (modo desenvolvedor)

1. `chrome://extensions` → ligue **Modo do desenvolvedor**.
2. **Carregar sem compactação** → escolha esta pasta (`chrome-extension/whatsapp-crm`).
3. Abra (ou recarregue) o WhatsApp Web. Aparece a aba verde **CRM** na borda direita.

Depois de editar o código: botão ↻ da extensão em `chrome://extensions` e recarregar a aba do WhatsApp.

## O que faz

| Aba          | Função                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contato**  | Estágio (Lead novo, Em proposta, Follow-up, Cliente fechado, Perdido), notas e marca de opt-out da conversa aberta.                                                                                   |
| **Disparo**  | Lista `telefone;nome` (ou "usar contatos do estágio"), mensagem com `{{nome}}`/`{{primeiro_nome}}`/`{{telefone}}` e variações `{Olá\|Oi}`. Iniciar, pausar, retomar, cancelar, progresso por contato. |
| **Contatos** | Lista filtrável por estágio; exportar/importar JSON (mescla pelo registro mais recente).                                                                                                              |

Os dados ficam em `chrome.storage.local` — **neste navegador**. Exporte o JSON para backup ou para outra máquina.

## Como o disparo funciona

Abrir conversa por número (`/send?phone=…&text=…`) **recarrega a página** e mata o
script. Por isso a fila é persistida: cada contato passa por `pendente → em_andamento →
enviado | falhou | pulado`, e o script retoma de onde parou depois do recarregamento.
Só se envia na página que nasceu da navegação para aquele contato
(`performance.timeOrigin >= iniciadoEm`); qualquer outra página devolve o item à fila,
para a mensagem nunca cair na conversa errada.

Freios embutidos:

- intervalo aleatório entre envios, com piso de 5 s (padrão 15–40 s);
- janela de horário (padrão 8h–20h; início = fim desliga a janela) — fora dela a campanha pausa;
- limite diário (padrão 150) — atingido, a campanha pausa;
- contato com opt-out é pulado;
- número sem WhatsApp é marcado como falha e o diálogo é fechado.

## ⚠️ Riscos

- **Os termos do WhatsApp proíbem envio automatizado e em massa.** Os freios reduzem o
  risco, não o eliminam: o número pode ser restrito ou banido. Envie só para quem
  autorizou o contato (LGPD) e respeite quem pede para parar.
- **O WhatsApp Web muda o HTML sem aviso.** Todos os seletores estão no bloco `SELETOR`
  de `content.js`; quando algo parar de achar o botão/caixa de texto, é ali.
- Para volume, use as campanhas do próprio DeskcommCRM via WAHA, que têm cadência,
  warm-up e detecção de STOP no servidor.

## Arquivos

- `manifest.json` — Manifest V3, só permissão `storage` e o host `web.whatsapp.com`.
- `nucleo.js` — regras puras (telefone, spintax, variáveis, janela, delay, leitura do `data-id`).
- `content.js` — painel (shadow DOM), CRM local e motor da campanha.
- `nucleo.test.js` — testes do núcleo; rodam no `pnpm test:unit` (ou `pnpm vitest run chrome-extension`).

## Próximos passos possíveis

- Sincronizar estágio/notas com o DeskcommCRM pela API `/api/v1/` com token `dsk_`
  (a rota precisa aceitar bearer — ver `lib/api/auth-dual.ts`).
- Detectar "PARAR"/"SAIR" nas mensagens recebidas e marcar opt-out automático.
