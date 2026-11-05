// Fixed order, so a cluster's colour never comes from cycling. Clusters past the
// last slot fold into "other", and text labels carry identity alongside colour.
const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export const SERIES_LIMIT = LIGHT.length;

export function seriesColor(index: number, dark: boolean): string {
  return (dark ? DARK : LIGHT)[index];
}

export const otherColor = (dark: boolean) => (dark ? "#8a8983" : "#8f8e88");
export const noiseColor = (dark: boolean) => (dark ? "#55544f" : "#c9c8c1");
