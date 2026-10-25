#!/usr/bin/env bash
# Instala o Controle de Leads 2026 numa VPS Ubuntu (22.04 ou 24.04) com HTTPS automático.
# Uso, dentro da pasta deploy:   sudo ./instalar-vps.sh
# Pode rodar de novo a qualquer momento: mantém o .env e os dados, e atualiza o sistema.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode como administrador:  sudo ./instalar-vps.sh"
  exit 1
fi

passo() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }

# 1) Docker
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  passo "Instalando o Docker"
  apt-get update -y
  if ! apt-get install -y docker.io docker-compose-v2; then
    echo "Não deu para instalar pelo apt. Instale o Docker seguindo https://docs.docker.com/engine/install/ubuntu/ e rode este script de novo."
    exit 1
  fi
  systemctl enable --now docker
fi

# 2) Configuração (.env) — só pergunta na primeira vez
if [ ! -f .env ]; then
  passo "Configuração"
  read -rp "Domínio do sistema (ex.: leads.suaempresa.com.br): " DOMINIO
  DOMINIO="${DOMINIO#http://}"; DOMINIO="${DOMINIO#https://}"; DOMINIO="${DOMINIO%%/*}"
  if ! [[ "$DOMINIO" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    echo "Domínio inválido: '$DOMINIO'"
    exit 1
  fi
  read -rsp "Senha para entrar no sistema (Enter para gerar uma): " SENHA; echo
  if [[ "$SENHA" == *"'"* ]]; then
    echo "A senha não pode ter aspas simples ('). Rode de novo e escolha outra."
    exit 1
  fi
  if [ -z "$SENHA" ]; then
    SENHA="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
    SENHA_GERADA=1
  fi
  read -rp "Chave da API da Anthropic para o assistente de IA (opcional, Enter para pular): " CHAVE
  umask 077
  # Entre aspas simples: o Docker Compose não troca "$" dentro delas.
  cat > .env <<CONF
DOMINIO='$DOMINIO'
APP_PASSWORD='$SENHA'
TZ='America/Sao_Paulo'
ANTHROPIC_API_KEY='${CHAVE//\'/}'
CONF
fi
# Lê os valores sem interpretar (a senha pode ter $, espaço ou aspas).
valor() { grep -m1 "^$1=" .env | cut -d= -f2- | sed "s/^'\(.*\)'\$/\1/"; }
DOMINIO="$(valor DOMINIO)"
APP_PASSWORD="$(valor APP_PASSWORD)"

# 3) O domínio aponta para esta máquina? (sem isso o certificado não sai)
IP_PUBLICO="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
IP_DOMINIO="$(getent ahostsv4 "$DOMINIO" | awk 'NR==1 {print $1}' || true)"
if [ -n "$IP_PUBLICO" ] && [ "$IP_DOMINIO" != "$IP_PUBLICO" ]; then
  echo
  echo "ATENÇÃO: $DOMINIO aponta para '${IP_DOMINIO:-nenhum IP}', mas esta VPS é $IP_PUBLICO."
  echo "Crie (ou corrija) um registro A no DNS do domínio apontando para $IP_PUBLICO."
  echo "O sistema sobe assim mesmo; o HTTPS começa a funcionar sozinho quando o DNS estiver certo."
fi

# 4) Pasta dos dados (do usuário 1000, o mesmo do app dentro do contêiner)
mkdir -p dados
chown -R 1000:1000 dados

# 5) Firewall
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  passo "Liberando as portas 80 e 443 no firewall"
  ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
fi

# 6) Sobe (ou atualiza) tudo
passo "Construindo e iniciando o sistema (a primeira vez leva alguns minutos)"
docker compose up -d --build

passo "Aguardando o HTTPS ficar pronto"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 5 -u "x:$APP_PASSWORD" "https://$DOMINIO/api/versao"; then
    PRONTO=1
    break
  fi
  sleep 5
done

echo
if [ "${PRONTO:-}" = 1 ]; then
  echo "Pronto! Abra https://$DOMINIO"
else
  echo "O sistema subiu, mas o HTTPS ainda não respondeu. Confira o DNS do domínio e veja os"
  echo "registros com:  docker compose logs caddy"
fi
echo "Usuário: qualquer um · Senha: $APP_PASSWORD"
if [ "${SENHA_GERADA:-}" = 1 ]; then echo "(senha gerada agora — anote; ela também fica no arquivo deploy/.env)"; fi
echo "Depois, conecte o WhatsApp na aba WhatsApp lendo o QR Code com o celular."
