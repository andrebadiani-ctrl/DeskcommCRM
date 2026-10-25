#!/usr/bin/env bash
# Controle de Leads 2026 — instala (na primeira vez) e inicia o sistema.
cd "$(dirname "$0")" || exit 1

echo
echo "  Controle de Leads 2026"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  O Node.js não está instalado. Baixe a versão LTS em https://nodejs.org e rode este arquivo de novo."
  exit 1
fi

# Instala na primeira vez e de novo sempre que uma atualização trouxer dependências novas
# (o package-lock.json mudou desde a última instalação).
if [ ! -d node_modules/express ] || ! cmp -s package-lock.json node_modules/.instalado-com.json; then
  echo "  Instalando/atualizando o sistema (pode levar 1 ou 2 minutos)..."
  npm install --omit=dev --no-audit --no-fund || { echo "  Não foi possível instalar. Confira a internet."; exit 1; }
  cp package-lock.json node_modules/.instalado-com.json
fi

if [ ! -s senha.txt ]; then
  echo "  Crie uma senha para entrar no painel (protege seus leads e o seu WhatsApp)."
  while [ -z "$NOVASENHA" ]; do read -r -s -p "  Senha: " NOVASENHA; echo; done
  printf '%s\n' "$NOVASENHA" > senha.txt
  chmod 600 senha.txt
fi

APP_PASSWORD="$(head -n1 senha.txt)" ABRIR_NAVEGADOR=1 exec node server.mjs
