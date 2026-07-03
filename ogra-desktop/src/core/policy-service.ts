import { DataClassification } from '../shared/types';
import { AuditService } from './audit-service';
import crypto from 'crypto';

export interface PolicyDefinition {
  id: string;
  name: string;
  version: number;
  contentYaml: string;
  contentHash: string;
  enabled: boolean;
  createdAt: string;
}

export interface PolicyMatch {
  dataClassification?: DataClassification;
  requestedCompute?: 'local' | 'cloud';
  requestedOperation?: string;
  providerId?: string;
  modelId?: string;
}

export interface PolicyRoute {
  allowedCompute?: 'local' | 'cloud' | 'hybrid';
  cloudUpload?: boolean;
  requireRedactionPreview?: boolean;
  requireUserApproval?: boolean;
  allowedModels?: string[];
}

export interface PolicyRule {
  name: string;
  match: PolicyMatch;
  route: PolicyRoute;
}

export interface PolicyEvaluationResult {
  matchedRules: Array<{ name: string; reason: string }>;
  decision: 'allow' | 'require_approval' | 'redact' | 'local_only' | 'blocked';
  reasons: string[];
  requiredApprovals: string[];
  route: string;
}

export interface PolicyEvaluationInput {
  workspaceId: string;
  workspaceDefaultClassification?: DataClassification;
  dataClassification: DataClassification;
  knowledgeBaseClassification?: DataClassification;
  providerId?: string;
  modelId?: string;
  providerIsLocal?: boolean;
  providerDataRetentionPolicy?: 'none' | 'zero_retention' | 'limited' | 'indefinite';
  providerTrainingOptOut?: boolean;
  requestedOperation?: string;
  requestedCompute?: 'local' | 'cloud';
  requiresCloud?: boolean;
  hasUserApproval?: boolean;
  agentId?: string;
  /** Agent manifest as JSON string — contains capability declarations */
  agentManifest?: string;
  /** Agent manifest permission flags — used for agent-level policy evaluation */
  agentPermissions?: {
    canUseCloud: boolean;
    canWriteToDisk: boolean;
    canAccessNetwork: boolean;
    allowedTools?: string[];
  };
  /** Specific tools the agent is requesting to use this run */
  requestedTools?: string[];
  hasPromptInjectionWarning?: boolean;
}

/**
 * Policy Engine for Ogra.
 *
 * Evaluates deterministic rules against run inputs.
 * Priority: Restricted/Confidential > deny > user preference > workspace > file > tool > approval > default.
 * No matching policy -> local-only or blocked.
 */
export class PolicyService {
  private policies: Map<string, PolicyRule[]> = new Map();
  private policyIdCounter = 0;

  constructor(private auditService: AuditService) {
    this.initializeDefaultPolicies();
  }

  private initializeDefaultPolicies(): void {
    this.addPolicy('confidential-local-only', {
      name: 'confidential-local-only',
      match: { dataClassification: DataClassification.Confidential },
      route: { allowedCompute: 'local', cloudUpload: false },
    });

    this.addPolicy('restricted-local-allowlist', {
      name: 'restricted-local-allowlist',
      match: { dataClassification: DataClassification.Restricted },
      route: {
        allowedCompute: 'local',
        allowedModels: ['local:qwen', 'local:llama'],
        cloudUpload: false,
      },
    });

    this.addPolicy('internal-redacted-cloud', {
      name: 'internal-redacted-cloud',
      match: { dataClassification: DataClassification.Internal, requestedCompute: 'cloud' },
      route: { requireRedactionPreview: true, requireUserApproval: true },
    });

    this.addPolicy('public-cloud-allowed', {
      name: 'public-cloud-allowed',
      match: { dataClassification: DataClassification.Public, requestedCompute: 'cloud' },
      route: { allowedCompute: 'cloud' },
    });
  }

  private addPolicy(name: string, rule: PolicyRule): void {
    this.policyIdCounter++;
    const yaml = this.ruleToYaml(rule);
    this.policies.set(name, [rule]);
  }

  private ruleToYaml(rule: PolicyRule): string {
    return `name: ${rule.name}\nmatch:\n  data_classification: ${rule.match.dataClassification}\nroute:\n  allowed_compute: ${rule.route.allowedCompute}\n`;
  }

  async evaluate(input: PolicyEvaluationInput): Promise<PolicyEvaluationResult> {
    const matchedRules: Array<{ name: string; reason: string }> = [];
    const reasons: string[] = [];
    const requiredApprovals: string[] = [];
    let decision: 'allow' | 'require_approval' | 'redact' | 'local_only' | 'blocked' = 'allow';
    let route = 'local';

    // === Compute effective classification ===
    // Fallback to workspaceDefaultClassification if dataClassification is unset
    let effectiveClassification = input.dataClassification ?? input.workspaceDefaultClassification;
    // Apply knowledgeBaseClassification as high-water mark
    if (input.knowledgeBaseClassification) {
      const classificationOrder: Record<string, number> = {
        [DataClassification.Public]: 0,
        [DataClassification.Internal]: 1,
        [DataClassification.Confidential]: 2,
        [DataClassification.Restricted]: 3,
      };
      const dataLevel = classificationOrder[effectiveClassification] ?? -1;
      const kbLevel = classificationOrder[input.knowledgeBaseClassification] ?? -1;
      if (kbLevel > dataLevel) {
        effectiveClassification = input.knowledgeBaseClassification;
        matchedRules.push({ name: 'kb-high-water-mark', reason: `Knowledge base classification ${input.knowledgeBaseClassification} elevated effective classification` });
        reasons.push(`Using knowledge base classification ${input.knowledgeBaseClassification} as high-water mark (higher than data classification ${input.dataClassification})`);
      }
    }

    // === Prompt injection check (blocks cloud routing if detected) ===
    if (input.hasPromptInjectionWarning) {
      matchedRules.push({ name: 'prompt-injection-detected', reason: 'Prompt injection warning flagged' });
      reasons.push('Prompt injection detected: restricting to local compute');
      if (input.requestedCompute === 'cloud' || input.requiresCloud) {
        return { matchedRules, decision: 'blocked', reasons, requiredApprovals, route: 'blocked' };
      }
    }

    // === Agent manifest validation (checks requestedTools against manifest capabilities) ===
    if (input.agentManifest && input.requestedTools && input.requestedTools.length > 0) {
      try {
        const manifest = JSON.parse(input.agentManifest);
        const manifestTools: string[] = manifest.capabilities?.tools || manifest.tools || [];
        if (Array.isArray(manifestTools) && manifestTools.length > 0) {
          for (const tool of input.requestedTools) {
            if (!manifestTools.includes(tool)) {
              matchedRules.push({ name: 'agent-manifest-tool-blocked', reason: `Tool "${tool}" not in agent manifest capabilities` });
              reasons.push(`Requested tool "${tool}" is not declared in agent manifest capabilities`);
              return { matchedRules, decision: 'blocked', reasons, requiredApprovals, route: 'blocked' };
            }
          }
        }
      } catch {
        matchedRules.push({ name: 'agent-manifest-invalid', reason: 'Agent manifest JSON is malformed' });
        reasons.push('Agent manifest is not valid JSON; blocking for safety');
        return { matchedRules, decision: 'blocked', reasons, requiredApprovals, route: 'blocked' };
      }
    }

    // Priority 0: Agent permissions — check before data classification
    if (input.agentPermissions) {
      const perms = input.agentPermissions;

      // Agent blocked from cloud entirely
      if (!perms.canUseCloud && (input.requestedCompute === 'cloud' || input.requiresCloud)) {
        matchedRules.push({ name: 'agent-no-cloud', reason: 'Agent lacks cloud permission' });
        reasons.push(`Agent ${input.agentId || 'unknown'} is not permitted to use cloud compute`);
        return { matchedRules, decision: 'blocked', reasons, requiredApprovals, route: 'blocked' };
      }

      // Check requested tools against allowed tools list
      if (input.requestedTools && input.requestedTools.length > 0 && perms.allowedTools) {
        for (const tool of input.requestedTools) {
          if (!perms.allowedTools.includes(tool)) {
            matchedRules.push({ name: 'agent-tool-restricted', reason: `Tool "${tool}" not in agent allowlist` });
            reasons.push(`Agent is not permitted to use tool: "${tool}"`);
            return { matchedRules, decision: 'blocked', reasons, requiredApprovals, route: 'blocked' };
          }
        }
      }

      // Network access requires approval
      if (perms.canAccessNetwork && input.requestedCompute !== 'local') {
        matchedRules.push({ name: 'agent-network-approval', reason: 'Agent network access requires approval' });
        requiredApprovals.push('allow_agent_network');
        if (!input.hasUserApproval) {
          decision = 'require_approval';
          reasons.push('Agent network access requires user approval before proceeding');
        } else {
          reasons.push('Agent network access approved by user');
        }
      }
    }

    // Priority 1: Restricted / Confidential rules
    const classification = effectiveClassification;
    if (classification === DataClassification.Restricted) {
      const restrictedPolicy = this.policies.get('restricted-local-allowlist');
      if (restrictedPolicy) {
        matchedRules.push({ name: 'restricted-local-allowlist', reason: 'Restricted data detected' });
        reasons.push('Restricted data: must use local allowlisted models');
        if (input.requestedCompute === 'cloud' || input.requiresCloud) {
          decision = 'blocked';
          route = 'blocked';
          matchedRules.push({ name: 'restricted-local-allowlist', reason: 'Cloud upload blocked for Restricted data' });
          reasons.push('Cloud upload is prohibited for Restricted data. Ordinary user approval cannot override.');
          return { matchedRules, decision, reasons, requiredApprovals, route };
        }
        decision = 'local_only';
        route = 'local';
        return { matchedRules, decision, reasons, requiredApprovals, route };
      }
    }

    if (classification === DataClassification.Confidential) {
      const confidentialPolicy = this.policies.get('confidential-local-only');
      if (confidentialPolicy) {
        matchedRules.push({ name: 'confidential-local-only', reason: 'Confidential data detected' });
        reasons.push('Confidential data: local-only by default in Alpha');
        if (input.requestedCompute === 'cloud' || input.requiresCloud) {
          // If provider is local, allow local routing instead of blocking
          if (input.providerIsLocal) {
            decision = 'allow';
            route = 'local';
            reasons.push('Confidential data with local provider: allowing local compute');
            return { matchedRules, decision, reasons, requiredApprovals, route };
          }
          decision = 'blocked';
          route = 'blocked';
          reasons.push('Cloud upload blocked for Confidential data in Alpha');
          return { matchedRules, decision, reasons, requiredApprovals, route };
        }
        decision = 'local_only';
        route = 'local';
        reasons.push('Rerouting to local model for Confidential data protection');
        return { matchedRules, decision, reasons, requiredApprovals, route };
      }
    }

    // Priority 2: Internal with cloud compute
    if (classification === DataClassification.Internal && (input.requestedCompute === 'cloud' || input.requiresCloud)) {
      const internalPolicy = this.policies.get('internal-redacted-cloud');
      if (internalPolicy) {
        matchedRules.push({ name: 'internal-redacted-cloud', reason: 'Internal data with cloud request' });
        reasons.push('Internal data cloud request: redaction and approval required');
        if (input.hasUserApproval) {
          // Check provider data retention policy
          if (input.providerDataRetentionPolicy && input.providerDataRetentionPolicy !== 'zero_retention' && input.providerDataRetentionPolicy !== 'none') {
            matchedRules.push({ name: 'provider-retention-cloud-restriction', reason: `Provider data retention policy is ${input.providerDataRetentionPolicy}` });
            if (input.providerDataRetentionPolicy === 'indefinite') {
              reasons.push('Provider retains data indefinitely: cloud blocked for Internal data');
              return { matchedRules, decision: 'blocked', reasons, requiredApprovals, route: 'blocked' };
            }
            // limited retention: require additional approval
            reasons.push(`Provider data retention policy (${input.providerDataRetentionPolicy}) requires additional approval for cloud`);
            requiredApprovals.push('allow_provider_retention_cloud');
            return { matchedRules, decision: 'require_approval', reasons, requiredApprovals, route: 'blocked' };
          }
          // Check provider training opt-out
          if (input.providerTrainingOptOut === false) {
            matchedRules.push({ name: 'provider-training-cloud-restriction', reason: 'Provider may use data for training' });
            reasons.push('Provider may use data for training: cloud blocked for Internal data');
            return { matchedRules, decision: 'blocked', reasons, requiredApprovals, route: 'blocked' };
          }
          decision = 'allow';
          route = 'hybrid';
          reasons.push('User approval provided, redaction required before cloud');
        } else {
          decision = 'require_approval';
          route = 'blocked';
          requiredApprovals.push('allow_internal_redacted_cloud');
          reasons.push('User approval and redaction preview required for Internal cloud upload');
          return { matchedRules, decision, reasons, requiredApprovals, route };
        }
        return { matchedRules, decision, reasons, requiredApprovals, route };
      }
    }

    // Priority 3: Public with cloud
    if (classification === DataClassification.Public && (input.requestedCompute === 'cloud' || input.requiresCloud)) {
      const publicPolicy = this.policies.get('public-cloud-allowed');
      if (publicPolicy) {
        matchedRules.push({ name: 'public-cloud-allowed', reason: 'Public data cloud request' });
        reasons.push('Public data: cloud allowed');
        if (input.providerId) {
          // Check provider data retention policy even for Public data
          if (input.providerDataRetentionPolicy === 'indefinite') {
            matchedRules.push({ name: 'provider-retention-indefinite', reason: 'Provider retains data indefinitely' });
            reasons.push('Provider retains data indefinitely: additional approval required');
            requiredApprovals.push('allow_indefinite_retention_cloud');
            if (!input.hasUserApproval) {
              return { matchedRules, decision: 'require_approval', reasons, requiredApprovals, route: 'blocked' };
            }
            reasons.push('User approved indefinite retention cloud routing');
          }
          // Check provider training opt-out
          if (input.providerTrainingOptOut === false) {
            matchedRules.push({ name: 'provider-training-public-restriction', reason: 'Provider may use data for training' });
            reasons.push('Provider may use data for training: additional approval required');
            requiredApprovals.push('allow_training_cloud');
            if (!input.hasUserApproval) {
              return { matchedRules, decision: 'require_approval', reasons, requiredApprovals, route: 'blocked' };
            }
            reasons.push('User approved cloud routing despite training data use');
          }
          decision = 'allow';
          route = 'cloud';
          return { matchedRules, decision, reasons, requiredApprovals, route };
        }
      }
    }

    // Default: local-only
    if (decision === 'allow' && route === 'local') {
      reasons.push('No matching policy or unknown classification: defaulting to local-only');
    }

    return { matchedRules, decision, reasons, requiredApprovals, route };
  }

  async dryRun(input: PolicyEvaluationInput): Promise<PolicyEvaluationResult> {
    return this.evaluate(input);
  }

  async list(): Promise<PolicyDefinition[]> {
    const result: PolicyDefinition[] = [];
    for (const [name, rules] of this.policies) {
      result.push({
        id: `pol_${name}`,
        name,
        version: 1,
        contentYaml: rules.map(r => this.ruleToYaml(r)).join('\n'),
        contentHash: crypto.createHash('sha256').update(name).digest('hex'),
        enabled: true,
        createdAt: new Date().toISOString(),
      });
    }
    return result;
  }

  getPolicyVersionHash(): string {
    const allNames = Array.from(this.policies.keys()).sort().join(',');
    return crypto.createHash('sha256').update(allNames).digest('hex');
  }
}
