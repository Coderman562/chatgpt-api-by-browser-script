import WebSocket, { WebSocketServer as WsServer } from 'ws';

export interface RequestPayload {
  text: string;
  model: string;
  newChat: boolean;
}

export type ResponseType = 'stop' | 'answer' | 'error';
export type ResponseCallback = (type: ResponseType, chunk: string, model?: string) => void;

const WS_PORT = 8765;

class WebSocketServer {
  private server: WsServer;
  private connectedSocket: WsServer | null = null;

  constructor() {
    this.server = new WsServer({ port: WS_PORT });
    this.initialize();
  }

  private initialize() {
    this.server.on('connection', socket => {
      // @ts-ignore
      this.connectedSocket = socket;
      console.log('Browser connected, can process requests now.');

      socket.on('close', () => {
        console.log(
          'The browser connection has been disconnected, the request cannot be processed.'
        );
        this.connectedSocket = null;
      });
    });

    console.log('WebSocket server is running');
  }

  async waitForConnection(): Promise<void> {
    if (this.connectedSocket) return;
    console.log('Waiting for browser to connect...');
    await new Promise<void>(resolve => {
      const check = () => {
        if (this.connectedSocket) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  sendRequest(request: RequestPayload, callback: ResponseCallback): void {
    if (!this.connectedSocket) {
      callback('stop', 'api error');
      console.log(
        'The browser connection has not been established, the request cannot be processed.'
      );
      return;
    }

    // @ts-ignore
    this.connectedSocket.send(JSON.stringify(request));

    let text = '';
    let model = '';
    const handleMessage = (data: WebSocket.RawData) => {
      const jsonObject = JSON.parse(data.toString('utf8'));

      if (jsonObject.type === 'stop') {
        this.connectedSocket!.off('message', handleMessage);
        callback('stop', text, model);
      } else if (jsonObject.type === 'answer') {
        text = jsonObject.text;
        model = jsonObject.the_model || model;
        callback('answer', text, model);
      }
    };
    this.connectedSocket.on('message', handleMessage);
  }
}

export const webSocketServer = new WebSocketServer();
