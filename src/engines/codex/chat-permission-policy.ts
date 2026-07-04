import type { CodexBotConfig, CodexChatPermissionPolicy } from '../../config.js';

export interface ResolvedCodexChatConfig {
  config: CodexBotConfig;
  policySource: 'chat' | 'default' | 'none';
}

const stripChatPermissions = (config: CodexBotConfig): CodexBotConfig => {
  const { chatPermissions: _chatPermissions, ...rest } = config;
  return rest;
};

const applyPolicy = (base: CodexBotConfig, policy: CodexChatPermissionPolicy): CodexBotConfig => {
  const merged: CodexBotConfig = { ...base, ...policy };

  if (policy.dangerouslyBypassApprovalsAndSandbox !== true) {
    merged.dangerouslyBypassApprovalsAndSandbox = false;
  }

  if (merged.sandbox && merged.sandbox !== 'danger-full-access') {
    merged.dangerouslyBypassApprovalsAndSandbox = false;
  }

  return merged;
};

export const resolveCodexChatConfig = (
  codexConfig: CodexBotConfig,
  chatId: string | undefined,
): ResolvedCodexChatConfig => {
  const base = stripChatPermissions(codexConfig);
  const chatPolicy = chatId ? codexConfig.chatPermissions?.chats?.[chatId] : undefined;

  if (chatPolicy) {
    return {
      config: applyPolicy(base, chatPolicy),
      policySource: 'chat',
    };
  }

  const defaultPolicy = codexConfig.chatPermissions?.default;
  if (defaultPolicy) {
    return {
      config: applyPolicy(base, defaultPolicy),
      policySource: 'default',
    };
  }

  return {
    config: base,
    policySource: 'none',
  };
};
