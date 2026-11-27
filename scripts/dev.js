import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');

const children = [
  spawn(process.execPath, ['server/index.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], {
    stdio: 'inherit'
  })
];

let stopping = false;

function stopChildren(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on('error', (error) => {
    console.error('Unable to start a SignSpeak development service:', error);
    stopChildren(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stopChildren(code || 0);
  });
}

process.once('SIGINT', () => stopChildren(0));
process.once('SIGTERM', () => stopChildren(0));
