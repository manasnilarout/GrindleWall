export type ProviderKind = 'realtime' | 'stt' | 'llm' | 'tts';

export interface ModelEntry {
  id: string;
  name: string;
  note?: string;
}

export interface ProviderEntry {
  id: string;
  name: string;
  kind: ProviderKind;
  implemented: boolean;
  registered: boolean;
  ready: boolean;
  envKeys: string[];
  missingEnv: string[];
  models: ModelEntry[];
  voices?: ModelEntry[];
  languages?: ModelEntry[];
  docs?: string;
}

export interface CatalogResponse {
  sampleRate: number;
  providers: ProviderEntry[];
}

export async function fetchCatalog(): Promise<CatalogResponse> {
  const res = await fetch('/api/catalog');
  if (!res.ok) throw new Error(`Catalog request failed: ${res.status}`);
  return res.json();
}
