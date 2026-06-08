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

REM ===== Velocidade x qualidade da traducao automatica =====
REM   google = RAPIDO (recomendado: abre e ja traduz em segundos)
REM   ollama = mais qualidade, porem LENTO balao a balao (precisa do Ollama rodando)
set "TRANSLATOR_PROVIDER=google"
REM Para usar a IA local (qualidade), comente a linha acima e descomente as 2 abaixo:
REM set "TRANSLATOR_PROVIDER=ollama"
REM set "OLLAMA_TRANSLATOR_MODEL=qwen3:8b"

REM Abre o navegador depois de 3s, em segundo plano, sem travar o servidor.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3210'"

REM Sobe o servidor (fica rodando nesta janela).
node translator-server.js

echo.
echo Servico encerrado.
pause
