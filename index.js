const WebSocket = require('ws');

const WS_PORT = 8765;

class WebSocketServer {
  constructor() {
    this.server = new WebSocket.Server({ port: WS_PORT });
    this.connectedSocket = null;
    this.initialize();
  }

  initialize() {
    this.server.on('connection', (socket) => {
      this.connectedSocket = socket;
      console.log('Browser connected, can process requests now.');

      socket.on('close', () => {
        console.log('The browser connection has been disconnected, the request cannot be processed.');
        this.connectedSocket = null;
      });
    });

    console.log('WebSocket server is running');
  }

  async waitForConnection() {
    if (this.connectedSocket) return;
    console.log('Waiting for browser to connect...');
    await new Promise((resolve) => {
      const check = () => {
        if (this.connectedSocket) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  async sendRequest(request, callback) {
    if (!this.connectedSocket) {
      callback('stop', 'api error');
      console.log('The browser connection has not been established, the request cannot be processed.');
      return;
    }

    console.log('Sending message request:', request.text);
    this.connectedSocket.send(JSON.stringify(request));

    let text = ''
    const handleMessage = (message) => {
      const data = message;
      const jsonString = data.toString('utf8');
      const jsonObject = JSON.parse(jsonString);

      if (jsonObject.type === 'stop') {
        this.connectedSocket.off('message', handleMessage);
        console.log('Message output (final):', text);
        callback('stop', text);
      } else if (jsonObject.type === 'answer')  {
        console.log('Message output (partial):', jsonObject.text);
        text = jsonObject.text
        callback('answer', text);
      }
    };
    this.connectedSocket.on('message', handleMessage);
  }
}

const webSocketServer = new WebSocketServer();

const requestPayload = {
  text: 'What is the capital of France?',
  model: 'gpt-4o',
  newChat: true,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  await webSocketServer.waitForConnection();
  console.log('Sending request...');
  webSocketServer.sendRequest(
    requestPayload,
    (type, response) => {
      try {
        response = response.trim()
        let deltaContent = '';
        const result = {
          choices: [{
              message: { content: response },
              delta: { content: deltaContent }
          }]
        }
        if(type === 'stop'){
          console.log('result', result)
        }
      } catch (error) {
        console.log('error', error)
      }
    }
  );
})();
