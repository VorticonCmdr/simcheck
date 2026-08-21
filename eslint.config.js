import js from "@eslint/js";
import globals from "globals";

// simcheck runs across several genuinely different JS environments (MV3
// service worker, browser page modules, a Web Worker module, and Node build
// tooling) — see CLAUDE.md's "Architecture" section. Each file group below
// gets the globals that actually exist at runtime for it, instead of one
// blanket browser+node config that would hide real no-undef bugs.
export default [
  {
    // Vendored/generated output — never linted, per CLAUDE.md's "Conventions"
    // table (three-tier dependency split) and "Build system" section.
    ignores: [
      "dist/**",
      "node_modules/**",
      "libs/transformers.min.js",
      "public/css/**",
      "public/icons/**",
      "public/libs/**",
      "public/templates/**",
    ],
  },

  js.configs.recommended,

  // Node.js build scripts (not shipped to the browser).
  {
    files: ["scripts/**/*.js", "vite.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },

  // js/background.js: MV3 service worker. ES module, no DOM, chrome.* APIs.
  {
    files: ["js/background.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.serviceworker,
        ...globals.webextensions,
      },
    },
  },

  // Page-context ES modules: DOM + chrome.* + jQuery/Handlebars as classic-
  // script globals (see CLAUDE.md's dependency tiers — jquery/select2 and
  // handlebars.runtime are loaded via <script>, not import).
  {
    files: ["js/*.js"],
    ignores: ["js/background.js", "js/hclust-worker.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        $: "readonly",
        jQuery: "readonly",
        Handlebars: "readonly",
      },
    },
    rules: {
      eqeqeq: "error",
    },
  },

  // libs/*.js: real ES modules (hand-written or genuinely vendored), no
  // chrome.* usage — see CLAUDE.md's "Vendored algorithm libraries" table.
  {
    files: ["libs/*.js"],
    ignores: ["libs/transformers.min.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
  },

  // js/hclust-worker.js: a Web Worker module (spawned by js/cluster.js via
  // `new Worker(new URL(...), { type: "module" })`) — Worker globals
  // (self, postMessage), no DOM, no chrome.*, and it has import/export so
  // it's a real ES module rather than a classic worker script.
  {
    files: ["js/hclust-worker.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.worker,
      },
    },
  },

  {
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
    },
  },
];
