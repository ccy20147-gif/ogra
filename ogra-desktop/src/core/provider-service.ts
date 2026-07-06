import { AuditService } from './audit-service';
import { ProviderKind, RunEventType } from '../shared/types';
import { OgraError, OgraErrorCode } from '../shared/errors';

export interface ProviderRecord {
  id: string;
  kind: ProviderKind;
  name: string;
  endpoint: string;
  isLocal: boolean;
  dataRetentionPolicy?: string;
  trainingOptOut?: boolean;
  region?: string;
  zeroDataRetentionSupported?: boolean;
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  enabled: boolean;
}

export interface ModelRecord {
  id: string;
  providerId: string;
  name: string;
  displayName: string;
  modality: string;
  localOnly: boolean;
  enabled: boolean;
}

/**
 * Provider and Model registry service.
 *
 * Manages model providers and their associated models.
 * Provider metadata includes data retention, training opt-out,
 * region, and other risk-relevant fields.
 */
export class ProviderService {
  private providers: Map<string, ProviderRecord> = new Map();
  private models: Map<string, ModelRecord> = new Map();

  constructor(private auditService: AuditService) {
    this.initializeDefaults();
  }

  private initializeDefaults(): void {
    // Ollama default
    this.providers.set('ollama_local', {
      id: 'ollama_local',
      kind: ProviderKind.Ollama,
      name: 'Ollama',
      endpoint: 'http://localhost:11434',
      isLocal: true,
      supportsStreaming: true,
      supportsToolCalling: false,
      enabled: true,
    });

    this.models.set('ollama_qwen', {
      id: 'ollama_qwen',
      providerId: 'ollama_local',
      name: 'qwen2.5',
      displayName: 'Qwen 2.5 (Ollama)',
      modality: 'text',
      localOnly: true,
      enabled: true,
    });

    this.models.set('ollama_llama', {
      id: 'ollama_llama',
      providerId: 'ollama_local',
      name: 'llama3.2',
      displayName: 'Llama 3.2 (Ollama)',
      modality: 'text',
      localOnly: true,
      enabled: true,
    });
  }

  async list(): Promise<{ providers: ProviderRecord[]; models: ModelRecord[] }> {
    return {
      providers: Array.from(this.providers.values()),
      models: Array.from(this.models.values()),
    };
  }

  async getProvider(id: string): Promise<ProviderRecord> {
    const provider = this.providers.get(id);
    if (!provider) throw new OgraError(OgraErrorCode.PROVIDER_NOT_FOUND, `Provider ${id} not found`);
    return provider;
  }

  async getModel(id: string): Promise<ModelRecord> {
    const model = this.models.get(id);
    if (!model) throw new OgraError(OgraErrorCode.MODEL_NOT_FOUND, `Model ${id} not found`);
    return model;
  }

  async updateProvider(id: string, updates: Partial<ProviderRecord>): Promise<ProviderRecord> {
    const existing = await this.getProvider(id);
    const updated = { ...existing, ...updates };
    this.providers.set(id, updated);
    return updated;
  }

  async addOpenAICompatible(req: {
    name: string;
    endpoint: string;
    isLocal: boolean;
    dataRetentionPolicy?: string;
    region?: string;
    zeroDataRetentionSupported?: boolean;
  }): Promise<ProviderRecord> {
    const id = `provider_${Date.now()}`;
    const provider: ProviderRecord = {
      id,
      kind: ProviderKind.OpenAICompatible,
      name: req.name,
      endpoint: req.endpoint,
      isLocal: req.isLocal,
      dataRetentionPolicy: req.dataRetentionPolicy,
      region: req.region,
      zeroDataRetentionSupported: req.zeroDataRetentionSupported,
      supportsStreaming: true,
      supportsToolCalling: false,
      enabled: true,
    };
    this.providers.set(id, provider);
    return provider;
  }

  async testConnection(providerId: string): Promise<{ success: boolean; message: string }> {
    const provider = await this.getProvider(providerId);
    try {
      let endpoint: string;
      let headers: Record<string, string> = {};

      if (provider.kind === ProviderKind.Ollama) {
        endpoint = `${provider.endpoint}/api/tags`;
      } else {
        // OpenAI-compatible endpoint
        endpoint = `${provider.endpoint}/models`;
      }

      const response = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        return { success: true, message: 'Connection successful' };
      }
      return { success: false, message: `Provider returned ${response.status}` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${(err as Error).message}` };
    }
  }

  getLocalProviders(): ProviderRecord[] {
    return Array.from(this.providers.values()).filter(p => p.isLocal && p.enabled);
  }

  getCloudProviders(): ProviderRecord[] {
    return Array.from(this.providers.values()).filter(p => !p.isLocal && p.enabled);
  }
}
