import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import lock from "../package-lock.json";
import serverJson from "../server.json";
import gemini from "../gemini-extension.json";
import cursor from "../.cursor-plugin/plugin.json";
import agentPlugin from "../plugin/plugin.json";
import antigravityPlugin from "../plugin/.antigravity-plugin/plugin.json";
import claudePlugin from "../plugin/.claude-plugin/plugin.json";
import codexPlugin from "../plugin/.codex-plugin/plugin.json";
import antigravityMcp from "../plugin/mcp_config.json";
import claudeMcp from "../plugin/.mcp.json";
import agentMcp from "../plugin/mcp.json";
import cursorLogo from "../plugin/assets/icon.svg?raw";

/**
 * The plugin package and the registry entry. Codex caches an installed plugin by version, and the directories
 * reject a listing over their limits, so these fail before a portal does.
 */
describe("plugin manifests", () => {
  it("every manifest carries the package version", () => {
    const versions = {
      "package-lock.json": lock.version,
      "package-lock.json packages['']": (lock.packages as Record<string, { version?: string }>)[""]?.version,
      "server.json": serverJson.version,
      "gemini-extension.json": gemini.version,
      ".cursor-plugin/plugin.json": cursor.version,
      "plugin/plugin.json": agentPlugin.version,
      "plugin/.antigravity-plugin/plugin.json": antigravityPlugin.version,
      "plugin/.claude-plugin/plugin.json": claudePlugin.version,
      "plugin/.codex-plugin/plugin.json": codexPlugin.version,
    };
    for (const [file, v] of Object.entries(versions)) expect(v, file).toBe(pkg.version);
  });

  it("the OpenAI listing fits the submission limits and has the four URLs", () => {
    const ui = agentPlugin.extensions["com.openai"].interface;
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
    expect(ui.developerName.length).toBeLessThanOrEqual(80);
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"] as const) {
      expect(ui[key], key).toMatch(/^https:\/\/\S+$/);
    }
    const prompts = ui.defaultPrompt;
    expect(prompts.length).toBeLessThanOrEqual(3);
    for (const p of prompts) expect(p.length).toBeLessThanOrEqual(128);
    // Listings may not advertise a price.
    expect(`${ui.shortDescription} ${ui.longDescription}`).not.toMatch(/\bfree\b/i);
  });

  it("the MCP Registry entry fits the registry schema's limits", () => {
    // static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json: description maxLength 100.
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });

  it("has five positive and three negative review cases", () => {
    const cases = agentPlugin.extensions["com.openai"].review.test_cases;
    expect(cases.positive).toHaveLength(5);
    expect(cases.negative).toHaveLength(3);
    for (const c of cases.positive) expect(c.tools_triggered && c.expected_behavior && c.prompt).toBeTruthy();
  });

  it("the Cursor manifest points inside the repository, with a square logo", () => {
    // Cursor resolves relative paths against the repository root and turns the logo into a raw.githubusercontent.com URL.
    for (const path of [cursor.logo, cursor.skills, cursor.mcpServers]) expect(path).not.toMatch(/^(\/|\.\.|[a-z]+:)/);
    expect(cursor.logo).toBe("plugin/assets/icon.svg");
    expect(cursorLogo).toMatch(/viewBox="0 0 (\d+) \1"/);
  });

  it("the Antigravity manifest fits the v1 schema and Marketplace rules", () => {
    // https://antigravity.google/schemas/v1/plugin.json has additionalProperties: false.
    const allowed = new Set([
      "$schema", "name", "displayName", "description", "version", "disabled", "logo",
      "suggestedPrompts", "skills", "author", "homepage", "repository", "license", "keywords", "extensions",
    ]);
    for (const key of Object.keys(antigravityPlugin)) expect(allowed.has(key), key).toBe(true);
    expect(antigravityPlugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(antigravityPlugin.displayName).not.toMatch(/^(Antigravity|Gemini|Claude|Cursor)\b/i);
    expect(antigravityPlugin.description.length).toBeGreaterThanOrEqual(40);
    expect(antigravityPlugin.description.length).toBeLessThanOrEqual(200);
    expect(antigravityPlugin.logo).toBe("assets/icon.svg");
    expect(antigravityPlugin.logo).not.toMatch(/^(\/|\.\.|[a-z]+:)/);
    expect(cursorLogo).toMatch(/viewBox="0 0 (\d+) \1"/);
    expect(antigravityPlugin.suggestedPrompts.length).toBeGreaterThanOrEqual(1);
    expect(antigravityPlugin.suggestedPrompts.length).toBeLessThanOrEqual(3);
    for (const p of antigravityPlugin.suggestedPrompts) expect(p.trim().length).toBeGreaterThan(0);
    expect(antigravityPlugin.author.url).toMatch(/^https:\/\/\S+$/);
    expect(antigravityPlugin.homepage).toMatch(/^https:\/\/\S+$/);
    expect(antigravityPlugin.repository).toMatch(/^https:\/\/\S+$/);
  });

  it("each host gets the transport type it accepts, on the same server", () => {
    // Anthropic's directory accepts http, sse or ws for a remote server; the Agent Plugins format names streamable-http;
    // Antigravity uses Streamable HTTP via url (or serverUrl) with automatic OAuth discovery.
    expect(claudeMcp.mcpServers.threadpacket).toEqual({ type: "http", url: serverJson.remotes[0]!.url });
    expect(agentMcp.mcpServers.threadpacket).toEqual({ type: "streamable-http", url: serverJson.remotes[0]!.url });
    expect(antigravityMcp.mcpServers.threadpacket).toEqual({ url: serverJson.remotes[0]!.url });
  });
});
