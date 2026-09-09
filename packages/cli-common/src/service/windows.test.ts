import { describe, expect, it } from 'vitest';

import {
  buildRemoveWindowsScheduledTaskIfPresentPowerShellCommand,
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  buildStopWindowsScheduledTaskIfRunningPowerShellCommand,
  parseWindowsScheduledTaskStatusPowerShellJson,
  renderWindowsScheduledTaskWrapperPs1,
} from './windows';

describe('Windows scheduled task PowerShell status helper', () => {
  it('parses launch post-mortem fields from invariant JSON', () => {
    const parsed = parseWindowsScheduledTaskStatusPowerShellJson(JSON.stringify({
      exists: true,
      enabled: true,
      active: false,
      stateLabel: 'Ready',
      stateValue: 3,
      lastRunTime: '2026-04-29T16:29:54.0000000+02:00',
      lastTaskResult: 267009,
      taskToRun: 'powershell.exe -NoProfile -File C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    }));

    expect(parsed).toEqual({
      exists: true,
      enabled: true,
      active: false,
      stateLabel: 'Ready',
      stateValue: 3,
      lastRunTime: '2026-04-29T16:29:54.0000000+02:00',
      lastTaskResult: 267009,
      taskToRun: 'powershell.exe -NoProfile -File C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    });
  });

  it('queries launch post-mortem fields using culture-independent property names', () => {
    const command = buildReadWindowsScheduledTaskStatusPowerShellCommand({
      taskPath: '\\Happier\\',
      taskName: 'happier-daemon.default',
    });

    expect(command).toContain('Get-ScheduledTaskInfo');
    expect(command).toContain('LastTaskResult');
    expect(command).toContain('LastRunTime');
    expect(command).toContain('Actions');
    expect(command).toContain('ConvertTo-Json -Compress');
  });
});

describe('Windows scheduled task lifecycle PowerShell helpers', () => {
  it('records wrapper startup errors and preserves the managed process exit code', () => {
    const wrapper = renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: 'C:\\Happier',
      programArgs: ['C:\\Happier\\happier-server.exe'],
      stderrPath: 'C:\\Happier\\logs\\server.err.log',
    });

    expect(wrapper).toContain('try {');
    expect(wrapper).toContain('$exitCode = $LASTEXITCODE');
    expect(wrapper).toContain('Add-Content -LiteralPath');
    expect(wrapper).toContain('exit $exitCode');
    expect(wrapper).toContain('exit 1');
    expect(wrapper).not.toContain('1>> ""');
  });

  it('captures native stderr without PowerShell converting its first line into a terminating error', () => {
    const wrapper = renderWindowsScheduledTaskWrapperPs1({
      programArgs: ['C:\\Happier\\happier-server.exe'],
      stdoutPath: 'C:\\Happier\\logs\\server.out.log',
      stderrPath: 'C:\\Happier\\logs\\server.err.log',
    });

    const nativeInvocation = wrapper.indexOf('& "C:\\Happier\\happier-server.exe"');
    const nativeErrorPolicy = wrapper.indexOf('$ErrorActionPreference = "Continue"');
    expect(nativeErrorPolicy).toBeGreaterThan(-1);
    expect(nativeErrorPolicy).toBeLessThan(nativeInvocation);
    expect(wrapper).toContain('$LASTEXITCODE = 1');
    expect(wrapper).toContain('2>> "C:\\Happier\\logs\\server.err.log"');
  });

  it('stops only an existing running task through typed scheduler state', () => {
    const command = buildStopWindowsScheduledTaskIfRunningPowerShellCommand({
      qualifiedTaskName: 'Happier\\happier-daemon.default',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    });

    expect(command).toContain('Get-ScheduledTask');
    expect(command).toContain('[int]$task.State -eq 4');
    expect(command).toContain('Get-CimInstance Win32_Process');
    expect(command).toContain('-File `"C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1`"');
    expect(command).toContain('taskkill.exe /PID $serviceProcessId /T /F');
    expect(command.indexOf('taskkill.exe')).toBeLessThan(command.indexOf('Stop-ScheduledTask'));
    expect(command).toContain('Stop-ScheduledTask');
    expect(command).toContain('-ErrorAction Stop');
    expect(command.trim()).toMatch(/exit 0$/);
    expect(command).not.toContain('schtasks');
  });

  it('removes only an existing task without parsing localized command output', () => {
    const command = buildRemoveWindowsScheduledTaskIfPresentPowerShellCommand({
      qualifiedTaskName: 'Happier\\happier-daemon.default',
    });

    expect(command).toContain('Get-ScheduledTask');
    expect(command).toContain('Unregister-ScheduledTask');
    expect(command).toContain('-Confirm:$false');
    expect(command).toContain('-ErrorAction Stop');
    expect(command.trim()).toMatch(/exit 0$/);
    expect(command).not.toContain('schtasks');
  });
});
