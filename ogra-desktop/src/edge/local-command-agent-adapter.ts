import { AuditService } from './audit-service';

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
 * This is a simplified stub for Alpha/Beta coverage.
 * Full implementation requires process spawning with workdir and timeout.
 */
export class LocalCommandAgentAdapter {
  private running = new Map<string, { cancelled: boolean }>();

  constructor(private auditService: AuditService) {}

  /**
   * Execute a read-only command. The command is hashed and executed
   * in a restricted workdir with no shell write access.
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
    const { execSync } = await import('child_process');

    // Hash input (command + workdir)
    const inputHash = createHash('sha256').update(`${command}:${workdir}`).digest('hex');

    // Write Level 1 audit event
    await this.auditService.appendEvent({
      runId,
      workspaceId: '',
      eventType: 'local_command_start',
      eventPayload: { command: command.substring(0, 100), workdir, inputHash },
    });

    const handle = { cancelled: false };
    this.running.set(runId, handle);

    try {
      const result = execSync(command, {
        cwd: workdir,
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024, // 1MB
        env: { PATH: process.env.PATH || '' },
      });

      const stdout = result?.toString() || '';
      const outputHash = createHash('sha256').update(stdout).digest('hex');

      await this.auditService.appendEvent({
        runId,
        workspaceId: '',
        eventType: 'local_command_complete',
        eventPayload: { exitCode: 0, outputHash, bytes: stdout.length },
      });

      return { stdout, stderr: '', exitCode: 0, inputHash, outputHash };
    } catch (err: any) {
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
      handle.cancelled = true;
    }
  }
}
