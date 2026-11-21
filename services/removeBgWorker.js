// Runs in its OWN process so its sharp/libvips never clashes with the app's sharp.
// usage: node removeBgWorker.js <inputPng> <outputPng> [model]
const fs = require("fs");

(async () => {
  const [, , inPath, outPath, model] = process.argv;
  try {
    const { removeBackground } = await import("@imgly/background-removal-node");
    const input = fs.readFileSync(inPath);

    const blob = await removeBackground(
      new Blob([input], { type: "image/png" }),
      { model: model || "medium", output: { format: "image/png" } }
    );

    fs.writeFileSync(outPath, Buffer.from(await blob.arrayBuffer()));
    process.exit(0);
  } catch (e) {
    console.error(e && e.message ? e.message : String(e));
    process.exit(1);
  }
})();