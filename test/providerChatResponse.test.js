const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');

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

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

class EventEmitter {
  constructor() {
    this.event = () => ({ dispose() {} });
  }
  fire() {}
  dispose() {}
}

const vscode = {
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  EventEmitter
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

let OllamaLanguageModelProvider;
try {
  ({ OllamaLanguageModelProvider } = require('../out/provider'));
} finally {
  Module._load = originalLoad;
}

test('recovers a stream that ends with done_reason but no done marker', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(`${JSON.stringify({ message: { content: 'Hello' }, prompt_eval_count: 5 })}\n`);
    response.write(`${JSON.stringify({
      message: {
        content: ' world',
        tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: { q: 'x' } } }]
      }
    })}\n`);
    response.end(`${JSON.stringify({ done_reason: 'stop', eval_count: 7 })}\n`);
  }, async url => {
    const progress = collectProgress();
    await runChatResponse(url, progress);

    const text = progress.reports
      .filter(part => part instanceof LanguageModelTextPart)
      .map(part => part.value)
      .join('');
    assert.equal(text, 'Hello world');

    const toolCall = progress.reports.find(part => part instanceof LanguageModelToolCallPart);
    assert.equal(toolCall.callId, 'call-1');
    assert.equal(toolCall.name, 'lookup');
    assert.deepEqual(toolCall.input, { q: 'x' });

    const usage = progress.reports.find(part => part instanceof LanguageModelDataPart);
    assert.deepEqual(
      JSON.parse(new TextDecoder().decode(usage.data)),
      { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
    );
  });
});

test('rejects when the stream ends without any completion signal', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.end(`${JSON.stringify({ message: { content: 'partial' } })}\n`);
  }, async url => {
    await assert.rejects(
      runChatResponse(url, collectProgress()),
      error => error.message === 'Did not receive done or success response in stream.'
    );
  });
});

test('still rejects an unrelated stream error received after a done_reason chunk', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(`${JSON.stringify({ done_reason: 'stop', eval_count: 7 })}\n`);
    response.end(`${JSON.stringify({ error: 'boom' })}\n`);
  }, async url => {
    await assert.rejects(
      runChatResponse(url, collectProgress()),
      error => error.message === 'boom'
    );
  });
});

for (const [name, inputSchema] of [['omitted', undefined], ['empty', {}]]) {
  test(`sends an object schema for a tool with ${name} input schema`, async () => {
    let sent;
    await withServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
      }
      sent = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify({
        message: { tool_calls: [{ id: 'time-1', function: { name: 'get_time', arguments: {} } }] },
        done: true
      })}\n`);
    }, async url => {
      const progress = collectProgress();
      await runChatResponse(url, progress, {
        tools: [{ name: 'get_time', description: 'Get the current time.', inputSchema }]
      });
      assert.deepEqual(sent.tools, [{
        type: 'function',
        function: {
          name: 'get_time',
          description: 'Get the current time.',
          parameters: { type: 'object', properties: {} }
        }
      }]);
      const call = progress.reports.find(part => part instanceof LanguageModelToolCallPart);
      assert.equal(call.name, 'get_time');
      assert.deepEqual(call.input, {});
    });
  });
}

test('preserves and surfaces an unsupported tool schema without retrying', async () => {
  const inputSchema = { type: '', properties: null };
  const detail = 'Unable to generate parser for this template. Unrecognized schema: {"type":"","properties":null}';
  let attempts = 0;
  let sent;
  await withServer(async (request, response) => {
    attempts++;
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    sent = JSON.parse(body);
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: detail }));
  }, async url => {
    const progress = collectProgress();
    await assert.rejects(runChatResponse(url, progress, {
      tools: [{ name: 'get_time', description: 'Get the current time.', inputSchema }]
    }), error => error.status === 400 && error.message.includes(detail));
    assert.deepEqual(sent.tools[0].function.parameters, inputSchema);
    assert.equal(attempts, 1);
    assert.deepEqual(progress.reports, []);
  });
});

function collectProgress() {
  return {
    reports: [],
    report(part) {
      this.reports.push(part);
    }
  };
}

async function runChatResponse(url, progress, options = {}) {
  const provider = new OllamaLanguageModelProvider();
  const model = {
    id: 'test-model:latest',
    name: 'test-model:latest',
    family: 'test-model',
    model: 'test-model:latest',
    url,
    headers: {},
    local: false
  };
  const messages = [{
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new LanguageModelTextPart('Hi')]
  }];
  const token = cancellationTokenSource().token;

  return provider.provideLanguageModelChatResponse(model, messages, options, progress, token);
}

function cancellationTokenSource() {
  const listeners = new Set();
  let cancelled = false;

  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    },
    cancel() {
      cancelled = true;
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
