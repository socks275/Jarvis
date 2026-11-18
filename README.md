# Frenemy Web

Frenemy is a free, browser-based AI chat. Ask a question, follow up in the same conversation, and revisit your chats from the sidebar. Replies can stream as they arrive and support Markdown, including code blocks with a copy button.

## Start chatting

Open the Arena preview, or run the website yourself with Node.js 20.19 or later:

```sh
npm ci
npm start
```

Open `http://localhost:3000`, type a message, and press **Enter** or the send arrow. Press **Shift+Enter** for a new line. On your first community message, review the privacy notice and choose **Accept and send**. **New chat** starts a fresh conversation; **Search chats** (Ctrl/Command+K) searches the titles and text of saved chats.

**Community AI** is the default. It uses the [AI Horde public chat interface](https://oai.aihorde.net/docs) without a model download, account, personal API key, or payment. Frenemy checks which text models are online before asking for a reply; **Settings → Check availability** checks the list without sending a message. Availability, output limits, and wait times vary, and anonymous traffic has low priority. Frenemy streams provider output when it’s available and shows wait information when the service supplies it.

Frenemy answers with a small team of models. Only small talk such as a greeting or a quick thanks stays with one model; any question or request has one model draft a reply and a second model reply with the finished answer; coding and long questions use three, where a reviewer lists what is wrong before the final model rewrites the answer. Each reply names the models that took part, so you can see who drafted, who checked and who finished. Turn on **Think deeper** to use the full three-model team even for a short question. That takes longer because the models work in sequence. If a later model cannot finish, Frenemy shows the draft with a note. Use **Stop** to cancel a reply or **Try again** to request a new answer to the most recent message. Frenemy respects provider cooldowns and does not automatically resubmit an uncertain request.

## Privacy and history

Community AI sends your message and recent relevant turns from the same chat to AI Horde and its volunteer workers. When two or three models work on one reply, the draft and the review notes are sent to the models that check and finish it. Don't submit secrets, personal information, or confidential material. See the [AI Horde terms](https://aihorde.net/terms) and [privacy policy](https://aihorde.net/privacy). You can reset permission in Settings; reloading the page also resets it.

Frenemy keeps recent chats in local browser storage when available; they are not encrypted or account-synced. Choose **Chat options** to rename or delete a conversation, or **Settings → Clear all chats** to remove them from this browser. Deleting them locally does not remove data already sent to a provider. Each reply uses a limited window of recent successful turns; start a new chat for a different subject. Existing Frenemy Web runs with usable answers are imported as individual chats.

### Optional: chat on-device

For work that shouldn’t leave your computer, choose **Settings → On-device** in a current desktop Chrome or Edge browser and select a single `.gguf` file. The local model and on-device conversation turns are never sent to AI Horde. Reselect the file after reloading the page.

- [Qwen2.5 0.5B Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf?download=true) — 491 MB.
- [SmolLM2 360M Instruct](https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf) — 271 MB, a smaller option.

Local models run with [wllama](https://github.com/ngxson/wllama) and WebAssembly on your CPU. Larger models may be slow or exceed browser memory. If the embedded preview limits workers, open the preview in its own tab.

## Publish for free

```sh
npm ci
npm run build
```

Upload **`dist/` only** to a static host, for example [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) on its free plan. For Git-connected hosting, use `npm run build` for the build command and `dist` for the output directory. The host must serve `.mjs` as JavaScript and `.wasm` as `application/wasm`. There is no inference backend to deploy. Community mode requires browser access to `https://oai.aihorde.net`. The build bundles fonts, the local runtime, Markdown rendering and license notices, but no model weights.

## Tests and upstream

```sh
npm test
node desktop/install.mjs --check
```

The original MIT-licensed [noblehacks/frenemy](https://github.com/noblehacks/frenemy) by Zakariya Syed is preserved in [`desktop/`](desktop/README.md) at [commit `39f2826`](https://github.com/noblehacks/frenemy/tree/39f2826a1ee6033d946a1cdc8fdcd388207fe022). Its CLI installers and VS Code extension are separate from the website. See [its install guide](desktop/INSTALL.md) for the original integrations and requirements. Frenemy Web never runs the desktop tools or shells out to commands.
