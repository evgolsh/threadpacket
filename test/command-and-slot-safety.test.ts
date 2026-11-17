import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { verifyBearer } from "../src/auth/verify";
import { redactSecrets } from "../src/app";
import { configFrom } from "../src/env";
import { ThreadpacketService } from "../src/domain/service";
import { D1Repository } from "../src/store/d1";
import { R2BlobStore } from "../src/store/blobs";
import { SignJWT, importJWK } from "jose";
import privateJwk from "./fixtures/test-private-jwk.json";
import { AUDIENCE, ISSUER, ORIGIN, PDF, alice, call, errorText, expectOk, rpc, send, sha256Hex } from "./helpers";

describe("the upload tool returns data, never a command", () => {
  it("returns the URL on this server and the headers, with no shell command and an unsafe type replaced", async () => {
    const a = await alice();
    const r = expectOk(await call(a, "threadpacket_upload_url", { filename: "../dir/proof$(printf X)\n.pdf", mime_type: "application/pdf" }));
    expect(Object.keys(r).sort()).toEqual(["attachment_id", "expires_at", "headers", "max_bytes", "method", "upload_url"]);
    expect(r.method).toBe("PUT");
    expect(r.headers).toEqual({ "content-type": "application/pdf" });
    expect(String(r.upload_url).startsWith(`${ORIGIN}/v1/uploads/${r.attachment_id}?ticket=`)).toBe(true);

    // Any type is accepted; one that is not a plain type/subtype becomes application/octet-stream.
    for (const bad of ["text/plain$(printf MIME_EXPANDED)", 'text/plain"; printf TYPE_ESCAPED; #']) {
      const res = expectOk(await call(a, "threadpacket_upload_url", { filename: "proof.txt", mime_type: bad }));
      expect(res.headers).toEqual({ "content-type": "application/octet-stream" });
    }
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(expectOk(await call(a, "threadpacket_upload_url", { filename: "r.docx", mime_type: docx })).headers).toEqual({ "content-type": docx });
    const canon = expectOk(await call(a, "threadpacket_upload_url", { filename: "n.md", mime_type: "Text/Markdown; charset=UTF-8" }));
    expect(canon.headers).toEqual({ "content-type": "text/markdown" });
  });

  it("the tool text and description give the fixed upload form, not a command built for this file", async () => {
    const a = await alice();
    const { body } = await rpc(a, "tools/call", { name: "threadpacket_upload_url", arguments: { filename: "it's.pdf", mime_type: "application/pdf" } });
    const shown = String(body.result.content[0].text);
    expect(shown).not.toContain("curl");
    expect(shown).not.toContain("Invoke-");
    expect(shown).toContain("content-type: application/pdf");
    const list = await rpc(a, "tools/list");
    const tool = list.body.result.tools.find((t: any) => t.name === "threadpacket_upload_url");
    expect(tool.description).toContain(`check that upload_url starts with ${ORIGIN}/v1/uploads/`);
    expect(tool.description).toContain("curl -fsS -X PUT --upload-file '<full path>' -H 'content-type: <type>' '<upload_url>'");
    expect(tool.description).toContain("Invoke-WebRequest -UseBasicParsing -Method Put -InFile '<full path>' -ContentType '<type>' -Uri '<upload_url>'");
    expect(tool.description).not.toContain("run the returned");
  });

  it("without a declared type the headers say application/octet-stream and the upload succeeds", async () => {
    const a = await alice();
    const r = expectOk(await call(a, "threadpacket_upload_url", { filename: "codeword.pdf" }));
    expect(r.headers).toEqual({ "content-type": "application/octet-stream" });
    const put = await SELF.fetch(String(r.upload_url), { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: PDF });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { mime_type: string }).mime_type).toBe("application/pdf");
  });
});

describe("one writer per upload slot over HTTP", () => {
  it("two concurrent PUTs to one slot: exactly one succeeds, and the stored bytes match the stored checksum", async () => {
    const a = await alice();
    const created = await SELF.fetch(`${ORIGIN}/v1/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${a}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: "race.pdf" }),
    });
    const { attachment_id, upload_url } = (await created.json()) as { attachment_id: string; upload_url: string };
    const bodies = ["A", "B"].map((x) => new TextEncoder().encode(`%PDF-1.4\n${x}\n%%EOF`));
    const results = await Promise.all(
      bodies.map((body) => SELF.fetch(upload_url, { method: "PUT", headers: { authorization: `Bearer ${a}`, "content-type": "application/pdf" }, body })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const p = await send(a, { attachment_ids: [attachment_id] });
    const dl = await SELF.fetch(`${ORIGIN}/v1/attachments/${attachment_id}/original?packet_id=${p.packet_id}`, { headers: { authorization: `Bearer ${a}` } });
    const bytes = new Uint8Array(await dl.arrayBuffer());
    expect(await sha256Hex(bytes)).toBe(dl.headers.get("x-checksum-sha256"));
    // A published file accepts no further bytes.
    const again = await SELF.fetch(upload_url, { method: "PUT", headers: { authorization: `Bearer ${a}`, "content-type": "application/pdf" }, body: bodies[0] });
    expect(again.status).toBe(409);
  });
});

describe("cleanup finishes deletions it claimed earlier", () => {
  it("a row left with claim 'delete' is removed with its bytes on the next run", async () => {
    const svc = new ThreadpacketService(new D1Repository(env.DB), new R2BlobStore(env.BLOBS), configFrom(env));
    const owner = { subject: `user_${crypto.randomUUID()}`, scopes: [], clientId: "t", token: "" };
    const slot = await svc.createUpload(owner, { filename: "x.pdf" });
    await svc.receiveBytes(slot, PDF, { mime_type: "application/pdf" });
    await env.DB.prepare("UPDATE attachments SET claim = 'delete' WHERE id = ?").bind(slot.id).run();
    await expect(svc.send(owner, { title: "t", brief: "b", attachment_ids: [slot.id], idempotency_key: crypto.randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    await svc.cleanup();
    expect(await env.DB.prepare("SELECT id FROM attachments WHERE id = ?").bind(slot.id).first()).toBeNull();
    expect(await env.BLOBS.head(slot.blob_key)).toBeNull();
  });
});

describe("development tokens", () => {
  const devCfg = (tokens: unknown, origin = "http://localhost:8787") => configFrom({ ...env, THREADPACKET_ENV: "dev", DEV_TOKENS: JSON.stringify(tokens) }, origin);

  it("production ignores DEV_TOKENS entirely", async () => {
    const cfg = configFrom({ ...env, THREADPACKET_ENV: "production", DEV_TOKENS: JSON.stringify({ "dev-token-1": "user_dev" }) });
    expect(cfg.devTokens.size).toBe(0);
    await expect(verifyBearer(cfg, "dev-token-1", env.DB)).rejects.toMatchObject({ error: "invalid_token" });
  });

  it("dev mode ignores DEV_TOKENS on a request that did not come to localhost", async () => {
    for (const origin of ["https://threadpacket.example.workers.dev", "", "http://localhost.evil.example"]) {
      expect(devCfg({ "dev-token-1": "user_dev" }, origin).devTokens.size, origin).toBe(0);
    }
    expect(devCfg({ "dev-token-1": "user_dev" }, "http://127.0.0.1:8787").devTokens.size).toBe(1);
  });

  it("dev mode accepts only configured own tokens with a string subject", async () => {
    const cfg = devCfg({ "dev-token-1": "user_dev", "dev-token-2": 5, "dev-token-3": "" });
    expect((await verifyBearer(cfg, "dev-token-1", env.DB)).subject).toBe("user_dev");
    for (const t of ["dev-token-2", "dev-token-3", "toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      await expect(verifyBearer(cfg, t, env.DB)).rejects.toMatchObject({ error: "invalid_token" });
    }
  });
});

describe("token claims", () => {
  it("a signed token whose subject is not a string is refused", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bearer = await new SignJWT({ sub: 42 as unknown as string, scope: "threadpacket", client_id: "test-client" })
      .setProtectedHeader({ alg: "ES256", kid: "test-key-1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(await importJWK(privateJwk, "ES256"));
    expect((await rpc(bearer, "tools/list")).status).toBe(401);
  });
});

describe("log redaction", () => {
  it("removes ticket-length tokens and keeps short ids", () => {
    const ticket = "pL03lYr1vhT9gi02GjpioTZFV0F9uu04S3peYZhS8BQ";
    expect(redactSecrets(`failed /v1/dl/${ticket} for at_hn6cul6nm7z6pm5i2kjt`)).toBe("failed /v1/dl/[redacted] for at_hn6cul6nm7z6pm5i2kjt");
  });
});
