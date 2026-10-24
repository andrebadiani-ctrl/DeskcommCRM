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

## Como rodar

Requer Node.js 20 ou mais novo.

```bash
cd controle-de-leads-2026
npm install
APP_PASSWORD="uma-senha-forte" npm start
# abra http://localhost:3000  (usuário: qualquer um; senha: a de APP_PASSWORD)
```

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

## Como funciona

- `server.mjs` — Express: API REST (`/api/leads`, `/api/whatsapp`, `/api/config`), eventos em tempo
  real (`/api/eventos`, Server-Sent Events) e o frontend estático.
- `store.mjs` — leads e configurações em `data/leads.json` (escrita atômica) + validação dos campos.
- `whatsapp.mjs` — conexão WhatsApp Web multi-dispositivo via [Baileys](https://github.com/WhiskeySockets/Baileys),
  com login por QR Code e reconexão automática.
- `public/` — HTML, CSS e JavaScript puro (sem etapa de build).

Na primeira execução o app cria 8 leads de exemplo para você ver as telas; apague-os à vontade.

> **Aviso:** a conexão usa o protocolo do WhatsApp Web (não é a API oficial do WhatsApp Business).
> Use com bom senso — envio em massa ou para quem não pediu contato pode levar ao bloqueio do número.
