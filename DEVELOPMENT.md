# Development

Install dependencies and compile:

```sh
npm install
npm run compile
```

Open this folder in VS Code and run the Extension Development Host.

## Verify thinking support

Run `npm test`, then use a separate VS Code profile and scratch workspace for
manual checks:

```sh
test_workspace=$(mktemp -d)
printf 'The test word is ORCHID.\n' > "$test_workspace/sample.txt"
code --new-window --profile "Ollama Thinking Test" \
  --extensionDevelopmentPath="$PWD" \
  --enable-proposed-api Ollama.ollama "$test_workspace"
```

This branch uses the `languageModelThinkingPart` and `chatProvider` proposed
APIs. Development-host success does not establish Marketplace readiness;
[VS Code's proposed API requirements](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
must be resolved before publishing.

In **Chat: Manage Language Models**, add an Ollama group for the test endpoint.
For request verification, point only this group at a local capture proxy that
forwards `/api/*` unchanged to Ollama. Record the VS Code and Ollama versions,
model tag, `/api/show` response, outgoing chat body, and streamed response.

Inspect the selected model's controls before testing:

```sh
curl http://127.0.0.1:11434/api/show -d '{"model":"qwen3.8:27b-mlx"}'
```

Use exactly the returned `thinking.values` and `thinking.default`, as described
in [Ollama's thinking API](https://docs.ollama.com/capabilities/thinking). Qwen3.8
advertises `false`, `low`, `medium`, and `xhigh`; its default can differ between
backends. Do not substitute `high` or `max`. When metadata is absent, only the
existing GPT-OSS, DeepSeek V4, and GLM 5.2 mappings apply. Unknown models without
metadata, invalid metadata, and models with only one supported value have no
selector.

| Check | Action and expected result | Evidence |
| --- | --- | --- |
| Discovery and controls | Select Qwen3.8; open Thinking Effort. Compare every option and the default with `/api/show`. Repeat with GPT-OSS and GLM 5.2, and check that a non-thinking model has no selector. | Visible menu and metadata. |
| Outgoing values | For each Qwen3.8 option, ask “What is 17 times 23? Answer with only the number.” Off sends boolean `false`; named levels are sent unchanged. | Captured `think` values, response, and thinking chunks. |
| Native streaming | Select Low and send a prompt. Thinking appears incrementally in the native thinking section before the answer. | UI observation plus multiple `message.thinking` chunks. |
| Tool history | In Agent mode, ask “Read sample.txt and tell me the test word.” Follow up with “What word did the file contain?” | Tool use in the UI; next request preserves assistant `thinking`, tool calls, and the matching tool result. |
| Ordinary chat | Select a non-thinking model such as Phi-3 and ask “Reply with only READY.” | Normal answer; no thinking selector or outgoing `think`. |
| Cancellation | Stop a long thinking response, then ask a short question. | First request aborts; the next request completes. |
| Refresh and saved settings | Select an effort, refresh models, and reload the test window. Repeat after changing the endpoint/model metadata so that the saved value is unsupported. | Valid choice survives; unsupported saved values are omitted from requests. |

Report UI observations, real-model/extension-host tests, and mocked tests
separately. A schema assertion alone does not verify a visible control, and an
HTTP 200 alone does not prove that an effort value took effect.

## Configuration

Configure the endpoint and optional request headers in VS Code settings:

```json
{
  "ollama.endpoint": "http://127.0.0.1:11434",
  "ollama.headers": {}
}
```

VS Code can also pass provider configuration through `chatLanguageModels.json`:

```json
[
  {
    "vendor": "ollama-models",
    "name": "Ollama",
    "url": "http://127.0.0.1:11434",
    "models": ["qwen3.6"],
    "headers": {}
  }
]
```

If `models` is omitted, the extension lists every model returned by `/api/tags`.
Provider configuration from VS Code takes precedence over workspace settings.

## Package a VSIX

Build the extension package:

```sh
npm install
npm run compile
npx @vscode/vsce package --out ollama-0.0.1.vsix
```

Install the packaged VSIX:

```sh
code --install-extension ollama-0.0.1.vsix
```

You can also install a VSIX from VS Code by running `Extensions: Install from
VSIX...` from the Command Palette.
