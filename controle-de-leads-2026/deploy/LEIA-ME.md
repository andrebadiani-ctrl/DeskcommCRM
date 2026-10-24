# Acessar de qualquer lugar (VPS com HTTPS)

Com o sistema numa VPS (um servidor alugado na internet), você e a equipe abrem o Controle de Leads
pelo celular ou computador de qualquer lugar, em `https://leads.suaempresa.com.br`, com cadeado
(HTTPS). O certificado é gratuito (Let's Encrypt) e renovado sozinho.

Em HTTPS também passam a funcionar **gravar áudio** no chat e **instalar o app** no celular e no
computador — o navegador só libera esses recursos em endereço seguro.

## O que você precisa

1. **Uma VPS com Ubuntu 22.04 ou 24.04** — 1 GB de memória funciona; 2 GB é mais folgado.
   Qualquer provedor serve (HostGator, Hostinger, Locaweb, DigitalOcean, Contabo…). Anote o
   **IP** da VPS e a senha de acesso (root).
2. **Um domínio ou subdomínio** — por exemplo `leads.suaempresa.com.br`. No painel de DNS do
   domínio (onde você comprou o domínio, ou na Cloudflare), crie um registro:

   | Tipo | Nome | Valor |
   |---|---|---|
   | `A` | `leads` | o IP da VPS |

   Na Cloudflare, deixe a nuvem **cinza** ("somente DNS") nesse registro. A mudança de DNS pode
   levar de alguns minutos a algumas horas para valer.

## Instalação (uma vez)

1. Entre na VPS pelo terminal (no Windows: PowerShell; no Mac: Terminal):

   ```bash
   ssh root@IP-DA-VPS
   ```

2. Leve o sistema para a VPS. Pelo GitHub:

   ```bash
   git clone <endereço do repositório> && cd DeskcommCRM/controle-de-leads-2026/deploy
   ```

   Ou pelo arquivo `.zip`: no **seu computador**, envie o zip e depois descompacte na VPS:

   ```bash
   scp controle-de-leads-2026.zip root@IP-DA-VPS:/root/    # no seu computador
   apt-get install -y unzip && unzip controle-de-leads-2026.zip && cd controle-de-leads-2026/deploy   # na VPS
   ```

3. Rode o instalador:

   ```bash
   sudo ./instalar-vps.sh
   ```

   Ele instala o Docker se faltar, pergunta o domínio, a senha de acesso (ou gera uma) e,
   opcionalmente, a chave da IA; libera as portas 80 e 443 no firewall e sobe tudo. No fim mostra o
   endereço e a senha. **Anote a senha** (ela também fica no arquivo `deploy/.env`).

4. Abra `https://seu-dominio`, entre (usuário: qualquer um; senha: a do passo 3) e conecte o
   WhatsApp na aba **WhatsApp** lendo o QR Code.

> Se o seu provedor tem um firewall no painel (Security Group, "Firewall da nuvem"), libere lá
> também as portas **80** e **443**.

## Levar os dados do seu computador para a VPS

Leads, pedidos, conversas e a sessão do WhatsApp ficam na pasta `data` do sistema no seu computador.

1. **Feche o sistema no computador** (o mesmo WhatsApp não deve ficar ligado em dois lugares).
2. Envie a pasta (no seu computador, dentro da pasta `controle-de-leads-2026`):

   ```bash
   scp -r data root@IP-DA-VPS:/root/dados-do-computador
   ```

3. Na VPS, dentro de `deploy`:

   ```bash
   cp -a /root/dados-do-computador/. dados/ && chown -R 1000:1000 dados && docker compose restart app
   ```

## Atualizar para uma versão nova

Traga os arquivos novos (`git pull`, ou um zip novo por cima, sem apagar `deploy/.env` nem
`deploy/dados`) e rode de novo:

```bash
sudo ./instalar-vps.sh
```

Ele mantém a configuração e os dados e só reconstrói o sistema.

## Cópia de segurança

Tudo o que importa está em `deploy/dados` (e a configuração em `deploy/.env`). Para guardar uma
cópia com data:

```bash
tar -czf backup-leads-$(date +%F).tar.gz dados .env
```

Baixe esse arquivo para o seu computador de vez em quando (`scp root@IP-DA-VPS:/root/.../deploy/backup-*.tar.gz .`).

## Comandos úteis (dentro de `deploy`)

| Para | Comando |
|---|---|
| Ver se está rodando | `docker compose ps` |
| Ver os registros do sistema | `docker compose logs -f app` |
| Ver os registros do HTTPS (certificado) | `docker compose logs caddy` |
| Reiniciar | `docker compose restart` |
| Parar | `docker compose down` (os dados ficam) |
| Trocar a senha | edite `APP_PASSWORD` no `.env` e rode `docker compose up -d` |

## Problemas comuns

- **O endereço não abre / "conexão não é segura"** — quase sempre é o DNS: confira se o registro
  `A` aponta para o IP da VPS (`ping seu-dominio` mostra o IP) e se as portas 80 e 443 estão
  liberadas. Depois de corrigir, o certificado sai sozinho em até um minuto
  (`docker compose logs caddy` mostra o andamento).
- **Pede senha toda hora no celular** — é o navegador; marque "lembrar" ao entrar.
- **Erro de permissão em `dados`** — rode `chown -R 1000:1000 dados && docker compose restart app`.

## Sem VPS: abrir o computador de casa para a internet

Se o sistema roda num computador que fica ligado, dá para publicá-lo com HTTPS sem VPS usando o
**Cloudflare Tunnel** (gratuito; precisa de um domínio na Cloudflare). Defina `APP_PASSWORD` antes,
instale o `cloudflared` e siga o guia "Create a tunnel" da Cloudflare apontando para
`http://localhost:3000`. O computador precisa ficar ligado para o sistema funcionar.
