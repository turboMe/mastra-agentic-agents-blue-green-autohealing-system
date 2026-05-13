/**
 * Feature flags for the jcode-inspired Mastra harness rollout.
 *
 * Flags are intentionally read at call time so local runs can change process.env
 * before invoking a harness component in tests or scripts.
 */

export const HARNESS_FEATURE_FLAG_NAMES = [
  'FEATURE_CODING_PRECONTEXT',
  'FEATURE_ASYNC_SEMANTIC_MEMORY',
  'FEATURE_FILE_ACTIVITY_LEDGER',
  'FEATURE_CODE_OUTLINE',
  'FEATURE_BACKGROUND_TASKS',
  'FEATURE_SOFT_INTERRUPTS',
  'FEATURE_MASTRA_HARNESS',
  'FEATURE_TOOL_ENVELOPE',
  'FEATURE_OUTPUT_COMPACTION',
  'FEATURE_HARNESS_POLICY',
  'FEATURE_HARNESS_REPLAY',
] as const;

export type HarnessFeatureFlagName = typeof HARNESS_FEATURE_FLAG_NAMES[number];

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

export function isHarnessFeatureEnabled(
  flagName: HarnessFeatureFlagName,
  defaultValue = false,
): boolean {
  return parseBooleanEnv(process.env[flagName], defaultValue);
}

export function getHarnessFeatureFlags(): Record<HarnessFeatureFlagName, boolean> {
  return Object.fromEntries(
    HARNESS_FEATURE_FLAG_NAMES.map((flagName) => [
      flagName,
      isHarnessFeatureEnabled(flagName),
    ]),
  ) as Record<HarnessFeatureFlagName, boolean>;
}
