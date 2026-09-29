/**
 * Data-only detection rules. Adding a provider means adding a row here — no
 * code changes. Each rule names a pi-ai provider id, a key shape, and a
 * confidence: `exact` shapes are unique to one vendor, `likely` shapes are
 * shared with others (e.g. bare `sk-`) and should be confirmed by a probe.
 *
 * Order matters only for readability; detection evaluates every rule and
 * ranks the matches by confidence, then by rule specificity (pattern length).
 *
 * @module dsh-llm-router/rules
 */

export type Confidence = 'exact' | 'likely' | 'weak'

export interface KeyRule {
  /** pi-ai provider id the key belongs to. */
  provider: string
  /** Pattern tested against the trimmed key. */
  pattern: RegExp
  confidence: Confidence
}

export interface ProbeSpec {
  /** URL that answers 2xx for a valid key and 401/403 otherwise. */
  url: string
  /** How the key is presented. */
  auth: 'bearer' | 'x-api-key' | 'query-key'
  headers?: Record<string, string>
}

export const KEY_RULES: readonly KeyRule[] = [
  { provider: 'anthropic', pattern: /^sk-ant-[\w-]{20,}$/, confidence: 'exact' },
  { provider: 'openrouter', pattern: /^sk-or-(v1-)?[\w-]{20,}$/, confidence: 'exact' },
  { provider: 'openai', pattern: /^sk-(proj|svcacct|admin)-[\w-]{20,}$/, confidence: 'exact' },
  { provider: 'google', pattern: /^AIza[\w-]{35}$/, confidence: 'exact' },
  { provider: 'groq', pattern: /^gsk_\w{20,}$/, confidence: 'exact' },
  { provider: 'xai', pattern: /^xai-\w{20,}$/, confidence: 'exact' },
  { provider: 'huggingface', pattern: /^hf_\w{20,}$/, confidence: 'exact' },
  { provider: 'nvidia', pattern: /^nvapi-[\w-]{20,}$/, confidence: 'exact' },
  { provider: 'cerebras', pattern: /^csk-\w{20,}$/, confidence: 'exact' },
  { provider: 'fireworks', pattern: /^fw_\w{20,}$/, confidence: 'exact' },
  { provider: 'amazon-bedrock', pattern: /^(AKIA|ASIA)[A-Z0-9]{16}$/, confidence: 'exact' },
  // Legacy OpenAI user keys: sk- + 48 alphanumerics (often containing T3BlbkFJ).
  { provider: 'openai', pattern: /^sk-\w*T3BlbkFJ\w*$/, confidence: 'exact' },
  { provider: 'openai', pattern: /^sk-[A-Za-z0-9]{48}$/, confidence: 'likely' },
  // Bare `sk-` + 32 hex is shared by DeepSeek, Moonshot, and several gateways.
  { provider: 'deepseek', pattern: /^sk-[a-f0-9]{32}$/, confidence: 'likely' },
  { provider: 'moonshotai', pattern: /^sk-[A-Za-z0-9]{32,64}$/, confidence: 'weak' },
  { provider: 'together', pattern: /^(tgp_v1_[\w-]{20,}|[a-f0-9]{64})$/, confidence: 'likely' },
  { provider: 'mistral', pattern: /^[A-Za-z0-9]{32}$/, confidence: 'weak' },
  { provider: 'openai', pattern: /^sk-[\w-]{20,}$/, confidence: 'weak' },
  { provider: 'deepseek', pattern: /^sk-[\w-]{20,}$/, confidence: 'weak' },
]

/**
 * Env-var name hints. When a key arrives through a conventionally named
 * variable the name is at least as strong as the shape.
 */
export const ENV_HINTS: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  GEMINI_API_KEY: 'google',
  GOOGLE_API_KEY: 'google',
  GOOGLE_GENERATIVE_AI_API_KEY: 'google',
  DEEPSEEK_API_KEY: 'deepseek',
  OPENROUTER_API_KEY: 'openrouter',
  GROQ_API_KEY: 'groq',
  XAI_API_KEY: 'xai',
  MISTRAL_API_KEY: 'mistral',
  TOGETHER_API_KEY: 'together',
  FIREWORKS_API_KEY: 'fireworks',
  CEREBRAS_API_KEY: 'cerebras',
  HF_TOKEN: 'huggingface',
  HUGGINGFACE_API_KEY: 'huggingface',
  NVIDIA_API_KEY: 'nvidia',
  MOONSHOT_API_KEY: 'moonshotai',
  MINIMAX_API_KEY: 'minimax',
  ZAI_API_KEY: 'zai',
  AWS_ACCESS_KEY_ID: 'amazon-bedrock',
}

/** Endpoints used to confirm an ambiguous key. Read-only, zero-cost calls. */
export const PROBES: Readonly<Record<string, ProbeSpec>> = {
  openai: { url: 'https://api.openai.com/v1/models', auth: 'bearer' },
  deepseek: { url: 'https://api.deepseek.com/models', auth: 'bearer' },
  moonshotai: { url: 'https://api.moonshot.ai/v1/models', auth: 'bearer' },
  mistral: { url: 'https://api.mistral.ai/v1/models', auth: 'bearer' },
  together: { url: 'https://api.together.xyz/v1/models', auth: 'bearer' },
  groq: { url: 'https://api.groq.com/openai/v1/models', auth: 'bearer' },
  xai: { url: 'https://api.x.ai/v1/models', auth: 'bearer' },
  openrouter: { url: 'https://openrouter.ai/api/v1/key', auth: 'bearer' },
  cerebras: { url: 'https://api.cerebras.ai/v1/models', auth: 'bearer' },
  fireworks: { url: 'https://api.fireworks.ai/inference/v1/models', auth: 'bearer' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', auth: 'bearer' },
  huggingface: { url: 'https://huggingface.co/api/whoami-v2', auth: 'bearer' },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    auth: 'x-api-key',
    headers: { 'anthropic-version': '2023-06-01' },
  },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'query-key' },
}
