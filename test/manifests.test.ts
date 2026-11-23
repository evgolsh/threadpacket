import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import lock from "../package-lock.json";
import serverJson from "../server.json";
import gemini from "../gemini-extension.json";
import cursor from "../.cursor-plugin/plugin.json";
import agentPlugin from "../plugin/plugin.json";
import claudePlugin from "../plugin/.claude-plugin/plugin.json";
import codexPlugin from "../plugin/.codex-plugin/plugin.json";
import claudeMcp from "../plugin/.mcp.json";
import agentMcp from "../plugin/mcp.json";
import rootMcp from "../mcp.json";
import logoSvg from "../plugin/assets/icon.svg?raw";
import skillMd from "../plugin/skills/threadpacket/SKILL.md?raw";

/** The pitch on the homepage and in every host manifest that has a free-form description. */
const PITCH =
  "Send your work to someone else's AI assistant, with your notes and the original files. Hosted at threadpacket.com, or on your own private server.";

/** A manifest path Cursor will accept: relative to the plugin root, and not a parent traversal. */
function assertPluginPath(p: string): void {
  expect(p.length).toBeGreaterThan(0);
  expect(p.startsWith("/")).toBe(false);
  expect(/^[A-Za-z]:/.test(p)).toBe(false);
  expect(p.split(/[\\/]/).includes("..")).toBe(false);
}

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

  it("the host descriptions share the current pitch", () => {
    expect(cursor.description).toBe(PITCH);
    expect(agentPlugin.description).toBe(PITCH);
    expect(claudePlugin.description).toBe(PITCH);
    expect(codexPlugin.description).toBe(PITCH);
    expect(gemini.description).toBe(PITCH);
  });

  it("the Cursor plugin is ready for the Marketplace checklist", () => {
    expect(cursor.name).toBe("threadpacket");
    expect(cursor.name).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
    expect(cursor.displayName).toBe("Threadpacket");
    expect(cursor.version).toBe(pkg.version);
    expect(cursor.homepage).toBe("https://threadpacket.com");
    expect(cursor.repository).toBe("https://github.com/evgolsh/threadpacket");
    expect(cursor.license).toBe("MIT");
    expect(cursor.keywords.length).toBeGreaterThan(0);
    expect(cursor.keywords).toContain("threadpacket");

    expect(cursor.logo).toBe("plugin/assets/icon.svg");
    assertPluginPath(cursor.logo);
    const box = /viewBox="0 0 (\d+(?:\.\d+)?) \1"/.exec(logoSvg);
    expect(box, "logo is a 1:1 SVG").not.toBeNull();
    expect(logoSvg).toMatch(/<rect\b[^>]*\bfill="/);

    expect(cursor.skills).toBe("plugin/skills");
    assertPluginPath(cursor.skills);
    const skillFile = "plugin/skills/threadpacket/SKILL.md";
    expect(skillFile.startsWith(`${cursor.skills}/`)).toBe(true);
    const front = /^---\n([\s\S]*?)\n---/.exec(skillMd);
    expect(front).not.toBeNull();
    expect(/^name:\s*(\S+)\s*$/m.exec(front![1]!)?.[1]).toBe("threadpacket");
    expect(/^description:\s*\S/m.exec(front![1]!)).not.toBeNull();

    expect(cursor.mcpServers).toBe("mcp.json");
    assertPluginPath(cursor.mcpServers);
    expect(rootMcp.mcpServers.threadpacket.url).toBe("https://threadpacket.com/mcp");
    expect(rootMcp.mcpServers.threadpacket.url).toBe(serverJson.remotes[0]!.url);
    expect(JSON.stringify(rootMcp)).not.toMatch(/\$\{/);
  });

  it("each host gets the transport type it accepts, on the same server", () => {
    // Anthropic's directory accepts http, sse or ws for a remote server; the Agent Plugins format names streamable-http.
    expect(claudeMcp.mcpServers.threadpacket).toEqual({ type: "http", url: serverJson.remotes[0]!.url });
    expect(agentMcp.mcpServers.threadpacket).toEqual({ type: "streamable-http", url: serverJson.remotes[0]!.url });
  });
});
