import { webSocketServer, type RequestPayload, type ResponseType } from '../server/webSocketServer';

export interface ChatGPTResponse {
  text: string;
  the_model: string;
}

export const askChatGPT = (text: string, newChat: boolean): Promise<ChatGPTResponse> =>
  new Promise((resolve, reject) => {
    const payload: RequestPayload = { text, newChat, webSearch: true };

    let theModel = '';
    webSocketServer.sendRequest(
      payload,
      (type: ResponseType, chunk: string, model?: string) => {
        if (type === 'answer') {
          if (model) theModel = model;
          return; // stream chunks ignored
        }
        if (type === 'stop') resolve({ text: chunk.trim(), the_model: theModel });
        if (type === 'error') reject(new Error(chunk));
      }
    );
  });
