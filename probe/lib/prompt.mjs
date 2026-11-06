// Prompts. Credentials are asked with a hidden prompt: never argv, never environment, never echoed,
// never written to disk. Without a terminal we refuse instead of reading them from a pipe.

import { createInterface } from 'node:readline/promises';

/** @param {string} question */
export function askHidden(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(
      new Error(
        'This script needs an interactive terminal to ask for the password (nothing is read from pipes or arguments).',
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let buffer = '';
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (fn, arg) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      fn(arg);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(resolve, buffer);
        if (ch === '\u0003') return finish(reject, new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') buffer = [...buffer].slice(0, -1).join('');
        else if (ch >= ' ') buffer += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Visible yes/no question. Anything but y/yes is "no". */
export async function askYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
