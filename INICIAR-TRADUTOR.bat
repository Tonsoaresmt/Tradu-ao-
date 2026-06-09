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
REM ===== Modelo de traducao =====
REM qwen3.5:9b = QUALIDADE (testado: acerta 'Voce esta no ar em cinco', 'casa
REM cheia', 'passou pela sede'). O 4b e rapido mas ERRA muito ('vem a cha',
REM 'full house') -> nao vale. Na sua GPU de 8GB nao tem rapido+bom local; o 9b
REM e o caminho da qualidade. ~12-17s/pagina (aceitavel p/ revisar).
set "OLLAMA_TRANSLATOR_MODEL=qwen3.5:9b"
set "OLLAMA_REVIEWER_MODEL=qwen3.5:9b"
REM Contexto (tokens). 8192 e suficiente p/ pagina+glossario+exemplos+personagens.
set "OLLAMA_NUM_CTX=8192"

REM ===== Detector na CPU (libera a GPU pro 9b) =====
REM Como o 9b (6.6GB) e o detector nao cabem juntos nos 8GB, o detector roda na
REM CPU e o 9b fica 100%% na GPU = traducao o mais rapido possivel.
set "DETECTOR_GPU=0"
REM Se um dia quiser VELOCIDADE em vez de qualidade (aceitando erros), troque o
REM modelo acima por qwen3.5:4b e comente a linha DETECTOR_GPU (4b cabe na GPU).
REM Para SEM IA (so Google, rapido/literal): set "TRANSLATOR_PROVIDER=google"

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
