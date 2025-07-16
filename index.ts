import fs from 'fs';
import { sleep } from './utils/sleep';
import { type ChatGPTResponse } from './services/chatGPTclient';
import { askWithReconnect } from './services/askWithReconnect';
import { webSocketServer } from './server/webSocketServer';

const questions: string[] = JSON.parse(
  fs.readFileSync('./bingo_prompts_all.json', 'utf-8')
);

(async () => {
  fs.writeFileSync('answers.txt', ''); // reset file

  await webSocketServer.waitForConnection();
  console.log('Browser connected – starting batch');

  let count = 0;

  for (const q of questions) {
    count += 1;
    console.log(`\n[${count}/${questions.length}]`);

    const resp: ChatGPTResponse = await askWithReconnect(q);
    const raw = resp.text;

    // grab the first JSON-array found (fallback: whole reply)
    const match = raw.match(/\[[\s\S]*?\]/);
    const extracted = match ? match[0] : raw.trim();

    console.log('  ↳', extracted, `(model: ${resp.the_model})`);
    fs.appendFileSync('answers.txt', extracted + `\t${resp.the_model}\n`);

    if (count < questions.length) {
      const delay = 8_000 + Math.random() * 7_000; // 8–15 s
      console.log(`  …waiting ${(delay / 1000).toFixed(1)} s`);
      await sleep(delay);
    }
  }

console.log('\nBatch complete – answers saved to answers.txt');
})();
