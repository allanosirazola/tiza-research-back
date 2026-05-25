import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pool from '../db';

export interface ScriptRunResult {
  output: string;
  error: string;
  exitCode: number;
  durationMs: number;
}

export async function runPythonScript(code: string, timeoutMs = 30000): Promise<ScriptRunResult> {
  const tmpFile = path.join(os.tmpdir(), `tiza_script_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);

  try {
    fs.writeFileSync(tmpFile, code, 'utf8');

    const startTime = Date.now();

    return await new Promise<ScriptRunResult>((resolve) => {
      let output = '';
      let error = '';
      let settled = false;

      const child = spawn('python3', [tmpFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        error += chunk.toString();
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGKILL');
          resolve({
            output,
            error: error + '\n[TIMEOUT] Script exceeded ' + timeoutMs + 'ms and was killed.',
            exitCode: -1,
            durationMs: Date.now() - startTime,
          });
        }
      }, timeoutMs);

      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            output,
            error,
            exitCode: code ?? 0,
            durationMs: Date.now() - startTime,
          });
        }
      });

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            output,
            error: err.message,
            exitCode: -1,
            durationMs: Date.now() - startTime,
          });
        }
      });
    });
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function runScriptById(scriptId: string): Promise<ScriptRunResult> {
  const result = await pool.query('SELECT * FROM user_scripts WHERE id = $1', [scriptId]);
  const script = result.rows[0];
  if (!script) throw new Error('Script not found');

  const runResult = await runPythonScript(script.code);

  await pool.query(
    `UPDATE user_scripts SET last_run = NOW(), last_output = $1, last_error = $2, run_count = run_count + 1, updated_at = NOW() WHERE id = $3`,
    [runResult.output, runResult.error, scriptId]
  );

  return runResult;
}
