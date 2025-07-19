import EventEmitter from 'events';
import WebSocket, { WebSocketServer as WsServer } from 'ws';

export interface RequestPayload {
  text: string;
  model?: string;
  newChat: boolean;
}

export type ResponseType = 'stop' | 'answer' | 'error';
export type ResponseCallback = (type: ResponseType, chunk: string, model?: string) => void;

const WS_PORT = 8765;

class WebSocketServer extends EventEmitter {
  private server: WsServer;
  private connectedSocket: WebSocket | null = null;

  constructor() {
    super();
    this.server = new WsServer({ port: WS_PORT });
    this.initialize();
  }

  private initialize() {
    this.server.on('connection', socket => {
      // @ts-ignore
      this.connectedSocket = socket;
      console.log('Browser connected, can process requests now.');
      this.emit('connect');

      socket.on('close', () => {
        console.log(
          'The browser connection has been disconnected, the request cannot be processed.'
        );
        this.connectedSocket = null;
        this.emit('disconnect');
      });
    });

    console.log('WebSocket server is running');
  }

  isConnected(): boolean {
    return this.connectedSocket !== null;
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
      callback('error', 'not connected');
      console.log(
        'The browser connection has not been established, the request cannot be processed.'
      );
      return;
    }

    const socket = this.connectedSocket as WebSocket;
    socket.send(JSON.stringify(request));

    let text = '';
    let model = '';
    const handleMessage = (data: WebSocket.RawData) => {
      const jsonObject = JSON.parse(data.toString('utf8'));

      if (jsonObject.type === 'stop') {
        socket.off('message', handleMessage);
        socket.off('close', handleClose);
        callback('stop', text, model);
      } else if (jsonObject.type === 'answer') {
        text = jsonObject.text;
        model = jsonObject.the_model || model;
        callback('answer', text, model);
      }
    };
    const handleClose = () => {
      socket.off('message', handleMessage);
      socket.off('close', handleClose);
      callback('error', 'disconnected');
    };

    socket.on('message', handleMessage);
    socket.once('close', handleClose);
  }
}

export const webSocketServer = new WebSocketServer();
