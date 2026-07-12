"use client";

import { useCredentialMutations } from "~/app/dashboard/_components/credential-ui";
import { GenericProviderForm } from "~/app/dashboard/_components/generic-provider-form";
import {
  ProviderDirectory,
  type ProviderEntry,
} from "~/app/dashboard/_components/provider-directory";
import { api } from "~/trpc/react";
import {
  AnthropicSection,
  AwsSection,
  GeminiSection,
  OpenAISection,
} from "./provider-sections";

// The user's model-provider directory: every provider — the four with rich,
// dedicated forms (Anthropic, OpenAI, Gemini, Bedrock) and the ~90 gollm-proxied
// ones — presented as a card in one searchable, tier-free list. The four rich
// providers keep their bespoke forms (dual auth kinds, the AWS field set, the
// service-account textarea) as card bodies; the rest use the generic
// catalog-driven form.

export function UserProviderDirectory() {
  const utils = api.useUtils();
  const anthropic = api.account.anthropicStatus.useQuery();
  const openai = api.account.openaiStatus.useQuery();
  const gemini = api.account.geminiStatus.useQuery();
  const aws = api.account.awsStatus.useQuery();
  const { data: catalog } = api.account.customProviderCatalog.useQuery();
  const { data: configured } = api.account.customProviderStatus.useQuery();

  const { result, onSave, onRemove } = useCredentialMutations(() =>
    utils.account.customProviderStatus.invalidate(),
  );
  const setCustom = api.account.setCustomProvider.useMutation({
    onSuccess: () => onSave(),
  });
  const deleteCustom = api.account.deleteCustomProvider.useMutation({
    onSuccess: onRemove,
  });

  const configuredById = new Map(
    (configured ?? []).map((c) => [c.provider, c]),
  );

  const entries: ProviderEntry[] = [
    {
      id: "anthropic",
      label: "Anthropic",
      hint: "API key (sk-ant-…) or Claude subscription",
      accent: "purple",
      configured: !!(
        anthropic.data?.apiKeyMasked ?? anthropic.data?.oauthTokenMasked
      ),
      keywords: "claude opus sonnet haiku",
      priority: 100,
      body: <AnthropicSection hideHeading />,
    },
    {
      id: "openai",
      label: "OpenAI",
      hint: "API key (sk-…) or ChatGPT (Codex) sign-in",
      accent: "teal",
      configured: !!(
        openai.data?.apiKeyMasked ?? openai.data?.chatgptConfigured
      ),
      keywords: "gpt chatgpt codex",
      priority: 90,
      body: <OpenAISection hideHeading />,
    },
    {
      id: "gemini",
      label: "Gemini",
      hint: "Google Cloud service-account JSON",
      accent: "blue",
      configured: !!gemini.data?.configured,
      keywords: "google vertex",
      priority: 80,
      body: <GeminiSection hideHeading />,
    },
    {
      id: "bedrock",
      label: "AWS Bedrock",
      hint: "Access key + secret + region",
      accent: "orange",
      configured: !!aws.data?.configured,
      keywords: "aws amazon claude",
      priority: 70,
      body: <AwsSection hideHeading />,
    },
    ...(catalog ?? []).map(
      (c): ProviderEntry => ({
        id: c.id,
        label: c.label,
        accent: "sky",
        configured: configuredById.has(c.id),
        keywords: c.id,
        body: (
          <GenericProviderForm
            entry={c}
            configured={configuredById.get(c.id)}
            onSubmit={async (v) => {
              await setCustom.mutateAsync({
                provider: c.id,
                fields: v.fields,
                models: v.models,
              });
            }}
            savePending={setCustom.isPending}
            saveError={setCustom.error?.message}
            result={result}
            onRemove={() => deleteCustom.mutate({ provider: c.id })}
            removePending={deleteCustom.isPending}
          />
        ),
      }),
    ),
  ];

  return (
    <ProviderDirectory
      entries={entries}
      intro={
        <p className="text-xs text-white/40">
          Configure how your agents reach their model. Every provider Bandolier
          supports is here — search to find one, expand it to add credentials.
          Configured providers rise to the top; their models appear in the
          deploy picker. Anthropic and Bedrock run Claude Code natively;
          everything else is served through the harness&apos;s built-in proxy.
          Credentials are verified before they&apos;re saved.
        </p>
      }
    />
  );
}
