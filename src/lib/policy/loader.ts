import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

import type { PolicyConfig } from "./types.js";
import type { PolicyEngine } from "./engine.js";
import { DEFAULT_POLICY_CONFIG } from "./types.js";
import { createPolicyEngine } from "./engine.js";

const POLICY_CONFIG_FILE_ENV = "PROXY_POLICY_CONFIG_FILE";

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

function mergeDeep<T extends object>(target: T, source: DeepPartial<T>): T {
  const result = { ...target };
  
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = target[key];
    
    if (
      sourceValue !== undefined
      && sourceValue !== null
      && typeof sourceValue === "object"
      && !Array.isArray(sourceValue)
      && targetValue !== undefined
      && targetValue !== null
      && typeof targetValue === "object"
      && !Array.isArray(targetValue)
    ) {
      (result as Record<string, unknown>)[key as string] = mergeDeep(
        targetValue as object,
        sourceValue as DeepPartial<object>,
      );
    } else if (sourceValue !== undefined) {
      (result as Record<string, unknown>)[key as string] = sourceValue;
    }
  }
  
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAccountOrderingRule(rule: unknown): boolean {
  if (!isObject(rule)) return false;
  if (typeof rule.kind !== "string") return false;
  
  switch (rule.kind) {
    case "prefer_plans":
    case "exclude_plans":
      return Array.isArray(rule.plans) && rule.plans.every((p) => typeof p === "string");
    case "prefer_free":
      return true;
    case "custom_weight":
      return isObject(rule.weights);
    default:
      return false;
  }
}

function validateModelRoutingRule(rule: unknown): boolean {
  if (!isObject(rule)) return false;
  if (typeof rule.modelPattern !== "string" && !(rule.modelPattern instanceof RegExp)) return false;

  if (rule.preferredProviders !== undefined && (!Array.isArray(rule.preferredProviders) || !rule.preferredProviders.every((p) => typeof p === "string"))) {
    return false;
  }

  if (rule.excludedProviders !== undefined && (!Array.isArray(rule.excludedProviders) || !rule.excludedProviders.every((p) => typeof p === "string"))) {
    return false;
  }
  
  if (rule.accountOrdering && !validateAccountOrderingRule(rule.accountOrdering)) {
    return false;
  }
  
  if (rule.requiresPaidPlan !== undefined && typeof rule.requiresPaidPlan !== "boolean") return false;
  if (rule.fallbackModels !== undefined && !Array.isArray(rule.fallbackModels)) return false;
  
  return true;
}

function validateStrategySelectionRule(rule: unknown): boolean {
  if (!isObject(rule)) return false;
  if (typeof rule.providerPattern !== "string" && !(rule.providerPattern instanceof RegExp)) return false;
  
  if (rule.preferredStrategies !== undefined && !Array.isArray(rule.preferredStrategies)) return false;
  if (rule.excludedStrategies !== undefined && !Array.isArray(rule.excludedStrategies)) return false;
  
  return true;
}

function validatePlanWeights(weights: unknown): boolean {
  if (!isObject(weights)) return false;
  const validPlanTypes = ["free", "plus", "pro", "team", "business", "enterprise", "unknown"];
  for (const [key, value] of Object.entries(weights)) {
    if (!validPlanTypes.includes(key)) return false;
    if (typeof value !== "number") return false;
  }
  return true;
}

function validateFallbackBehavior(fallback: unknown): boolean {
  if (!isObject(fallback)) return false;
  
  const numericFields = ["maxAttempts", "retryDelayMs", "retryBackoffMultiplier", "transientRetryCount"];
  for (const field of numericFields) {
    if (fallback[field] !== undefined && typeof fallback[field] !== "number") return false;
  }
  
  if (fallback.transientStatusCodes !== undefined && !Array.isArray(fallback.transientStatusCodes)) return false;
  
  const booleanFields = ["skipOnRateLimit", "skipOnModelNotFound", "skipOnAccountIncompatible", "skipOnServerError"];
  for (const field of booleanFields) {
    if (fallback[field] !== undefined && typeof fallback[field] !== "boolean") return false;
  }
  
  return true;
}

function validateModelConstraints(constraints: unknown): boolean {
  if (!isObject(constraints)) return false;
  
  for (const [, value] of Object.entries(constraints)) {
    if (!isObject(value)) return false;
    if ((value as Record<string, unknown>).requiresPlan !== undefined && !Array.isArray((value as Record<string, unknown>).requiresPlan)) return false;
    if ((value as Record<string, unknown>).excludesPlan !== undefined && !Array.isArray((value as Record<string, unknown>).excludesPlan)) return false;
  }
  
  return true;
}

function validatePolicyConfig(config: unknown, filePath: string): DeepPartial<PolicyConfig> {
  if (!isObject(config)) {
    throw new Error(`Policy config file ${filePath} must be a JSON object`);
  }
  
  if (config.version !== undefined && config.version !== "1.0") {
    throw new Error(`Policy config file ${filePath} must have version "1.0"`);
  }
  
  if (config.modelRouting !== undefined) {
    if (!isObject(config.modelRouting)) {
      throw new Error(`Policy config file ${filePath}: modelRouting must be an object`);
    }
    
    if ((config.modelRouting as Record<string, unknown>).rules !== undefined && !Array.isArray((config.modelRouting as Record<string, unknown>).rules)) {
      throw new Error(`Policy config file ${filePath}: modelRouting.rules must be an array`);
    }
    
    for (const rule of ((config.modelRouting as Record<string, unknown>).rules as unknown[]) ?? []) {
      if (!validateModelRoutingRule(rule)) {
        throw new Error(`Policy config file ${filePath}: invalid modelRouting rule`);
      }
    }
    
    if ((config.modelRouting as Record<string, unknown>).defaultAccountOrdering !== undefined
      && !validateAccountOrderingRule((config.modelRouting as Record<string, unknown>).defaultAccountOrdering)) {
      throw new Error(`Policy config file ${filePath}: invalid modelRouting.defaultAccountOrdering`);
    }
  }
  
  if (config.strategySelection !== undefined) {
    if (!isObject(config.strategySelection)) {
      throw new Error(`Policy config file ${filePath}: strategySelection must be an object`);
    }
    
    if ((config.strategySelection as Record<string, unknown>).rules !== undefined && !Array.isArray((config.strategySelection as Record<string, unknown>).rules)) {
      throw new Error(`Policy config file ${filePath}: strategySelection.rules must be an array`);
    }
    
    for (const rule of ((config.strategySelection as Record<string, unknown>).rules as unknown[]) ?? []) {
      if (!validateStrategySelectionRule(rule)) {
        throw new Error(`Policy config file ${filePath}: invalid strategySelection rule`);
      }
    }
    
    if ((config.strategySelection as Record<string, unknown>).defaultOrder !== undefined && !Array.isArray((config.strategySelection as Record<string, unknown>).defaultOrder)) {
      throw new Error(`Policy config file ${filePath}: strategySelection.defaultOrder must be an array`);
    }
  }
  
  if (config.fallback !== undefined && !validateFallbackBehavior(config.fallback)) {
    throw new Error(`Policy config file ${filePath}: invalid fallback configuration`);
  }
  
  if (config.accountPreferences !== undefined) {
    if (!isObject(config.accountPreferences)) {
      throw new Error(`Policy config file ${filePath}: accountPreferences must be an object`);
    }
    
    if ((config.accountPreferences as Record<string, unknown>).planWeights !== undefined && !validatePlanWeights((config.accountPreferences as Record<string, unknown>).planWeights)) {
      throw new Error(`Policy config file ${filePath}: invalid accountPreferences.planWeights`);
    }
    
    if ((config.accountPreferences as Record<string, unknown>).modelConstraints !== undefined && !validateModelConstraints((config.accountPreferences as Record<string, unknown>).modelConstraints)) {
      throw new Error(`Policy config file ${filePath}: invalid accountPreferences.modelConstraints`);
    }
  }
  
  return config as DeepPartial<PolicyConfig>;
}

export async function loadPolicyConfig(configPath?: string): Promise<PolicyConfig> {
  const filePath = configPath ?? process.env[POLICY_CONFIG_FILE_ENV];
  
  if (!filePath) {
    return DEFAULT_POLICY_CONFIG;
  }
  
  const resolvedPath = resolve(filePath);
  
  try {
    await access(resolvedPath);
  } catch {
    return DEFAULT_POLICY_CONFIG;
  }
  
  const content = await readFile(resolvedPath, "utf-8");
  let parsed: unknown;
  
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Policy config file ${resolvedPath} contains invalid JSON: ${error}`);
  }
  
  const validated = validatePolicyConfig(parsed, resolvedPath);
  return mergeDeep(DEFAULT_POLICY_CONFIG, validated);
}

export async function initializePolicyEngine(configPath?: string): Promise<PolicyEngine> {
  const config = await loadPolicyConfig(configPath);
  return createPolicyEngine(config);
}

export { DEFAULT_POLICY_CONFIG } from "./types.js";
