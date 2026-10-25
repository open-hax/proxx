import { kernels } from "./cljs-kernels.js";

const constants = kernels.tenantApiKeyConstants();

export const DEFAULT_TENANT_ID = constants.defaultTenantId as "default";
export const TENANT_API_KEY_PREFIX = constants.apiKeyPrefix as "ohpk_";
export const TENANT_API_KEY_VISIBLE_PREFIX_LENGTH = constants.visiblePrefixLength;

export const normalizeTenantId = (value: string): string => kernels.normalizeTenantId(value);

export const generateTenantApiKey = (): string => kernels.generateTenantApiKey();

export const buildTenantApiKeyPrefix = (token: string): string => kernels.buildTenantApiKeyPrefix(token);

export const hashTenantApiKey = (token: string, pepper: string): string => kernels.hashTenantApiKey(token, pepper);
