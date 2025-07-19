import fs from 'fs';
import { askWithReconnect } from './askWithReconnect';
import type { ChatGPTResponse } from './chatGPTclient';
import { webSocketServer } from '../server/webSocketServer';
import { sleep } from '../utils/sleep';
import { writeChart } from '../utils/chart';

export async function runBatch(questions: string[]): Promise<void> {
  const durations: number[] = [];
  fs.writeFileSync('answers.txt', '');

  await webSocketServer.waitForConnection();
  console.log('Browser connected – starting batch');

  let count = 0;
  for (const q of questions) {
    count += 1;
    console.log(`\n[${count}/${questions.length}]`);

    const newChat = count % 50 === 1;
    const start = Date.now();
    const resp: ChatGPTResponse = await askWithReconnect(q, newChat);
    const elapsed = Date.now() - start;
    durations.push(elapsed);
    await writeChart(durations);
    const raw = resp.text;
    const match = raw.match(/\[[\s\S]*?\]/);
    const extracted = match ? match[0] : raw.trim();
    const oneLine = extracted.replace(/\s*\n+\s*/g, ' ').trim();

    console.log('  ↳', oneLine, `(model: ${resp.the_model}, ${elapsed} ms)`);
    fs.appendFileSync('answers.txt', oneLine + `\t${resp.the_model}\n`);

    if (count < questions.length) {
      const delay = 8_000 + Math.random() * 7_000;
      console.log(`  …waiting ${(delay / 1000).toFixed(1)} s`);
      await sleep(delay);
    }
  }

  console.log('\nBatch complete – answers saved to answers.txt');
  console.log('Response times chart written to response-times.png');
}
