import {
  AutoConfig,
  pipeline,
  layer_norm,
  env,
  cos_sim,
} from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

env.allowRemoteModels = true;
env.allowLocalModels = false;

// Due to a bug in onnxruntime-web, we must disable multithreading for now.
// See https://github.com/microsoft/onnxruntime/issues/14445 for more information.
env.backends.onnx.wasm.numThreads = 1;

let settings = {
  model: "Snowflake/snowflake-arctic-embed-m",
};

async function init() {
  let config = await AutoConfig.from_pretrained(settings.model);
  console.log(config);
  debugger;

  // Create a feature extraction pipeline
  const extractor = await pipeline("feature-extraction", settings.model, {
    quantized: false, // Comment out this line to use the quantized version
  });

  let docs = [
    "Stellen Sie diesen Satz für die Suche nach relevanten Passagen dar: Ein Mann isst ein Stück Brot",
    "Ein Mann isst.",
    "Ein Mann isst Nudeln.",
    "Das Mädchen trägt ein Baby.",
    "Ein Mann reitet auf einem Pferd.",
  ];
  console.log(docs);

  let embeddings = await extractor(docs, {
    pooling: "cls",
  });

  /*
  const matryoshka_dim = 768;
  embeddings = layer_norm(embeddings, [embeddings.dims[1]])
    .slice(null, [0, matryoshka_dim])
    .normalize(2, -1);
  */

  console.log(embeddings.tolist());

  // Compute similarity scores
  const [source_embeddings, ...document_embeddings] = embeddings.tolist();
  const similarities = document_embeddings.map((x) =>
    cos_sim(source_embeddings, x),
  );
  console.log(similarities);
}

// listen for messages, process it, and send the result back.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("sender", sender);
  console.log("message", message);

  switch (message.action) {
    case "init":
      init();
      break;
    default:
      //
      sendResponse({
        code: 404,
      });
  }

  // return true to indicate we will send a response asynchronously
  // see https://stackoverflow.com/a/46628145 for more information
  return true;
});
