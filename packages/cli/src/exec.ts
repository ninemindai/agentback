// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {spawn} from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

export const nodeExec: Exec = (cmd, args) =>
  new Promise(resolve => {
    const child = spawn(cmd, args, {stdio: ['inherit', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', d => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on('close', code => resolve({code: code ?? 1, stdout, stderr}));
    child.on('error', () => resolve({code: 127, stdout, stderr}));
  });
