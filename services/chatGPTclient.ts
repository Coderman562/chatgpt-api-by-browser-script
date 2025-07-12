import { webSocketServer, type RequestPayload, type ResponseType } from '../server/webSocketServer';

export interface ChatGPTResponse {
  text: string;
  the_model: string;
}

export const askChatGPT = (text: string): Promise<ChatGPTResponse> =>
  new Promise((resolve, reject) => {
    const payload: RequestPayload = { text, model: 'gpt-4o', newChat: true };

    let theModel = 'gpt-4o';
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
