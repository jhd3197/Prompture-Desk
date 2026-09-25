// Provider identity: which provider a model string belongs to, its display
// name, brand colour and logo (curated LobeHub icons, bundled offline).
import { ICON_SVG, PROVIDER_ICON } from "./providerIconData";

interface ProviderInfo { name: string; brand: string }

const KNOWN: Record<string, ProviderInfo> = {
  claude: { name: "Claude", brand: "#d97757" },
  anthropic: { name: "Claude", brand: "#d97757" },
  openai: { name: "OpenAI", brand: "#10a37f" },
  gemini: { name: "Gemini", brand: "#3f7de8" },
  google: { name: "Gemini", brand: "#3f7de8" },
  vertex: { name: "Vertex AI", brand: "#4285f4" },
  deepseek: { name: "DeepSeek", brand: "#4d6bfe" },
  mistral: { name: "Mistral", brand: "#f0621f" },
  qwen: { name: "Qwen", brand: "#615ced" },
  groq: { name: "Groq", brand: "#f55036" },
  grok: { name: "Grok", brand: "#9ca3af" },
  xai: { name: "Grok", brand: "#9ca3af" },
  moonshot: { name: "Kimi", brand: "#1783ff" },
  kimi: { name: "Kimi", brand: "#1783ff" },
  ollama: { name: "Ollama", brand: "#9ca3af" },
  openrouter: { name: "OpenRouter", brand: "#6467f2" },
  lmstudio: { name: "LM Studio", brand: "#7c5cff" },
  zai: { name: "Z.ai", brand: "#3859ff" },
  zhipu: { name: "Z.ai", brand: "#3859ff" },
  cohere: { name: "Cohere", brand: "#39594d" },
  perplexity: { name: "Perplexity", brand: "#20808d" },
  huggingface: { name: "Hugging Face", brand: "#ffd21e" },
  hugging: { name: "Hugging Face", brand: "#ffd21e" },
  azure: { name: "Azure", brand: "#0078d4" },
  fireworks: { name: "Fireworks", brand: "#5019c5" },
  together: { name: "Together", brand: "#0f6fff" },
  cerebras: { name: "Cerebras", brand: "#f15a29" },
  minimax: { name: "MiniMax", brand: "#e2167e" },
  modelscope: { name: "ModelScope", brand: "#624aff" },
  sambanova: { name: "SambaNova", brand: "#ee7624" },
  bedrock: { name: "Bedrock", brand: "#ff9900" },
  nvidia: { name: "NVIDIA", brand: "#76b900" },
};

/** Provider id for a model string, matching the hub's rule. Virtual routes return null. */
export function providerOf(model: string | null | undefined): string | null {
  if (!model) return null;
  const parts = model.split("/");
  if (parts.length < 2 || ["combo", "auto", "fusion"].includes(parts[0])) return null;
  if (parts[0] === "openai_compatible" && parts.length >= 3) return parts[1];
  return parts[0];
}

export function providerName(id: string): string {
  return KNOWN[id]?.name ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export function providerBrand(id: string): string {
  return KNOWN[id]?.brand ?? "#6b7280";
}

/** The provider's logo on a rounded tile, or its initial when there is no logo. */
export function ProviderLogo({ id, size = 20, dim = false }: { id: string; size?: number; dim?: boolean }) {
  const svg = ICON_SVG[PROVIDER_ICON[id] ?? ""];
  return (
    <span
      className="plogo"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), opacity: dim ? 0.45 : 1 }}
      title={providerName(id)}
    >
      {svg ? (
        <span className="plogo-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <span className="plogo-letter" style={{ color: providerBrand(id), fontSize: Math.round(size * 0.5) }}>
          {providerName(id).charAt(0)}
        </span>
      )}
    </span>
  );
}
