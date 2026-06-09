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
REM ===== Modelo do Ollama =====
REM Detectado sozinho (hoje: qwen3.5:4b). Os tags qwen3.5:8b / qwen3:8b NAO
REM existem no registro do seu Ollama. Para usar um modelo MAIOR (mais qualidade),
REM baixe um que exista, ex.:  ollama pull qwen2.5:7b
REM e descomente a linha abaixo. AVISO: sua GPU tem 8GB e o detector tambem usa a
REM GPU; um 7b/8b pode cair parte na CPU (mais LENTO). O 4b e o ponto ideal aqui.
REM set "OLLAMA_TRANSLATOR_MODEL=qwen2.5:7b"
REM Contexto do Ollama (tokens). Maior = cabe mais glossario/exemplos/personagens.
set "OLLAMA_NUM_CTX=32768"
REM Para priorizar VELOCIDADE em vez de qualidade, troque a 1a linha por:
REM set "TRANSLATOR_PROVIDER=google"

REM ===== Encerra instancias ANTIGAS (servidor + detector) =====
REM Sem isso, se um servidor velho continuar rodando, o navegador segue vendo o
REM codigo antigo (porta 3210 ocupada) e o detector velho e reusado. Aqui matamos
REM qualquer node do translator-server e qualquer python do detector/service.py.
echo Encerrando instancias antigas (se houver)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'translator-server\.js|detector.+service\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
REM da um instante pra liberar as portas 3210/5000
powershell -NoProfile -Command "Start-Sleep -Milliseconds 800"

REM Abre o navegador depois de 4s, em segundo plano, sem travar o servidor.
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:3210'"

REM Sobe o servidor (fica rodando nesta janela).
node translator-server.js

echo.
echo Servico encerrado.
pause
