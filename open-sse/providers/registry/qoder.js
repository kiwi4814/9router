import {
  QODER_OPENAPI_BASE,
  QODER_CENTER_BASE,
  QODER_CHAT_BASE,
  QODER_CHAT_URL,
  QODER_QUOTA_USAGE_URL,
  QODER_DEVICE_TOKEN_URL,
  QODER_REFRESH_TOKEN_URL,
  QODER_USERINFO_URL,
  QODER_LOGIN_URL,
} from "../../shared/qoder/constants.js";

function qoderEnvMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const QODER_STREAM_TIMEOUT_MS = qoderEnvMs("QODER_STREAM_TIMEOUT_MS", 600000);
const QODER_STALL_TIMEOUT_MS = qoderEnvMs("QODER_STALL_TIMEOUT_MS", QODER_STREAM_TIMEOUT_MS);

export default {
  id: "qoder",
  priority: 30,
  alias: "qd",
  uiAlias: "qd",
  display: {
    name: "Qoder",
    icon: "water_drop",
    color: "#EC4899",
    website: "https://qoder.com",
    notice: {
      signupUrl: "https://qoder.com",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "Personal Access Token (pt-...) từ https://qoder.com/account/integrations",
  transport: {
    baseUrl: QODER_CHAT_URL,
    headers: {},
    timeoutMs: QODER_STREAM_TIMEOUT_MS,
    stallTimeoutMs: QODER_STALL_TIMEOUT_MS,
    usage: {
      url: QODER_QUOTA_USAGE_URL,
    },
  },
  models: [
    { id: "ultimate", name: "Ultimate" },
    { id: "auto", name: "Auto" },
    { id: "performance", name: "Performance" },
    { id: "efficient", name: "Efficient" },
    { id: "qmodel_preview", name: "Qwen3.8-Max-Preview" },
    { id: "qmodel_latest", name: "Qwen3.7-Max" },
    { id: "qmodel", name: "Qwen3.7-Plus" },
    { id: "kmodel_latest", name: "Kimi-K3" },
    { id: "kmodel", name: "Kimi-K2.7-Code" },
    { id: "gm51model", name: "GLM-5.2" },
    { id: "dmodel", name: "DeepSeek-V4-Pro" },
    { id: "dfmodel", name: "DeepSeek-V4-Flash" },
    { id: "mmodel", name: "MiniMax-M3" },
  ],
  oauth: {
    openApiBaseUrl: QODER_OPENAPI_BASE,
    centerBaseUrl: QODER_CENTER_BASE,
    chatBaseUrl: QODER_CHAT_BASE,
    deviceTokenUrl: QODER_DEVICE_TOKEN_URL,
    refreshUrl: QODER_REFRESH_TOKEN_URL,
    userInfoUrl: QODER_USERINFO_URL,
    quotaUsageUrl: QODER_QUOTA_USAGE_URL,
    loginUrl: QODER_LOGIN_URL,
  },
  features: {
    usage: true,
    // PAT (apikey) connections also carry quota usage (via job-token exchange).
    usageApikey: true,
  },
};
