@echo off
chcp 65001 >nul
title Controle de Leads 2026
cd /d "%~dp0"

echo.
echo  ==========================================
echo     Controle de Leads 2026
echo  ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto semnode

rem Instala na primeira vez e de novo sempre que uma atualizacao trouxer dependencias novas
rem (o package-lock.json mudou desde a ultima instalacao).
if not exist node_modules\express goto instalar
if not exist node_modules\.instalado-com.json goto instalar
fc /b package-lock.json node_modules\.instalado-com.json >nul 2>nul
if errorlevel 1 goto instalar
goto senha

:instalar
echo  Instalando/atualizando o sistema (pode levar 1 ou 2 minutos)...
echo.
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto erroinstalar
copy /y package-lock.json node_modules\.instalado-com.json >nul

:senha
if exist senha.txt goto iniciar
echo.
echo  Crie uma senha para entrar no painel.
echo  (ela protege seus leads e o seu WhatsApp)
echo.
set /p NOVASENHA=  Digite a senha e aperte Enter: 
if "%NOVASENHA%"=="" goto senha
> senha.txt echo %NOVASENHA%
echo.
echo  Senha salva no arquivo senha.txt desta pasta.

:iniciar
set /p APP_PASSWORD=<senha.txt
set ABRIR_NAVEGADOR=1
echo.
echo  Abrindo o sistema no navegador...
echo  Login: qualquer nome de usuario + a sua senha.
echo.
echo  NAO FECHE ESTA JANELA enquanto estiver usando o sistema.
echo  (fechar esta janela desliga o CRM e o WhatsApp)
echo.
node server.mjs
echo.
echo  O sistema foi desligado.
pause
exit /b

:semnode
echo  O Node.js nao esta instalado neste computador.
echo.
echo  1. Vai abrir o site do Node.js. Baixe a versao "LTS" e instale
echo     (pode clicar em Avancar/Next em tudo).
echo  2. Depois de instalar, clique de novo neste arquivo.
echo.
start "" https://nodejs.org/pt/download
pause
exit /b 1

:erroinstalar
echo.
echo  Nao foi possivel instalar. Confira a internet e tente de novo.
pause
exit /b 1
