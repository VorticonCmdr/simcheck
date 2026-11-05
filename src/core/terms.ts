const STOPWORDS = new Set(
  `a about after all also an and any are as at be because been but by can could did do does for from had has have he her his how i if in into is it its just like more most my no not of on one or other our out over she so some such than that the their them then there these they this to too up us was we were what when which who will with would you your
  aber als am an auch auf aus bei bin bis da das dass dem den der des die doch du durch ein eine einem einen einer eines er es für hat hatte ich ihr im in ist ja kann mit nach nicht noch nur oder sich sie sind so über um und uns vom von vor war was wenn werden wie wir wird zu zum zur`.split(/\s+/),
);

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/\p{L}[\p{L}\p{N}'-]+/gu) ?? [];
  return words.filter((word) => !STOPWORDS.has(word));
}

/**
 * The terms that set each cluster apart, scored by c-TF-IDF: each cluster counts
 * as one document, and a word loses weight with its total frequency across all of
 * them, so a word that's common everywhere ranks below rarer, distinctive ones.
 */
export function topTerms(
  texts: string[],
  labels: ArrayLike<number>,
  clusterCount: number,
  perCluster = 5,
): string[][] {
  const counts = Array.from({ length: clusterCount }, () => new Map<string, number>());
  texts.forEach((text, i) => {
    const label = labels[i];
    if (label < 0 || label >= clusterCount) return;
    for (const word of tokenize(text)) {
      counts[label].set(word, (counts[label].get(word) ?? 0) + 1);
    }
  });

  const frequency = new Map<string, number>();
  const clusterWords = counts.map((cluster) => {
    let total = 0;
    for (const [word, count] of cluster) {
      frequency.set(word, (frequency.get(word) ?? 0) + count);
      total += count;
    }
    return total;
  });
  const averageWords = clusterWords.reduce((sum, total) => sum + total, 0) / Math.max(1, clusterCount);

  return counts.map((cluster, id) =>
    [...cluster.entries()]
      .map(([word, count]) => ({
        word,
        score: (count / clusterWords[id]) * Math.log(1 + averageWords / frequency.get(word)!),
      }))
      .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word))
      .slice(0, perCluster)
      .map(({ word }) => word),
  );
}
