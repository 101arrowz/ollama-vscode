const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class Disposable {
  dispose() {}
}

class EventEmitter {
  event = () => new Disposable();
  fire() {}
  dispose() {}
}

class CancellationTokenSource {
  token = cancellationToken;
  cancel() {}
  dispose() {}
}

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }
}

class LanguageModelThinkingPart {
  constructor(value) { this.value = value; }
}
class LanguageModelToolCallPart {}
class LanguageModelToolResultPart {}

const cancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => new Disposable()
};

const vscode = {
  CancellationError: class CancellationError extends Error {},
  CancellationTokenSource,
  EventEmitter,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelThinkingPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  commands: { executeCommand: async () => undefined },
  env: { openExternal: async () => undefined },
  window: {
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback })
  }
};

let models = [];
let chatRequests = [];

class Ollama {
  async version() {
    return { version: 'test' };
  }

  async list() {
    return { models };
  }

  async show({ model }) {
    return models.find(candidate => (candidate.model || candidate.name) === model)?.show ?? {};
  }

  async chat(request) {
    chatRequests.push(request);
    return {
      abort() {},
      async *[Symbol.asyncIterator]() {
        yield { done: true, message: {} };
      }
    };
  }
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  if (request === 'ollama') {
    return { Ollama };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let OllamaLanguageModelProvider;
try {
  ({ OllamaLanguageModelProvider } = require('../out/provider'));
} finally {
  Module._load = originalLoad;
}

test.beforeEach(() => {
  models = [];
  chatRequests = [];
});

test('sends the policy default when VS Code omits an unset model configuration', async () => {
  models = [{ name: 'deepseek-v4-flash:cloud', capabilities: ['thinking'], remote_host: 'ollama.com' }];
  const provider = new OllamaLanguageModelProvider();
  const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);

  await provider.provideLanguageModelChatResponse(
    model,
    [{ role: 1, content: [new LanguageModelTextPart('hello')] }],
    { modelConfiguration: {} },
    { report() {} },
    cancellationToken
  );

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, false);
});

test('omits a stale thinking value from the actual Ollama request', async () => {
  models = [{ name: 'gpt-oss:20b', capabilities: ['thinking'], remote_host: 'ollama.com' }];
  const provider = new OllamaLanguageModelProvider();
  const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);

  await provider.provideLanguageModelChatResponse(
    model,
    [{ role: 1, content: [new LanguageModelTextPart('hello')] }],
    { modelConfiguration: { thinkingLevel: 'none' } },
    { report() {} },
    cancellationToken
  );

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, undefined);
});

test('exposes thinking controls only with both a verified policy and server capability', async () => {
  models = [
    { name: 'gpt-oss:20b', capabilities: ['thinking'], remote_host: 'ollama.com' },
    { name: 'gpt-oss:120b', capabilities: ['tools'], remote_host: 'ollama.com' },
    { name: 'unknown-thinking:cloud', capabilities: ['thinking'], remote_host: 'ollama.com' }
  ];
  const provider = new OllamaLanguageModelProvider();
  const discovered = await provider.provideLanguageModelChatInformation({}, cancellationToken);
  const properties = Object.fromEntries(discovered.map(model => [
    model.id,
    model.configurationSchema.properties
  ]));

  assert.deepEqual(properties['gpt-oss:20b'].thinkingLevel.enum, ['low', 'medium', 'high']);
  assert.equal(properties['gpt-oss:120b'].thinkingLevel, undefined);
  assert.equal(properties['unknown-thinking:cloud'].thinkingLevel, undefined);
  for (const model of discovered.slice(1)) {
    await provider.provideLanguageModelChatResponse(model, [], {
      modelConfiguration: { thinkingLevel: 'high' }
    }, { report() {} }, cancellationToken);
    assert.equal(chatRequests.at(-1).think, undefined);
  }
});

test('advertises exact metadata controls and sends every selection without translation', async () => {
  for (const { name, values, default: defaultLevel } of [
    { name: 'qwen3.8:27b-mlx', values: [false, 'low', 'medium', 'xhigh'], default: 'medium' },
    { name: 'glm-5.2:cloud', values: [false, 'high', 'max'], default: 'high' },
    { name: 'qwen3.6:27b', values: [false, true], default: true },
    { name: 'custom-thinking:cloud', values: ['brief', 'deep'], default: 'brief' }
  ]) {
    models = [{ name, model: `server/${name}`, capabilities: ['thinking'], remote_host: 'ollama.com',
      max_context_length: 131072,
      show: { thinking: { values, default: defaultLevel } } }];
    const provider = new OllamaLanguageModelProvider();
    try {
      const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);
      const property = model.configurationSchema.properties.thinkingLevel;
      assert.deepEqual(property.enum, values);
      assert.equal(property.default, defaultLevel);
      for (const value of [...values, undefined, 'stale', 1, null, {}]) {
        await provider.provideLanguageModelChatResponse(model, [], {
          modelConfiguration: { thinkingLevel: value }
        }, { report() {} }, cancellationToken);
        assert.equal(chatRequests.at(-1).model, `server/${name}`);
        assert.equal(chatRequests.at(-1).think,
          value === undefined ? defaultLevel : values.includes(value) ? value : undefined);
      }
    } finally {
      provider.dispose();
    }
  }
});

test('refreshing metadata rejects a previously supported saved value', async () => {
  const entry = { name: 'gpt-oss:120b-cloud', capabilities: ['thinking'], remote_host: 'ollama.com',
    show: { thinking: { values: ['low', 'medium', 'high'], default: 'medium' } } };
  models = [entry];
  const provider = new OllamaLanguageModelProvider();
  try {
    await provider.provideLanguageModelChatInformation({}, cancellationToken);
    entry.show.thinking = { values: [false], default: false };
    provider.refresh();
    const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);
    assert.equal(model.configurationSchema.properties.thinkingLevel, undefined);
    await provider.provideLanguageModelChatResponse(model, [], {
      modelConfiguration: { thinkingLevel: 'high' }
    }, { report() {} }, cancellationToken);
    assert.equal(chatRequests.at(-1).think, undefined);
  } finally {
    provider.dispose();
  }
});
