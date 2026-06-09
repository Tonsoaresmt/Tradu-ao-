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
REM qwen3.5:9b = MAIOR qualidade (testado: acerta mais expressoes). Como sua GPU
REM tem 8GB e o detector tambem usa a GPU, ~58%% do 9b roda na CPU -> mais LENTO
REM (~10-15s/pagina vs ~3-6s do 4b). Se quiser VELOCIDADE, comente esta linha
REM (volta pro qwen3.5:4b, todo na GPU). Dica: posso fazer o detector rodar na CPU
REM pra o 9b caber 100%% na GPU (ai o 9b fica rapido) - peca se quiser.
set "OLLAMA_TRANSLATOR_MODEL=qwen3.5:9b"
REM Contexto (tokens). 8192 e suficiente p/ pagina+glossario+exemplos+personagens.
REM Nao suba muito com o 9b: contexto grande nessa GPU de 8GB deixa MUITO mais lento.
set "OLLAMA_NUM_CTX=8192"

REM ===== Detector na CPU (libera a GPU pro 9b) =====
REM Sua GPU tem 8GB e NAO cabe o 9b + o detector juntos. Com DETECTOR_GPU=0 o
REM detector roda na CPU (~8s/pagina na deteccao) e o 9b fica 100%% na GPU (rapido).
REM No total ~14s/pagina. Honestidade: o 9b e LENTO nessa GPU de qualquer jeito.
REM >> Para VELOCIDADE: comente a linha do qwen3.5:9b acima E esta linha aqui:
REM    ai roda o qwen3.5:4b + detector juntos na GPU = ~5s/pagina (qualidade um
REM    pouco menor, mas muito mais rapido).
set "DETECTOR_GPU=0"
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
