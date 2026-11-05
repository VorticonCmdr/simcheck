const ENGLISH = new Set(
  "the of and to in a is that for it with as on was be are this by at from have or an not you but they his her which".split(" "),
);

/**
 * Whether texts look like a language other than English, going by how few English
 * function words they hold. Those make up well over a tenth of English text, also in
 * headlines. False when there are too few words to tell, as with ids or numbers.
 */
export function looksNonEnglish(texts: string[]): boolean {
  const words = texts.join(" ").toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 50) return false;
  return words.filter((word) => ENGLISH.has(word)).length / words.length < 0.08;
}
