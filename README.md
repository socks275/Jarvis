# Frenemy Web

Frenemy’s relay workflow, in a browser. Ask for a direct answer, compare two independent answers, or let an online model draft, another review, and a model write the final answer. Snitch shows each stage and which model answered it.

**Community AI** is the default. It uses the [AI Horde public chat interface](https://oai.aihorde.net/docs) anonymously. Visitors need no model downloads, account, API key, or payment. The live pool is limited to the volunteer models that are online, not a fixed catalogue or an unlimited service.

## Start the website

Try the Arena live preview, or run the site yourself with Node.js 20 or later:

```sh
npm ci
npm start
```

Open `http://localhost:3000`, enter a prompt, select **Run relay** and confirm the community notice. Anonymous traffic has low priority, so wait times vary. **Draft & review** uses up to three generation steps; **Quick answer** uses one. Each step checks the live model list, offers a few compatible candidates, and prefers a different reviewer model when possible. If a later step fails, completed answers are still available. Settings shows current availability without sending a prompt.

Community runs send your prompt and relevant intermediate replies directly from your browser to AI Horde and its volunteer workers. Don’t submit personal information, secrets, or confidential material. See the [AI Horde terms](https://aihorde.net/terms) and [privacy policy](https://aihorde.net/privacy). Permission lasts for the tab and can be reset in Settings. This site does not work around the provider’s rate limits or automatically retry an uncertain submission.

### Optional: set up local models

Choose **Settings → Local model files** in a current desktop version of Chrome or Edge for on-device inference without sharing prompts. This is the only mode that needs GGUF files.

1. Under **Find model files**, download one of these free, instruction-tuned GGUFs:
   - [Qwen2.5 0.5B Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf?download=true) — `qwen2.5-0.5b-instruct-q4_k_m.gguf` (491 MB).
   - [SmolLM2 360M Instruct](https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf) — `SmolLM2-360M-Instruct-Q4_K_M.gguf` (271 MB), a smaller option.
2. Select the downloaded file as **Driver model**. You can select a second file as **Reviewer model** or leave it blank to reuse the driver. Select **Use models** to return to the relay desk.
3. Enter a prompt and select **Run relay**. The browser uses [wllama](https://github.com/ngxson/wllama) and WebAssembly to run the models on the CPU. Start with a small model; larger files run more slowly and can exceed the browser’s memory. If the embedded preview limits workers, open the preview in its own tab.

In local mode, model files and prompts are not uploaded. Only one local model is loaded into memory at a time. Reselect files after a reload. The last 16 runs are stored in this browser’s local storage when available; they are not encrypted or synced. Use **Run history → Clear history** to remove them.

## Publish for free

```sh
npm ci
npm run build
```

Upload **`dist/` only** to a static host, for example [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) on its free plan. For Git-connected static hosting, use `npm run build` for the build command and `dist` for the output directory. The host needs to serve `.mjs` as JavaScript and `.wasm` as `application/wasm`. There is no inference backend to deploy or pay for. Community mode requires browser access to `https://oai.aihorde.net`; local mode is separate. Build output is generated, not committed, and includes the runtime and license notices but no model weights.

## Tests and upstream

```sh
npm test
node desktop/install.mjs --check
```

The original MIT-licensed [noblehacks/frenemy](https://github.com/noblehacks/frenemy) by Zakariya Syed is preserved in [`desktop/`](desktop/README.md) at [commit `39f2826`](https://github.com/noblehacks/frenemy/tree/39f2826a1ee6033d946a1cdc8fdcd388207fe022). Its CLI installers and VS Code extension are separate from the website. See [its install guide](desktop/INSTALL.md) for the original integrations and requirements. The web edition never runs the desktop tools or shells out to commands.
