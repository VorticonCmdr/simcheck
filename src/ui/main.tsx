import "bootstrap/dist/css/bootstrap.min.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./app";
import { initState, showError } from "./state";

const applyTheme = () => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.bsTheme = dark ? "dark" : "light";
};
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

window.addEventListener("unhandledrejection", (event) => showError(event.reason));

render(<App />, document.getElementById("app")!);
initState().catch(showError);
