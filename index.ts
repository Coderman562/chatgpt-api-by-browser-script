import fs from 'fs';
import { runBatch } from './services/batchRunner';

const questions: string[] = JSON.parse(
  fs.readFileSync('./bingo_prompts_all.json', 'utf-8')
);

runBatch(questions).catch(err => {
  console.error(err);
  process.exit(1);
});
