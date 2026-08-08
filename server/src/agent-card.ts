// The A2A Agent Card. A discovery client fetches this to learn what the agent
// does and where to call it. Without it, the SPA catch-all answered
// /.well-known/agent-card.json with HTML and a 200, which reads as a broken
// agent rather than an absent capability.
//
// Field names and required-ness follow the AgentCard message in the A2A
// specification proto: name, description, supportedInterfaces, version,
// capabilities, defaultInputModes, defaultOutputModes and skills are REQUIRED;
// provider, documentationUrl and iconUrl are optional. JSON keys are camelCase.

import type { RequestHandler } from "express";

export const AGENT_CARD_PATH = "/.well-known/agent-card.json" as const;

// Werk implements the REST-shaped binding: message:send, message:stream and
// tasks/{id} are exactly the HTTP+JSON custom-method routes the A2A router
// already serves.
const PROTOCOL_BINDING = "HTTP+JSON" as const;
const PROTOCOL_VERSION = "1.0" as const;
const AGENT_VERSION = "1.0.0" as const;

export type AgentCard = {
  name: string;
  description: string;
  supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string }[];
  provider?: { organization: string; url: string };
  version: string;
  documentationUrl?: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; extendedAgentCard: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: {
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
    inputModes?: string[];
    outputModes?: string[];
  }[];
};

// What a caller may send, and what comes back. Werk takes a plain-language
// request and returns rendered files, so the output modes are the media types
// its artifacts actually carry (see RENDER_FORMAT_BY_KIND in artifacts.ts).
const INPUT_MODES = ["text/plain", "application/json"];
const OUTPUT_MODES = [
  "text/plain",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function buildAgentCard(baseUrl: string): AgentCard {
  const url = normalizeBaseUrl(baseUrl);
  return {
    name: "Werk",
    description:
      "Turns one plain-language request into a package of business-ready assets: presentations, documents, spreadsheets, meeting plans, task lists, and schedules. Werk plans the package first, keeps missing details visible instead of inventing them, and publishes each deliverable as a downloadable file.",
    supportedInterfaces: [
      { url, protocolBinding: PROTOCOL_BINDING, protocolVersion: PROTOCOL_VERSION },
    ],
    provider: { organization: "Werk", url },
    version: AGENT_VERSION,
    documentationUrl: `${url}/docs`,
    capabilities: {
      // message:stream publishes status and artifact updates as they happen.
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: INPUT_MODES,
    defaultOutputModes: OUTPUT_MODES,
    skills: [
      {
        id: "business-asset-package",
        name: "Business asset generator",
        description:
          "Describe the outcome you need in plain language. Werk decides which outputs genuinely help, drafts each one, and returns them as files. When a needed detail is missing it publishes a decision card asking for it rather than inventing an answer.",
        tags: ["documents", "presentations", "spreadsheets", "planning", "business"],
        examples: [
          "Create a client proposal for my website design service.",
          "Plan the launch of my handmade skincare brand.",
          "Prepare a project kickoff for a new client.",
        ],
        inputModes: INPUT_MODES,
        outputModes: OUTPUT_MODES,
      },
    ],
  };
}

/**
 * Serve the card at the well-known path. The URL is derived per request so the
 * card advertises whichever host answered it, rather than a value baked in at
 * build time that would go stale behind a rename or a custom domain.
 */
export function createAgentCardRouter(): RequestHandler {
  return (req, res, next) => {
    if (req.path !== AGENT_CARD_PATH) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const base = process.env.PUBLIC_URL?.trim() || `${req.protocol}://${req.get("host") ?? ""}`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(buildAgentCard(base));
  };
}
