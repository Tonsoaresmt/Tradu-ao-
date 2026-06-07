Esta pasta guarda o treino local do tradutor.

Arquivos:
- exemplos.jsonl: criado automaticamente quando voce salva traducoes revisadas.
- glossario.json: termos fixos que a IA local deve respeitar.
- estilo.txt: regras de estilo para sugestoes de traducao.

Fluxo:
1. Detecte ou marque uma fala.
2. Corrija o texto original, se necessario.
3. Escreva a traducao final em PT-BR.
4. Salve o projeto.
5. O sistema adiciona a fala revisada em exemplos.jsonl.

Com Ollama rodando, esses exemplos entram no prompt como memoria de treino.
