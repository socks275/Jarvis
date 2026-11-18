# Frenemy Web

Frenemy’s relay workflow, in a browser. One local model drafts, another reviews, and the driver writes the final answer. **Compare answers** runs the same prompt through two roles independently. Snitch shows each step, and completed, stopped, and failed runs can be reopened from browser history.

The web edition is free to run. It has no accounts, database, API keys, or hosted inference. It uses open models you supply, **not** the Claude, Codex, Gemini, and Kimi subscriptions supported by the original desktop tools.

## Start the website

With Node.js 20 or later:

```sh
npm ci
npm start
```

Open `http://localhost:3000` (or the Arena live preview). Click **Run demo** to see a scripted relay without downloading a model. The demo does not generate answers to custom prompts.

### Run real AI locally

1. Download a small instruction-tuned GGUF model. For example, pick the `q4_k_m.gguf` variant from [Qwen2.5 0.5B Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/main).
2. In a current desktop Chrome or Edge browser, open **Models**, select the file as **Driver model**, and click **Apply models**. Add a second compatible GGUF as **Reviewer** for different models, or leave it blank to use the driver model in both roles.
3. Enter a prompt and click **Run relay**. The browser uses [wllama](https://github.com/ngxson/wllama) and WebAssembly to run the models on the CPU. Larger files are slower and can exceed the browser’s memory; start small. If the embedded preview limits workers, open the preview in its own tab.

Model files and prompts are never uploaded. Only one model is loaded into memory at a time. Reselect models after a reload. The last 16 runs are stored in this browser’s local storage when available; they are not encrypted or synced. Use **Run history → Clear history** to remove them.

## Publish for free

```sh
npm ci
npm run build
```

Upload **`dist/` only** to a static host, for example [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) on its free plan. For Git-connected static hosting, use `npm run build` for the build command and `dist` for the output directory. The host needs to serve `.mjs` as JavaScript and `.wasm` as `application/wasm`. There is no inference backend to deploy or pay for. Build output is generated, not committed, and includes the runtime and license notices but no model weights.

## Tests and upstream

```sh
npm test
node desktop/install.mjs --check
```

The original MIT-licensed [noblehacks/frenemy](https://github.com/noblehacks/frenemy) by Zakariya Syed is preserved in [`desktop/`](desktop/README.md) at [commit `39f2826`](https://github.com/noblehacks/frenemy/tree/39f2826a1ee6033d946a1cdc8fdcd388207fe022). Its CLI installers and VS Code extension are separate from the website. See [its install guide](desktop/INSTALL.md) for the original integrations and requirements. The web edition never runs the desktop tools or shells out to commands.
