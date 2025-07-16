import { askChatGPT, type ChatGPTResponse } from './chatGPTclient';
import { webSocketServer } from '../server/webSocketServer';
import { sleep } from '../utils/sleep';

export async function askWithReconnect(text: string): Promise<ChatGPTResponse> {
  while (true) {
    try {
      await webSocketServer.waitForConnection();
      return await askChatGPT(text);
    } catch (err: any) {
      if (err.message === 'disconnected' || err.message === 'not connected') {
        console.log('Lost connection, waiting to reconnect...');
        await webSocketServer.waitForConnection();
        await sleep(1000);
      } else {
        throw err;
      }
    }
  }
}
