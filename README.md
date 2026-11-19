# Chorus

Chorus is a free, browser-based AI chat where several models answer together. One model reads your message and decides how many should take part, then they draft, check and finish the reply as a team. Ask a question, follow up in the same conversation, and revisit your chats from the sidebar. Replies stream as they arrive, support Markdown, and can be opened in a canvas for editing and running code.

## Start chatting

Open the Arena preview, or run the website yourself with Node.js 20.19 or later:

```sh
npm ci
npm start
```

Open `http://localhost:3000`, type a message, and press **Enter** or the send arrow. Press **Shift+Enter** for a new line. On your first community message, review the privacy notice and choose **Accept and send**. **New chat** starts a fresh conversation; **Search chats** (Ctrl/Command+K) searches the titles and text of saved chats.

**Community AI** is the default. It uses the [AI Horde public chat interface](https://oai.aihorde.net/docs) without a model download, account, personal API key, or payment. Chorus checks which text models are online before asking for a reply; **Settings → Check availability** checks the list without sending a message. Availability, output limits, and wait times vary, and anonymous traffic has low priority. Chorus streams provider output when it’s available and shows wait information when the service supplies it.

Chorus answers with a small team of models, and one model decides the size of that team. It reads your message first and replies with one word: one model for small talk such as a greeting or a quick thanks, two for a question or a request, three for coding, maths or anything risky. The models then work in order: one drafts, the next replies with corrections, and the last gives the finished answer. Each reply names the model that decided and the models that answered, so you can see who drafted, who checked and who finished. If the deciding model can’t be reached, a built-in guess keeps the reply moving. Turn on **Think deeper** to skip the vote and use the full three-model team even for a short question. That takes longer because the models work in sequence. If a later model cannot finish, Chorus shows the draft with a note. A reply that runs out of room is not left half-finished: Chorus asks the same model to carry on, pass after pass, until it stops of its own accord. Use **Stop** to cancel a reply or **Try again** to request a new answer to the most recent message. Chorus respects provider cooldowns and does not automatically resubmit an uncertain request.

## Coding

Code is not a side case. A message that is about code — a language, a library, a bug, a stack trace, a fenced block, or a follow-up in a conversation that was already about code — takes the full three-model panel and gets the code rules:

- **The right models.** AI Horde's roster is ranked by capacity, so a coding task reorders it: models whose names say they were trained for code (Qwen, DeepSeek, Codestral, StarCoder and similar) are offered first, and the roomier contexts break the tie. Capacity still decides among equals, so a busy coder does not win over an idle one.
- **Written, not improvised.** Sampling temperature drops from 0.55 to 0.2 for code, which is the difference between inventing an API and recalling the real one.
- **Complete or nothing.** The instructions ask for every import and dependency, no placeholders and no invented functions or flags, the language and versions the user named, the edge cases that actually happen, and the assumptions that had to be made. If an API may have changed, the model is told to say what it is unsure about rather than guess.
- **A reviewer that looks for breakage.** The checking model is asked specifically for bugs, wrong or invented APIs, missing imports, unhandled edge cases, off-by-one and null mistakes, and anything that would fail to compile or run. The final model then fixes each one and returns runnable code.
- **Room to finish.** Answers are continued pass after pass until the model stops of their own accord, so a long function is not left mid-line.

Long code answers can be opened in the canvas (**Canvas and video** below) and run from there.

## Canvas and video

Any code block in a reply has a **Canvas** button. It opens a side panel with a live preview for HTML, CSS and JavaScript, next to an editor you can change and re-run, plus copy and download. The preview runs in a sandboxed frame, so it can’t read your chats or browser storage. Other languages open in the canvas as editable text.

Type **play** followed by a YouTube link and the video starts in the chat without asking a model. Type a description instead and Chorus asks a set of public YouTube front-ends at the same time, takes the first answer and plays that match; no account, key or download is needed. Filler words are dropped first, so “play a jettism video” searches for “jettism”. If none of the front-ends answer, the card offers a YouTube search link and a **Try again** button. The description goes to those front-ends, not to a model. YouTube links that appear in an answer get a click-to-play thumbnail. Nothing loads from YouTube until you press play: the poster is a plain thumbnail, and the player runs on `youtube-nocookie.com`, so no cookies are set before playback. The **✕** on the player closes it and unloads the frame again.

If a model runs out of room part way through an answer, Chorus asks it to continue and joins the parts, so long code answers finish instead of stopping early. The output-limit note only appears if the reply is still truncated after those extra passes.

## Connectors

Settings → **Connectors** links a chat to the services you already use:

| Connector | What you add | What you can ask |
| --- | --- | --- |
| GitHub | a personal access token, or OAuth through your own relay | “list my GitHub repos”, “GitHub commits in owner/repo”, “my github notifications” |
| Supabase | project URL and anon key | “Supabase rows from profiles” |
| Cloudflare | an API token with Zone:Read | “my Cloudflare zones”, “Cloudflare DNS for example.com” |
| Reddit | nothing | “hot in r/webdev”, “search Reddit for mechanical keyboards” |

A connector only answers when the service is named in the message, so an ordinary question about GitHub still goes to the models. Chorus fetches the data itself, shows it in a card with links, and hands the same rows to the models as context so the reply can talk about them. Keys live in this browser's storage, are sent only to the service they belong to, and are never put in a chat message or sent to a model. Nothing is proxied through a server — each request goes straight from your browser, so a service that blocks cross-origin requests will report an error in the card instead of silently failing.

### Editing, not just reading

GitHub can also write, but only after you tick **Allow changes** on its card, and only for commands you type yourself. With it on:

| You type | What happens |
| --- | --- |
| `open an issue in owner/repo: the button overlaps the text` | Creates the issue and links to it |
| `comment on owner/repo#12: fixed in the latest build` | Posts the comment |
| `create the file docs/hi.md in owner/repo with: hello` | Adds or replaces that file with a commit |
| `set the description of owner/repo to …` | Changes the repository description |

A write is never left to the models: the card reports exactly what changed, with a link to the issue, comment or commit, so nothing can be invented on top of it. The token needs the rights to do it — a classic token wants the **repo** scope, a fine-grained token wants **Contents: read and write** (files) and **Issues: write** — otherwise GitHub answers 403 and the card says so.

### Where to get the key

- **GitHub** — [github.com/settings/tokens](https://github.com/settings/tokens) → *Generate new token*. A fine-grained token needs **Repository access** (the repos you want) and **Contents: read**; a classic token needs the **repo** and **read:user** scopes. Set an expiry — a week is enough for a try. In Chorus the GitHub card's *Get a token instead* link opens the form with those scopes already ticked.
- **Supabase** — [Project settings → API](https://supabase.com/dashboard/project/_/settings/api): copy the **Project URL** and the **anon public** key. Never paste the `service_role` key into a page; it bypasses row level security.
- **Cloudflare** — [Profile → API tokens](https://dash.cloudflare.com/profile/api-tokens) → *Create token* → the *Read all resources* template, or a custom token with **Zone:Read** and **DNS:Read**.
- **Reddit** — nothing to create.

### Keeping keys private

- A key is saved in this browser's storage and nowhere else. There is no account, no server copy and no sync.
- Once saved, Chorus never writes it back into the page: the field comes up empty, marked *saved*, so neither a shoulder nor a screen share nor DevTools shows it. Type a new one to replace it, or press **Remove**.
- It is sent only to the service it belongs to. It is never put into a chat message, never passed to a model (the card's rows are, the key is not), and never logged.
- **Forget every key** in Settings wipes all of them at once. Clearing site data for the page does the same.
- Anything you can see in a browser, someone with access to that browser profile can read. On a shared or public machine, use **Forget every key** when you are done, and prefer short-lived tokens.

### Signing in with OAuth

A pasted token is the quick path, and **Sign in with GitHub** is the real OAuth one. There is one thing that cannot be designed away: GitHub's sign-in endpoints send no CORS headers ([github/isaacs#330](https://github.com/isaacs/github/issues/330)), so a browser is not allowed to swap an OAuth code for a token. The exchange has to happen somewhere that can hold the client secret. That is the relay — deploy it once, and Chorus never sees the secret.

The relay lives in [`relay/`](relay/) — [deploy it to Cloudflare Workers with one press](https://deploy.workers.cloudflare.com/?url=https://github.com/socks275/Jarvis/tree/main/relay), or paste the file yourself. It is one small function and it never stores anything:

```js
export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });
    const { code } = await request.json();
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
    });
    const data = await response.json();
    if (!data.access_token) return Response.json({ error: data.error, error_description: data.error_description }, { status: 400, headers: cors });
    return Response.json({ access_token: data.access_token }, { headers: cors });
  },
};
```

1. Create an OAuth App at [github.com/settings/developers](https://github.com/settings/developers) and set its callback to the URL you open Chorus at. In Chorus, **Settings → Connectors → GitHub → How this works** repeats these steps.
2. Deploy the worker with `ALLOWED_ORIGIN`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set as secrets.
3. In Settings → Connectors → GitHub, paste the client ID and the worker URL, then press **Sign in with GitHub**.

Chorus checks the account afterwards and shows “Connected as @you”. The relay is optional: the token field keeps working on its own. `*.workers.dev`, `*.pages.dev`, `*.deno.dev`, `*.vercel.app` and `*.netlify.app` are already allowed in the page's `connect-src`; a relay on another host needs that host added there.

Reddit, Cloudflare and Supabase have no browser-safe OAuth: Reddit's token endpoint refuses cross-origin calls, Cloudflare's OAuth needs a client secret and is not offered for public clients, and a Supabase project is authenticated by its URL and key rather than by signing in.

## Privacy and history

Community AI sends your message and recent relevant turns from the same chat to AI Horde and its volunteer workers. When two or three models work on one reply, the draft and the review notes are sent to the models that check and finish it. Don't submit secrets, personal information, or confidential material. See the [AI Horde terms](https://aihorde.net/terms) and [privacy policy](https://aihorde.net/privacy). You can reset permission in Settings; reloading the page also resets it.

Chorus keeps recent chats in local browser storage when available; they are not encrypted or account-synced. Delete a chat with the trash button beside it in the sidebar, from **Chat options**, or remove everything with **Settings → Clear all chats**. Deleting them locally does not remove data already sent to a provider. Each reply uses a limited window of recent turns — seven — and every model in a team reads that window, not only the draft it is handed. A question stays in that window even when its own reply was stopped or failed, so a follow-up such as “which one did you pick?” still has the question to refer to. Start a new chat for a different subject. Existing Chorus runs with usable answers are imported as individual chats.

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

The original MIT-licensed [noblehacks/frenemy](https://github.com/noblehacks/frenemy) by Zakariya Syed is preserved in [`desktop/`](desktop/README.md) at [commit `39f2826`](https://github.com/noblehacks/frenemy/tree/39f2826a1ee6033d946a1cdc8fdcd388207fe022). Its CLI installers and VS Code extension are separate from the website. See [its install guide](desktop/INSTALL.md) for the original integrations and requirements. Chorus never runs the desktop tools or shells out to commands. The browser app is named Chorus; the desktop tools in `desktop/` keep their original Frenemy name.
