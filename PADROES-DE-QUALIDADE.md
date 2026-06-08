# Padrões de qualidade — tradução PT-BR de mangá

Derivado das referências profissionais (Chainsaw Man EN + PT-BR) enviadas pelo Everton.
Princípio guia: **isto é uma TRADUÇÃO e portabilidade para PT-BR, não uma remodelagem.**
Mantemos o original fiel ao máximo; só trocamos o texto e o adaptamos. **Nunca remover
recursos do mangá original.**

Estes parâmetros guiam tanto a TRADUÇÃO (Ollama tradutor/revisor) quanto o RENDER
(typeset) e a VERIFICAÇÃO automática (QC) que aprova/reprova cada balão.

---

## 1. Tradução (o Ollama age como tradutor E revisor)

1. **PT-BR natural e fluente** — localizar, não traduzir ao pé da letra quando soar
   robótico. É diálogo falado, registro coloquial — não texto formal.
2. **Fidelidade ao SENTIDO e ao TOM**, não às palavras: preservar humor, ironia,
   sarcasmo, raiva, ternura.
3. **Concisão que cabe no balão** — espaço é limitado. Se a tradução literal ficar
   longa, encurtar mantendo o sentido (mangá usa frases curtas).
4. **Gírias/expressões** — adaptar para o equivalente brasileiro quando soar natural;
   manter literal quando for nome, termo técnico ou ataque.
5. **Preservar**: nomes próprios, nomes de técnicas/ataques, honoríficos quando fizer
   sentido, e **SFX/onomatopeias** (não traduzir o desenho do efeito; no máximo glosar).
6. **Corrigir erros óbvios de OCR** antes de traduzir (usar o contexto das falas vizinhas).
7. **Consistência** — mesmo personagem/termo traduzido igual ao longo do capítulo
   (memória/glossário por obra).

## 2. Lettering (como o texto é desenhado no balão)

1. **CAIXA ALTA** (padrão de scan).
2. **Centralizado** nos dois eixos (horizontal e vertical).
3. **Formato OVAL** — a quebra de linha segue o formato do balão: linhas curtas no
   topo e na base, largas no meio (texto inscrito na elipse do balão). NUNCA um bloco
   retangular que bate nas laterais.
4. **Margem confortável** até a borda (texto ocupa ~60–70% do balão; nunca encosta).
5. **Fonte de quadrinho com acentos PT-BR corretos** (Ê Ã Ç É ... corretos).
6. **Hifenização** para equilibrar linhas, só em último recurso.
7. **Fonte se ajusta** para caber; respeita um mínimo legível. Tamanho coerente entre
   balões próximos.

## 3. Design / Fidelidade ao original (crucial)

1. **Contorno preto do balão é PRESERVADO** — é o que delimita a fala e a diferencia
   do cenário e da narração. Nunca apagar.
2. **Arte que INVADE o balão é preservada** — se o rosto/cabelo de um personagem entra
   no balão (o balão está atrás dele), isso fica. Não encher de branco por cima.
3. **Profundidade/camadas** — o balão pode estar atrás de elementos da cena; não cobrir
   o que no original está na frente do balão.
4. **SFX / onomatopeia** — preservar a arte original do efeito; no máximo uma glosa
   pequena ao lado. Não apagar nem redesenhar o SFX.
5. **Narração (caixa retangular)** ≠ **fala (balão oval)** — tratamentos diferentes.
6. **Não inventar** elementos que não existem no original.

## 4. Verificação (QC) — reprova e toma medidas

Depois de traduzir/renderizar, cada balão é conferido. Se não estiver no padrão,
**reprova** e tenta consertar; o que não der, aponta para o humano revisar.

- **Geométrico (automático, no render):** texto cabe no balão, centralizado, com
  margem, no formato oval, sem transbordar, sem cobrir arte. Medidas automáticas:
  diminuir a fonte → refazer a quebra → hifenizar.
- **Tradução (Ollama-revisor):** se mesmo na menor fonte legível o texto não cabe →
  **encurtar/adaptar** a tradução mantendo o sentido. Se soar robótico → **localizar**.
  Apontar o balão, o problema e o que foi mudado.
- **Design:** se o balão cobriria arte do original, ou perdeu o contorno → reprova.

---

### Resumo operacional
Fiel ao original (arte, contorno, camadas, SFX) • PT-BR natural e conciso • CAIXA ALTA,
oval, centralizado, com margem • fonte com acento • QC aprova/reprova e conserta.
