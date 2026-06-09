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
REM ===== Modelos: TRADUTOR (rapido) + REVISOR (inteligente) =====
REM Tradutor = qwen3.5:4b: rapido, roda 100%% na GPU JUNTO com o detector. Faz a
REM traducao automatica de todas as paginas (o grosso).
set "OLLAMA_TRANSLATOR_MODEL=qwen3.5:4b"
REM Revisor = qwen3.5:9b: mais inteligente, usado SO no botao "Revisar (9b)" (sob
REM demanda). Ao revisar, o Ollama troca de modelo (carrega o 9b) -> demora, normal.
set "OLLAMA_REVIEWER_MODEL=qwen3.5:9b"
REM Contexto (tokens). 8192 e suficiente p/ pagina+glossario+exemplos+personagens.
set "OLLAMA_NUM_CTX=8192"

REM ===== Detector na GPU (padrao) =====
REM Com o tradutor 4b (leve), o detector cabe JUNTO na GPU = tudo rapido. Deixe
REM assim. (So valeria DETECTOR_GPU=0 se voce trocasse o tradutor padrao pro 9b.)
REM set "DETECTOR_GPU=0"
REM Para priorizar VELOCIDADE (sem IA), troque a 1a linha por:
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
