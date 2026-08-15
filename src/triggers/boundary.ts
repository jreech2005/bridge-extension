import type { TriggerMatch } from '@/shared/types';

// Examples (should fire):
//   "I asked ChatGPT about Stripe webhooks last week" → platform: chatgpt
//   "discussed with Gemini yesterday"                  → platform: gemini
//   "from my ChatGPT chat about auth"                  → platform: chatgpt
//   "ChatGPT told me to use Redis"                     → platform: chatgpt
//   "in my Stripe project we decided"                  → project: Stripe (if known and not current)
//   "the Onboarding project had a doc"                 → project: Onboarding
//
// Examples (should NOT fire):
//   "as we discussed yesterday"        — no platform/project name
//   "remember when you said that"      — Claude-internal reference
//   "GPT-4 is faster than 3.5"         — model name, no referential phrase, also -\d guard
//   "I use ChatGPT daily"              — no referential preposition
//   "in my current project"            — generic, no project name
//   "discussed in this project"        — current project (excluded by caller)

const PLATFORMS: { canonical: string; aliasGroup: string; alias: RegExp }[] = [
  // 'gpt' is matched but excluded when followed by `-\d` (model variants like GPT-4).
  { canonical: 'chatgpt', aliasGroup: '(?:chatgpt|openai|gpt(?!-\\d))', alias: /\b(?:chatgpt|openai|gpt(?!-\d))\b/i },
  { canonical: 'gemini', aliasGroup: 'gemini', alias: /\bgemini\b/i },
  { canonical: 'perplexity', aliasGroup: 'perplexity', alias: /\bperplexity\b/i },
  { canonical: 'grok', aliasGroup: 'grok', alias: /\bgrok\b/i },
  { canonical: 'deepseek', aliasGroup: 'deepseek', alias: /\bdeepseek\b/i },
  { canonical: 'copilot', aliasGroup: 'copilot', alias: /\bcopilot\b/i },
  { canonical: 'meta-ai', aliasGroup: 'meta\\s+ai', alias: /\bmeta\s+ai\b/i },
];

// Referential framings — either "<verb> <platform>" or "<platform> <verb>".
const PRE_REF = '(?:with|from\\s+my|in|asked|discussed\\s+with|told\\s+me|told)';
const POST_REF = '(?:told\\s+me|said|chat|conversation|thread)';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectPlatform(text: string): TriggerMatch | null {
  for (const p of PLATFORMS) {
    if (!p.alias.test(text)) continue;
    const before = new RegExp(
      `\\b${PRE_REF}\\s+(?:my\\s+)?${p.aliasGroup}\\b`,
      'i',
    );
    const after = new RegExp(
      `\\b${p.aliasGroup}\\s+${POST_REF}\\b`,
      'i',
    );
    const m = before.exec(text) ?? after.exec(text);
    if (m) {
      return {
        source: { type: 'platform', platform: p.canonical },
        matchedText: m[0],
      };
    }
  }
  return null;
}

function detectProject(
  text: string,
  currentProject: string | null,
  knownProjects: string[],
): TriggerMatch | null {
  const current = currentProject?.toLowerCase().trim() ?? null;
  for (const project of knownProjects) {
    if (!project) continue;
    if (current && project.toLowerCase().trim() === current) continue;
    const re = new RegExp(
      `\\b(?:my|the|in\\s+my|in\\s+the)\\s+${escapeRegex(project)}\\s+project\\b`,
      'i',
    );
    const m = re.exec(text);
    if (m) {
      return {
        source: { type: 'project', project },
        matchedText: m[0],
      };
    }
  }
  return null;
}

export function detectBoundaryTrigger(
  text: string,
  currentProject: string | null,
  knownProjects: string[],
): TriggerMatch | null {
  if (!text || text.length < 3) return null;
  const result = detectPlatform(text) ?? detectProject(text, currentProject, knownProjects);
  console.log(
    '[bridge debug] trigger check:',
    'knownProjects=', knownProjects,
    'currentProject=', currentProject,
    'result=', result,
  );
  return result;
}
