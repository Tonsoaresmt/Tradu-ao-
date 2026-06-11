// Heuristicas de "traducao parece cortada" compartilhadas entre o servidor
// (filtro de memoria/few-shot) e o editor (badge de aviso nos chips de fala).

export const SENTENCE_END_RE = /[.!?…]["'”’)\]]*$/;

// Palavras curtas (1-2 letras) que SAO uma fala/palavra completa em PT-BR e
// podem legitimamente terminar uma frase sem pontuacao (OCR sem "!"/"."). Fora
// dessa lista, uma ultima "palavra" de 1-2 letras costuma ser um PEDACO de
// palavra maior cortado no meio (ex.: "MO" de "MONSTROS").
export const SHORT_WORD_WHITELIST = new Set([
  "de", "da", "do", "um", "uma", "uns", "umas", "eu", "tu", "ja", "ai", "la",
  "ta", "to", "no", "na", "ou", "se", "te", "me", "lhe", "sim", "nao", "ah",
  "oh", "eh", "ui", "uh", "oi", "ei", "vc", "e", "a", "o", "ok"
]);

// Detecta traducao que termina NO MEIO DE UMA PALAVRA: sem pontuacao final e a
// ultima "palavra" e um pedaco curto que normalmente nao existe sozinho em
// PT-BR (ex.: "...UM GRUPO DE MO"). Frases muito curtas (<3 palavras, tipo
// interjeicoes "OPA!", "TA") sao ignoradas p/ nao dar falso positivo.
export function endsMidWord(translated) {
  const trans = String(translated || "").trim();
  if (!trans || SENTENCE_END_RE.test(trans)) return false;
  if (trans.split(/\s+/).length < 3) return false;
  const lastWord = trans.match(/(\p{L}+)$/u)?.[1] || "";
  if (!lastWord || lastWord.length > 2) return false;
  return !SHORT_WORD_WHITELIST.has(lastWord.toLowerCase());
}

// Detecta FRASE CORTADA: a IA "nao entendeu o final da frase" e devolveu so um
// pedaco, seja porque (1) o ORIGINAL termina com pontuacao final (.!?...) mas
// a traducao nao, ou (2) a propria traducao tentou "completar" o pensamento
// (ex.: a partir de um original ja cortado pelo OCR, "...a bunch of") e a
// geracao parou no meio de uma palavra ("...UM GRUPO DE MO").
export function looksTruncated(original, translated) {
  const orig = String(original || "").trim();
  const trans = String(translated || "").trim();
  if (!orig || !trans) return false;

  if (SENTENCE_END_RE.test(orig) && !SENTENCE_END_RE.test(trans)) {
    const lastWord = trans.match(/(\p{L}+)$/u)?.[1] || "";
    if (lastWord.length > 0 && lastWord.length <= 2) return true;
  }

  return endsMidWord(trans);
}
