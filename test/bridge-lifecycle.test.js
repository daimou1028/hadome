'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { openBridge, EXPECTED_TAB_PROTOCOL } = require('../src/bridge');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }

  receive(message) {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
}

class FakeWebSocketServer extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.serverAddress = null;
    this.closed = false;
    FakeWebSocketServer.instances.push(this);
    queueMicrotask(() => {
      this.serverAddress = { address: '127.0.0.1', port: 0 };
      this.emit('listening');
    });
  }

  address() {
    return this.serverAddress;
  }

  close() {
    this.closed = true;
  }

  connect(socket) {
    this.emit('connection', socket);
  }
}

function latestServer() {
  return FakeWebSocketServer.instances.at(-1);
}

function hello(socket, tabId = 'tab-a') {
  socket.receive({
    type: 'hello',
    tabId,
    protocol: 59,
    url: 'https://chatgpt.com/c/12345678',
    title: 'Fake tab',
    turns: 0,
  });
}

test('hello selects the first tab and rejects a different target', async () => {
  FakeWebSocketServer.instances = [];
  const bridge = await openBridge({
    port: 0,
    workspace: '',
    WebSocketServerImpl: FakeWebSocketServer,
  });
  const server = latestServer();
  const first = new FakeSocket();
  const second = new FakeSocket();

  server.connect(first);
  hello(first, 'tab-a');
  server.connect(second);
  hello(second, 'tab-b');

  assert.equal(first.sent.at(-1).type, 'welcome');
  assert.equal(first.sent.at(-1).protocol, EXPECTED_TAB_PROTOCOL);
  assert.deepEqual(second.sent.at(-1), { type: 'not_target' });
  assert.equal(bridge.connected(), true);
  assert.equal(bridge.tabUrl(), 'https://chatgpt.com/c/12345678');

  bridge.close();
});

test('done resolves ask and error rejects ask while cleaning the waiter', async () => {
  FakeWebSocketServer.instances = [];
  const bridge = await openBridge({
    port: 0,
    workspace: '',
    WebSocketServerImpl: FakeWebSocketServer,
  });
  const socket = new FakeSocket();
  latestServer().connect(socket);
  hello(socket);

  const answer = bridge.ask('hello');
  assert.equal(socket.sent.at(-1).type, 'send');
  socket.receive({ type: 'delta', text: 'world' });
  socket.receive({ type: 'done', text: 'world', complete: true });
  assert.equal(await answer, 'world');

  const failure = bridge.ask('again');
  socket.receive({ type: 'error', message: 'failed', status: 0 });
  await assert.rejects(failure, /failed/);

  bridge.close();
});

test('disconnect rejects an unanswered request and close is idempotent', async () => {
  FakeWebSocketServer.instances = [];
  const bridge = await openBridge({
    port: 0,
    workspace: '',
    WebSocketServerImpl: FakeWebSocketServer,
  });
  const socket = new FakeSocket();
  latestServer().connect(socket);
  hello(socket);

  const pending = bridge.ask('will disconnect');
  socket.close();
  await assert.rejects(pending);
  assert.equal(bridge.connected(), false);

  bridge.close();
  bridge.close();
});
