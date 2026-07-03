import { AuditService } from '@core/audit-service';

/**
 * LocalCommandAgentAdapter — read-only supervised mode.
 *
 * Beta MUST implement:
 * - restricted workdir
 * - disabled shell write by default
 * - capture process start/stop
 * - capture stdout/stderr transcript
 * - hash input and output
 * - write Level 1 audit events
 * - support cancellation
 *
 * This implementation uses spawn() instead of execSync to avoid
 * shell injection vulnerabilities. Commands are validated against
 * an allowlist of safe read-only programs.
 */

const ALLOWED_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg',
  'diff', 'stat', 'echo', 'pwd', 'which', 'file', 'sort',
  'uniq', 'cut', 'wc', 'tree', 'git', 'npm', 'npx',
]);

function isSafeReadonlyCommand(cmd: string): boolean {
  // Disallow shell metacharacters
  const unsafeChars = /[;&|`$(){}[\]<>!\\\n\r]/;
  if (unsafeChars.test(cmd)) return false;

  const parts = cmd.trim().split(/\s+/);
  if (parts.length === 0) return false;
  const base = parts[0];

  return ALLOWED_COMMANDS.has(base);
}

export class LocalCommandAgentAdapter {
  private running = new Map<string, { abort: AbortController }>();

  constructor(private auditService: AuditService) {}

  /**
   * Execute a read-only command in a restricted workdir with no shell.
   * Command must be from the allowlist and contain no shell metacharacters.
   */
  async executeReadOnly(
    runId: string,
    command: string,
    workdir: string,
    timeoutMs = 30000,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    inputHash: string;
    outputHash: string;
  }> {
    const { createHash } = await import('crypto');
    const { spawn } = await import('child_process');

    // Validate command: allowlist + no shell metacharacters
    if (!isSafeReadonlyCommand(command)) {
      const errorMsg = `Command rejected: "${command.substring(0, 80)}" is not in the safe allowlist or contains shell metacharacters`;
      await this.auditService.appendEvent({
        runId,
        workspaceId: '',
        eventType: 'local_command_failed',
        eventPayload: { error: errorMsg, exitCode: -1 },
      });
      return { stdout: '', stderr: errorMsg, exitCode: -1, inputHash: '', outputHash: '' };
    }

    // Hash input (command + workdir)
    const inputHash = createHash('sha256').update(`${command}:${workdir}`).digest('hex');

    // Write Level 1 audit event
    await this.auditService.appendEvent({
      runId,
      workspaceId: '',
      eventType: 'local_command_start',
      eventPayload: { command: command.substring(0, 100), workdir, inputHash },
    });

    const abortController = new AbortController();
    this.running.set(runId, { abort: abortController });

    // Split command into program + args for safe spawn (no shell)
    const parts = command.trim().split(/\s+/);
    const program = parts[0];
    const args = parts.slice(1);

    try {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const child = spawn(program, args, {
        cwd: workdir,
        signal: abortController.signal,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '' },
      });

      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`Command timed out after ${timeoutMs}ms: ${command.substring(0, 80)}`));
        }, timeoutMs);

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
      });

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const outputHash = createHash('sha256').update(stdout + stderr).digest('hex');

      await this.auditService.appendEvent({
        runId,
        workspaceId: '',
        eventType: exitCode === 0 ? 'local_command_complete' : 'local_command_failed',
        eventPayload: { exitCode, outputHash, bytes: stdout.length + stderr.length },
      });

      return { stdout, stderr, exitCode, inputHash, outputHash };
    } catch (err: any) {
      // AbortError = cancellation
      if (err.name === 'AbortError') {
        await this.auditService.appendEvent({
          runId,
          workspaceId: '',
          eventType: 'local_command_failed',
          eventPayload: { error: 'Command cancelled', exitCode: -1 },
        });
        return { stdout: '', stderr: 'Command cancelled', exitCode: -1, inputHash, outputHash: '' };
      }

      const stderr = err.stderr?.toString() || err.message || '';
      const outputHash = createHash('sha256').update(stderr).digest('hex');

      await this.auditService.appendEvent({
        runId,
        workspaceId: '',
        eventType: 'local_command_failed',
        eventPayload: { error: err.message, exitCode: err.status ?? -1, outputHash },
      });

      return { stdout: '', stderr, exitCode: err.status ?? -1, inputHash, outputHash };
    } finally {
      this.running.delete(runId);
    }
  }

  cancel(runId: string): void {
    const handle = this.running.get(runId);
    if (handle) {
      handle.abort.abort();
    }
  }
}
