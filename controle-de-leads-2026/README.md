# Controle de Leads 2026

CRM minimalista para controle de leads, com **Tabela editável**, **Kanban com arrastar e soltar**
e **integração com o WhatsApp por QR Code**. Visual verde-escuro, responsivo (desktop e celular).

## O que tem

- **Tabela de leads** — todas as colunas editáveis direto na célula (salva ao sair do campo / Enter);
  ordenação por data de criação e faturamento mensal clicando no cabeçalho.
- **Kanban** — 8 colunas do funil (Novo Lead, Em atendimento IA, Atendimento Humano, Reunião Agendada,
  Proposta Enviada, Ganho, Perdido, Sem interesse). Arraste o cartão para mudar a etapa; no celular,
  arraste pela alça (⋮⋮) ou use o seletor "mover para" do cartão.
- **CRUD completo** — criar, ver, editar e excluir leads (botão *Novo lead* e modal do lead).
- **Campos** — Data de criação, Nome, E-mail, Telefone, Cargo, Empresa, Observações, Faturamento mensal,
  Cidade, País (Brasil / Portugal), UF (os 27 estados, quando Brasil), Distrito (os 20 de Portugal,
  quando Portugal) e Etapa do funil.
- **Notas rápidas** — no modal do lead, adiciona uma linha datada às Observações.
- **Busca global** (nome, empresa, cidade, e-mail, telefone) e **filtros** por etapa, país, UF/distrito
  e cidade.
- **Indicadores** no topo — total, novos, em andamento, ganhos, perdidos e taxa de conversão.
- **Exportação CSV** (do que está filtrado), pronta para abrir no Excel.
- **WhatsApp**
  - Aba *WhatsApp* → **Gerar QR Code** → no celular: *WhatsApp › Configurações › Dispositivos
    conectados › Conectar um dispositivo*.
  - Com a conexão ativa, envie mensagens pelo modal de qualquer lead (botão WhatsApp na tabela).
  - Mensagens recebidas entram no histórico do lead do mesmo telefone; número novo vira lead em
    *Novo Lead* automaticamente (pode desligar na aba WhatsApp).
  - A sessão fica salva em `data/whatsapp-auth/` e reconecta sozinha quando o servidor reinicia.
- **Pedidos** (aba *Pedidos*)
  - **Produtos:** nome, código/SKU, unidade, preço, descrição; ativar/desativar.
  - **Condições de pagamento:** nome, número de parcelas e desconto (−) ou acréscimo (+) em %
    (ex.: PIX à vista −5%, Cartão 3x sem juros, Boleto 30/60/90 +3%).
  - **Pedido:** cliente (lead ou cliente sem cadastro), itens do catálogo ou avulsos, quantidade e
    preço, condição de pagamento, desconto, frete, observações. Totais e parcelas calculados na hora.
    Moeda acompanha o país do lead (Portugal = €).
  - **Status:** Orçamento → Confirmado → Em separação → Enviado → Entregue (ou Cancelado), mudado
    direto na lista; cada mudança fica no histórico do pedido.
  - Totais por status no topo, busca, e **enviar o resumo do pedido pelo WhatsApp** ao cliente.
  - Pedido guarda uma cópia do produto e da condição: mudar o cadastro depois não altera pedidos feitos.
  - Também dá para criar pedido a partir do lead (modal do lead) e da conversa (botão *+ Pedido*).
  - **Parcelas e recebimento:** a condição define o 1º vencimento e o intervalo; cada parcela é
    marcada como paga no próprio pedido. Situação do pagamento (Pendente, Parcial, Atrasado, Pago)
    na lista, com filtro.
  - **Estoque (opcional por produto):** baixa ao confirmar, devolve ao cancelar ou excluir, e avisa
    quando fica abaixo do mínimo.
  - **Vendedores e comissão:** cadastro com % de comissão; o pedido calcula a comissão e a aba
    *Vendedores* soma vendas e comissões de cada um.
  - **Imprimir / PDF:** página do pedido com os dados da empresa (⚙ Empresa), itens, parcelas e
    assinaturas — no navegador, *Imprimir › Salvar como PDF*.
  - **Pedido confirmado leva o lead para "Ganho"** (dá para desligar em ⚙ Empresa).
- **Painel de resultados** (aba *Painel*) — período de 7, 30, 90 dias, 12 meses ou tudo:
  - Leads novos, conversão, ganhos e quanto tempo levaram para fechar; vendas, ticket médio e
    valor recebido.
  - **Funil:** dos leads que entraram no período, quantos chegaram a cada etapa e quantos passaram
    de uma para a outra (o sistema guarda por onde cada lead passou).
  - **Vendas por mês** (12 meses), **origem dos leads** com a conversão de cada canal, **contas a
    receber** (atrasado, vence em 30 dias, depois), **vendedores** com comissão e **produtos mais
    vendidos**.
  - **Atendimento no WhatsApp:** tempo de resposta, % respondidas em até 5 minutos, fila agora,
    espera até a baixa e os horários em que os clientes mais escrevem.
  - Atualiza sozinho quando entra lead, pedido ou mensagem. Real e euro aparecem separados.
- **Conversas (caixa de entrada do WhatsApp)**
  - A aba *Conversas* mostra as conversas do seu WhatsApp (as recentes chegam quando você conecta;
    as novas entram na hora), com busca e filtros *Todas / Não lidas / Sem lead / Leads*.
  - Abra uma conversa para ler e responder (com respostas rápidas `/`).
  - **+ Adicionar como lead**: abre o cadastro já com nome, telefone e país; ao salvar, o histórico
    da conversa vai junto para o lead.
  - **Vincular a lead existente**: liga a conversa a um lead já cadastrado (útil quando o WhatsApp
    esconde o número do contato).
  - Conversa que já é lead mostra a etapa do funil — dá para mudar a etapa ali mesmo, e o Kanban
    acompanha. No lead, o link *Abrir em Conversas* leva direto ao chat.
  - **Fotos, vídeos, áudios (inclusive mensagens de voz), documentos e figurinhas** abrem dentro da
    conversa e no histórico do lead: foto ampliável, player de vídeo e de áudio, documento com
    *Abrir* e *Baixar*. O arquivo é baixado do WhatsApp na primeira vez que alguém abre e fica
    guardado em `data/midia/` (abre na hora das próximas vezes).
  - **Enviar anexos:** botão 📎 (ou arraste o arquivo para o chat), com legenda opcional — até 64 MB.
    JPG/PNG/WEBP vão como foto, MP4 como vídeo, OGG/MP3/M4A como áudio; o resto vai como documento.
  - Por segurança, só foto, vídeo, áudio e PDF abrem no navegador; qualquer outro arquivo é baixado.
  - Mídia antiga pode ter expirado no WhatsApp: com o celular conectado ele reenvia; se não der,
    aparece "Não foi possível abrir este arquivo — tentar de novo".
  - **Fila de atendimento** (filtro *Fila*): quem manda mensagem entra na fila **por ordem de
    chegada** (1º, 2º, 3º…, com "chegou há X min"). Ao terminar o atendimento, clique em
    **✓ Dar baixa**: a conversa sai da fila e segue normal em *Todas*. Se a pessoa mandar mensagem
    de novo, ela volta para o fim da fila. Dá para *Pôr na fila* à mão.
  - **Fixar contatos:** o 📌 no topo da conversa fixa o contato no alto da lista.
  - Grupos, status e canais não entram. Mensagens que você manda pelo celular também aparecem.
  - A criação automática de lead para todo número novo vem **desligada** (ligue em *WhatsApp* se quiser).
- **Respostas rápidas** — modelos de mensagem com atalho. No chat do lead, digite `/` (ex.: `/ola`)
  ou clique no atalho acima da caixa de texto. Aceitam variáveis: `{primeiro_nome}`, `{nome}`,
  `{empresa}`, `{cargo}`, `{cidade}`, `{etapa}`. Cadastre em *WhatsApp › Respostas rápidas*.
- **Follow-ups integrados ao Kanban**
  - **Regras por etapa:** "quando o lead entrar na etapa X, esperar N minutos/horas/dias e enviar esta
    mensagem — e, se quiser, mover o lead para a etapa Y". Crie em *WhatsApp › Follow-ups automáticos*
    ou pelo botão ⚡ no topo de cada coluna do Kanban.
  - Arrastar o lead para a etapa agenda os follow-ups dela; tirar o lead da etapa cancela os pendentes.
  - "Não enviar se o lead responder antes" cancela o envio quando chega mensagem do lead.
  - Com "mover para", uma regra empurra o lead pelo funil (ex.: *Proposta Enviada* → 7 dias sem
    resposta → *Sem interesse*), e a etapa nova pode ter as próprias regras, formando uma cadência.
  - **Follow-up manual:** no modal do lead, agende uma mensagem para uma data e hora.
  - O cartão do Kanban mostra o próximo follow-up ("Follow-up em 2 h"); a lista *Próximos envios*
    permite enviar agora ou cancelar.
  - **Janela de envio** (padrão 8h–21h, no fuso de `TZ`): fora dela os envios esperam. Os envios saem com
    pausa de 4–7 s entre um e outro.
  - Se o lead mandar só "PARAR", "SAIR", "STOP" ou "CANCELAR", ele é marcado como *Não contatar* e os
    follow-ups pendentes são cancelados. Também dá para marcar à mão no lead.
  - As regras de exemplo vêm **pausadas**: nada é enviado até você ativar uma regra.
  - Os follow-ups só saem com o WhatsApp conectado e o servidor ligado; enquanto isso eles esperam.

## Instalação fácil (sem digitar comandos)

1. Instale o **Node.js** (versão **LTS**) em <https://nodejs.org> — é só avançar até o fim.
2. Descompacte a pasta `controle-de-leads-2026` em um lugar fixo (ex.: Documentos).
3. Dê dois cliques em:
   - **Windows:** `INICIAR-WINDOWS.bat`
     (se aparecer "O Windows protegeu o computador", clique em *Mais informações › Executar assim mesmo*)
   - **Mac / Linux:** `iniciar-mac-linux.sh` (ou, no Terminal, `./iniciar-mac-linux.sh`)
4. Na primeira vez ele instala tudo sozinho e pede para você **criar uma senha** (use letras e números).
5. O navegador abre no sistema. Login: **qualquer nome de usuário** + a **sua senha**.
6. **Deixe a janela preta aberta** enquanto usa — fechá-la desliga o CRM e o WhatsApp.

Para trocar a senha, apague o arquivo `senha.txt` da pasta e inicie de novo.
Seus dados ficam na pasta `data/` (leads, conversas e os arquivos de mídia em `data/midia/`) — copie essa pasta para fazer backup.

## Como rodar (pelo terminal)

Requer Node.js 20 ou mais novo.

```bash
cd controle-de-leads-2026
npm install
APP_PASSWORD="uma-senha-forte" npm start
# abra http://localhost:3000  (usuário: qualquer um; senha: a de APP_PASSWORD)
```

### Na rede local (Wi-Fi / cabo)

O servidor aceita conexões de qualquer aparelho da mesma rede. Ao iniciar, ele mostra os endereços:

```
Controle de Leads 2026 rodando em http://localhost:3000
Na rede local: http://192.168.0.15:3000
```

Abra esse endereço `http://192.168.x.x:3000` no celular ou em outro computador conectado à mesma
rede. Se não abrir:

- **Windows:** na primeira execução, permita o Node.js no aviso do Firewall (marque "Redes privadas"),
  ou libere a porta 3000 em *Firewall do Windows › Configurações avançadas › Regras de entrada*.
- **Linux:** `sudo ufw allow 3000/tcp` (se o ufw estiver ativo).
- **macOS:** aceite "Permitir conexões de entrada" para o `node` quando o sistema perguntar.
- Confira se a rede do Wi-Fi não é de "convidados" (essas costumam isolar um aparelho do outro).
- Para o endereço não mudar, fixe o IP do computador no roteador (reserva de DHCP).

O computador que roda o servidor precisa ficar ligado; o WhatsApp conectado continua funcionando
enquanto o servidor estiver de pé. Mesmo em rede local, defina `APP_PASSWORD`.

### Com Docker (VPS)

```bash
cd controle-de-leads-2026
docker build -t controle-de-leads-2026 .
docker run -d --name leads --restart unless-stopped -p 3000:3000 \
  -e APP_PASSWORD="uma-senha-forte" -v leads-dados:/app/data controle-de-leads-2026
```

Coloque um proxy com HTTPS (Caddy, Nginx, Traefik) na frente se for expor na internet.

### Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `APP_PASSWORD` | *(vazia)* | Senha do painel (HTTP Basic). **Defina sempre que o servidor for acessível pela internet** — quem abre o painel controla o seu WhatsApp |
| `DATA_DIR` | `./data` | Onde ficam `leads.json` e a sessão do WhatsApp |
| `TZ` | `America/Sao_Paulo` | Fuso usado no carimbo das notas rápidas |
| `WA_LOG_LEVEL` | `silent` | Log da biblioteca do WhatsApp (`info`, `debug`) |
| `WA_SIMULADO` | *(vazia)* | `1` = modo demonstração: WhatsApp de mentira com conversas de exemplo, dados em `data-demonstracao/` |

## Versão

A versão e a data dela aparecem no canto superior direito (ex.: `v1.4.0 · 24/10/2026`). Elas vêm
dos campos `version` e `dataVersao` do `package.json`.

## WhatsApp não carrega as mensagens? (passo a passo)

1. Abra a aba **WhatsApp › Diagnóstico da sincronização**. Ele mostra quantas conversas e mensagens
   o celular mandou, quantas não puderam ser lidas e o último erro.
2. **Conversas antigas não aparecem** ("Lotes de histórico recebidos" = 0): o WhatsApp só manda o
   histórico **na hora em que o aparelho é conectado**. Clique em **Desconectar**, gere o QR Code e
   leia de novo. (Quem conectou numa versão antiga do sistema precisa fazer isso uma vez.)
3. **Uma conversa mostra só as últimas mensagens**: dentro dela, use **↑ Carregar mensagens
   anteriores** (o celular manda em lotes; precisa estar com internet).
4. **"Mensagens que não puderam ser lidas"**: logo depois de conectar, algumas são normais — o
   sistema pede ao remetente que reenvie e elas entram como "recuperadas". Se o número só aumentar
   por mais de 10 minutos, desconecte e leia o QR Code de novo.
   Desde a v1.4.2 o sistema reconhece sessões criadas pela versão antiga (que causam esse erro) e
   pede um QR Code novo automaticamente. Depois de ler, apague no celular, em *Dispositivos
   conectados*, a conexão antiga do "Controle de Leads 2026" que ficar sobrando.
5. Mande o arquivo `data/whatsapp.log` para quem dá suporte — ele tem o registro técnico.

Desde a versão 1.4.1 o sistema usa a Baileys 7, que entende os contatos com **número oculto
(LID)** — o formato que o WhatsApp passou a usar em muitas conversas. A mesma pessoa não aparece mais
em duas conversas: quando o WhatsApp revela o número, as conversas são juntadas.

Para conferir a lógica sem celular: `npm test`.

## Como funciona

- `server.mjs` — Express: API REST (`/api/leads`, `/api/whatsapp`, `/api/config`), eventos em tempo
  real (`/api/eventos`, Server-Sent Events) e o frontend estático.
- `store.mjs` — leads e configurações em `data/leads.json` (escrita atômica) + validação dos campos.
- `followups.mjs` — agenda de follow-ups (regras por etapa + manuais) e o laço que envia os vencidos a cada 30 s.
- `pedidos.mjs` — produtos, condições de pagamento e pedidos em `data/pedidos.json`.
- `conversas.mjs` — caixa de entrada: conversas e últimas mensagens em `data/conversas.json`.
- `whatsapp-simulado.mjs` — modo demonstração (`WA_SIMULADO=1`), sem celular.
- `whatsapp.mjs` — conexão WhatsApp Web multi-dispositivo via [Baileys](https://github.com/WhiskeySockets/Baileys),
  com login por QR Code e reconexão automática.
- `public/` — HTML, CSS e JavaScript puro (sem etapa de build).

Na primeira execução o app cria 8 leads de exemplo para você ver as telas; apague-os à vontade.

> **Aviso:** a conexão usa o protocolo do WhatsApp Web (não é a API oficial do WhatsApp Business).
> Use com bom senso — envio em massa ou para quem não pediu contato pode levar ao bloqueio do número.
