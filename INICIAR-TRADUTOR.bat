@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Tradutor de Manga - servidor
echo ============================================================
echo   TRADUTOR DE MANGA
echo.
echo   - O navegador vai abrir sozinho em alguns segundos.
echo   - NAO FECHE esta janela enquanto estiver traduzindo.
echo     (fechar esta janela = encerrar o servico)
echo   - Seu trabalho salva sozinho a cada ~10s e ao fechar a aba.
echo ============================================================
echo.

REM ===== Qualidade x velocidade da traducao automatica =====
REM   auto  = usa o Ollama (IA local, melhor qualidade) e, se ele nao estiver
REM           rodando, cai sozinho no Google. Traduz a PAGINA INTEIRA numa
REM           unica chamada (rapido). << RECOMENDADO
REM   google = sempre Google: mais rapido, porem mais literal/robotico.
REM   ollama = forca so a IA local (sem fallback).
set "TRANSLATOR_PROVIDER=auto"
REM O modelo do Ollama e detectado sozinho (usa o que voce tiver instalado).
REM Para fixar um modelo especifico, descomente e ajuste:
REM set "OLLAMA_TRANSLATOR_MODEL=qwen3.5:4b"
REM Para priorizar VELOCIDADE em vez de qualidade, troque a 1a linha por:
REM set "TRANSLATOR_PROVIDER=google"

REM Abre o navegador depois de 3s, em segundo plano, sem travar o servidor.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3210'"

REM Sobe o servidor (fica rodando nesta janela).
node translator-server.js

echo.
echo Servico encerrado.
pause
