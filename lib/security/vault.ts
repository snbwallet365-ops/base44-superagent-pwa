export type VaultData = {
  browserUseKeys: string[];
  base44Keys: string[];
  base44AgentId: string;
  base44AgentUrl: string;
  openaiKeys: string[];
  anthropicKeys: string[];
  geminiKeys: string[];
  customKeys: string[];
  customBaseUrl: string;
  customModel: string;
};

export const emptyVault: VaultData = {
  browserUseKeys: [], base44Keys: [], base44AgentId: "", base44AgentUrl: "",
  openaiKeys: [], anthropicKeys: [], geminiKeys: [], customKeys: [], customBaseUrl: "", customModel: "",
};

type SealedVault = { version: 1; salt: string; iv: string; ciphertext: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveKey(passphrase: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 310_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealVault(data: VaultData, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(data)));
  return JSON.stringify({ version: 1, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) } satisfies SealedVault);
}

export async function openVault(serialized: string, passphrase: string): Promise<VaultData> {
  const sealed = JSON.parse(serialized) as SealedVault;
  if (sealed.version !== 1) throw new Error("Unsupported vault format.");
  const key = await deriveKey(passphrase, fromBase64(sealed.salt));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.ciphertext));
  return { ...emptyVault, ...JSON.parse(decoder.decode(plaintext)) } as VaultData;
}
