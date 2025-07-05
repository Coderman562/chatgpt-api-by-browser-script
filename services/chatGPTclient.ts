import { webSocketServer, type RequestPayload, type ResponseType } from '../server/webSocketServer';

export const askChatGPT = (text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const payload: RequestPayload = { text, model: 'gpt-4o', newChat: true };

    webSocketServer.sendRequest(payload, (type: ResponseType, chunk: string) => {
      if (type === 'answer') return; // stream chunks ignored
      if (type === 'stop') resolve(chunk.trim());
      if (type === 'error') reject(new Error(chunk));
    });
  });