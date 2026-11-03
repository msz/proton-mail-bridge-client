import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/index.js";
import { readAttachmentFromUploadDir } from "../dist/tools/drafts-support.js";
import { closeTrackedIndexes } from "./helpers/close-indexes.mjs";

// An attachment can name a file by `path` instead of carrying base64 `content`, so a model does not have to write a whole
// file out as tokens. A mail can ask the model to attach ~/.ssh/id_rsa, so only files inside
// PROTONMAIL_ALLOW_FILE_UPLOAD_DIR are read, compared by real path, and nothing is read when it is not set.

const PDF = Buffer.from("%PDF-1.4 not really a pdf\n");

// root holds the upload directory and, beside it, a directory the upload directory must not reach.
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "attachment-upload-"));
  const uploads = join(root, "uploads");
  const outside = join(root, "outside");
  await mkdir(uploads);
  await mkdir(outside);
  await writeFile(join(uploads, "invoice.pdf"), PDF);
  await writeFile(join(outside, "id_rsa"), "PRIVATE KEY");
  try { await fn({ root, uploads, outside }); } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

test("a file inside the upload directory is read, by a relative or an absolute path", async () => {
  await withRoot(async ({ uploads }) => {
    assert.deepEqual(await readAttachmentFromUploadDir(uploads, "invoice.pdf"), PDF);
    assert.deepEqual(await readAttachmentFromUploadDir(uploads, join(uploads, "invoice.pdf")), PDF);
  });
});

test("a path outside the upload directory is refused, by traversal or as an absolute path", async () => {
  await withRoot(async ({ uploads, outside }) => {
    await assert.rejects(readAttachmentFromUploadDir(uploads, "../outside/id_rsa"), /not a file inside PROTONMAIL_ALLOW_FILE_UPLOAD_DIR/);
    await assert.rejects(readAttachmentFromUploadDir(uploads, join(outside, "id_rsa")), /not a file inside PROTONMAIL_ALLOW_FILE_UPLOAD_DIR/);
  });
});

test("a symlink inside the upload directory that leads out of it is refused, to a file or through a directory", async () => {
  await withRoot(async ({ uploads, outside }) => {
    await symlink(join(outside, "id_rsa"), join(uploads, "harmless.txt"));
    await symlink(outside, join(uploads, "folder"));
    await assert.rejects(readAttachmentFromUploadDir(uploads, "harmless.txt"), /not a file inside/);
    await assert.rejects(readAttachmentFromUploadDir(uploads, "folder/id_rsa"), /not a file inside/);
  });
});

test("an upload directory that is itself a symlink is accepted, and a symlink that stays inside it too", async () => {
  await withRoot(async ({ root, uploads }) => {
    await symlink(uploads, join(root, "link"));
    assert.deepEqual(await readAttachmentFromUploadDir(join(root, "link"), "invoice.pdf"), PDF);
    await symlink(join(uploads, "invoice.pdf"), join(uploads, "latest.pdf"));
    assert.deepEqual(await readAttachmentFromUploadDir(uploads, "latest.pdf"), PDF);
  });
});

test("a missing file and a file outside get the same answer, so the refusal does not tell what exists elsewhere", async () => {
  await withRoot(async ({ uploads, outside }) => {
    await assert.rejects(readAttachmentFromUploadDir(uploads, "nope.pdf"), /not a file inside/);
    await assert.rejects(readAttachmentFromUploadDir(uploads, join(outside, "nope")), /not a file inside/);
  });
});

test("with no upload directory nothing is read", async () => {
  await withRoot(async ({ uploads }) => {
    await assert.rejects(readAttachmentFromUploadDir(undefined, join(uploads, "invoice.pdf")), /PROTONMAIL_ALLOW_FILE_UPLOAD_DIR is not set/);
  });
});

// Through a whole server: create_draft stands for every tool that takes attachments (they share one parser).
async function withServer({ uploads, root }, fn, runtime = {}) {
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const conn = { host: "127.0.0.1", port: 9, secure: false, username: "owner@example.com", password: "x" };
  const config = {
    smtp: conn, imap: conn, dataDir, debug: false, cacheEnabled: true, analyticsEnabled: true, autoSync: false, syncInterval: 5,
    accounts: [{ address: "owner@example.com", slug: "owner-example-com", imap: conn, smtp: conn, dataDir }],
    runtime: { readOnly: false, allowSend: true, allowRemoteDraftSync: false, allowedActions: [], startupSync: false, autoSyncFolder: "INBOX", autoSyncFull: false, autoSyncLimitPerFolder: 25,
      idleWatchEnabled: false, idleMaxSeconds: 30, confirmDestructive: false, allowEmptyFolder: false, restrictOutboundToSelf: false, maxInlineBytes: 40960, opDelayMs: 0, sendDelaySeconds: 0,
      allowFileUploadDir: uploads, ...runtime },
  };
  const { server, accountManager } = createServer(config, { startBackgroundSync: false });
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    await fn({ call: (name, args) => client.callTool({ name, arguments: args }), draftStore: accountManager.primary().draftStore, dataDir });
  } finally {
    await client.close(); await server.close(); await closeTrackedIndexes();
  }
}

const draft = (attachments) => ({ to: "someone@example.com", subject: "Invoice", body: "Attached.", syncToRemote: false, attachments });

test("create_draft attaches a file by path, named after the file, and the audit log has the path but not the bytes", async () => {
  await withRoot(async (dirs) => {
    await withServer(dirs, async ({ call, draftStore, dataDir }) => {
      const result = await call("create_draft", draft([{ path: "invoice.pdf", contentType: "application/pdf" }]));
      assert.ok(!result.isError, JSON.stringify(result.content));
      const [stored] = (await draftStore.listDrafts()).map((entry) => entry.attachments);
      assert.equal(stored.length, 1);
      assert.equal(stored[0].filename, "invoice.pdf");
      assert.equal(stored[0].contentType, "application/pdf");
      assert.deepEqual(Buffer.from(stored[0].content, "base64"), PDF);
      // The result does not echo the file back either.
      assert.ok(!result.content[0].text.includes(PDF.toString("base64")));

      const audit = await readFile(join(dataDir, "audit.log"), "utf8");
      assert.match(audit, /"path":"invoice.pdf"/);
      assert.ok(!audit.includes(PDF.toString("base64")), "the audit log must not hold the file");
    });
  });
});

test("a filename given with path is kept, and base64 content still works beside a path attachment", async () => {
  await withRoot(async (dirs) => {
    await withServer(dirs, async ({ call, draftStore }) => {
      const result = await call("create_draft", draft([{ path: "invoice.pdf", filename: "March.pdf" }, { filename: "note.txt", content: Buffer.from("hi").toString("base64") }]));
      assert.ok(!result.isError, JSON.stringify(result.content));
      const [stored] = (await draftStore.listDrafts()).map((entry) => entry.attachments);
      assert.deepEqual(stored.map((attachment) => attachment.filename), ["March.pdf", "note.txt"]);
    });
  });
});

test("create_draft refuses a path outside the upload directory and creates no draft", async () => {
  await withRoot(async (dirs) => {
    await withServer(dirs, async ({ call, draftStore }) => {
      const result = await call("create_draft", draft([{ path: join(dirs.outside, "id_rsa") }]));
      assert.ok(result.isError);
      assert.match(result.content[0].text, /not a file inside PROTONMAIL_ALLOW_FILE_UPLOAD_DIR/);
      assert.deepEqual(await draftStore.listDrafts(), []);
    });
  });
});

test("with PROTONMAIL_ALLOW_FILE_UPLOAD_DIR unset, a path is refused and base64 content still works", async () => {
  await withRoot(async (dirs) => {
    await withServer(dirs, async ({ call, draftStore }) => {
      const refused = await call("create_draft", draft([{ path: join(dirs.uploads, "invoice.pdf") }]));
      assert.ok(refused.isError);
      assert.match(refused.content[0].text, /PROTONMAIL_ALLOW_FILE_UPLOAD_DIR is not set/);
      assert.deepEqual(await draftStore.listDrafts(), []);
      const ok = await call("create_draft", draft([{ filename: "a.pdf", content: PDF.toString("base64") }]));
      assert.ok(!ok.isError, JSON.stringify(ok.content));
    }, { allowFileUploadDir: undefined });
  });
});

test("path and content in the same attachment are refused", async () => {
  await withRoot(async (dirs) => {
    await withServer(dirs, async ({ call, draftStore }) => {
      const result = await call("create_draft", draft([{ path: "invoice.pdf", filename: "a.pdf", content: PDF.toString("base64") }]));
      assert.ok(result.isError);
      assert.match(result.content[0].text, /either content or path, not both/);
      assert.deepEqual(await draftStore.listDrafts(), []);
    });
  });
});
