export {
  SYSTEM_TASK_PROTOCOL_VERSION,
  SystemTaskEventSchema,
  SystemTaskJsonValueSchema,
  SystemTaskResultErrorSchema,
  SystemTaskResultSchema,
  SystemTaskSpecSchema,
  type SystemTaskEvent,
  type SystemTaskJsonArray,
  type SystemTaskJsonObject,
  type SystemTaskJsonValue,
  type SystemTaskResult,
  type SystemTaskResultError,
  type SystemTaskSpec,
} from './spec.js';

export {
  createTailscaleSecureAccessTaskSpec,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS,
  type TailscaleSecureAccessInstallPolicy,
  type TailscaleSecureAccessLoginPolicy,
  type TailscaleSecureAccessMode,
  type TailscaleSecureAccessSystemTaskStepId,
  type TailscaleSecureAccessTaskParams,
  type TailscaleSecureAccessTaskResult,
  type TailscaleSecureAccessTaskSpec,
} from './tailscaleSecureAccessTaskContract.js';

export {
  classifySetupPairingRequirement,
  createSetupPairingPromptData,
  createSetupServiceConsentPromptData,
  parseSetupPairingPromptData,
  parseSetupServiceConsentPromptData,
  SETUP_PAIRING_PROMPT_KIND,
  SETUP_SERVICE_CONSENT_PROMPT_KIND,
  SETUP_THIS_COMPUTER_SYSTEM_TASK_KIND,
  type SetupCliProvenance,
  type SetupPairingPromptPayload,
  type SetupPairingRequirement,
  type SetupServiceConsentPromptPayload,
} from './setupThisComputerTaskContract.js';
