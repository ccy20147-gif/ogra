import { describe, it, expect, beforeEach } from 'vitest';
import { AuditService } from '../../src/core/audit-service';
import { ProviderService, ProviderRecord } from '../../src/core/provider-service';

describe('ProviderService', () => {
  let providerService: ProviderService;
  let auditService: AuditService;

  beforeEach(() => {
    auditService = new AuditService();
    providerService = new ProviderService(auditService);
  });

  it('should have default Ollama provider', async () => {
    const { providers, models } = await providerService.list();
    expect(providers.length).toBeGreaterThanOrEqual(1);
    const ollama = providers.find(p => p.id === 'ollama_local');
    expect(ollama).toBeTruthy();
    expect(ollama!.kind).toBe('ollama');
    expect(ollama!.isLocal).toBe(true);
  });

  it('should have default models', async () => {
    const { models } = await providerService.list();
    expect(models.length).toBeGreaterThanOrEqual(1);
    const qwen = models.find(m => m.id === 'ollama_qwen');
    expect(qwen).toBeTruthy();
    expect(qwen!.name).toBe('qwen2.5');
  });

  it('should register OpenAI-compatible providers', async () => {
    const provider = await providerService.addOpenAICompatible({
      name: 'Test OpenAI',
      endpoint: 'https://api.openai.com/v1',
      isLocal: false,
    });

    expect(provider.id).toBeTruthy();
    expect(provider.isLocal).toBe(false);
    expect(provider.endpoint).toBe('https://api.openai.com/v1');
  });

  it('should get a provider by ID', async () => {
    const provider = await providerService.getProvider('ollama_local');
    expect(provider.id).toBe('ollama_local');
  });

  it('should throw PROVIDER_NOT_FOUND for unknown provider', async () => {
    await expect(providerService.getProvider('nonexistent'))
      .rejects.toThrow('Provider nonexistent not found');
  });

  it('should get local providers only', () => {
    const localProviders = providerService.getLocalProviders();
    expect(localProviders.length).toBeGreaterThanOrEqual(1);
    expect(localProviders.every(p => p.isLocal)).toBe(true);
  });
});
