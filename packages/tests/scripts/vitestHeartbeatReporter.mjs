import { appendHeartbeatDiagnostic } from './heartbeatDiagnostic.mjs';

export default class VitestHeartbeatReporter {
  async onTestModuleStart(testModule) {
    const diagnosticPath = process.env.HAPPIER_CI_DIAGNOSTIC_PATH;
    if (!diagnosticPath) return;
    await appendHeartbeatDiagnostic(diagnosticPath, {
      event: 'module-start',
      moduleId: testModule.moduleId,
    });
  }

  async onTestCaseReady(testCase) {
    const diagnosticPath = process.env.HAPPIER_CI_DIAGNOSTIC_PATH;
    if (!diagnosticPath) return;
    await appendHeartbeatDiagnostic(diagnosticPath, {
      event: 'test-case-ready',
      moduleId: testCase.module.moduleId,
      testName: testCase.fullName,
    });
  }

  async onTestCaseResult(testCase) {
    const diagnosticPath = process.env.HAPPIER_CI_DIAGNOSTIC_PATH;
    if (!diagnosticPath) return;
    const result = testCase.result();
    await appendHeartbeatDiagnostic(diagnosticPath, {
      event: 'test-case-result',
      moduleId: testCase.module.moduleId,
      testName: testCase.fullName,
      state: result.state,
    });
  }
}
